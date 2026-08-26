// Crypto Decision Engine — Trading Worker (server-only)
// ===================================================================
// Runtime modes:
//   simulation -> public market data, no account, local simulator only (frontend)
//   testnet    -> public market data from Mainnet, authenticated orders to Bybit Testnet
//   live       -> public market data from Mainnet, authenticated orders to Bybit Mainnet
//
// CRITICAL: BYBIT_TESTNET selects ONLY the authenticated execution/account URL.
// Public candles/prices ALWAYS come from Mainnet (https://api.bybit.com) regardless of mode.
// The browser never sees the secret key. All signing happens here, server-side.
// ===================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';
// Server-side simulation engine (runs the bot 24/7 without a browser).
import { createSimEngine, SimSnapshot } from '../../server/simEngine.ts';
// Core decision engine — single source of truth for Layers 0-3 (intraday MTF).
import { evaluateIntradayDecision, IntradayDecision, TradeType } from '../services/intradayEngine';
import { buildPortfolioRiskStats } from '../services/intradayBridge';
import { getMultiTimeframeData, exportMarketDataCache, importMarketDataCache, TIMEFRAME_SPECS, TIMEFRAME_ORDER, type TimeframeCacheEntry } from '../services/marketDataService';
import { toBybitSymbol } from '../services/assetUniverse';
import { TARGET_SYMBOLS } from '../shared/targetSymbols';
import { createKVStore } from './kvStore';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Local development reads the repository .env; Render variables retain precedence.
loadEnv({ path: join(__dirname, '..', '.env') });

// Load .env (local dev). On Render, dashboard env vars are already present in
// process.env and dotenv will NOT override them (it only fills missing keys).
const DATA_DIR = join(__dirname, '.data');
const STATE_FILE = join(DATA_DIR, 'bot-state.json');

// ── Server-only configuration ──────────────────────────────────────────────
const port = Number(process.env.PORT || 3001);
const apiKey = process.env.BYBIT_API_KEY || '';
const secretKey = process.env.BYBIT_SECRET_KEY || '';
const testnet = process.env.BYBIT_TESTNET === 'true'; // default false (mainnet)
const dryRun = process.env.BOT_DRY_RUN !== 'false'; // default true (safe)
const adminToken = process.env.BOT_ADMIN_TOKEN || '';
const autostart = process.env.BOT_AUTOSTART === 'true';
const riskLevel = process.env.BOT_RISK_LEVEL || 'medium';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
const minConfidence = boundedNumber('BOT_MIN_CONFIDENCE', 60, 0, 100);
const positionPercent = boundedNumber('BOT_POSITION_PERCENT', 10, 0.1, 100); // % of available USDT
const maxOpenPositions = Math.floor(boundedNumber('BOT_MAX_OPEN_POSITIONS', 5, 1, 100));
const scanConcurrency = Math.floor(boundedNumber('BOT_SCAN_CONCURRENCY', 5, 1, 20));
const intervalMs = boundedNumber('BOT_SCAN_INTERVAL_SECONDS', 300, 60, 3600) * 1000;
// FIX #1: symbols that opened a SPOT position are no longer blocked forever.
// After this many hours they become eligible again even if we can't verify
// the spot position closed (Bybit spot has no "position list" like Futures).
// Futures positions are still verified directly against the exchange (see scan()).
const REENTRY_COOLDOWN_MS = boundedNumber('BOT_REENTRY_COOLDOWN_HOURS', 24, 1, 720) * 3600 * 1000;

// CORS: restrict to configured frontend origins. Comma-separated, or '*' to allow any.
// A value such as https://*.netlify.app permits Netlify Deploy Preview URLs.
const corsOriginEnv = process.env.CORS_ORIGIN || '';
const allowedOrigins = corsOriginEnv.split(',').map(s => s.trim()).filter(Boolean);
// Basic rate limiting: per-IP window.
const RATE_LIMIT_MAX = Math.floor(boundedNumber('BOT_RATE_LIMIT_MAX', 120, 1, 10000));
const RATE_LIMIT_WINDOW_MS = boundedNumber('BOT_RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000);
const REQUEST_TIMEOUT_MS = boundedNumber('BOT_REQUEST_TIMEOUT_MS', 15000, 1000, 120000);


// ── HTTP helpers: CORS, rate limiting, timeouts ────────────────────────────
function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const rateBuckets = new Map<string, number[]>(); // ip -> [timestamps]
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

// FIX #3: rateBuckets grew forever (one entry per distinct IP, never removed).
// Periodically drop IPs with no hits left in the current window.
function pruneRateBuckets(): void {
  const now = Date.now();
  for (const [ip, hits] of rateBuckets) {
    const fresh = hits.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, fresh);
  }
}

function setCors(req: { headers: Record<string, string | string[] | undefined> }, res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void; setHeader: (name: string, value: string) => void }): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!origin) return;
  const originAllowed = allowedOrigins.some((allowed) =>
    allowed === origin ||
    (allowed.includes('*') && origin.startsWith(allowed.split('*')[0]) && origin.endsWith(allowed.split('*').slice(1).join('*')))
  );
  const allow = allowedOrigins.length === 0 || allowedOrigins.includes('*') ? '*' : (originAllowed ? origin : null);
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Vary', 'Origin');
  }
}

// Abort external calls that exceed the request timeout so the worker never hangs.
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Send critical error alerts to Telegram. Requires TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID environment variables. No-op if not configured.
let lastAlertedError: string | null = null;

// Send order execution notification to Telegram. Requires TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID environment variables. No-op if not configured.
async function sendTelegramOrder(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;
  try {
    await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch {
    // Never throw from notification — a Telegram failure must not crash the worker.
  }
}
async function sendTelegramAlert(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;
  if (lastAlertedError === message) return;
  lastAlertedError = message;
  try {
    await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: `🚨 Crypto Bot Error\n\n${message}`,
        parse_mode: 'HTML'
      })
    });
  } catch {
    // Never throw from alerting — a Telegram failure must not crash the worker.
  }
}

// Public market data is ALWAYS Mainnet. Execution/account URL depends on testnet flag.
const PUBLIC_BASE = 'https://api.bybit.com';
const EXEC_BASE = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

// Kline interval for the scan. Daily ('D') candles rarely reach a TRENDING
// regime (ADX>25), so Futures almost never triggers and the bot stays on SPOT.
// Shorter intervals (4h='240', 1h='60') detect trends far more often, letting
// the existing Futures routing/leverage logic actually engage. Configurable.
const klineInterval = process.env.BOT_KLINE_INTERVAL || '240';

// `BOT_SYMBOLS=100` (or unset) means the full supported universe; any other
// value is treated as an explicit comma-separated list, which pins the
// universe and disables the automatic liquidity-based refresh below.
const botSymbolsRaw = process.env.BOT_SYMBOLS?.trim();
const isExplicitSymbolOverride = Boolean(botSymbolsRaw && botSymbolsRaw !== '100');
const rawSymbols = (isExplicitSymbolOverride
  ? botSymbolsRaw!.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : TARGET_SYMBOLS
);
// Unsupported symbols are recorded with a visible reason — never silently treated as a successful scan.
const unsupportedSymbols = rawSymbols.filter(s => !s.endsWith('USDT')).map(s => ({ symbol: s, reason: 'לא מסתיים ב-USDT (לא נתמך)' }));
// Mutable: refreshUniverseIfStale() swaps this to a fresh liquidity-based list
// (see below). Read at call time everywhere it's used, never captured once.
// Deduplicated — an explicit BOT_SYMBOLS list with a repeated entry (typo,
// copy-paste) would otherwise scan and evaluate the same symbol twice per
// cycle for no reason (harmless, but wasted API calls and log noise).
let symbols = [...new Set(rawSymbols.filter(s => s.endsWith('USDT')))];

// ── Liquidity-based universe refresh ────────────────────────────────────────
// TARGET_SYMBOLS (the static list) can drift: a coin's Bybit liquidity shifts,
// or a symbol gets delisted outright, day to day. computeLiquidUniverse() re-
// derives the tradeable list live from Bybit turnover and is persisted to
// Firestore (via configStore) so the SAME refreshed universe survives
// restarts/redeploys without waiting on a fresh full recompute every boot.
// Skipped entirely when the operator pinned an explicit BOT_SYMBOLS list.
//
// Refreshed daily (was 7 days): the recompute is just 3 lightweight public
// Bybit ticker calls (spot/linear/inverse, no auth, no per-symbol overhead —
// nothing like the per-symbol candle fetching that needs rate-limit care
// elsewhere), so daily cost is negligible. A 7-day staleness window meant a
// symbol that got delisted from Bybit Spot could sit dead in the trading
// universe for up to a week before self-healing, silently wasting that slot's
// worth of scan budget the whole time.
const UNIVERSE_STALE_MS = 24 * 60 * 60 * 1000; // 1 day
const UNIVERSE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // re-check staleness daily

// Exposed read-only via GET /api/public/universe so the simulation frontend
// (no admin token) can mirror the SAME live universe as the real bot.
let universeGeneratedAt = 0;

async function refreshUniverseIfStale(): Promise<void> {
  if (isExplicitSymbolOverride) return;
  try {
    const cached = await configStore.get('targetSymbols');
    const parsed = cached ? (JSON.parse(cached) as { symbols: string[]; generatedAt: number }) : null;
    const isStale = !parsed || Date.now() - parsed.generatedAt > UNIVERSE_STALE_MS;

    if (parsed && parsed.symbols.length) {
      symbols = parsed.symbols;
      universeGeneratedAt = parsed.generatedAt;
    }
    if (!isStale) return;

    const { computeLiquidUniverse } = await import('../services/symbolUniverse');
    const fresh = await computeLiquidUniverse();
    if (!fresh.symbols.length) return; // never adopt an empty result
    symbols = fresh.symbols;
    universeGeneratedAt = fresh.generatedAt;
    await configStore.set('targetSymbols', JSON.stringify({ symbols: fresh.symbols, generatedAt: fresh.generatedAt }));
    console.log(`[universe] refreshed: ${fresh.liquid.length} liquid + ${fresh.close.length} close = ${fresh.symbols.length} symbols`);
  } catch (e) {
    console.warn('[universe] refresh failed, keeping current symbol list:', e instanceof Error ? e.message : String(e));
  }
}

// ── Source health counters ─────────────────────────────────────────────────
const health = { publicRequests: 0, publicFailures: 0, execRequests: 0, execFailures: 0, lastScanAt: null as string | null };

// ── In-memory + persisted state ────────────────────────────────────────────
const state = {
  running: autostart,
  lastScanAt: null as string | null,
  lastError: null as string | null,
  scans: 0,
  startedAt: new Date().toISOString(),
  decisions: [] as ScanResult[],
  orders: [] as { at: string; dryRun: boolean; symbol: string; side: string; reason?: string; error?: string; result?: unknown }[],
  openedSymbols: new Map<string, { at: number; type: 'SPOT' | 'FUTURES' }>(),
  skippedSymbols: [...unsupportedSymbols] as { symbol: string; reason: string }[],
  // Pending Limit Orders: symbol → { orderId, placedAt, expiresAt }
  // Auto-cancelled after LIMIT_ORDER_TTL_MS if not filled.
  pendingLimitOrders: new Map<string, { orderId: string; symbol: string; placedAt: number; expiresAt: number }>()
};

function json(res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Read a JSON request body (used by the shared simulation bot endpoints).
async function readJsonBody(req: { on: (event: string, handler: (chunk?: string | Buffer) => void) => void; destroy: () => void }, limitBytes = 5_000_000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk?: string | Buffer) => {
      data += chunk;
      if (data.length > limitBytes) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// FIX #2: constant-time comparison so a bad admin token can't be brute-forced
// via response-time measurement. Falls back to a safe `false` on any length
// mismatch instead of throwing (timingSafeEqual requires equal-length buffers).
function authorized(req: { headers: { authorization?: string } }): boolean {
  if (!adminToken) return false;
  const header = req.headers.authorization || '';
  const expected = `Bearer ${adminToken}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ═══════════════════════════════════════════════════════════════════════════
// BYBIT CLIENT — public (Mainnet) + authenticated execution (testnet/mainnet)
// ═══════════════════════════════════════════════════════════════════════════

function sign(timestamp: string, payload: string): string {
  return createHmac('sha256', secretKey).update(`${timestamp}${apiKey}5000${payload}`).digest('hex');
}

async function bybitExec(path: string, method = 'GET', params: Record<string, string | number | boolean | undefined> = {}, attempt = 0): Promise<unknown> {
  const MAX_ATTEMPTS = 3;
  const payload = method === 'GET' ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).reduce((a, [k, v]) => ({ ...a, [k]: String(v) }), {} as Record<string, string>)).toString() : JSON.stringify(params);
  const timestamp = Date.now().toString();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && secretKey) {
    Object.assign(headers, {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': sign(timestamp, payload),
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': '5000'
    });
  }
  const url = method === 'GET' && payload ? `${EXEC_BASE}${path}?${payload}` : `${EXEC_BASE}${path}`;
  const res = await fetchWithTimeout(url, { method, headers, body: method === 'POST' ? payload : undefined });
  health.execRequests++;
  const responseText = await res.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    health.execFailures++;
    // Render logs retain enough context to identify a proxy/WAF/upstream error,
    // while the client receives no credentials, response headers, or raw body.
    console.error(`[bybit] Invalid JSON from ${method} ${path}`, {
      status: res.status,
      contentType: res.headers.get('content-type'),
      preview: responseText.slice(0, 300)
    });
    // A non-JSON body (often an EMPTY body) alongside a 4xx/5xx status usually
    // means a proxy/WAF/gateway rejected the request before it reached Bybit's
    // API layer (e.g. transient edge issue) rather than Bybit returning a real
    // retCode error — retry a couple of times before giving up. Do NOT retry
    // POST order-placement calls, to avoid ever double-submitting an order.
    if (method === 'GET' && attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return bybitExec(path, method, params, attempt + 1);
    }
    throw new Error(`Bybit returned an invalid response (HTTP ${res.status})`);
  }
  if (!res.ok || data.retCode !== 0) { health.execFailures++; throw new Error(data.retMsg || `Bybit HTTP ${res.status}`); }
  return data.result;
}

// FIX #5: Public candles ALWAYS from Mainnet — never from the testnet execution URL.
// Added a small retry with backoff so a transient failure (proxy hiccup, brief
// rate limit) doesn't immediately fall back to stale cached candles.
async function fetchPublicCandles(symbol: string, attempt = 0): Promise<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }[]> {
  const MAX_ATTEMPTS = 3;
  const url = `${PUBLIC_BASE}/v5/market/kline?category=spot&symbol=${symbol}&interval=${klineInterval}&limit=100`;
  try {
    const res = await fetchWithTimeout(url);
    health.publicRequests++;
    if (!res.ok) throw new Error(`kline HTTP ${res.status}`);
    const data = await res.json() as { retCode: number; result?: { list?: [string, string, string, string, string, string][] } };
    if (data.retCode !== 0 || !data.result?.list?.length) throw new Error('no kline data');
    return [...data.result.list].reverse().map(a => ({
      timestamp: Number(a[0]),
      open: Number(a[1]), high: Number(a[2]), low: Number(a[3]), close: Number(a[4]), volume: Number(a[5])
    }));
  } catch (e) {
    health.publicFailures++;
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return fetchPublicCandles(symbol, attempt + 1);
    }
    throw e;
  }
}

// Account context (Testnet/Live only). Simulation never reaches here.
async function getAccountContext(): Promise<{ available: number; total: number; openFutures: { symbol: string; size: string; leverage: string; entryPrice: string; side?: string }[]; openFuturesCount: number } | null> {
  if (!apiKey || !secretKey) return null;
  const wallet = await bybitExec('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' }) as { list?: { totalEquity?: string; totalWalletBalance?: string; coin?: { coin: string; availableBalance: string }[] }[] };
  const account = wallet?.list?.[0] || {};
  const total = Number(account.totalEquity || account.totalWalletBalance || 0);
  const usdt = account.coin?.find((c: { coin: string }) => c.coin === 'USDT');
  const available = Number(usdt?.availableBalance || 0);
  const positions = await bybitExec('/v5/position/list', 'GET', { category: 'linear', settleCoin: 'USDT' }) as { list?: { symbol: string; size: string; leverage: string; entryPrice: string; side?: string }[] };
  const openFutures = (positions?.list || []).filter((p: { size: string }) => parseFloat(p.size) > 0);
  return { available, total, openFutures, openFuturesCount: openFutures.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENCE — KV Store (Firestore in production, local file in dev)
// ═══════════════════════════════════════════════════════════════════════════

const store = createKVStore('bot-state', join(DATA_DIR, 'bot-state.json'));
const simStore = createKVStore('sim-state', join(DATA_DIR, 'sim-state.json'));
const configStore = createKVStore('config', join(DATA_DIR, 'config.json'));

// ── Shared Simulation Bot state ───────────────────────────────────────────────
// The simulation engine runs in exactly ONE browser (the "leader"); it pushes its
// full snapshot here so every other device (followers) views the SAME bot. This
// is the single source of truth that replaces per-device localStorage state.
const SIM_STATE_FILE = join(DATA_DIR, 'sim-state.json');
const SIM_LEADER_TIMEOUT_MS = 8000;
const DEFAULT_SIM_CONFIG = {
  riskLevel: 'medium' as const,
  initialAmount: 10000,
  stopLoss: 4.2,
  takeProfit: 3,
  maxPositions: 5,
  maxFuturesPositions: 2,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 3,
  minConfidenceOverride: 0,
  positionPercent: 10
};
const simState = {
  running: false,
  config: { ...DEFAULT_SIM_CONFIG } as typeof DEFAULT_SIM_CONFIG,
  snapshot: null as unknown | null,
  leaderId: null as string | null,
  leaderHeartbeat: 0,
  updatedAt: 0,
  epoch: 0
};

// The simulation engine now runs SERVER-SIDE (24/7, no browser required).
// It is the single source of truth; clients are pure viewers.
// Pass a getter (not the array) so it always reads the CURRENT `symbols` —
// refreshUniverseIfStale() reassigns that binding, and capturing it once here
// would freeze the sim engine on the boot-time universe.
const simEngine = createSimEngine(() => symbols);

async function hydrateSim() {
  const saved = await simStore.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  simState.running = typeof s.running === 'boolean' ? s.running : false;
  simState.config = { ...DEFAULT_SIM_CONFIG, ...(typeof s.config === 'object' && s.config !== null ? s.config as Record<string, unknown> : {}) };
  simState.snapshot = s.snapshot ?? null;
  simState.leaderId = typeof s.leaderId === 'string' ? s.leaderId : null;
  simState.leaderHeartbeat = typeof s.leaderHeartbeat === 'number' ? s.leaderHeartbeat : 0;
  simState.updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : 0;
  simState.epoch = typeof s.epoch === 'number' ? s.epoch : 0;
}

async function persistSim() {
  await simStore.set('state', JSON.stringify({
    running: simState.running,
    config: simState.config,
    snapshot: simState.snapshot,
    leaderId: simState.leaderId,
    leaderHeartbeat: simState.leaderHeartbeat,
    updatedAt: simState.updatedAt,
    epoch: simState.epoch
  }));
}

function serializeState(): string {
  return JSON.stringify({
    running: state.running,
    lastScanAt: state.lastScanAt,
    lastError: state.lastError,
    scans: state.scans,
    startedAt: state.startedAt,
    decisions: state.decisions,
    orders: state.orders,
    openedSymbols: Object.fromEntries(state.openedSymbols),
    skippedSymbols: state.skippedSymbols,
    pendingLimitOrders: Object.fromEntries(state.pendingLimitOrders),
    health
  });
}

async function hydrate(): Promise<void> {
  const saved = await store.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  state.running = typeof s.running === 'boolean' ? s.running : state.running;
  state.lastScanAt = typeof s.lastScanAt === 'string' ? s.lastScanAt : null;
  state.lastError = typeof s.lastError === 'string' ? s.lastError : null;
  state.scans = typeof s.scans === 'number' ? s.scans : 0;
  state.startedAt = typeof s.startedAt === 'string' ? s.startedAt : state.startedAt;
  state.decisions = Array.isArray(s.decisions) ? s.decisions as ScanResult[] : [];
  state.orders = Array.isArray(s.orders) ? s.orders as { at: string; dryRun: boolean; symbol: string; side: string; reason?: string; error?: string; result?: unknown }[] : [];
  const savedOpened = s.openedSymbols;
  if (Array.isArray(savedOpened)) {
    state.openedSymbols = new Map(savedOpened.map((symbol) => [symbol, { at: Date.now(), type: 'SPOT' }]));
  } else if (savedOpened && typeof savedOpened === 'object') {
    state.openedSymbols = new Map(Object.entries(savedOpened as Record<string, { at: number; type: 'SPOT' | 'FUTURES' }>));
  } else {
    state.openedSymbols = new Map();
  }
  state.skippedSymbols = Array.isArray(s.skippedSymbols) ? s.skippedSymbols as { symbol: string; reason: string }[] : [];
  // Restore pending limit orders (if any survived a restart)
  const savedPending = s.pendingLimitOrders;
  if (savedPending && typeof savedPending === 'object') {
    state.pendingLimitOrders = new Map(
      Object.entries(savedPending as Record<string, { orderId: string; symbol: string; placedAt: number; expiresAt: number }>)
    );
  } else {
    state.pendingLimitOrders = new Map();
  }
  health.lastScanAt = typeof (s.health as Record<string, unknown> | undefined)?.lastScanAt === 'string' ? (s.health as Record<string, unknown> | undefined)?.lastScanAt as string : null;
}

// ── Warm market-data cache (Firestore in prod / local file in dev) ──────────────
// The in-memory timeframe cache in marketDataService is the hot path. On boot we
// hydrate it from the KV store so a restart/deploy doesn't re-pull every full
// window; afterwards we only delta-fetch what changed. Persistence is THROTTLED
// (not per-scan) and split per-symbol so each document stays well under the
// Firestore 1MB limit while still carrying enough history (minCandles) to let the
// first post-restart scan evaluate immediately instead of doing a full refetch.
const MARKET_CACHE_PERSIST_MS = 10 * 60 * 1000; // 10 min
let lastCachePersistAt = 0;

async function hydrateMarketCache(): Promise<void> {
  for (const sym of symbols) {
    const bybitSym = toBybitSymbol(sym);
    try {
      const saved = await store.get(`mcache:${bybitSym}`);
      if (!saved) continue;
      const doc = JSON.parse(saved) as Record<string, TimeframeCacheEntry>;
      for (const tf of TIMEFRAME_ORDER) {
        const entry = doc[tf];
        if (entry && Array.isArray(entry.candles) && entry.candles.length && typeof entry.lastTimestamp === 'number') {
          importMarketDataCache({ [`${bybitSym}:${tf}`]: entry });
        }
      }
    } catch {
      /* corrupt warm cache is non-fatal — fall back to a cold fetch */
    }
  }
}

async function persistMarketCache(): Promise<void> {
  const now = Date.now();
  if (now - lastCachePersistAt < MARKET_CACHE_PERSIST_MS) return;
  lastCachePersistAt = now;
  const full = exportMarketDataCache();
  try {
    for (const sym of symbols) {
      const bybitSym = toBybitSymbol(sym);
      const doc: Record<string, TimeframeCacheEntry> = {};
      for (const tf of TIMEFRAME_ORDER) {
        const entry = full[`${bybitSym}:${tf}`];
        if (entry) {
          // Trim to minCandles so each per-symbol document stays under the 1MB limit.
          doc[tf] = { ...entry, candles: entry.candles.slice(-TIMEFRAME_SPECS[tf].minCandles) };
        }
      }
      if (Object.keys(doc).length) await store.set(`mcache:${bybitSym}`, JSON.stringify(doc));
    }
  } catch {
    /* never block a scan on cache persistence */
  }
}

// Live Fear & Greed index (0-100). Falls back to neutral 50 on any failure so
// the scan never blocks on an external sentiment source.
async function fetchFearGreed(): Promise<number> {
  try {
    const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', { method: 'GET' });
    if (!res.ok) return 50;
    const data = await res.json() as { data?: { value?: string }[] };
    const v = Number(data?.data?.[0]?.value);
    return isFinite(v) ? v : 50;
  } catch {
    return 50;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCAN + EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

// How long a Limit Order is kept alive before auto-cancellation.
const LIMIT_ORDER_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ── Spot lot-size rounding ───────────────────────────────────────────────────
// Bybit rejects a Spot order whose qty doesn't match the symbol's own step
// size (basePrecision) or falls below its minOrderQty — both vary per symbol
// (e.g. BTC allows 6 decimals, some low-price alts allow none at all). This
// used to be unhandled entirely, so Spot SELL (closing a long) was hard-
// blocked rather than risk a rejected order — eliminating an entire class of
// trades. Cached per symbol (lot sizes change rarely) with a 6h TTL.
interface LotSizeInfo { basePrecision: number; minOrderQty: number }
const lotSizeCache = new Map<string, { info: LotSizeInfo; at: number }>();
const LOT_SIZE_TTL_MS = 6 * 60 * 60 * 1000;

async function getSpotLotSize(symbol: string): Promise<LotSizeInfo | null> {
  const cached = lotSizeCache.get(symbol);
  if (cached && Date.now() - cached.at < LOT_SIZE_TTL_MS) return cached.info;
  try {
    const res = await fetchWithTimeout(`${PUBLIC_BASE}/v5/market/instruments-info?category=spot&symbol=${symbol}`);
    health.publicRequests++;
    if (!res.ok) throw new Error(`instruments-info HTTP ${res.status}`);
    const data = await res.json() as {
      retCode: number;
      result?: { list?: { lotSizeFilter?: { basePrecision?: string; minOrderQty?: string } }[] };
    };
    const filter = data.result?.list?.[0]?.lotSizeFilter;
    if (data.retCode !== 0 || !filter?.basePrecision) throw new Error('no lotSizeFilter');
    const info: LotSizeInfo = {
      basePrecision: Number(filter.basePrecision),
      minOrderQty: Number(filter.minOrderQty ?? filter.basePrecision)
    };
    lotSizeCache.set(symbol, { info, at: Date.now() });
    return info;
  } catch (e) {
    health.publicFailures++;
    console.warn(`[lot-size] ${symbol} fetch failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Rounds DOWN to the symbol's step size so the order never exceeds the intended budget, and returns null if that rounds below the exchange minimum. */
function roundToLotSize(qty: number, lot: LotSizeInfo): number | null {
  const stepDecimals = Math.max(0, -Math.floor(Math.log10(lot.basePrecision)));
  const stepped = Math.floor(qty / lot.basePrecision) * lot.basePrecision;
  const rounded = Number(stepped.toFixed(stepDecimals));
  return rounded >= lot.minOrderQty ? rounded : null;
}

async function executeOrder(d: IntradayDecision, ctx: { available: number } | null, runningTotals: { totalOpen: number; futuresOpen: number }): Promise<{ opened: boolean; skipped?: string }> {
  const { symbol, direction, tradeType, risk } = d;

  if (!risk || !risk.approved) {
    return { opened: false, skipped: 'נפסל על ידי מנוע הסיכון' };
  }

  // Lot-size rounding (getSpotLotSize/roundToLotSize above) is now implemented
  // and ready to use, but the block below is intentionally NOT removed yet —
  // see the reasoning left for the user in chat. Spot has no margin/borrow, so
  // a "sell" only makes sense against a position this bot already holds, and
  // nothing here currently verifies the held balance before attempting one;
  // lot-size rounding alone doesn't make that safe.
  if (tradeType === 'SPOT' && direction === 'SHORT') {
    if (dryRun) {
      state.orders.unshift({ at: new Date().toISOString(), dryRun: true, symbol, side: 'SELL', reason: 'Spot SELL מושבת (אין אימות יתרה מוחזקת) — dry-run only' });
      return { opened: false };
    }
    return { opened: false, skipped: 'live spot SELL disabled — no held-balance verification yet' };
  }

  const side = direction === 'LONG' ? 'LONG' : 'SHORT';
  const limitEntryPrice = d.entry?.entryPrice ?? risk.stopLoss;

  const budget = Math.max(5, (ctx?.available ?? 0) * (positionPercent / 100));
  if (budget < 5) return { opened: false, skipped: 'יתרה לא מספיקה' };

  const qty = risk.quantity;
  if (!(qty > 0) || !isFinite(qty)) return { opened: false, skipped: 'כמות לא חוקית' };

  const leverage = risk.leverage;
  const formattedLimitPrice = limitEntryPrice.toFixed(8).replace(/\.?0+$/, '').slice(0, 20);
  const order = tradeType === 'FUTURES'
    ? {
        category: 'linear', symbol,
        side: side === 'LONG' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        price: formattedLimitPrice,
        timeInForce: 'GTC',
        qty: qty.toFixed(4),
        stopLoss: risk.stopLoss.toString(),
        takeProfit: risk.takeProfit1?.toString(),
        tpslMode: 'Partial',
        tpOrderType: 'Market',
        slOrderType: 'Market',
        leverage: String(leverage)
      }
    : {
        category: 'spot', symbol,
        side: 'Buy',
        orderType: 'Limit',
        price: formattedLimitPrice,
        timeInForce: 'GTC',
        qty: qty.toFixed(4)
      };

  const entryReason = `${d.setupType} ${direction} | ${d.summary}`;

  if (dryRun) {
    state.orders.unshift({ at: new Date().toISOString(), dryRun: true, ...order, reason: entryReason });
    return { opened: true };
  }
  try {
    if (tradeType === 'FUTURES') {
      await bybitExec('/v5/position/set-leverage', 'POST', { category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) });
    }
    const result = await bybitExec('/v5/order/create', 'POST', order) as { orderId?: string };
    const orderId = result?.orderId || '';
    state.orders.unshift({ at: new Date().toISOString(), dryRun: false, ...order, result });

    if (orderId) {
      const placedAt = Date.now();
      state.pendingLimitOrders.set(symbol, {
        orderId,
        symbol,
        placedAt,
        expiresAt: placedAt + LIMIT_ORDER_TTL_MS
      });
    }
    return { opened: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    state.orders.unshift({ at: new Date().toISOString(), dryRun: false, error: msg, symbol, side });
    return { opened: false, skipped: msg };
  }
}

interface ScanResult {
  symbol: string;
  action: 'HOLD' | 'SPOT' | 'FUTURES';
  side: string;
  confidence: number;
  reason: string;
  currentPrice: number;
  decision: IntradayDecision;
  skipped?: string;
}

let scanInProgress = false;
async function scan(): Promise<void> {
  if (!state.running || scanInProgress) return;
  scanInProgress = true;
  try {
    if (!apiKey || !secretKey) throw new Error('Missing BYBIT_API_KEY / BYBIT_SECRET_KEY (server-only)');
    // Account/auth failures (e.g. Bybit 401, IP-restriction rejection, transient
    // network error) must NOT abort the whole scan — every symbol would otherwise
    // go unevaluated for the entire cycle on a single account-endpoint hiccup.
    // Degrade to ctx=null (already handled via `ctx ? ... : ...` everywhere below)
    // and keep evaluating symbols off public market data.
    let ctx: Awaited<ReturnType<typeof getAccountContext>> = null;
    try {
      ctx = await getAccountContext();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scan] getAccountContext failed, continuing with ctx=null: ${msg}`);
      state.lastError = `Account context unavailable: ${msg}`;
    }
    const decisions: ScanResult[] = [];
    const scannedThisRun = new Set();
    state.skippedSymbols = [...unsupportedSymbols]; // reset to config-time unsupported each scan
    const runningTotals = { totalOpen: ctx ? ctx.openFuturesCount : 0, futuresOpen: ctx ? ctx.openFuturesCount : 0 };
    const fearGreed = await fetchFearGreed();

    const now = Date.now();

    // ── TTL: cancel stale Limit Orders that were never filled ──────────────────
    // If the price didn't reach our limit within LIMIT_ORDER_TTL_MS, cancel the
    // order on Bybit and remove the re-entry block so the next scan can try again.
    if (!dryRun) {
      for (const [sym, pending] of state.pendingLimitOrders) {
        if (now >= pending.expiresAt) {
          try {
            // Attempt to cancel on Bybit; ignore errors (order may already be filled/cancelled)
            const category = ctx?.openFutures.some(p => p.symbol === sym) ? 'linear' : 'spot';
            await bybitExec('/v5/order/cancel', 'POST', { category, symbol: sym, orderId: pending.orderId });
            console.log(`[TTL] Cancelled expired limit order ${pending.orderId} for ${sym}`);
          } catch {
            // Silently ignore — order may have already been filled or rejected
          }
          state.pendingLimitOrders.delete(sym);
          // Release the re-entry block so the bot can re-evaluate next scan
          state.openedSymbols.delete(sym);
          state.orders.unshift({
            at: new Date().toISOString(),
            dryRun: false,
            symbol: sym,
            side: 'N/A',
            reason: `[TTL] פקודת Limit בוטלה אחרי ${LIMIT_ORDER_TTL_MS / 3600000}h ללא מילוי (orderId: ${pending.orderId})`
          });
        }
      }
    }

    // FIX #1: expire re-entry blocks instead of holding them forever.
    // - FUTURES: verified directly against the exchange's open positions.
    // - SPOT: no equivalent "position list" here, so we release the block
    //   after REENTRY_COOLDOWN_MS as a best-effort cooldown.
    for (const [sym, meta] of state.openedSymbols) {
      if (meta.type === 'FUTURES') {
        const stillOpen = ctx ? ctx.openFutures.some(p => p.symbol === sym) : true;
        if (!stillOpen) state.openedSymbols.delete(sym);
      } else if (now - meta.at > REENTRY_COOLDOWN_MS) {
        state.openedSymbols.delete(sym);
      }
    }

    for (let i = 0; i < symbols.length; i += scanConcurrency) {
      const batch = symbols.slice(i, i + scanConcurrency);
      const results = await Promise.all(batch.map(async (symbol): Promise<ScanResult> => {
        try {
          const snap = await getMultiTimeframeData(symbol, { log: true });
          if (snap.status !== 'READY') {
            state.skippedSymbols.push({ symbol, reason: `אין נתונים MTF (${snap.reason ?? 'NOT_READY'})` });
            return { symbol, action: 'HOLD', side: 'NONE', confidence: 0, reason: 'אין נתונים MTF', currentPrice: snap.livePrice, decision: null as unknown as IntradayDecision, skipped: undefined };
          }
          const currentPrice = snap.liquidity?.lastPrice || snap.m5[snap.m5.length - 1]?.close || 0;

          const openPositions = [
            ...[...state.openedSymbols.entries()].map(([s, m]) => ({ symbol: s, type: m.type as TradeType })),
            ...(ctx ? ctx.openFutures.map((p) => ({ symbol: p.symbol, type: 'FUTURES' as TradeType })) : [])
          ];
          const portfolio = buildPortfolioRiskStats({
            portfolioValue: ctx?.available ?? 0,
            initialAmount: ctx?.available ?? 0,
            dailyDrawdownPercent: 0,
            weeklyDrawdownPercent: 0,
            openPositionsCount: runningTotals.totalOpen,
            openFuturesPositionsCount: runningTotals.futuresOpen,
            totalLeveragedExposureUsd: 0
          });

          const decision = evaluateIntradayDecision({
            symbol: snap.symbol,
            h1: snap.h1,
            m15: snap.m15,
            m5: snap.m5,
            spreadPercent: snap.liquidity?.spreadPercent ?? 0,
            quoteVolume24h: snap.liquidity?.quoteVolume24h ?? 0,
            quoteVolume24hSpot: snap.liquidity?.quoteVolume24hSpot ?? 0,
            livePrice: currentPrice,
            portfolio,
            openPositions
          });

          const action = decision.outcome === 'SIGNAL' ? (decision.tradeType as 'SPOT' | 'FUTURES') : 'HOLD';
          const side = decision.direction === 'LONG' ? 'LONG' : decision.direction === 'SHORT' ? 'SHORT' : 'NONE';
          const confidence = decision.outcome === 'SIGNAL' ? Math.round((decision.metrics.setupScore + decision.metrics.entryScore) / 2) : 0;
          return { symbol, action, side, confidence, reason: decision.summary, currentPrice, decision, skipped: undefined };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          state.skippedSymbols.push({ symbol, reason: `שגיאה בסריקה: ${msg}` });
          return { symbol, action: 'HOLD', side: 'NONE', confidence: 0, reason: `שגיאה: ${msg}`, currentPrice: 0, decision: null as unknown as IntradayDecision, skipped: undefined };
        }
      }));

      for (const d of results) {
        decisions.push(d);
        if (d.action === 'HOLD') continue;
        if (scannedThisRun.has(d.symbol)) continue; // idempotency within scan
        if (state.openedSymbols.has(d.symbol)) continue; // idempotency across restarts (now with expiry, see above)
        if (runningTotals.totalOpen >= maxOpenPositions) { d.skipped = 'הגעה למקסימום פוזיציות'; continue; }
        const res = await executeOrder(d.decision, ctx, runningTotals);
        if (res.opened) {
          runningTotals.totalOpen++;
          if (d.action === 'FUTURES') runningTotals.futuresOpen++;
          state.openedSymbols.set(d.symbol, { at: Date.now(), type: d.action as 'SPOT' | 'FUTURES' });
          scannedThisRun.add(d.symbol);
          // Send Telegram order notification
          const risk = d.decision.risk;
          const sideLabel = d.decision.direction === 'LONG' ? 'LONG' : 'SHORT';
          const entryPrice = d.decision.entry?.entryPrice ?? risk?.stopLoss;
          const tp1 = risk?.takeProfit1;
          const sl = risk?.stopLoss;
          const leverage = risk?.leverage;
          const qty = risk?.quantity;
          const msg = `📈 אות מסחר\n\nסמל: ${d.decision.symbol}\nכיוון: ${sideLabel}\nמהלך: ${d.decision.summary}\nמחיר כניסה: ${entryPrice.toFixed(4)}\nTP1: ${tp1?.toFixed(4) ?? 'N/A'}\nSL: ${sl?.toFixed(4) ?? 'N/A'}\nמינוף: ${leverage ?? '1x'}\nכמות: ${qty ?? 0}\nזמן: ${new Date().toLocaleTimeString()}`;
          await sendTelegramOrder(msg);
        } else if (res.skipped) {
          d.skipped = res.skipped;
        }
      }
    }

    state.decisions = decisions;
    state.lastScanAt = new Date().toISOString();
    state.lastError = null;
    lastAlertedError = null;
    state.scans++;
    health.lastScanAt = state.lastScanAt;
    state.orders = state.orders.slice(0, 50);
    await store.set('state', serializeState());
    await persistMarketCache();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown scan error';
    state.lastError = errorMessage;
    await store.set('state', serializeState());
    await persistMarketCache();
    void sendTelegramAlert(errorMessage);
  } finally {
    scanInProgress = false;
  }
}

// Sanitized account summary — never includes secrets, signatures, or auth headers.
async function getAccountSummary(): Promise<{ availableUsdt: number; totalUsdt: number; openFuturesCount: number; positions: { symbol: string; side: string; size: number; leverage: number; entryPrice: number }[] } | null> {
  if (!apiKey || !secretKey) return null;
  const ctx = await getAccountContext();
  if (!ctx) return null;
  return {
    availableUsdt: Number(ctx.available.toFixed(2)),
    totalUsdt: Number(ctx.total.toFixed(2)),
    openFuturesCount: ctx.openFuturesCount,
    positions: ctx.openFutures.map(p => ({
      symbol: p.symbol,
      side: p.side || 'NONE',
      size: parseFloat(p.size),
      leverage: parseFloat(p.leverage || '0'),
      entryPrice: parseFloat(p.entryPrice || '0')
    }))
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP SERVER — public /health + authenticated bot control
// CORS restricted to CORS_ORIGIN; basic per-IP rate limiting; request timeout.
// ═══════════════════════════════════════════════════════════════════════════

interface BotRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  on(event: string, handler: (chunk?: string | Buffer) => void): void;
  destroy(): void;
}

interface BotResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  setHeader(name: string, value: string): void;
}

createServer(async (req: BotRequest, res: BotResponse) => {
  setCors(req, res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true, testnet, dryRun, mode: testnet ? 'testnet' : 'live',
      publicBase: PUBLIC_BASE, execBase: EXEC_BASE,
      configured: Boolean(apiKey && secretKey),
      running: state.running, lastScanAt: state.lastScanAt, lastError: state.lastError,
      symbols: symbols.length, skipped: state.skippedSymbols.length, health
    });
  }

  // Health is public and must remain available to Render probes.
  if (rateLimited(clientIp(req))) {
    return json(res, 429, { error: 'Too many requests' });
  }

  // Public (no admin token) — lets the simulation frontend mirror the SAME
  // liquidity-based universe the live bot trades, instead of a static list
  // that can drift out of date.
  if (req.method === 'GET' && url.pathname === '/api/public/universe') {
    return json(res, 200, { symbols, generatedAt: universeGeneratedAt });
  }

  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/sim/') && !url.pathname.startsWith('/api/public/') && !authorized(req)) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  if (req.method === 'GET' && url.pathname === '/api/bot/state') {
    return json(res, 200, {
      testnet, dryRun, mode: testnet ? 'testnet' : 'live',
      riskLevel, symbols, minConfidence, positionPercent, maxOpenPositions, scanConcurrency,
      ...state, openedSymbols: Object.fromEntries(state.openedSymbols), health
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/account/summary') {
    try {
      const summary = await getAccountSummary();
      if (!summary) return json(res, 503, { error: 'Account context unavailable (missing credentials or exchange error)' });
      return json(res, 200, summary);
    } catch (e: unknown) {
      return json(res, 502, { error: `Account summary failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/decisions') {
    // Decisions include rejection reasons; skippedSymbols lists unsupported/failed scans.
    return json(res, 200, {
      decisions: state.decisions,
      skippedSymbols: state.skippedSymbols,
      lastScanAt: state.lastScanAt,
      lastError: state.lastError
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/bot/start') {
    state.running = true;
    await store.set('state', serializeState());
    await scan();
    return json(res, 200, { ...state, openedSymbols: Object.fromEntries(state.openedSymbols), dryRun, testnet, health });
  }

  if (req.method === 'POST' && url.pathname === '/api/bot/stop') {
    state.running = false;
    await store.set('state', serializeState());
    return json(res, 200, { ...state, openedSymbols: Object.fromEntries(state.openedSymbols), dryRun, testnet, health });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED SIMULATION BOT — public, single shared bot for every viewer.
  // One browser (the leader) runs the engine and pushes snapshots here; all
  // other devices read the same state. No admin token required (it's a sim).
  // ═══════════════════════════════════════════════════════════════════════════

  if (req.method === 'GET' && url.pathname === '/api/sim/state') {
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/state') {
    // The engine now runs server-side and owns the snapshot. Clients are pure
    // viewers, so pushes are ignored (the server is the single source of truth).
    return json(res, 200, { ok: true, updatedAt: simState.updatedAt });
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/claim') {
    const body = await readJsonBody(req);
    const leaderId = typeof body?.leaderId === 'string' ? body.leaderId : null;
    if (!leaderId) return json(res, 400, { error: 'leaderId required' });
    const stale = !simState.leaderId || (Date.now() - simState.leaderHeartbeat) > SIM_LEADER_TIMEOUT_MS;
    if (stale) {
      simState.leaderId = leaderId;
      simState.leaderHeartbeat = Date.now();
      await persistSim();
      return json(res, 200, { claimed: true, leaderId });
    }
    return json(res, 200, { claimed: false, leaderId: simState.leaderId });
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/start') {
    simState.running = true;
    await persistSim();
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/stop') {
    simState.running = false;
    await persistSim();
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/reset') {
    simState.running = false;
    simEngine.reset(simState.config);
    simState.snapshot = simEngine.getSnapshot();
    simState.leaderId = null;
    simState.leaderHeartbeat = 0;
    simState.updatedAt = Date.now();
    simState.epoch = (simState.epoch || 0) + 1;
    await persistSim();
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/config') {
    const body = await readJsonBody(req);
    if (body && typeof body.config === 'object' && body.config !== null) {
      simState.config = { ...DEFAULT_SIM_CONFIG, ...simState.config, ...(body.config as Record<string, unknown>) };
    }
    await persistSim();
    return json(res, 200, simState);
  }

  return json(res, 404, { error: 'Not found' });
}).listen(port, async () => {
  await refreshUniverseIfStale();
  await hydrate();
  await hydrateMarketCache();
  await hydrateSim();
  if (simState.snapshot) simEngine.hydrate(simState.snapshot as SimSnapshot);
  console.log(`Trading worker listening on ${port} | mode=${testnet ? 'testnet' : 'live'} | dryRun=${dryRun} | symbols=${symbols.length} | risk=${riskLevel} | cors=${allowedOrigins.join(',') || '*'}`);
  if (state.running) void scan();
  setInterval(() => void scan(), intervalMs);
  setInterval(() => void refreshUniverseIfStale(), UNIVERSE_CHECK_INTERVAL_MS);

  // FIX #3: periodically drop rate-limit buckets for IPs with no recent hits,
  // so long-lived uptime on Render doesn't leak memory per distinct visitor IP.
  setInterval(pruneRateBuckets, RATE_LIMIT_WINDOW_MS);

  // Self-ping: keep a free-tier host (e.g. Render free) from sleeping after
  // inactivity. Pings the service's own /health every 12 minutes. Prefers the
  // platform-provided external URL so the request counts as inbound traffic;
  // falls back to loopback for local development.
  const SELF_PING_INTERVAL_MS = 12 * 60 * 1000;
  const selfBase = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '') || `http://127.0.0.1:${port}`;
  setInterval(async () => {
    try {
      const r = await fetchWithTimeout(`${selfBase}/health`, { method: 'GET' });
      if (!r.ok) console.warn(`[self-ping] /health responded ${r.status}`);
    } catch (e: unknown) {
      console.warn('[self-ping] failed:', e instanceof Error ? e.message : String(e));
    }
  }, SELF_PING_INTERVAL_MS);

  // Server-side simulation loop: advance the shared bot while it is running.
  let simTickInProgress = false;
  let cachedSimFearGreed = 50;
  let lastFgFetchAt = 0;
  setInterval(async () => {
    if (!simState.running || simTickInProgress) return;
    simTickInProgress = true;
    try {
      const now = Date.now();
      if (now - lastFgFetchAt > 15 * 60 * 1000) {
        cachedSimFearGreed = await fetchFearGreed();
        lastFgFetchAt = now;
      }
      const snap = await simEngine.tick(simState.config, cachedSimFearGreed);
      simState.snapshot = snap;
      simState.updatedAt = Date.now();
      await persistSim();
    } catch (e: unknown) {
      console.warn('[sim-engine] tick failed:', e instanceof Error ? e.message : String(e));
    } finally {
      simTickInProgress = false;
    }
  }, 4000);
});

// Graceful shutdown: flush bot state and the warm market-data cache (Firestore in
// prod) so the next boot can delta-fetch instead of re-pulling every full window.
async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} — flushing state and warm cache`);
  try { await store.set('state', serializeState()); } catch { /* ignore */ }
  lastCachePersistAt = 0; // bypass throttle so the final flush always writes
  try { await persistMarketCache(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
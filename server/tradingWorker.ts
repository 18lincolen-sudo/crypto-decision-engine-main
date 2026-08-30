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
import { createSimEngine, SimSnapshot } from './simEngine.ts';
// Server-side legacy simulation engine (original alg.md algorithm) — same
// server, same infra, only the decision logic differs (see legacySimEngine.ts).
import { createLegacySimEngine, LegacySimSnapshot } from './legacySimEngine.ts';
// Server-side "Bot Pro" — a literal, verified-faithful implementation of
// ASSETS/alg.md, independent from the (drifted) legacy engine above. Same
// server, same infra, only the decision logic differs (see proSimEngine.ts).
import { createProSimEngine, ProSimSnapshot } from './proSimEngine.ts';
// Core decision engine — single source of truth for Layers 0-3 (intraday MTF).
import { evaluateIntradayDecision, IntradayDecision, TradeType } from '../src/services/intradayEngine';
import { buildPortfolioRiskStats } from '../src/services/intradayBridge';
import { getMultiTimeframeData, exportMarketDataCache, importMarketDataCache, TIMEFRAME_SPECS, TIMEFRAME_ORDER, type TimeframeCacheEntry } from '../src/services/marketDataService';
import { toBybitSymbol } from '../src/services/assetUniverse';
import { TARGET_SYMBOLS } from '../src/shared/targetSymbols';
import { createKVStore } from './kvStore';
import { runBacktestSweep } from '../src/services/backtestRunner';

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
const positionPercent = boundedNumber('BOT_POSITION_PERCENT', 10, 0.1, 100);
const maxOpenPositions = Math.floor(boundedNumber('BOT_MAX_OPEN_POSITIONS', 5, 1, 100));
const scanConcurrency = Math.floor(boundedNumber('BOT_SCAN_CONCURRENCY', 5, 1, 20));
const intervalMs = boundedNumber('BOT_SCAN_INTERVAL_SECONDS', 300, 60, 3600) * 1000;
const REENTRY_COOLDOWN_MS = boundedNumber('BOT_REENTRY_COOLDOWN_HOURS', 24, 1, 720) * 3600 * 1000;

// CORS: restrict to configured frontend origins. Comma-separated, or '*' to allow any.
const corsOriginEnv = process.env.CORS_ORIGIN || '';
const allowedOrigins = corsOriginEnv.split(',').map(s => s.trim()).filter(Boolean);
// Basic rate limiting: per-IP window.
const RATE_LIMIT_MAX = Math.floor(boundedNumber('BOT_RATE_LIMIT_MAX', 120, 1, 10000));
const RATE_LIMIT_WINDOW_MS = boundedNumber('BOT_RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000);
const REQUEST_TIMEOUT_MS = boundedNumber('BOT_REQUEST_TIMEOUT_MS', 15000, 1000, 120000);
// Engine versions — bumped when the decision algorithm changes.
// The frontend can use this to warn if the displayed sim/backtest
// results were produced by a different algorithm than the current one.
export const ENGINE_VERSIONS = {
  intraday: '1.0.0',
  legacy: '1.0.0',
  pro: '1.0.0',
  backtest: '1.0.0',
} as const;


// ── HTTP helpers: CORS, rate limiting, timeouts ────────────────────────────
function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const rateBuckets = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

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

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let lastAlertedError: string | null = null;

async function sendTelegramOrder(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) {
    console.warn('[telegram] not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID) — order notification dropped');
    return;
  }
  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[telegram] sendMessage failed (order): HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.warn('[telegram] sendMessage threw (order):', e instanceof Error ? e.message : String(e));
  }
}
async function sendTelegramAlert(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;
  if (lastAlertedError === message) return;
  lastAlertedError = message;
  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: `🚨 Crypto Bot Error\n\n${message}` })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[telegram] sendMessage failed (alert): HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.warn('[telegram] sendMessage threw (alert):', e instanceof Error ? e.message : String(e));
  }
}

const PUBLIC_BASE = 'https://api.bybit.com';
const EXEC_BASE = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

const klineInterval = process.env.BOT_KLINE_INTERVAL || '240';

const botSymbolsRaw = process.env.BOT_SYMBOLS?.trim();
const isExplicitSymbolOverride = Boolean(botSymbolsRaw && botSymbolsRaw !== '100');
const rawSymbols = (isExplicitSymbolOverride
  ? botSymbolsRaw!.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : TARGET_SYMBOLS
);
const unsupportedSymbols = rawSymbols.filter(s => !s.endsWith('USDT')).map(s => ({ symbol: s, reason: 'לא מסתיים ב-USDT (לא נתמך)' }));
let symbols = [...new Set(rawSymbols.filter(s => s.endsWith('USDT')))];

const UNIVERSE_STALE_MS = 24 * 60 * 60 * 1000;
const UNIVERSE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

    const { computeLiquidUniverse } = await import('../src/services/symbolUniverse');
    const fresh = await computeLiquidUniverse();
    if (!fresh.symbols.length) return;
    symbols = fresh.symbols;
    universeGeneratedAt = fresh.generatedAt;
    await configStore.set('targetSymbols', JSON.stringify({ symbols: fresh.symbols, generatedAt: fresh.generatedAt }));
    console.log(`[universe] refreshed: ${fresh.liquid.length} liquid + ${fresh.close.length} close = ${fresh.symbols.length} symbols`);
  } catch (e) {
    console.warn('[universe] refresh failed, keeping current symbol list:', e instanceof Error ? e.message : String(e));
  }
}

const health = { publicRequests: 0, publicFailures: 0, execRequests: 0, execFailures: 0, lastScanAt: null as string | null };

const state = {
  running: autostart,
  lastScanAt: null as string | null,
  lastError: null as string | null,
  scans: 0,
  startedAt: new Date().toISOString(),
  decisions: [] as ScanResult[],
  orders: [] as { at: string; dryRun: boolean; symbol: string; side: string; reason?: string; error?: string; result?: unknown }[],
  openedSymbols: new Map<string, { at: number; type: 'SPOT' | 'FUTURES'; reason?: string; confidence?: number }>(),
  skippedSymbols: [...unsupportedSymbols] as { symbol: string; reason: string }[],
  realizedPnlTotal: 0,
  pendingLimitOrders: new Map<string, { orderId: string; symbol: string; placedAt: number; expiresAt: number }>(),
  spotHoldings: new Map<string, { entryPrice: number; qty: number; at: number; reason?: string; confidence?: number }>(),
  engineVersion: ENGINE_VERSIONS.intraday
};

function json(res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

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

function authorized(req: { headers: { authorization?: string } }): boolean {
  if (!adminToken) return false;
  const header = req.headers.authorization || '';
  const expected = `Bearer ${adminToken}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
    console.error(`[bybit] Invalid JSON from ${method} ${path}`, {
      status: res.status,
      contentType: res.headers.get('content-type'),
      preview: responseText.slice(0, 300)
    });
    if (method === 'GET' && attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return bybitExec(path, method, params, attempt + 1);
    }
    throw new Error(`Bybit returned an invalid response (HTTP ${res.status})`);
  }
  if (!res.ok || data.retCode !== 0) { health.execFailures++; throw new Error(data.retMsg || `Bybit HTTP ${res.status}`); }
  return data.result;
}

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

async function getAccountContext(): Promise<{ available: number; total: number; openFutures: { symbol: string; size: string; leverage: string; entryPrice: string; side?: string }[]; openFuturesCount: number; spotBalances: Record<string, number> } | null> {
  if (!apiKey || !secretKey) return null;
  const wallet = await bybitExec('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' }) as { list?: { totalEquity?: string; totalWalletBalance?: string; coin?: { coin: string; availableBalance: string; walletBalance: string }[] }[] };
  const account = wallet?.list?.[0] || {};
  const total = Number(account.totalEquity || account.totalWalletBalance || 0);
  const usdt = account.coin?.find((c: { coin: string }) => c.coin === 'USDT');
  const available = Number(usdt?.availableBalance || 0);
  const spotBalances: Record<string, number> = {};
  for (const c of account.coin || []) {
    if (c.coin === 'USDT') continue;
    spotBalances[c.coin] = Number(c.walletBalance || 0);
  }
  const positions = await bybitExec('/v5/position/list', 'GET', { category: 'linear', settleCoin: 'USDT' }) as { list?: { symbol: string; size: string; leverage: string; entryPrice: string; side?: string }[] };
  const openFutures = (positions?.list || []).filter((p: { size: string }) => parseFloat(p.size) > 0);
  return { available, total, openFutures, openFuturesCount: openFutures.length, spotBalances };
}

function baseCoin(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

async function getSpotFillSummary(symbol: string, side: 'Buy' | 'Sell', since: number): Promise<{ avgPrice: number; totalQty: number; totalFee: number } | null> {
  try {
    const res = await bybitExec('/v5/execution/list', 'GET', { category: 'spot', symbol, startTime: since, limit: 50 }) as { result?: { list?: { execPrice: string; execQty: string; execFee: string; side: string }[] } };
    const fills = (res?.result?.list ?? []).filter((e) => e.side === side);
    if (!fills.length) return null;
    const totalQty = fills.reduce((sum, f) => sum + Number(f.execQty || 0), 0);
    const totalFee = fills.reduce((sum, f) => sum + Number(f.execFee || 0), 0);
    if (totalQty <= 0) return null;
    const avgPrice = fills.reduce((sum, f) => sum + Number(f.execPrice || 0) * Number(f.execQty || 0), 0) / totalQty;
    return { avgPrice, totalQty, totalFee };
  } catch (e) {
    console.warn(`[spot-fills] ${symbol} ${side} lookup failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function confirmSpotEntries(ctx: Awaited<ReturnType<typeof getAccountContext>>): Promise<void> {
  if (dryRun || !ctx) return;
  for (const [sym, meta] of [...state.openedSymbols]) {
    if (meta.type !== 'SPOT' || state.spotHoldings.has(sym)) continue;
    const lot = await getSpotLotSize(sym);
    const balance = ctx.spotBalances[baseCoin(sym)] || 0;
    if (!lot || balance < lot.minOrderQty) continue;
    const fill = await getSpotFillSummary(sym, 'Buy', meta.at - 60_000);
    state.spotHoldings.set(sym, {
      entryPrice: fill?.avgPrice || 0,
      qty: balance,
      at: Date.now(),
      reason: meta.reason,
      confidence: meta.confidence
    });
  }
}

async function checkClosedSpotPositions(ctx: Awaited<ReturnType<typeof getAccountContext>>): Promise<void> {
  if (dryRun || !ctx) return;
  for (const [sym, holding] of [...state.spotHoldings]) {
    const lot = await getSpotLotSize(sym);
    const balance = ctx.spotBalances[baseCoin(sym)] || 0;
    if (lot && balance >= lot.minOrderQty) continue;
    state.spotHoldings.delete(sym);
    state.openedSymbols.delete(sym);
    const fill = await getSpotFillSummary(sym, 'Sell', holding.at - 60_000);
    if (!fill) continue;
    const totalPnl = (fill.avgPrice - holding.entryPrice) * fill.totalQty - fill.totalFee;
    const pnlPercent = holding.entryPrice > 0 ? ((fill.avgPrice - holding.entryPrice) / holding.entryPrice) * 100 : 0;
    state.realizedPnlTotal += totalPnl;
    const msg = `🤖 בוט מסחר אמיתי${dryRun ? ' (dry-run)' : ''}\n\n${totalPnl >= 0 ? '✅' : '🔴'} פוזיציה נסגרה (SPOT)\n\nסמל: ${sym}\nכיוון: LONG\nמחיר כניסה: ${holding.entryPrice.toFixed(4)}\nמחיר יציאה: ${fill.avgPrice.toFixed(4)}\nרווח/הפסד: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
      (holding.reason ? `סיבת כניסה: ${holding.reason}\n` : '') +
      `\n📊 מצב כולל של הבוט\nרווח מצטבר מאז ההפעלה: ${state.realizedPnlTotal >= 0 ? '+' : ''}$${state.realizedPnlTotal.toFixed(2)}\nיתרת חשבון כוללת: $${ctx.total.toFixed(2)}\nזמן: ${new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;
    await sendTelegramOrder(msg);
  }
}

async function checkClosedFuturesPositions(ctx: Awaited<ReturnType<typeof getAccountContext>>): Promise<void> {
  if (dryRun) return;
  if (!ctx) return;
  const stillOpenSymbols = new Set(ctx.openFutures.map((p) => p.symbol));
  for (const [sym, meta] of [...state.openedSymbols]) {
    if (meta.type !== 'FUTURES' || stillOpenSymbols.has(sym)) continue;
    state.openedSymbols.delete(sym);
    try {
      const res = await bybitExec('/v5/position/closed-pnl', 'GET', { category: 'linear', symbol: sym, startTime: meta.at, limit: 50 }) as { result?: { list?: { closedPnl: string; avgEntryPrice: string; avgExitPrice: string; qty: string; side: string; leverage: string }[] } };
      const records = res?.result?.list ?? [];
      if (!records.length) continue;
      const totalPnl = records.reduce((sum, r) => sum + Number(r.closedPnl || 0), 0);
      const entryPrice = Number(records[records.length - 1]?.avgEntryPrice || 0);
      const exitPrice = Number(records[0]?.avgExitPrice || 0);
      const totalQty = records.reduce((sum, r) => sum + Number(r.qty || 0), 0);
      const side = records[0]?.side === 'Buy' ? 'LONG' : 'SHORT';
      const leverage = Number(records[0]?.leverage || 1);
      const marginUsed = leverage > 0 ? (totalQty * entryPrice) / leverage : 0;
      const pnlPercent = marginUsed > 0 ? (totalPnl / marginUsed) * 100 : 0;
      state.realizedPnlTotal += totalPnl;
      const msg = `🤖 בוט מסחר אמיתי${dryRun ? ' (dry-run)' : ''}\n\n${totalPnl >= 0 ? '✅' : '🔴'} פוזיציה נסגרה\n\nסמל: ${sym}\nכיוון: ${side} (${leverage}x)\nמחיר כניסה: ${entryPrice.toFixed(4)}\nמחיר יציאה: ${exitPrice.toFixed(4)}\nרווח/הפסד: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
        (meta.reason ? `סיבת כניסה: ${meta.reason}\n` : '') +
        `\n📊 מצב כולל של הבוט\nרווח מצטבר מאז ההפעלה: ${state.realizedPnlTotal >= 0 ? '+' : ''}$${state.realizedPnlTotal.toFixed(2)}\nיתרת חשבון כוללת: $${ctx.total.toFixed(2)}\nפוזיציות פתוחות: ${ctx.openFuturesCount}\nזמן: ${new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;
      await sendTelegramOrder(msg);
    } catch (e) {
      console.warn(`[exit-notify] closed-pnl lookup failed for ${sym}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

// Engine versions — bumped when the decision algorithm changes.

const store = createKVStore('bot-state', join(DATA_DIR, 'bot-state.json'));
const simStore = createKVStore('sim-state', join(DATA_DIR, 'sim-state.json'));
const legacySimStore = createKVStore('legacy-sim-state', join(DATA_DIR, 'legacy-sim-state.json'));
const proSimStore = createKVStore('pro-sim-state', join(DATA_DIR, 'pro-sim-state.json'));
const configStore = createKVStore('config', join(DATA_DIR, 'config.json'));
const backtestStore = createKVStore('backtest-results', join(DATA_DIR, 'backtest-results.json'));

const SIM_STATE_FILE = join(DATA_DIR, 'sim-state.json');
const SIM_LEADER_TIMEOUT_MS = 8000;

// Fixed max positions: 7 for all bots (regardless of initial amount)
function calcMaxPositions(_initialAmount: number): number {
  return 7;
}

/** Sanitize a sim config loaded from an external source.
 *  minConfidenceOverride: 0 is treated as "not set" because the ?? operator
 *  would otherwise pass 0 through and fully disable the confidence floor. */
function sanitizeSimConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  if (cfg.minConfidenceOverride !== undefined && (cfg.minConfidenceOverride as number) < 1) {
    cfg.minConfidenceOverride = undefined;
  }
  return cfg;
}

const DEFAULT_SIM_CONFIG = {
  riskLevel: 'medium' as const, initialAmount: 10000, stopLoss: 4.2, takeProfit: 3,
  maxPositions: 7, maxFuturesPositions: 2, feePercent: 0.1, slippagePercent: 0.05,
  executionDelaySec: 3, minConfidenceOverride: 52, positionPercent: 10
};
const simState = {
  running: false, config: { ...DEFAULT_SIM_CONFIG } as typeof DEFAULT_SIM_CONFIG,
  snapshot: null as unknown | null, leaderId: null as string | null,
  leaderHeartbeat: 0, updatedAt: 0, epoch: 0,
  engineVersion: ENGINE_VERSIONS.intraday
};

const simEngine = createSimEngine(() => symbols);

async function hydrateSim() {
  const saved = await simStore.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  simState.running = typeof s.running === 'boolean' ? s.running : false;
  simState.config = { ...DEFAULT_SIM_CONFIG, ...sanitizeSimConfig(typeof s.config === 'object' && s.config !== null ? { ...s.config as Record<string, unknown> } : {}) };
  simState.snapshot = s.snapshot ?? null;
  simState.leaderId = typeof s.leaderId === 'string' ? s.leaderId : null;
  simState.leaderHeartbeat = typeof s.leaderHeartbeat === 'number' ? s.leaderHeartbeat : 0;
  simState.updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : 0;
  simState.epoch = typeof s.epoch === 'number' ? s.epoch : 0;
  simState.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.intraday;
}

async function persistSim() {
  await simStore.set('state', JSON.stringify({
    running: simState.running, config: simState.config, snapshot: simState.snapshot,
    leaderId: simState.leaderId, leaderHeartbeat: simState.leaderHeartbeat,
    updatedAt: simState.updatedAt, epoch: simState.epoch,
    engineVersion: simState.engineVersion
  }));
}

const DEFAULT_LEGACY_SIM_CONFIG = {
  riskLevel: 'medium' as const, initialAmount: 10000, stopLoss: 4.2, takeProfit: 3,
  maxPositions: 7, maxFuturesPositions: 2, feePercent: 0.1, slippagePercent: 0.05,
  executionDelaySec: 3, minConfidenceOverride: 58, positionPercent: 10
};
const legacySimState = { running: false, config: { ...DEFAULT_LEGACY_SIM_CONFIG } as typeof DEFAULT_LEGACY_SIM_CONFIG, snapshot: null as unknown | null, updatedAt: 0, engineVersion: ENGINE_VERSIONS.legacy };

const legacySimEngine = createLegacySimEngine(() => symbols);

async function hydrateLegacySim() {
  const saved = await legacySimStore.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  legacySimState.running = typeof s.running === 'boolean' ? s.running : false;
  legacySimState.config = { ...DEFAULT_LEGACY_SIM_CONFIG, ...sanitizeSimConfig(typeof s.config === 'object' && s.config !== null ? { ...s.config as Record<string, unknown> } : {}) };
  legacySimState.snapshot = s.snapshot ?? null;
  legacySimState.updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : 0;
  legacySimState.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.legacy;
}

async function persistLegacySim() {
  await legacySimStore.set('state', JSON.stringify({
    running: legacySimState.running, config: legacySimState.config,
    snapshot: legacySimState.snapshot, updatedAt: legacySimState.updatedAt,
    engineVersion: legacySimState.engineVersion
  }));
}

const DEFAULT_PRO_SIM_CONFIG = {
  riskLevel: 'medium' as const, initialAmount: 10000, stopLoss: 4.2, takeProfit: 3,
  maxPositions: 7, maxFuturesPositions: 2, feePercent: 0.1, slippagePercent: 0.05,
  executionDelaySec: 3, minConfidenceOverride: 58, positionPercent: 10
};
const proSimState = { running: false, config: { ...DEFAULT_PRO_SIM_CONFIG } as typeof DEFAULT_PRO_SIM_CONFIG, snapshot: null as unknown | null, updatedAt: 0, engineVersion: ENGINE_VERSIONS.pro };

const proSimEngine = createProSimEngine(() => symbols);

async function hydrateProSim() {
  const saved = await proSimStore.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  proSimState.running = typeof s.running === 'boolean' ? s.running : false;
  proSimState.config = { ...DEFAULT_PRO_SIM_CONFIG, ...sanitizeSimConfig(typeof s.config === 'object' && s.config !== null ? { ...s.config as Record<string, unknown> } : {}) };
  proSimState.snapshot = s.snapshot ?? null;
  proSimState.updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : 0;
  proSimState.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.pro;
}

async function persistProSim() {
  await proSimStore.set('state', JSON.stringify({
    running: proSimState.running, config: proSimState.config,
    snapshot: proSimState.snapshot, updatedAt: proSimState.updatedAt,
    engineVersion: proSimState.engineVersion
  }));
}

// ── Backtest state ──────────────────────────────────────────────────────────
import type { SweepResult } from '../src/services/backtestRunner';

interface BacktestState {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: number | null;
  finishedAt: number | null;
  results: SweepResult[];
  error: string | null;
  engine: string | null;
  days: number | null;
  engineVersion: string;
}

const backtestState: BacktestState = {
  status: 'idle', startedAt: null, finishedAt: null, results: [], error: null, engine: null, days: null, engineVersion: '1.0.0'
};

async function hydrateBacktest(): Promise<void> {
  const saved = await backtestStore.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as BacktestState;
  backtestState.status = s.status ?? 'idle';
  backtestState.startedAt = s.startedAt ?? null;
  backtestState.finishedAt = s.finishedAt ?? null;
  backtestState.results = Array.isArray(s.results) ? s.results : [];
  backtestState.error = s.error ?? null;
  backtestState.engine = s.engine ?? null;
  backtestState.days = s.days ?? null;
  backtestState.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.backtest;
}

const BACKTEST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function persistBacktest(): Promise<void> {
  await backtestStore.set('state', JSON.stringify({
    ...backtestState,
    engineVersion: ENGINE_VERSIONS.backtest,
  }), BACKTEST_TTL_MS);
}

// Run backtest for both engines in background
async function runBacktestInBackground(): Promise<void> {
  const DAYS = 120;
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'AAVEUSDT'];
  try {
    // Run legacy first, then pro
    const legacyResults = await runBacktestSweep({
      engine: 'legacy', days: DAYS, symbols: SYMBOLS, concurrency: 4,
      onProgress: (msg) => console.log(`[backtest] legacy: ${msg}`),
    });
    const proResults = await runBacktestSweep({
      engine: 'pro', days: DAYS, symbols: SYMBOLS, concurrency: 4,
      onProgress: (msg) => console.log(`[backtest] pro: ${msg}`),
    });
    backtestState.status = 'done';
    backtestState.finishedAt = Date.now();
    backtestState.results = [...legacyResults, ...proResults];
    backtestState.engine = 'legacy+pro';
    backtestState.days = DAYS;
    backtestState.error = null;
  } catch (e: unknown) {
    backtestState.status = 'error';
    backtestState.finishedAt = Date.now();
    backtestState.error = e instanceof Error ? e.message : String(e);
  } finally {
    await persistBacktest();
  }
}

function serializeState(): string {
  return JSON.stringify({
    running: state.running, lastScanAt: state.lastScanAt, lastError: state.lastError,
    scans: state.scans, startedAt: state.startedAt, decisions: state.decisions,
    orders: state.orders, openedSymbols: Object.fromEntries(state.openedSymbols),
    skippedSymbols: state.skippedSymbols, pendingLimitOrders: Object.fromEntries(state.pendingLimitOrders),
    spotHoldings: Object.fromEntries(state.spotHoldings), realizedPnlTotal: state.realizedPnlTotal, health,
    engineVersion: state.engineVersion
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
    state.openedSymbols = new Map(Object.entries(savedOpened as Record<string, { at: number; type: 'SPOT' | 'FUTURES'; reason?: string; confidence?: number }>));
  } else {
    state.openedSymbols = new Map();
  }
  state.realizedPnlTotal = typeof s.realizedPnlTotal === 'number' ? s.realizedPnlTotal : 0;
  state.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.intraday;
  state.skippedSymbols = Array.isArray(s.skippedSymbols) ? s.skippedSymbols as { symbol: string; reason: string }[] : [];
  const savedPending = s.pendingLimitOrders;
  if (savedPending && typeof savedPending === 'object') {
    state.pendingLimitOrders = new Map(Object.entries(savedPending as Record<string, { orderId: string; symbol: string; placedAt: number; expiresAt: number }>));
  } else {
    state.pendingLimitOrders = new Map();
  }
  const savedSpotHoldings = s.spotHoldings;
  if (savedSpotHoldings && typeof savedSpotHoldings === 'object') {
    state.spotHoldings = new Map(Object.entries(savedSpotHoldings as Record<string, { entryPrice: number; qty: number; at: number; reason?: string; confidence?: number }>));
  } else {
    state.spotHoldings = new Map();
  }
  health.lastScanAt = typeof (s.health as Record<string, unknown> | undefined)?.lastScanAt === 'string' ? (s.health as Record<string, unknown> | undefined)?.lastScanAt as string : null;
}

const MARKET_CACHE_PERSIST_MS = 10 * 60 * 1000;
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
    } catch { /* corrupt warm cache is non-fatal */ }
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
          doc[tf] = { ...entry, candles: entry.candles.slice(-TIMEFRAME_SPECS[tf].minCandles) };
        }
      }
      if (Object.keys(doc).length) await store.set(`mcache:${bybitSym}`, JSON.stringify(doc));
    }
  } catch { /* never block a scan on cache persistence */ }
}

interface FearGreedReading {
  value: number;
  value_classification: string;
  timestamp: string;
  at: number;
}
const FEAR_GREED_TTL_MS = 15 * 60 * 1000;
let fearGreedCache: FearGreedReading | null = null;
let fearGreedInFlight: Promise<FearGreedReading | null> | null = null;

async function fetchFearGreedFull(): Promise<FearGreedReading | null> {
  if (fearGreedCache && Date.now() - fearGreedCache.at < FEAR_GREED_TTL_MS) {
    return fearGreedCache;
  }
  if (fearGreedInFlight) return fearGreedInFlight;
  fearGreedInFlight = (async () => {
    try {
      const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', { method: 'GET' });
      if (!res.ok) throw new Error(`fng HTTP ${res.status}`);
      const data = await res.json() as { data?: { value?: string; value_classification?: string; timestamp?: string }[] };
      const latest = data?.data?.[0];
      const v = Number(latest?.value);
      if (!latest || !isFinite(v)) throw new Error('invalid fng payload');
      fearGreedCache = {
        value: v,
        value_classification: latest.value_classification || 'Neutral',
        timestamp: String(latest.timestamp || Math.floor(Date.now() / 1000)),
        at: Date.now()
      };
    } catch { /* Keep any stale reading; null only if we never got a good one. */ } finally {
      fearGreedInFlight = null;
    }
    return fearGreedCache;
  })();
  return fearGreedInFlight;
}

async function fetchFearGreed(): Promise<number> {
  const fg = await fetchFearGreedFull();
  return fg ? fg.value : 50;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCAN + EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

const LIMIT_ORDER_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

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
    state.skippedSymbols = [...unsupportedSymbols];
    const runningTotals = { totalOpen: ctx ? ctx.openFuturesCount : 0, futuresOpen: ctx ? ctx.openFuturesCount : 0 };
    const fearGreed = await fetchFearGreed();

    const now = Date.now();

    if (!dryRun) {
      for (const [sym, pending] of state.pendingLimitOrders) {
        if (now >= pending.expiresAt) {
          try {
            const category = ctx?.openFutures.some(p => p.symbol === sym) ? 'linear' : 'spot';
            await bybitExec('/v5/order/cancel', 'POST', { category, symbol: sym, orderId: pending.orderId });
            console.log(`[TTL] Cancelled expired limit order ${pending.orderId} for ${sym}`);
          } catch { /* order may have already been filled/cancelled */ }
          state.pendingLimitOrders.delete(sym);
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

    for (const [sym, meta] of state.openedSymbols) {
      if (meta.type === 'SPOT' && now - meta.at > REENTRY_COOLDOWN_MS) {
        state.openedSymbols.delete(sym);
      }
    }
    await checkClosedFuturesPositions(ctx);
    await confirmSpotEntries(ctx);
    await checkClosedSpotPositions(ctx);

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
            totalLeveragedExposureUsd: 0,
            existingExposureByAsset: {}
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
        if (scannedThisRun.has(d.symbol)) continue;
        if (state.openedSymbols.has(d.symbol)) continue;
        if (runningTotals.totalOpen >= maxOpenPositions) { d.skipped = 'הגעה למקסימום פוזיציות'; continue; }
        const res = await executeOrder(d.decision, ctx, runningTotals);
        if (res.opened) {
          runningTotals.totalOpen++;
          if (d.action === 'FUTURES') runningTotals.futuresOpen++;
          state.openedSymbols.set(d.symbol, { at: Date.now(), type: d.action as 'SPOT' | 'FUTURES', reason: d.decision.summary, confidence: d.confidence });
          scannedThisRun.add(d.symbol);
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
// HTTP SERVER
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

  if (rateLimited(clientIp(req))) {
    return json(res, 429, { error: 'Too many requests' });
  }

  if (req.method === 'GET' && url.pathname === '/api/public/universe') {
    return json(res, 200, { symbols, generatedAt: universeGeneratedAt });
  }

  if (req.method === 'GET' && url.pathname === '/api/fear-greed') {
    const fg = await fetchFearGreedFull();
    if (!fg) return json(res, 503, { error: 'Fear & Greed unavailable' });
    return json(res, 200, { value: fg.value, value_classification: fg.value_classification, timestamp: fg.timestamp, cachedAt: fg.at });
  }

  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/sim/') && !url.pathname.startsWith('/api/legacy-sim/') && !url.pathname.startsWith('/api/pro-sim/') && !url.pathname.startsWith('/api/public/') && !authorized(req)) {
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

  if (req.method === 'GET' && url.pathname === '/api/sim/state') {
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/state') {
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
      simState.config = { ...DEFAULT_SIM_CONFIG, ...simState.config, ...sanitizeSimConfig({ ...(body.config as Record<string, unknown>) }) };
      // maxPositions is fixed at 7 — no recalculation needed
    }
    await persistSim();
    return json(res, 200, simState);
  }

  if (req.method === 'GET' && url.pathname === '/api/legacy-sim/state') {
    return json(res, 200, legacySimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/legacy-sim/start') {
    legacySimState.running = true;
    await persistLegacySim();
    return json(res, 200, legacySimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/legacy-sim/stop') {
    legacySimState.running = false;
    await persistLegacySim();
    return json(res, 200, legacySimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/legacy-sim/reset') {
    legacySimState.running = false;
    legacySimEngine.reset(legacySimState.config);
    legacySimState.snapshot = legacySimEngine.getSnapshot();
    legacySimState.updatedAt = Date.now();
    await persistLegacySim();
    return json(res, 200, legacySimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/legacy-sim/config') {
    const body = await readJsonBody(req);
    if (body && typeof body.config === 'object' && body.config !== null) {
      legacySimState.config = { ...DEFAULT_LEGACY_SIM_CONFIG, ...legacySimState.config, ...sanitizeSimConfig({ ...(body.config as Record<string, unknown>) }) };
      // maxPositions is fixed at 7 — no recalculation needed
    }
    await persistLegacySim();
    return json(res, 200, legacySimState);
  }

  if (req.method === 'GET' && url.pathname === '/api/pro-sim/state') {
    return json(res, 200, proSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/pro-sim/start') {
    proSimState.running = true;
    await persistProSim();
    return json(res, 200, proSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/pro-sim/stop') {
    proSimState.running = false;
    await persistProSim();
    return json(res, 200, proSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/pro-sim/reset') {
    proSimState.running = false;
    proSimEngine.reset(proSimState.config);
    proSimState.snapshot = proSimEngine.getSnapshot();
    proSimState.updatedAt = Date.now();
    await persistProSim();
    return json(res, 200, proSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/pro-sim/config') {
    const body = await readJsonBody(req);
    if (body && typeof body.config === 'object' && body.config !== null) {
      proSimState.config = { ...DEFAULT_PRO_SIM_CONFIG, ...proSimState.config, ...sanitizeSimConfig({ ...(body.config as Record<string, unknown>) }) };
      // maxPositions is fixed at 7 — no recalculation needed
    }
    await persistProSim();
    return json(res, 200, proSimState);
  }

  // ── Backtest endpoints ───────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/backtest/results') {
    return json(res, 200, backtestState);
  }

  if (req.method === 'POST' && url.pathname === '/api/backtest/run') {
    if (backtestState.status === 'running') {
      return json(res, 409, { error: 'Backtest already running', startedAt: backtestState.startedAt });
    }
    backtestState.status = 'running';
    backtestState.startedAt = Date.now();
    backtestState.finishedAt = null;
    backtestState.results = [];
    backtestState.error = null;
    await persistBacktest();
    // Run in background — return immediately
    void runBacktestInBackground();
    return json(res, 202, { status: 'running', startedAt: backtestState.startedAt });
  }

  return json(res, 404, { error: 'Not found' });
}).listen(port, async () => {
  await refreshUniverseIfStale();
  await hydrate();
  await hydrateMarketCache();
  await hydrateSim();
  if (simState.snapshot) simEngine.hydrate(simState.snapshot as SimSnapshot);
  await hydrateLegacySim();
  if (legacySimState.snapshot) legacySimEngine.hydrate(legacySimState.snapshot as LegacySimSnapshot);
  await hydrateProSim();
  if (proSimState.snapshot) proSimEngine.hydrate(proSimState.snapshot as ProSimSnapshot);
  await hydrateBacktest();
  console.log(`Trading worker listening on ${port} | mode=${testnet ? 'testnet' : 'live'} | dryRun=${dryRun} | symbols=${symbols.length} | risk=${riskLevel} | cors=${allowedOrigins.join(',') || '*'}`);
  if (state.running) void scan();
  setInterval(() => void scan(), intervalMs);
  setInterval(() => void refreshUniverseIfStale(), UNIVERSE_CHECK_INTERVAL_MS);

  setInterval(pruneRateBuckets, RATE_LIMIT_WINDOW_MS);

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

  // Weekly auto-run backtest: check every hour if 7 days have passed since last run
  const WEEKLY_BACKTEST_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const WEEKLY_BACKTEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  setInterval(async () => {
    if (backtestState.status === 'running') return;
    const lastFinished = backtestState.finishedAt;
    const shouldRun = !lastFinished || (Date.now() - lastFinished > WEEKLY_BACKTEST_INTERVAL_MS);
    if (shouldRun) {
      console.log('[backtest] weekly auto-run triggered');
      backtestState.status = 'running';
      backtestState.startedAt = Date.now();
      backtestState.finishedAt = null;
      backtestState.results = [];
      backtestState.error = null;
      await persistBacktest();
      void runBacktestInBackground();
    }
  }, WEEKLY_BACKTEST_CHECK_INTERVAL_MS);

  // Each sim engine still TICKS every 4s (evaluation + mark-to-market + order
  // fills need that cadence to stay responsive), but the snapshot it produces
  // was previously PERSISTED (Firestore PATCH + local-file read-modify-write)
  // on every single one of those ticks regardless of whether anything
  // meaningful changed — ~900 writes/hour per engine, x3 engines. Persistence
  // is now throttled to once per SIM_PERSIST_INTERVAL_MS; the in-memory
  // snapshot (served by /api/*/state) still updates every tick. A forced,
  // unthrottled flush still happens on start/stop/reset/config (those already
  // call persistX() directly at their own call sites) and on shutdown below,
  // so at most SIM_PERSIST_INTERVAL_MS of history is at risk on a hard crash.
  const SIM_PERSIST_INTERVAL_MS = 30_000;
  let lastSimPersistAt = 0;
  let lastLegacySimPersistAt = 0;
  let lastProSimPersistAt = 0;

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
      if (now - lastSimPersistAt >= SIM_PERSIST_INTERVAL_MS) {
        await persistSim();
        lastSimPersistAt = now;
      }
    } catch (e: unknown) {
      console.warn('[sim-engine] tick failed:', e instanceof Error ? e.message : String(e));
    } finally {
      simTickInProgress = false;
    }
  }, 4000);

  let legacySimTickInProgress = false;
  setInterval(async () => {
    if (!legacySimState.running || legacySimTickInProgress) return;
    legacySimTickInProgress = true;
    try {
      const now = Date.now();
      if (now - lastFgFetchAt > 15 * 60 * 1000) {
        cachedSimFearGreed = await fetchFearGreed();
        lastFgFetchAt = now;
      }
      const snap = await legacySimEngine.tick(legacySimState.config, cachedSimFearGreed);
      legacySimState.snapshot = snap;
      legacySimState.updatedAt = Date.now();
      if (now - lastLegacySimPersistAt >= SIM_PERSIST_INTERVAL_MS) {
        await persistLegacySim();
        lastLegacySimPersistAt = now;
      }
    } catch (e: unknown) {
      console.warn('[legacy-sim-engine] tick failed:', e instanceof Error ? e.message : String(e));
    } finally {
      legacySimTickInProgress = false;
    }
  }, 4000);

  let proSimTickInProgress = false;
  setInterval(async () => {
    if (!proSimState.running || proSimTickInProgress) return;
    proSimTickInProgress = true;
    try {
      const now = Date.now();
      if (now - lastFgFetchAt > 15 * 60 * 1000) {
        cachedSimFearGreed = await fetchFearGreed();
        lastFgFetchAt = now;
      }
      const snap = await proSimEngine.tick(proSimState.config, cachedSimFearGreed);
      proSimState.snapshot = snap;
      proSimState.updatedAt = Date.now();
      if (now - lastProSimPersistAt >= SIM_PERSIST_INTERVAL_MS) {
        await persistProSim();
        lastProSimPersistAt = now;
      }
    } catch (e: unknown) {
      console.warn('[pro-sim-engine] tick failed:', e instanceof Error ? e.message : String(e));
    } finally {
      proSimTickInProgress = false;
    }
  }, 4000);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} — flushing state and warm cache`);
  try { await store.set('state', serializeState()); } catch { /* ignore */ }
  lastCachePersistAt = 0;
  try { await persistMarketCache(); } catch { /* ignore */ }
  // Force-flush the throttled sim snapshots too — otherwise up to
  // SIM_PERSIST_INTERVAL_MS of in-memory-only history is lost on restart.
  try { await persistSim(); } catch { /* ignore */ }
  try { await persistLegacySim(); } catch { /* ignore */ }
  try { await persistProSim(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));


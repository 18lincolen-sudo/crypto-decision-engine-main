/**
 * MarketDataService — Multi-Timeframe OHLCV pipeline (1H / 15M / 5M)
 * ============================================================================
 * Priority (§3):   Bybit Klines  →  Binance Klines  →  SKIP ASSET
 * CoinGecko is NEVER used as an intraday OHLCV source. It stays an analytic
 * fallback only, guarded by the asset mapping (§4/§57).
 *
 * Guarantees:
 *  - Every timeframe is fetched SEPARATELY with its own candle budget (§2).
 *  - Pagination is used when the requested history exceeds the API page size.
 *  - Candles are validated, de-duplicated and sorted oldest → newest (§5).
 *  - The currently FORMING candle is dropped: signals use closed candles (§7/§41).
 *  - A missing timeframe yields status = NOT_READY (never a silent "HOLD") (§5).
 *  - Telemetry: `[market-data] symbol=BTCUSDT 1h=200 15m=300 5m=500` (§56).
 */

import { Candle } from './tradeEngine';
import { toBybitSymbol, toBaseAsset } from './assetUniverse';

// ── Endpoints ────────────────────────────────────────────────────────────────
const BYBIT_PUBLIC_BASE = 'https://api.bybit.com';
const BINANCE_PUBLIC_BASE = 'https://api.binance.com/api/v3';

export type TimeframeKey = '1h' | '15m' | '5m';
export type CandleSource = 'bybit' | 'binance' | 'cache' | 'none';

export interface TimeframeSpec {
  key: TimeframeKey;
  /** Bybit v5 interval code */
  bybit: string;
  /** Binance interval code */
  binance: string;
  /** Candle duration in ms */
  ms: number;
  /** Hard minimum required to evaluate the asset */
  minCandles: number;
  /** Desired history depth */
  targetCandles: number;
  /** How often live data is refreshed for this timeframe (§7) */
  refreshMs: number;
}

export const TIMEFRAME_SPECS: Record<TimeframeKey, TimeframeSpec> = {
  '1h': { key: '1h', bybit: '60', binance: '1h', ms: 3_600_000, minCandles: 200, targetCandles: 240, refreshMs: 5 * 60_000 },
  '15m': { key: '15m', bybit: '15', binance: '15m', ms: 900_000, minCandles: 300, targetCandles: 320, refreshMs: 90_000 },
  '5m': { key: '5m', bybit: '5', binance: '5m', ms: 300_000, minCandles: 500, targetCandles: 520, refreshMs: 45_000 }
};

export const TIMEFRAME_ORDER: TimeframeKey[] = ['1h', '15m', '5m'];

// ── Validation ───────────────────────────────────────────────────────────────

export interface CandleValidationResult {
  ok: boolean;
  cleaned: Candle[];
  reason?: string;
  issues: string[];
  dropped: number;
}

/**
 * Validates and normalizes a candle array:
 *   timestamp finite & positive, OHLC finite & positive, high >= low,
 *   volume finite & >= 0, no NaN, sorted ascending, duplicates removed.
 */
export function validateCandles(candles: Candle[] | undefined | null, minCandles: number): CandleValidationResult {
  const issues: string[] = [];
  if (!candles || !candles.length) {
    return { ok: false, cleaned: [], reason: 'NO_DATA', issues: ['empty candle array'], dropped: 0 };
  }

  const seen = new Set<number>();
  const cleaned: Candle[] = [];
  let dropped = 0;

  for (const c of candles) {
    const valid =
      c &&
      Number.isFinite(c.timestamp) && c.timestamp > 0 &&
      Number.isFinite(c.open) && c.open > 0 &&
      Number.isFinite(c.high) && c.high > 0 &&
      Number.isFinite(c.low) && c.low > 0 &&
      Number.isFinite(c.close) && c.close > 0 &&
      Number.isFinite(c.volume) && c.volume >= 0 &&
      c.high >= c.low &&
      c.high >= Math.max(c.open, c.close) - Math.abs(c.high) * 1e-9 &&
      c.low <= Math.min(c.open, c.close) + Math.abs(c.low) * 1e-9;

    if (!valid) {
      dropped++;
      continue;
    }
    if (seen.has(c.timestamp)) {
      dropped++;
      continue;
    }
    seen.add(c.timestamp);
    cleaned.push({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    });
  }

  cleaned.sort((a, b) => a.timestamp - b.timestamp);

  if (dropped > 0) issues.push(`${dropped} invalid/duplicate candles dropped`);
  if (cleaned.length < minCandles) {
    return {
      ok: false,
      cleaned,
      reason: 'INSUFFICIENT_CANDLES',
      issues: [...issues, `${cleaned.length} < required ${minCandles}`],
      dropped
    };
  }

  return { ok: true, cleaned, issues, dropped };
}

/**
 * Removes the candle that is still forming so signals only ever see closed data.
 * A candle opened at T closes at T + tfMs; it is closed only when now >= T + tfMs.
 */
export function dropFormingCandle(candles: Candle[], tfMs: number, now = Date.now()): Candle[] {
  if (!candles.length) return candles;
  const out = [...candles];
  while (out.length && out[out.length - 1].timestamp + tfMs > now) {
    out.pop();
  }
  return out;
}

/** True when the last candle timestamp is aligned to the timeframe grid */
export function isAlignedToTimeframe(candles: Candle[], tfMs: number): boolean {
  if (!candles.length) return true;
  return candles[candles.length - 1].timestamp % tfMs === 0;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function timedFetch(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Bybit klines (primary, paginated) ────────────────────────────────────────

const BYBIT_PAGE_LIMIT = 1000;

interface BybitKlineResponse {
  retCode: number;
  retMsg?: string;
  result?: { list?: string[][] };
}

/**
 * Fetches `limit` klines for one timeframe from Bybit, paginating backwards when
 * `limit` exceeds the API page size. Returns candles oldest → newest.
 */
export async function fetchBybitKlines(
  symbol: string,
  tf: TimeframeKey,
  limit: number,
  opts: { endTime?: number; category?: 'spot' | 'linear' } = {}
): Promise<Candle[]> {
  const spec = TIMEFRAME_SPECS[tf];
  const bybitSymbol = toBybitSymbol(symbol);
  const category = opts.category || 'spot';
  const collected: Candle[] = [];
  let end = opts.endTime;
  let guard = 0;

  while (collected.length < limit && guard < 40) {
    guard++;
    const page = Math.min(BYBIT_PAGE_LIMIT, limit - collected.length);
    const params = new URLSearchParams({
      category,
      symbol: bybitSymbol,
      interval: spec.bybit,
      limit: String(page)
    });
    if (end !== undefined) params.set('end', String(end));

    const res = await timedFetch(`${BYBIT_PUBLIC_BASE}/v5/market/kline?${params.toString()}`);
    if (!res.ok) throw new Error(`Bybit kline HTTP ${res.status}`);
    const data = (await res.json()) as BybitKlineResponse;
    if (data.retCode !== 0) throw new Error(`Bybit retCode ${data.retCode} ${data.retMsg || ''}`);
    const list = data.result?.list;
    if (!list || !list.length) break;

    // Bybit returns newest → oldest
    const chunk: Candle[] = list.map((row) => ({
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    }));

    collected.push(...chunk);

    const oldest = Math.min(...chunk.map((c) => c.timestamp));
    if (!Number.isFinite(oldest)) break;
    end = oldest - 1;
    if (chunk.length < page) break; // no more history available
  }

  collected.sort((a, b) => a.timestamp - b.timestamp);
  return collected;
}

// ── Binance klines (fallback) ────────────────────────────────────────────────

const BINANCE_PAGE_LIMIT = 1000;

export async function fetchBinanceKlines(
  symbol: string,
  tf: TimeframeKey,
  limit: number,
  opts: { endTime?: number } = {}
): Promise<Candle[]> {
  const spec = TIMEFRAME_SPECS[tf];
  const pair = toBybitSymbol(symbol); // same USDT pair naming on Binance
  const collected: Candle[] = [];
  let endTime = opts.endTime;
  let guard = 0;

  while (collected.length < limit && guard < 40) {
    guard++;
    const page = Math.min(BINANCE_PAGE_LIMIT, limit - collected.length);
    const params = new URLSearchParams({ symbol: pair, interval: spec.binance, limit: String(page) });
    if (endTime !== undefined) params.set('endTime', String(endTime));

    const res = await timedFetch(`${BINANCE_PUBLIC_BASE}/klines?${params.toString()}`);
    if (!res.ok) throw new Error(`Binance kline HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    if (!Array.isArray(rows) || !rows.length) break;

    const chunk: Candle[] = rows.map((row) => ({
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    }));

    collected.push(...chunk);
    const oldest = Math.min(...chunk.map((c) => c.timestamp));
    if (!Number.isFinite(oldest)) break;
    endTime = oldest - 1;
    if (chunk.length < page) break;
  }

  collected.sort((a, b) => a.timestamp - b.timestamp);
  return collected;
}

/**
 * Bybit → Binance → fail. Returns validated, closed candles for one timeframe.
 */
export async function fetchTimeframe(
  symbol: string,
  tf: TimeframeKey,
  opts: { limit?: number; now?: number; endTime?: number; requireClosed?: boolean } = {}
): Promise<{ candles: Candle[]; source: CandleSource; reason?: string; issues: string[] }> {
  const spec = TIMEFRAME_SPECS[tf];
  const limit = opts.limit ?? spec.targetCandles;
  const now = opts.now ?? Date.now();
  const requireClosed = opts.requireClosed !== false;
  const issues: string[] = [];

  const attempt = async (source: 'bybit' | 'binance'): Promise<Candle[]> =>
    source === 'bybit'
      ? fetchBybitKlines(symbol, tf, limit, { endTime: opts.endTime })
      : fetchBinanceKlines(symbol, tf, limit, { endTime: opts.endTime });

  for (const source of ['bybit', 'binance'] as const) {
    try {
      const raw = await attempt(source);
      const closed = requireClosed ? dropFormingCandle(raw, spec.ms, now) : raw;
      const validation = validateCandles(closed, spec.minCandles);
      issues.push(...validation.issues.map((i) => `${source}:${i}`));
      if (validation.ok) {
        return { candles: validation.cleaned, source, issues };
      }
      issues.push(`${source}:${validation.reason}`);
    } catch (e) {
      issues.push(`${source}:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { candles: [], source: 'none', reason: 'INSUFFICIENT_CANDLES', issues };
}

// ── Liquidity / spread snapshot (§26/§27) ────────────────────────────────────

export interface LiquiditySnapshot {
  symbol: string;
  lastPrice: number;
  bid: number;
  ask: number;
  /** (ask-bid)/mid * 100 */
  spreadPercent: number;
  /** 24h quote turnover in USDT */
  quoteVolume24h: number;
  source: 'bybit' | 'binance' | 'estimate';
  fetchedAt: number;
}

let liquidityCache: { at: number; map: Map<string, LiquiditySnapshot> } = { at: 0, map: new Map() };
const LIQUIDITY_TTL_MS = 15_000;

interface BybitTickerRow {
  symbol: string;
  lastPrice: string;
  bid1Price?: string;
  ask1Price?: string;
  turnover24h?: string;
  volume24h?: string;
}

/**
 * One Bybit call returns every spot ticker with best bid/ask, which gives the
 * live spread AND the 24h turnover used by the liquidity filter.
 */
export async function getLiquiditySnapshots(symbols: string[], now = Date.now()): Promise<Map<string, LiquiditySnapshot>> {
  if (now - liquidityCache.at < LIQUIDITY_TTL_MS && liquidityCache.map.size) {
    return liquidityCache.map;
  }

  const wanted = new Set(symbols.map((s) => toBybitSymbol(s)));
  const map = new Map<string, LiquiditySnapshot>();

  try {
    const res = await timedFetch(`${BYBIT_PUBLIC_BASE}/v5/market/tickers?category=spot`);
    if (res.ok) {
      const data = (await res.json()) as { retCode: number; result?: { list?: BybitTickerRow[] } };
      if (data.retCode === 0 && data.result?.list) {
        for (const row of data.result.list) {
          if (!wanted.has(row.symbol)) continue;
          const lastPrice = Number(row.lastPrice);
          const bid = Number(row.bid1Price ?? row.lastPrice);
          const ask = Number(row.ask1Price ?? row.lastPrice);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : lastPrice;
          const spreadPercent = mid > 0 && ask > bid ? ((ask - bid) / mid) * 100 : 0.02;
          map.set(row.symbol, {
            symbol: row.symbol,
            lastPrice,
            bid,
            ask,
            spreadPercent: Number(spreadPercent.toFixed(5)),
            quoteVolume24h: Number(row.turnover24h ?? 0),
            source: 'bybit',
            fetchedAt: now
          });
        }
      }
    }
  } catch {
    /* fall through to Binance */
  }

  const missing = [...wanted].filter((s) => !map.has(s));
  if (missing.length) {
    try {
      const res = await timedFetch(`${BINANCE_PUBLIC_BASE}/ticker/bookTicker`);
      if (res.ok) {
        const rows = (await res.json()) as { symbol: string; bidPrice: string; askPrice: string }[];
        const byPair = new Map(rows.map((r) => [r.symbol, r]));
        for (const pair of missing) {
          const row = byPair.get(pair);
          if (!row) continue;
          const bid = Number(row.bidPrice);
          const ask = Number(row.askPrice);
          const mid = (bid + ask) / 2;
          map.set(pair, {
            symbol: pair,
            lastPrice: mid,
            bid,
            ask,
            spreadPercent: mid > 0 && ask > bid ? Number((((ask - bid) / mid) * 100).toFixed(5)) : 0.02,
            quoteVolume24h: 0,
            source: 'binance',
            fetchedAt: now
          });
        }
      }
    } catch {
      /* leave missing symbols without a liquidity snapshot */
    }
  }

  if (map.size) liquidityCache = { at: now, map };
  return map;
}

// ── Multi-timeframe snapshot with per-timeframe refresh cadence ──────────────

export interface MultiTimeframeSnapshot {
  symbol: string;
  base: string;
  status: 'READY' | 'NOT_READY';
  reason?: string;
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
  counts: Record<TimeframeKey, number>;
  sources: Record<TimeframeKey, CandleSource>;
  /** Close timestamp of the newest closed 5M candle */
  lastClosedAt: number;
  liquidity: LiquiditySnapshot | null;
  livePrice: number;
  issues: string[];
  fetchedAt: number;
}

interface TimeframeCacheEntry {
  candles: Candle[];
  source: CandleSource;
  fetchedAt: number;
  lastTimestamp: number;
}

const tfCache = new Map<string, TimeframeCacheEntry>();

function cacheKey(symbol: string, tf: TimeframeKey): string {
  return `${toBybitSymbol(symbol)}:${tf}`;
}

/** Manual cache reset — used by tests and by /api/sim/reset */
export function clearMarketDataCache(): void {
  tfCache.clear();
  liquidityCache = { at: 0, map: new Map() };
}

export interface MarketDataStats {
  assetsSeen: number;
  assetsWithValidData: number;
  assetsSkipped: number;
  dataErrors: number;
  skipped: { symbol: string; reason: string }[];
}

export interface GetMarketDataOptions {
  now?: number;
  /** Force a refetch regardless of the refresh cadence */
  force?: boolean;
  /** Emit `[market-data]` telemetry lines */
  log?: boolean;
  /** Override candle budgets (backtest / tests) */
  limits?: Partial<Record<TimeframeKey, number>>;
}

/**
 * Loads 1H/15M/5M for a single symbol, honouring the per-timeframe refresh
 * cadence (§7) so a 5s tick does not hammer the API for 1H candles that cannot
 * have changed.
 */
export async function getMultiTimeframeData(symbol: string, opts: GetMarketDataOptions = {}): Promise<MultiTimeframeSnapshot> {
  const now = opts.now ?? Date.now();
  const bybitSymbol = toBybitSymbol(symbol);
  const issues: string[] = [];
  const candles: Record<TimeframeKey, Candle[]> = { '1h': [], '15m': [], '5m': [] };
  const sources: Record<TimeframeKey, CandleSource> = { '1h': 'none', '15m': 'none', '5m': 'none' };

  for (const tf of TIMEFRAME_ORDER) {
    const spec = TIMEFRAME_SPECS[tf];
    const key = cacheKey(bybitSymbol, tf);
    const cached = tfCache.get(key);
    const expectedLastClose = Math.floor(now / spec.ms) * spec.ms - spec.ms;
    const cacheFresh =
      !!cached &&
      !opts.force &&
      (now - cached.fetchedAt < spec.refreshMs || cached.lastTimestamp >= expectedLastClose);

    if (cacheFresh && cached) {
      candles[tf] = cached.candles;
      sources[tf] = 'cache';
      continue;
    }

    const result = await fetchTimeframe(symbol, tf, { now, limit: opts.limits?.[tf] });
    issues.push(...result.issues);
    if (result.candles.length) {
      candles[tf] = result.candles;
      sources[tf] = result.source;
      tfCache.set(key, {
        candles: result.candles,
        source: result.source,
        fetchedAt: now,
        lastTimestamp: result.candles[result.candles.length - 1].timestamp
      });
    } else if (cached) {
      // Transient outage: keep last-known-good rather than dropping the asset.
      candles[tf] = cached.candles;
      sources[tf] = 'cache';
      issues.push(`${tf}:served-stale-cache`);
    }
  }

  const counts: Record<TimeframeKey, number> = {
    '1h': candles['1h'].length,
    '15m': candles['15m'].length,
    '5m': candles['5m'].length
  };

  const missing = TIMEFRAME_ORDER.filter((tf) => counts[tf] < TIMEFRAME_SPECS[tf].minCandles);
  const status: 'READY' | 'NOT_READY' = missing.length ? 'NOT_READY' : 'READY';
  const reason = missing.length ? `INSUFFICIENT_CANDLES:${missing.join(',')}` : undefined;

  const liquidityMap = await getLiquiditySnapshots([bybitSymbol], now).catch(() => new Map<string, LiquiditySnapshot>());
  const liquidity = liquidityMap.get(bybitSymbol) ?? null;
  const lastM5 = candles['5m'][candles['5m'].length - 1];

  if (opts.log) {
    if (status === 'READY') {
      console.log(`[market-data] symbol=${bybitSymbol} 1h=${counts['1h']} 15m=${counts['15m']} 5m=${counts['5m']} src=${sources['5m']}`);
    } else {
      console.log(`[market-data] symbol=${bybitSymbol} status=SKIP reason=INSUFFICIENT_CANDLES 1h=${counts['1h']} 15m=${counts['15m']} 5m=${counts['5m']}`);
    }
  }

  return {
    symbol: bybitSymbol,
    base: toBaseAsset(bybitSymbol),
    status,
    reason,
    h1: candles['1h'],
    m15: candles['15m'],
    m5: candles['5m'],
    counts,
    sources,
    lastClosedAt: lastM5 ? lastM5.timestamp + TIMEFRAME_SPECS['5m'].ms : 0,
    liquidity,
    livePrice: liquidity?.lastPrice || lastM5?.close || 0,
    issues,
    fetchedAt: now
  };
}

/**
 * Loads the whole trading universe with bounded concurrency and returns the
 * data-quality statistics required by §6 (never a bare `evals=0`).
 */
export async function getUniverseMarketData(
  symbols: string[],
  opts: GetMarketDataOptions & { concurrency?: number } = {}
): Promise<{ snapshots: Map<string, MultiTimeframeSnapshot>; stats: MarketDataStats }> {
  const now = opts.now ?? Date.now();
  const concurrency = opts.concurrency ?? 4;
  const snapshots = new Map<string, MultiTimeframeSnapshot>();
  const stats: MarketDataStats = {
    assetsSeen: symbols.length,
    assetsWithValidData: 0,
    assetsSkipped: 0,
    dataErrors: 0,
    skipped: []
  };

  // Warm the shared liquidity cache with a single call for the whole universe.
  await getLiquiditySnapshots(symbols, now).catch(() => {
    stats.dataErrors++;
    return new Map<string, LiquiditySnapshot>();
  });

  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (symbol) => {
        try {
          return await getMultiTimeframeData(symbol, { ...opts, now });
        } catch (e) {
          stats.dataErrors++;
          return {
            symbol: toBybitSymbol(symbol),
            base: toBaseAsset(symbol),
            status: 'NOT_READY' as const,
            reason: `DATA_ERROR:${e instanceof Error ? e.message : String(e)}`,
            h1: [],
            m15: [],
            m5: [],
            counts: { '1h': 0, '15m': 0, '5m': 0 } as Record<TimeframeKey, number>,
            sources: { '1h': 'none', '15m': 'none', '5m': 'none' } as Record<TimeframeKey, CandleSource>,
            lastClosedAt: 0,
            liquidity: null,
            livePrice: 0,
            issues: [],
            fetchedAt: now
          } satisfies MultiTimeframeSnapshot;
        }
      })
    );

    for (const snap of results) {
      snapshots.set(snap.symbol, snap);
      if (snap.status === 'READY') stats.assetsWithValidData++;
      else {
        stats.assetsSkipped++;
        stats.skipped.push({ symbol: snap.symbol, reason: snap.reason || 'NOT_READY' });
      }
    }
  }

  return { snapshots, stats };
}

/**
 * Backtest loader: pulls a deep 5M/15M/1H history in one shot (paginated) with
 * NO cache and NO forming-candle trimming ambiguity.
 */
export async function fetchBacktestHistory(
  symbol: string,
  limits: Record<TimeframeKey, number>,
  now = Date.now()
): Promise<{ symbol: string; h1: Candle[]; m15: Candle[]; m5: Candle[]; sources: Record<TimeframeKey, CandleSource> }> {
  const out = { symbol: toBybitSymbol(symbol), h1: [] as Candle[], m15: [] as Candle[], m5: [] as Candle[] };
  const sources: Record<TimeframeKey, CandleSource> = { '1h': 'none', '15m': 'none', '5m': 'none' };

  for (const tf of TIMEFRAME_ORDER) {
    const res = await fetchTimeframe(symbol, tf, { limit: limits[tf], now });
    sources[tf] = res.source;
    if (tf === '1h') out.h1 = res.candles;
    if (tf === '15m') out.m15 = res.candles;
    if (tf === '5m') out.m5 = res.candles;
  }

  return { ...out, sources };
}

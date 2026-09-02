/**
 * Decision Funnel report — runs the REAL intraday decision engine
 * (evaluateIntradayDecision) over historical Bybit 5M/15M/1H candles for every
 * symbol in TARGET_SYMBOLS, across EVERY 5-minute window, and aggregates how
 * many evaluations pass each decision layer (gate) and why the rest are rejected.
 *
 * Run:  npx tsx scripts/decisionFunnel.ts
 * Env:  FM_LIMIT (5M candles, def 1000)  M15_LIMIT (def 500)  H1_LIMIT (def 250)
 *       CONC (fetch concurrency, def 6)   SYMS (comma subset, def all)
 *       OUT (report path, def decisionFunnel.report.json)
 */
import { evaluateIntradayDecision } from '../src/services/intradayEngine';
import { DEFAULT_INTRADAY_PARAMS } from '../src/services/intradayParams';
import { TARGET_SYMBOLS } from '../src/shared/targetSymbols';
import type { Candle } from '../src/services/tradeEngine';
import type { DecisionGate } from '../src/services/intradayParams';

const BYBIT = 'https://api.bybit.com/v5/market';
interface BybitApiResponse<TResult> {
  retCode: number;
  retMsg?: string;
  result?: TResult;
}

interface BybitKlineResult {
  list?: unknown[];
}

interface BybitTicker {
  lastPrice?: string;
  bid1Price?: string;
  ask1Price?: string;
  turnover24h?: string;
}

interface BybitTickerResult {
  list?: BybitTicker[];
}

/**
 * Rebranded/delisted tickers: the TARGET_SYMBOLS label is kept in the report,
 * but the (current) exchange ticker is fetched instead so the funnel uses live
 * data. Symbols with no current ticker (e.g. MKRUSDT/EOSUSDT on Binance spot)
 * fall back to whatever history exists and are flagged as stale in the report.
 */
const REMAP: Record<string, string> = {
  MATICUSDT: 'POLUSDT',
  RNDRUSDT: 'RENDERUSDT',
  FTMUSDT: 'SUSDT'
};
const FM_LIMIT = Number(process.env.FM_LIMIT ?? 1000);
const M15_LIMIT = Number(process.env.M15_LIMIT ?? 500);
const H1_LIMIT = Number(process.env.H1_LIMIT ?? 250);
const CONC = Number(process.env.CONC ?? 6);
const WARMUP = 500; // 5M candles required before first evaluation
const OUT = process.env.OUT ?? 'decisionFunnel.report.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson<T>(url: string, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      const json = (await res.json()) as BybitApiResponse<unknown> | null;
      if (json && json.retCode === 0) return json as T;
      lastErr = new Error(`retCode ${json?.retCode} ${json?.retMsg}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(250 * (i + 1));
  }
  throw lastErr;
}

function toCandles(list: unknown[]): Candle[] {
  return list
    .map((c) => {
      if (!Array.isArray(c)) {
        return null;
      }
      return {
        timestamp: Number(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5])
      };
    })
    .filter((c): c is Candle => c !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

const BINANCE = 'https://api.binance.com/api/v3';
const BINANCE_INTERVAL: Record<string, string> = { '5': '5m', '15': '15m', '60': '1h' };

async function fetchBybitKlines(symbol: string, interval: string, limit: number): Promise<Candle[] | null> {
  const url = `${BYBIT}/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  try {
    const json = await fetchJson<BybitApiResponse<BybitKlineResult>>(url);
    const list = json.result?.list;
    if (!list || !list.length) return null; // symbol not on Bybit linear → try Binance
    return toCandles(list);
  } catch {
    return null;
  }
}

async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<Candle[] | null> {
  const bi = BINANCE_INTERVAL[interval] ?? `${interval}m`;
  const url = `${BINANCE}/klines?symbol=${symbol}&interval=${bi}&limit=${limit}`;
  try {
    const res = await fetch(url);
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list) || !list.length) return null;
    return list
      .map((c) => {
        if (!Array.isArray(c)) {
          return null;
        }
        return {
          timestamp: Number(c[0]),
          open: Number(c[1]),
          high: Number(c[2]),
          low: Number(c[3]),
          close: Number(c[4]),
          volume: Number(c[5])
        };
      })
      .filter((c): c is Candle => c !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return null;
  }
}

/** Bybit linear first, Binance fallback (matches the engine's universe behavior). */
async function fetchKlines(symbol: string, interval: string, limit: number): Promise<{ candles: Candle[]; source: 'bybit' | 'binance' | 'none' }> {
  const bybit = await fetchBybitKlines(symbol, interval, limit);
  if (bybit) return { candles: bybit, source: 'bybit' };
  const binance = await fetchBinanceKlines(symbol, interval, limit);
  if (binance) return { candles: binance, source: 'binance' };
  return { candles: [], source: 'none' };
}

async function fetchTicker(symbol: string): Promise<{ turnover24h: number; spreadPercent: number; source: 'bybit' | 'binance' | 'fallback' }> {
  // Bybit linear ticker
  try {
    const json = await fetchJson<BybitApiResponse<BybitTickerResult>>(`${BYBIT}/tickers?category=linear&symbol=${symbol}`);
    const t = json.result?.list?.[0];
    if (t) {
      const last = Number(t.lastPrice);
      const bid = Number(t.bid1Price);
      const ask = Number(t.ask1Price);
      const spread = bid && ask && last ? ((ask - bid) / last) * 100 : 0.03;
      return { turnover24h: Number(t.turnover24h), spreadPercent: spread, source: 'bybit' };
    }
  } catch {
    /* fall through */
  }
  // Binance bookTicker + 24hr
  try {
    const [bt, hr] = await Promise.all([
      fetch(`${BINANCE}/ticker/bookTicker?symbol=${symbol}`).then((r) => r.json()) as Promise<{ bidPrice: string; askPrice: string }>,
      fetch(`${BINANCE}/ticker/24hr?symbol=${symbol}`).then((r) => r.json()) as Promise<{ quoteVolume: string }>
    ]);
    const bid = Number(bt.bidPrice);
    const ask = Number(bt.askPrice);
    const last = ask || bid;
    const spread = bid && ask && last ? ((ask - bid) / last) * 100 : 0.03;
    return { turnover24h: Number(hr.quoteVolume) || 1e12, spreadPercent: spread, source: 'binance' };
  } catch {
    /* fall through */
  }
  return { turnover24h: 1e12, spreadPercent: 0.03, source: 'fallback' };
}

/** Binary-search slice: all candles with timestamp <= t (arrays ascending). */
function sliceUpTo(arr: Candle[], t: number): Candle[] {
  let lo = 0;
  let hi = arr.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp <= t) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return last < 0 ? [] : arr.slice(0, last + 1);
}

const GATE_ORDER: DecisionGate[] = [
  'NO_DATA',
  'CIRCUIT_BREAKER',
  'EXPOSURE',
  'NO_REGIME',
  'VOLATILITY',
  'NO_SETUP',
  'NO_ENTRY',
  'LIQUIDITY',
  'SPREAD',
  'COST',
  'RISK'
];

interface Agg {
  total: number;
  landed: Record<string, number>;
  reasons: Record<string, Record<string, number>>;
  signals: {
    total: number;
    byTradeType: Record<string, number>;
    byDirection: Record<string, number>;
    bySetup: Record<string, number>;
    byRegime: Record<string, number>;
    bySymbol: Record<string, number>;
  };
  perSymbol: Record<string, { windows: number; signals: number; landed: Record<string, number> }>;
}

function newAgg(): Agg {
  return {
    total: 0,
    landed: {},
    reasons: {},
    signals: { total: 0, byTradeType: {}, byDirection: {}, bySetup: {}, byRegime: {}, bySymbol: {} },
    perSymbol: {}
  };
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function reasonFromLogs(logs: string[]): string {
  const last = logs[logs.length - 1] ?? '';
  const m = last.match(/^\s*\[[^\]]+\]\s+[A-Z_]+\s+[—-]\s*(.*)$/);
  return (m ? m[1] : last).trim();
}

async function run() {
  const symbols = (process.env.SYMS ? process.env.SYMS.split(',') : TARGET_SYMBOLS).map((s) => s.trim().toUpperCase());
  console.log(`[funnel] symbols=${symbols.length} FM=${FM_LIMIT} M15=${M15_LIMIT} H1=${H1_LIMIT} conc=${CONC}`);

  const agg = newAgg();
  const dateRanges: { symbol: string; from: number; to: number; m5: number; source: string }[] = [];

  // ── Fetch all symbols (concurrency-limited) ────────────────────────────────
  const queue = [...symbols];
  let done = 0;
  async function worker() {
      while (queue.length) {
        const symbol = queue.shift()!;
        const fetchSym = REMAP[symbol] ?? symbol;
        try {
          const [h1r, m15r, m5r] = await Promise.all([
            fetchKlines(fetchSym, '60', H1_LIMIT),
            fetchKlines(fetchSym, '15', M15_LIMIT),
            fetchKlines(fetchSym, '5', FM_LIMIT)
          ]);
          const m5 = m5r.candles;
          if (m5.length < WARMUP + 1) {
            console.log(`[funnel] ${symbol}: no klines on Bybit/Binance (source=${m5r.source}), skipping`);
            done++;
            continue;
          }
          const ticker = await fetchTicker(fetchSym);
          const liq = { turnover24h: ticker.turnover24h, spreadPercent: ticker.spreadPercent };
          if (ticker.source !== 'bybit') console.log(`[funnel] ${symbol}: liquidity source=${ticker.source}`);
          const stale = m5[m5.length - 1].timestamp < Date.now() - 7 * 24 * 60 * 60 * 1000;
          if (stale) console.log(`[funnel] ${symbol}: STALE data (ends ${new Date(m5[m5.length - 1].timestamp).toISOString()})`);
          dateRanges.push({ symbol, from: m5[0].timestamp, to: m5[m5.length - 1].timestamp, m5: m5.length, source: m5r.source });
          evaluateSymbol(agg, symbol, h1r.candles, m15r.candles, m5, liq);
      } catch (e: unknown) {
        console.log(`[funnel] ${symbol}: FETCH ERROR ${e instanceof Error ? e.message : String(e)}`);
      }
      done++;
      if (done % 10 === 0) console.log(`[funnel] progress ${done}/${symbols.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, symbols.length) }, worker));

  printReport(agg, dateRanges, symbols.length);
  const fs = await import('fs');
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), config: { FM_LIMIT, M15_LIMIT, H1_LIMIT, WARMUP }, agg, dateRanges }, null, 2));
  console.log(`[funnel] wrote ${OUT}`);
}

function evaluateSymbol(
  agg: Agg,
  symbol: string,
  h1: Candle[],
  m15: Candle[],
  m5: Candle[],
  ticker: { turnover24h: number; spreadPercent: number }
) {
  const ps = agg.perSymbol[symbol] = { windows: 0, signals: 0, landed: {} };
  const portfolio = {
    portfolioValue: 10000,
    initialAmount: 10000,
    dailyDrawdownPercent: 0,
    weeklyDrawdownPercent: 0,
    openPositionsCount: 0,
    openFuturesPositionsCount: 0,
    totalLeveragedExposureUsd: 0
  };

  for (let i = WARMUP; i < m5.length; i++) {
    const bar = m5[i];
    const t = bar.timestamp;
    const h1ctx = sliceUpTo(h1, t);
    const m15ctx = sliceUpTo(m15, t);
    const m5ctx = m5.slice(0, i + 1);
    if (h1ctx.length < 200 || m15ctx.length < 300 || m5ctx.length < 500) continue;

    const d = evaluateIntradayDecision({
      symbol,
      h1: h1ctx,
      m15: m15ctx,
      m5: m5ctx,
      spreadPercent: ticker.spreadPercent,
      quoteVolume24h: ticker.turnover24h,
      livePrice: bar.close,
      portfolio,
      openPositions: [],
      params: DEFAULT_INTRADAY_PARAMS,
      now: t + 300_000
    });

    agg.total++;
    ps.windows++;
    const landed = d.outcome === 'SIGNAL' ? 'SIGNAL' : d.gate;
    bump(agg.landed, landed);
    bump(ps.landed, landed);

    if (d.outcome !== 'SIGNAL') {
      const reason = reasonFromLogs(d.logs);
      if (!agg.reasons[landed]) agg.reasons[landed] = {};
      bump(agg.reasons[landed], reason);
    } else {
      agg.signals.total++;
      ps.signals++;
      bump(agg.signals.byTradeType, d.tradeType ?? 'UNKNOWN');
      bump(agg.signals.byDirection, d.direction);
      bump(agg.signals.bySetup, d.setupType);
      bump(agg.signals.byRegime, d.regime?.regime ?? 'UNKNOWN');
      bump(agg.signals.bySymbol, symbol);
    }
  }
}

function pct(n: number, d: number) {
  return d ? ((n / d) * 100).toFixed(1) + '%' : '0%';
}

function printReport(agg: Agg, ranges: { symbol: string; from: number; to: number; m5: number }[], symbolCount: number) {
  const total = agg.total;
  console.log('\n════════════════════════════════════════════════════════════════════════');
  console.log('  DECISION FUNNEL REPORT — 100 assets × every 5-minute window');
  console.log('════════════════════════════════════════════════════════════════════════');
  const from = Math.min(...ranges.map((r) => r.from));
  const to = Math.max(...ranges.map((r) => r.to));
  console.log(`Symbols evaluated : ${symbolCount}`);
  console.log(`Total windows     : ${total.toLocaleString()}  (5M evaluations)`);
  console.log(`Date range (UTC)  : ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);
  console.log(`Portfolio state   : NEUTRAL (no open positions, 0% drawdown) — account-safety`);
  console.log(`                    gates CIRCUIT_BREAKER / EXPOSURE are pass-through by design.`);

  console.log('\n── 6-LAYER FUNNEL (cumulative pass counts) ─────────────────────────────');
  const layers: [string, DecisionGate[]][] = [
    ['L1 Data', ['NO_DATA']],
    ['L2 Account Safety', ['CIRCUIT_BREAKER', 'EXPOSURE']],
    ['L3 Regime', ['NO_REGIME', 'VOLATILITY']],
    ['L4 Setup', ['NO_SETUP']],
    ['L5 Entry', ['NO_ENTRY']],
    ['L6 Execution → Signal', ['LIQUIDITY', 'SPREAD', 'COST', 'RISK']]
  ];
  let passed = total;
  for (const [name, gates] of layers) {
    const rejected = gates.reduce((s, g) => s + (agg.landed[g] ?? 0), 0);
    passed -= rejected;
    console.log(`  ${name.padEnd(24)} passed=${String(passed).padStart(8)}  rejected@layer=${String(rejected).padStart(7)}  (${pct(passed, total)} of windows)`);
  }
  const signals = agg.landed['SIGNAL'] ?? 0;
  console.log(`  ${'SIGNAL (final)'.padEnd(24)} passed=${String(signals).padStart(8)}  (${pct(signals, total)} of windows)`);

  console.log('\n── DETAILED GATE FUNNEL ────────────────────────────────────────────────');
  let cum = total;
  console.log(`  ${'GATE'.padEnd(16)} ${'rejected'.padStart(9)} ${'passed-after'.padStart(13)} ${'%windows'.padStart(9)}`);
  for (const g of GATE_ORDER) {
    const r = agg.landed[g] ?? 0;
    cum -= r;
    console.log(`  ${g.padEnd(16)} ${String(r).padStart(9)} ${String(cum).padStart(13)} ${pct(r, total).padStart(9)}`);
  }
  console.log(`  ${'SIGNAL'.padEnd(16)} ${String(0).padStart(9)} ${String(signals).padStart(13)} ${pct(signals, total).padStart(9)}`);

  console.log('\n── REJECTION REASONS (top per gate) ───────────────────────────────────');
  for (const g of GATE_ORDER) {
    const reasons = agg.reasons[g];
    if (!reasons) continue;
    const sorted = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`\n  [${g}]  (${Object.values(reasons).reduce((a, b) => a + b, 0)} rejections)`);
    for (const [reason, c] of sorted) {
      console.log(`     ${String(c).padStart(7)}  ${reason.slice(0, 110)}`);
    }
  }

  console.log('\n── SIGNAL BREAKDOWN ───────────────────────────────────────────────────');
  const s = agg.signals;
  console.log(`  Total signals     : ${s.total.toLocaleString()} (${pct(s.total, total)} of all windows)`);
  console.log(`  By trade type     :`, JSON.stringify(s.byTradeType));
  console.log(`  By direction      :`, JSON.stringify(s.byDirection));
  console.log(`  By setup          :`, JSON.stringify(s.bySetup));
  console.log(`  By 1H regime      :`, JSON.stringify(s.byRegime));

  const top = Object.entries(s.bySymbol).sort((a, b) => b[1] - a[1]);
  console.log(`\n  Top 15 signal-generating symbols:`);
  for (const [sym, c] of top.slice(0, 15)) console.log(`     ${sym.padEnd(12)} ${String(c).padStart(6)} signals`);
  const bottom = top.slice(-10).reverse();
  console.log(`  Bottom 10 (fewest signals):`);
  for (const [sym, c] of bottom) console.log(`     ${sym.padEnd(12)} ${String(c).padStart(6)} signals`);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

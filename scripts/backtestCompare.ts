/**
 * Short, focused backtest comparison (§11/§12).
 * Fetches recent Bybit/Binance history for a few liquid symbols and runs the
 * SAME engine via runWalkForward, printing the combined metrics so we can
 * compare BEFORE vs AFTER the engine upgrade.
 *
 * Run:  npx tsx scripts/backtestCompare.ts
 * Env:  SYMS (comma list), FM_LIMIT, M15_LIMIT, H1_LIMIT, CONC, RISK
 */
import { runWalkForward, BacktestHistory } from '../src/services/intradayBacktest';
import { DEFAULT_INTRADAY_PARAMS } from '../src/services/intradayParams';
import type { Candle } from '../src/services/tradeEngine';

const BYBIT = 'https://api.bybit.com/v5/market';
const BINANCE = 'https://api.binance.com/api/v3';
const BINANCE_INTERVAL: Record<string, string> = { '5': '5m', '15': '15m', '60': '1h' };
const FM_LIMIT = Number(process.env.FM_LIMIT ?? 1000);
const M15_LIMIT = Number(process.env.M15_LIMIT ?? 500);
const H1_LIMIT = Number(process.env.H1_LIMIT ?? 250);
const CONC = Number(process.env.CONC ?? 4);
const RISK = Number(process.env.RISK ?? 0.5);
const SYMS = (process.env.SYMS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,AVAXUSDT,AAVEUSDT').split(',').map((s) => s.trim().toUpperCase());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fetchJson(url: string, tries = 4): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      const json = await res.json();
      if (json && json.retCode === 0) return json;
      lastErr = new Error(`retCode ${json?.retCode} ${json?.retMsg}`);
    } catch (e) { lastErr = e; }
    await sleep(250 * (i + 1));
  }
  throw lastErr;
}
function toCandles(list: any[]): Candle[] {
  return list.map((c) => ({ timestamp: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]) })).sort((a, b) => a.timestamp - b.timestamp);
}
async function fetchBybit(symbol: string, interval: string, limit: number): Promise<Candle[] | null> {
  try { const j = await fetchJson(`${BYBIT}/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`); return j.result?.list?.length ? toCandles(j.result.list) : null; } catch { return null; }
}
async function fetchBinance(symbol: string, interval: string, limit: number): Promise<Candle[] | null> {
  const bi = BINANCE_INTERVAL[interval] ?? `${interval}m`;
  try { const r = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${bi}&limit=${limit}`); const l: any[] = await r.json(); if (!Array.isArray(l) || !l.length) return null; return l.map((c) => ({ timestamp: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]) })).sort((a, b) => a.timestamp - b.timestamp); } catch { return null; }
}
async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  return (await fetchBybit(symbol, interval, limit)) || (await fetchBinance(symbol, interval, limit)) || [];
}

async function main() {
  console.log(`[bt] symbols=${SYMS.length} FM=${FM_LIMIT} risk=${RISK}`);
  const histories: BacktestHistory[] = [];
  const queue = [...SYMS];
  async function worker() {
    while (queue.length) {
      const symbol = queue.shift()!;
      const [h1, m15, m5] = await Promise.all([fetchKlines(symbol, '60', H1_LIMIT), fetchKlines(symbol, '15', M15_LIMIT), fetchKlines(symbol, '5', FM_LIMIT)]);
      if (m5.length < 500) { console.log(`[bt] ${symbol}: only ${m5.length} 5M, skip`); continue; }
      histories.push({ symbol, h1, m15, m5 });
      console.log(`[bt] ${symbol}: ok (5M=${m5.length})`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, SYMS.length) }, worker));

  let agg = {
    netProfitUsd: 0, totalTrades: 0, wins: 0, losses: 0, grossWin: 0, grossLoss: 0,
    fillStats: { signals: 0, pending: 0, filled: 0, missed: 0, partial: 0 }, holdSum: 0, equityCur: 10000, equityPeak: 10000, maxDD: 0
  };
  for (const h of histories) {
    const res = runWalkForward(h, { ...DEFAULT_INTRADAY_PARAMS, riskPerTradePercent: RISK }, { startEquity: 10000, seed: 12345, spreadPercent: 0.03 });
    const m = res.combined;
    agg.netProfitUsd += m.netProfitUsd;
    agg.totalTrades += m.totalTrades;
    agg.wins += m.wins;
    agg.losses += m.losses;
    agg.grossWin += m.bySetup ? 0 : 0;
    agg.fillStats.signals += m.fillStats.signals;
    agg.fillStats.filled += m.fillStats.filled;
    agg.fillStats.missed += m.fillStats.missed;
    agg.fillStats.partial += m.fillStats.partial;
    agg.holdSum += m.avgHoldMinutes * m.totalTrades;
    agg.equityCur += m.netProfitUsd;
    agg.equityPeak = Math.max(agg.equityPeak, agg.equityCur);
    agg.maxDD = Math.max(agg.maxDD, agg.equityPeak > 0 ? ((agg.equityPeak - agg.equityCur) / agg.equityPeak) * 100 : 0);
  }
  const total = agg.totalTrades;
  const winRate = total ? (agg.wins / total) * 100 : 0;
  const grossWin = 0; // not tracked per-trade here; PF from metrics below
  const pf = (() => {
    // recompute PF from combined metrics per symbol
    let gw = 0, gl = 0;
    for (const h of histories) {
      const m = runWalkForward(h, { ...DEFAULT_INTRADAY_PARAMS, riskPerTradePercent: RISK }, { startEquity: 10000, seed: 12345, spreadPercent: 0.03 }).combined;
      // approximate: use netProfit and win/loss counts
    }
    return 0;
  })();
  console.log('\n════════ BACKTEST (combined) ══════════');
  console.log(`Symbols            : ${histories.map((h) => h.symbol).join(', ')}`);
  console.log(`Signals generated  : ${agg.fillStats.signals}`);
  console.log(`Filled             : ${agg.fillStats.filled}`);
  console.log(`Missed (TTL)       : ${agg.fillStats.missed}`);
  console.log(`Total trades       : ${agg.totalTrades}`);
  console.log(`Win rate           : ${winRate.toFixed(1)}%`);
  console.log(`Net PnL (sum)      : ${agg.netProfitUsd.toFixed(2)} $`);
  console.log(`Avg holding time   : ${total ? (agg.holdSum / total).toFixed(1) : 0} min`);
  console.log(`Max drawdown (agg) : ${agg.maxDD.toFixed(2)}%`);
  console.log(`(Per-symbol PF/expectancy printed below)`);
  for (const h of histories) {
    const m = runWalkForward(h, { ...DEFAULT_INTRADAY_PARAMS, riskPerTradePercent: RISK }, { startEquity: 10000, seed: 12345, spreadPercent: 0.03 }).combined;
    console.log(`  ${h.symbol.padEnd(10)} trades=${String(m.totalTrades).padStart(4)} WR=${m.winRate.toFixed(0).padStart(3)}% PF=${m.profitFactor} Exp=${m.expectancyUsd} Net=${m.netProfitUsd.toFixed(1)} DD=${m.maxDrawdownPercent.toFixed(1)}% hold=${m.avgHoldMinutes}min`);
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

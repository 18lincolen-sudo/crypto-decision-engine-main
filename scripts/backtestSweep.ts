/**
 * Longer-horizon backtest + parameter sweep to find better filtering (§49).
 * Fetches ~N days of real Binance 5M/15M/1H history per symbol (paginated),
 * then runs runWalkForward across a small grid of setupScoreMin/entryScoreMin/
 * minRewardRisk/riskPerTradePercent, ranking by combined profit factor &
 * expectancy so we can identify which symbols/params actually hold an edge.
 *
 * Run:  npx tsx scripts/backtestSweep.ts
 * Env:  DAYS (default 120), SYMS (comma list), CONC
 */
import { runWalkForward, BacktestHistory } from '../src/services/intradayBacktest';
import { DEFAULT_INTRADAY_PARAMS, IntradayParams } from '../src/services/intradayParams';
import type { Candle } from '../src/services/tradeEngine';

const BINANCE = 'https://api.binance.com/api/v3';
const DAYS = Number(process.env.DAYS ?? 120);
const CONC = Number(process.env.CONC ?? 4);
const SYMS = (process.env.SYMS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,AVAXUSDT,AAVEUSDT').split(',').map((s) => s.trim().toUpperCase());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchKlinesPaged(symbol: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard < 2000) {
    guard++;
    const url = `${BINANCE}/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    let list: any[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url);
        list = await r.json();
        if (Array.isArray(list)) break;
      } catch { /* retry */ }
      await sleep(300 * (attempt + 1));
    }
    if (!Array.isArray(list) || !list.length) break;
    for (const c of list) {
      out.push({ timestamp: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]) });
    }
    const lastTs = Number(list[list.length - 1][0]);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    if (list.length < 1000) break;
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchHistory(symbol: string, days: number): Promise<BacktestHistory | null> {
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  const [h1, m15, m5] = await Promise.all([
    fetchKlinesPaged(symbol, '1h', start, end),
    fetchKlinesPaged(symbol, '15m', start, end),
    fetchKlinesPaged(symbol, '5m', start, end)
  ]);
  if (m5.length < 500) return null;
  return { symbol, h1, m15, m5 };
}

// ── Parameter grid ────────────────────────────────────────────────────────
const SETUP_MIN = [42, 46, 50];
const ENTRY_MIN = [46, 50, 54];
const MIN_RR = [1.2, 1.5];
const RISK_PCT = [0.5];

interface Combo { setupScoreMin: number; entryScoreMin: number; minRewardRisk: number; riskPerTradePercent: number }
function buildGrid(): Combo[] {
  const out: Combo[] = [];
  for (const s of SETUP_MIN) for (const e of ENTRY_MIN) for (const rr of MIN_RR) for (const rp of RISK_PCT) {
    out.push({ setupScoreMin: s, entryScoreMin: e, minRewardRisk: rr, riskPerTradePercent: rp });
  }
  return out;
}

interface ComboResult extends Combo {
  totalTrades: number;
  winRate: number;
  netProfitUsd: number;
  profitFactorAvg: number;
  expectancyAvg: number;
  bySymbol: Record<string, { trades: number; net: number; wr: number; pf: number }>;
}

async function main() {
  console.log(`[sweep] fetching ${DAYS}d history for ${SYMS.length} symbols from Binance...`);
  const histories: BacktestHistory[] = [];
  const queue = [...SYMS];
  async function worker() {
    while (queue.length) {
      const symbol = queue.shift()!;
      const h = await fetchHistory(symbol, DAYS);
      if (!h) { console.log(`[sweep] ${symbol}: insufficient data, skip`); continue; }
      histories.push(h);
      console.log(`[sweep] ${symbol}: ok (5M=${h.m5.length} 15M=${h.m15.length} 1H=${h.h1.length})`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, SYMS.length) }, worker));

  const grid = buildGrid();
  console.log(`[sweep] running ${grid.length} param combos x ${histories.length} symbols = ${grid.length * histories.length} backtests...`);

  const results: ComboResult[] = [];
  for (const combo of grid) {
    const params: IntradayParams = { ...DEFAULT_INTRADAY_PARAMS, ...combo };
    let totalTrades = 0, wins = 0, netProfitUsd = 0, pfSum = 0, pfCount = 0, expSum = 0;
    const bySymbol: ComboResult['bySymbol'] = {};
    for (const h of histories) {
      const res = runWalkForward(h, params, { startEquity: 10000, seed: 12345, spreadPercent: 0.03 });
      const m = res.combined;
      totalTrades += m.totalTrades;
      wins += m.wins;
      netProfitUsd += m.netProfitUsd;
      if (m.totalTrades > 0) { pfSum += m.profitFactor; pfCount++; expSum += m.expectancyUsd; }
      bySymbol[h.symbol] = { trades: m.totalTrades, net: m.netProfitUsd, wr: m.winRate, pf: m.profitFactor };
    }
    results.push({
      ...combo,
      totalTrades,
      winRate: totalTrades ? (wins / totalTrades) * 100 : 0,
      netProfitUsd,
      profitFactorAvg: pfCount ? pfSum / pfCount : 0,
      expectancyAvg: pfCount ? expSum / pfCount : 0,
      bySymbol
    });
  }

  results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

  console.log('\n════════ TOP 10 PARAM COMBOS BY NET PROFIT (all symbols combined) ══════════');
  for (const r of results.slice(0, 10)) {
    console.log(`setup>=${r.setupScoreMin} entry>=${r.entryScoreMin} minRR=${r.minRewardRisk} risk=${r.riskPerTradePercent}%  | trades=${r.totalTrades} WR=${r.winRate.toFixed(1)}% avgPF=${r.profitFactorAvg.toFixed(2)} avgExp=${r.expectancyAvg.toFixed(2)} NET=${r.netProfitUsd.toFixed(1)}$`);
  }

  console.log('\n════════ PER-SYMBOL EDGE (best combo overall) ══════════');
  const best = results[0];
  for (const [sym, s] of Object.entries(best.bySymbol)) {
    console.log(`  ${sym.padEnd(10)} trades=${String(s.trades).padStart(4)} WR=${s.wr.toFixed(0).padStart(3)}% PF=${s.pf.toFixed(2)} Net=${s.net.toFixed(1)}$`);
  }

  console.log('\n════════ SYMBOL EDGE ACROSS ALL COMBOS (avg PF, avg net) ══════════');
  const symAgg: Record<string, { pfSum: number; netSum: number; n: number }> = {};
  for (const r of results) {
    for (const [sym, s] of Object.entries(r.bySymbol)) {
      if (!symAgg[sym]) symAgg[sym] = { pfSum: 0, netSum: 0, n: 0 };
      symAgg[sym].pfSum += s.pf;
      symAgg[sym].netSum += s.net;
      symAgg[sym].n++;
    }
  }
  const symRanked = Object.entries(symAgg).map(([sym, a]) => ({ sym, avgPf: a.pfSum / a.n, avgNet: a.netSum / a.n })).sort((a, b) => b.avgNet - a.avgNet);
  for (const s of symRanked) {
    console.log(`  ${s.sym.padEnd(10)} avgPF=${s.avgPf.toFixed(2)} avgNet(perCombo)=${s.avgNet.toFixed(1)}$`);
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

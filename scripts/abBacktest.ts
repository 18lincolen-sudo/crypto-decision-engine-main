/**
 * A/B measurement harness for engine changes (PLAN_ENGINE_FIXES.md — שלב 4).
 *
 * WHY THIS EXISTS
 * ---------------
 * `runBacktestSweep()` is a *calibration* tool: it fetches a window relative to
 * `Date.now()` and sweeps an SL grid. Neither property is acceptable for A/B
 * work — two runs a day apart see different data, and a grid confounds "the
 * change helped" with "a different grid point won". This harness fixes both:
 *
 *   1. `snapshot` downloads candles for an EXPLICIT absolute date range once
 *      and writes them to disk. Every later run replays that exact file.
 *   2. `run` uses ONE fixed SlConfig, so the only thing that differs between
 *      a baseline run and a post-change run is the engine code itself.
 *
 * USAGE
 * -----
 *   npx tsx scripts/abBacktest.ts snapshot --from 2025-01-01 --to 2025-07-01
 *   npx tsx scripts/abBacktest.ts run --label baseline --engine pro
 *   # ... apply an engine change ...
 *   npx tsx scripts/abBacktest.ts run --label kelly-r --engine pro
 *   npx tsx scripts/abBacktest.ts compare baseline kelly-r
 *
 * Snapshots and results live in `backtest-ab/` (gitignored). A snapshot is
 * meant to be kept for the life of the comparison: re-downloading it changes
 * the yardstick and invalidates every earlier run measured against it.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPortfolioBacktest, runBacktest, type SlConfig, type EngineType } from '../server/backtestRunner.js';

const OUT_DIR = join(process.cwd(), 'backtest-ab');
const BINANCE = 'https://api.binance.com/api/v3';

// The fixed comparison basket. Chosen for liquidity and for spanning a range
// of volatility regimes (BTC/ETH low, SOL/AVAX mid, DOGE high) so a change
// that only helps one volatility bucket cannot hide inside the average.
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'DOGEUSDT', 'LINKUSDT'];

// One fixed point, NOT a grid. These are the runner's own mid-grid defaults;
// what matters is only that every run uses the identical value.
const FIXED_SL: SlConfig = { minStop: 1.5, maxStop: 4.0, softTrendBase: 60 };

interface Candle {
  timestamp: number; open: number; high: number; low: number; close: number; volume: number;
}

interface Snapshot {
  createdAt: string;
  from: string;
  to: string;
  symbols: string[];
  histories: { symbol: string; candles: Candle[] }[];
}

interface Metrics {
  label: string;
  engine: EngineType;
  snapshotFrom: string;
  snapshotTo: string;
  ranAt: string;
  gitCommit: string;
  totalTrades: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  /** mean(pnl) / stdev(pnl) across trades. NOT an annualised time-series
   *  Sharpe — there is no equity time axis here, only a trade sequence.
   *  Comparable between runs on the same snapshot, which is all we need. */
  sharpePerTrade: number;
  pnlStdev: number;
  largestWin: number;
  largestLoss: number;
  /** Populated only once ClosedTradeRecord carries riskUsd (PLAN שלב 1).
   *  Until then this is null and the R-multiple row reports "unavailable" —
   *  which is honest: R-multiples cannot be reconstructed after the fact. */
  rMultiples: RMultipleStats | null;
}

interface RMultipleStats {
  mean: number; median: number; stdev: number; p25: number; p75: number;
  best: number; worst: number; sampleSize: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required argument --${name}`);
}

function gitCommit(): string {
  try {
    // Read HEAD directly rather than shelling out — keeps the harness usable
    // in environments where spawning git is restricted.
    const head = readFileSync(join(process.cwd(), '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      return readFileSync(join(process.cwd(), '.git', head.slice(5)), 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return 'unknown';
  }
}

// ── snapshot ───────────────────────────────────────────────────────────────

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard++ < 2000) {
    const url = `${BINANCE}/klines?symbol=${symbol}&interval=1h&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows as unknown[][]) {
      out.push({
        timestamp: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
        low: Number(r[3]), close: Number(r[4]), volume: Number(r[5])
      });
    }
    const last = out[out.length - 1].timestamp;
    if (last <= cursor) break;
    cursor = last + 1;
    await new Promise((r) => setTimeout(r, 250)); // stay well inside the public rate limit
  }
  return out;
}

async function cmdSnapshot() {
  const from = arg('from');
  const to = arg('to');
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error('--from/--to must be YYYY-MM-DD');
  if (endMs <= startMs) throw new Error('--to must be after --from');

  const histories: { symbol: string; candles: Candle[] }[] = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`  ${symbol} ... `);
    const candles = await fetchKlines(symbol, startMs, endMs);
    if (candles.length < 200) {
      console.log(`skipped (${candles.length} bars, need 200+)`);
      continue;
    }
    histories.push({ symbol, candles });
    console.log(`${candles.length} bars`);
  }
  if (!histories.length) throw new Error('no symbol had enough data');

  const snap: Snapshot = { createdAt: new Date().toISOString(), from, to, symbols: histories.map((h) => h.symbol), histories };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snap));
  console.log(`\nsnapshot → ${path}`);
  console.log(`${histories.length} symbols, ${histories.reduce((s, h) => s + h.candles.length, 0)} bars, ${from} → ${to}`);
  console.log('\nKeep this file. Re-running `snapshot` changes the yardstick and');
  console.log('invalidates every result already measured against it.');
}

// ── run ────────────────────────────────────────────────────────────────────

async function cmdRun() {
  const label = arg('label');
  const engine = arg('engine', 'pro') as EngineType;
  if (engine !== 'pro' && engine !== 'legacy') throw new Error('--engine must be pro or legacy');

  const snapPath = join(OUT_DIR, 'snapshot.json');
  if (!existsSync(snapPath)) throw new Error(`no snapshot at ${snapPath} — run the snapshot command first`);
  const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;

  console.log(`replaying ${snap.histories.length} symbols (${snap.from} → ${snap.to}), engine=${engine}`);
  const t0 = Date.now();
  const result = snap.histories.length > 1
    ? await runPortfolioBacktest(snap.histories, FIXED_SL, engine)
    : await runBacktest(snap.histories[0].symbol, snap.histories[0].candles, FIXED_SL, engine);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const pnls = result.closedTrades.map((t) => t.pnl);
  const sd = stdev(pnls);

  // R-multiples need risk-at-entry, which ClosedTradeRecord does not carry yet
  // (PLAN שלב 1 adds it). Detect rather than assume: the field is optional.
  const withRisk = result.closedTrades.filter(
    (t) => typeof (t as { riskUsd?: number }).riskUsd === 'number' && (t as { riskUsd?: number }).riskUsd! > 0
  );
  let rStats: RMultipleStats | null = null;
  if (withRisk.length === result.closedTrades.length && withRisk.length > 0) {
    const rs = withRisk.map((t) => t.pnl / (t as { riskUsd: number }).riskUsd).sort((a, b) => a - b);
    rStats = {
      mean: mean(rs), median: quantile(rs, 0.5), stdev: stdev(rs),
      p25: quantile(rs, 0.25), p75: quantile(rs, 0.75),
      best: rs[rs.length - 1], worst: rs[0], sampleSize: rs.length
    };
  }

  const metrics: Metrics = {
    label, engine,
    snapshotFrom: snap.from, snapshotTo: snap.to,
    ranAt: new Date().toISOString(), gitCommit: gitCommit(),
    totalTrades: result.totalTrades,
    winRate: result.winRate,
    netProfit: result.netProfit,
    profitFactor: Number.isFinite(result.profitFactor) ? result.profitFactor : 0,
    expectancy: result.expectancy,
    maxDrawdown: result.maxDrawdown,
    sharpePerTrade: sd > 0 ? mean(pnls) / sd : 0,
    pnlStdev: sd,
    largestWin: pnls.length ? Math.max(...pnls) : 0,
    largestLoss: pnls.length ? Math.min(...pnls) : 0,
    rMultiples: rStats
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `run-${label}.json`);
  writeFileSync(path, JSON.stringify(metrics, null, 2));

  console.log(`\n${label} (${engine}, commit ${metrics.gitCommit})`);
  console.log(`  trades         ${metrics.totalTrades}`);
  console.log(`  win rate       ${metrics.winRate.toFixed(1)}%`);
  console.log(`  net profit     $${metrics.netProfit.toFixed(2)}`);
  console.log(`  profit factor  ${metrics.profitFactor.toFixed(3)}`);
  console.log(`  expectancy     $${metrics.expectancy.toFixed(2)}`);
  console.log(`  max drawdown   ${metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`  sharpe/trade   ${metrics.sharpePerTrade.toFixed(3)}`);
  console.log(`  R-multiples    ${rStats ? `mean ${rStats.mean.toFixed(2)}R, median ${rStats.median.toFixed(2)}R, sd ${rStats.stdev.toFixed(2)}` : 'unavailable (riskUsd not recorded — see PLAN שלב 1)'}`);
  console.log(`\n→ ${path}`);
}

// ── compare ────────────────────────────────────────────────────────────────

// Direction each metric should move for the change to count as an improvement.
const HIGHER_IS_BETTER: Record<string, boolean> = {
  winRate: true, netProfit: true, profitFactor: true, expectancy: true,
  maxDrawdown: false, sharpePerTrade: true
};

function cmdCompare() {
  const [, , , aLabel, bLabel] = process.argv;
  if (!aLabel || !bLabel) throw new Error('usage: compare <baseline-label> <candidate-label>');

  const load = (l: string): Metrics => {
    const p = join(OUT_DIR, `run-${l}.json`);
    if (!existsSync(p)) throw new Error(`no run at ${p}`);
    return JSON.parse(readFileSync(p, 'utf8')) as Metrics;
  };
  const a = load(aLabel);
  const b = load(bLabel);

  if (a.snapshotFrom !== b.snapshotFrom || a.snapshotTo !== b.snapshotTo) {
    console.error('REFUSING TO COMPARE: the two runs used different snapshot windows.');
    console.error(`  ${a.label}: ${a.snapshotFrom} → ${a.snapshotTo}`);
    console.error(`  ${b.label}: ${b.snapshotFrom} → ${b.snapshotTo}`);
    process.exit(1);
  }
  if (a.engine !== b.engine) {
    console.error(`REFUSING TO COMPARE: different engines (${a.engine} vs ${b.engine}).`);
    process.exit(1);
  }

  console.log(`\n${a.engine}   ${a.snapshotFrom} → ${a.snapshotTo}`);
  console.log(`baseline  ${a.label} @ ${a.gitCommit}`);
  console.log(`candidate ${b.label} @ ${b.gitCommit}\n`);

  const row = (name: string, av: number, bv: number, digits = 2, suffix = '') => {
    const delta = bv - av;
    const better = HIGHER_IS_BETTER[name];
    const mark = delta === 0 ? ' ' : better === undefined ? '·' : (delta > 0) === better ? '+' : '-';
    console.log(
      `  ${mark} ${name.padEnd(15)}${av.toFixed(digits).padStart(11)}${suffix}` +
      `${bv.toFixed(digits).padStart(13)}${suffix}` +
      `${(delta >= 0 ? '+' : '') + delta.toFixed(digits)}`.padStart(12)
    );
  };

  console.log(`    ${'metric'.padEnd(15)}${'baseline'.padStart(11)}${'candidate'.padStart(14)}${'delta'.padStart(12)}`);
  row('totalTrades', a.totalTrades, b.totalTrades, 0);
  row('winRate', a.winRate, b.winRate, 1, '%');
  row('netProfit', a.netProfit, b.netProfit, 2);
  row('profitFactor', a.profitFactor, b.profitFactor, 3);
  row('expectancy', a.expectancy, b.expectancy, 2);
  row('maxDrawdown', a.maxDrawdown, b.maxDrawdown, 2, '%');
  row('sharpePerTrade', a.sharpePerTrade, b.sharpePerTrade, 3);

  if (a.rMultiples && b.rMultiples) {
    console.log('');
    row('R mean', a.rMultiples.mean, b.rMultiples.mean, 3);
    row('R median', a.rMultiples.median, b.rMultiples.median, 3);
    row('R stdev', a.rMultiples.stdev, b.rMultiples.stdev, 3);
  } else {
    console.log('\n  R-multiples unavailable in at least one run (riskUsd not recorded).');
  }

  // A change in trade count means the change altered WHICH trades were taken,
  // not just how they were sized. PnL deltas then compare two different
  // strategies, not two versions of one — worth saying out loud.
  const tradeDelta = a.totalTrades ? Math.abs(b.totalTrades - a.totalTrades) / a.totalTrades : 0;
  if (tradeDelta > 0.1) {
    console.log(`\n  ⚠ trade count moved ${(tradeDelta * 100).toFixed(0)}% — the change altered which`);
    console.log('    trades were taken, not only their size. PnL deltas below compare two');
    console.log('    different strategies; judge on expectancy and R, not net profit.');
  }
  console.log('');
}

// ── main ───────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
const run =
  cmd === 'snapshot' ? cmdSnapshot :
  cmd === 'run' ? cmdRun :
  cmd === 'compare' ? async () => cmdCompare() :
  null;

if (!run) {
  console.error('usage: abBacktest.ts <snapshot|run|compare> [...]');
  console.error('  snapshot --from YYYY-MM-DD --to YYYY-MM-DD');
  console.error('  run --label <name> [--engine pro|legacy]');
  console.error('  compare <baseline-label> <candidate-label>');
  process.exit(1);
}
run().catch((e) => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1); });

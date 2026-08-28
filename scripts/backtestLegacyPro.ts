/**
 * Walk-forward backtest for Legacy (tradeEngine.ts) and Pro (proAlgEngine.ts)
 * engines. Fetches real Binance H1 history, runs the full decision pipeline
 * (regime → signals → routing → risk → exit) bar-by-bar with no lookahead,
 * and sweeps MIN_STOP_PERCENT / MAX_STOP_PERCENT / softTrendBase to find the
 * parameter combination that best holds an edge.
 *
 * Run:  npx tsx scripts/backtestLegacyPro.ts
 * Env:  ENGINE=legacy|pro (default legacy), DAYS (default 120),
 *       SYMS (comma list), CONC (parallel fetches, default 4)
 */
import { runBacktestSweep, EngineType } from '../src/services/backtestRunner';

const ENGINE: EngineType = (process.env.ENGINE as EngineType) ?? 'legacy';
const DAYS = Number(process.env.DAYS ?? 120);
const CONC = Number(process.env.CONC ?? 4);
const SYMS = (process.env.SYMS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,AVAXUSDT,AAVEUSDT').split(',').map((s) => s.trim().toUpperCase());

async function main() {
  console.log(`[backtest] engine=${ENGINE}, days=${DAYS}, symbols=${SYMS.length}`);

  const results = await runBacktestSweep({
    engine: ENGINE,
    days: DAYS,
    symbols: SYMS,
    concurrency: CONC,
    onProgress: (msg) => console.log(`[backtest] ${msg}`),
  });

  console.log('\n════════ SL PARAMETER SWEEP RESULTS ══════════════════════════════════');
  console.log(`Engine: ${ENGINE.toUpperCase()} | Symbols: ${SYMS.length} | Days: ${DAYS}`);
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log(`${'Min SL'.padEnd(8)} ${'Max SL'.padEnd(8)} ${'SoftBase'.padEnd(10)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'Net $'.padEnd(10)} ${'PF'.padEnd(8)} ${'Exp $'.padEnd(8)} ${'MaxDD%'.padEnd(8)}`);
  console.log('────────────────────────────────────────────────────────────────────────');
  for (const r of results) {
    console.log(
      `${r.minStop.toFixed(1)}%`.padEnd(8) +
      `${r.maxStop.toFixed(1)}%`.padEnd(8) +
      `${r.softTrendBase}`.padEnd(10) +
      `${r.totalTrades}`.padEnd(8) +
      `${r.winRate.toFixed(1)}%`.padEnd(8) +
      `${r.netProfit.toFixed(0)}$`.padEnd(10) +
      `${r.profitFactor.toFixed(2)}`.padEnd(8) +
      `${r.expectancy.toFixed(1)}$`.padEnd(8) +
      `${r.maxDrawdown.toFixed(1)}%`.padEnd(8)
    );
  }

  const best = results[0];
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log(`BEST: MIN_STOP=${best.minStop}%, MAX_STOP=${best.maxStop}%, SOFT_BASE=${best.softTrendBase} → PF=${best.profitFactor.toFixed(2)}, Net=$${best.netProfit.toFixed(0)}, WR=${best.winRate.toFixed(1)}%`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

/**
 * Walk-forward backtest for Legacy (tradeEngine.ts) and Pro (proAlgEngine.ts)
 * engines. Fetches real Binance H1 history, runs the full decision pipeline
 * (regime → signals → routing → risk → exit) bar-by-bar with no lookahead,
 * and sweeps MIN_STOP_PERCENT / MAX_STOP_PERCENT to find the SL window that
 * best holds an edge.
 *
 * Run:  npx tsx scripts/backtestLegacyPro.ts
 * Env:  ENGINE=legacy|pro (default legacy), DAYS (default 120),
 *       SYMS (comma list), CONC (parallel fetches, default 4)
 */
import {
  Candle,
  detectMarketRegime,
  evaluateSignals,
  routeTradeType,
  calculateRiskParameters,
  evaluateExit,
  calculateATR,
  calculateADX,
  calculateSupertrend,
  computeRelativeVolume,
  ClosedTradeMetric,
  ActivePosition,
  TradeSide,
  VolatilityRegimeType,
} from '../src/services/tradeEngine';
import {
  detectProRegime,
  evaluateProSignals,
  routeProTradeType,
  calculateProRisk,
  evaluateProExit,
  ProActivePosition,
  ProRouterResult,
  ProSignalResult,
  ProMarketRegimeResult,
} from '../src/services/proAlgEngine';
import { summarizeRecentPerformance, sizingMultiplierFromHistory, streakCooldownFromHistory, MIN_STOP_PERCENT, MAX_STOP_PERCENT } from '../src/services/adaptiveRisk';

type EngineType = 'legacy' | 'pro';

const BINANCE = 'https://api.binance.com/api/v3';
const ENGINE: EngineType = (process.env.ENGINE as EngineType) ?? 'legacy';
const DAYS = Number(process.env.DAYS ?? 120);
const CONC = Number(process.env.CONC ?? 4);
const SYMS = (process.env.SYMS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,AVAXUSDT,AAVEUSDT').split(',').map((s) => s.trim().toUpperCase());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Binance fetch (same pattern as backtestSweep.ts) ───────────────────────
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
        list = (await r.json()) as any[];
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

// ── SL parameter grid ──────────────────────────────────────────────────────
interface SlConfig { minStop: number; maxStop: number }

function buildSlGrid(): SlConfig[] {
  // Sweep: [floor, ceiling] pairs to test
  return [
    { minStop: 1, maxStop: 4 },
    { minStop: 1.5, maxStop: 6 },  // proposed default
    { minStop: 2, maxStop: 8 },
    { minStop: 1, maxStop: 8 },
    { minStop: 2, maxStop: 6 },
  ];
}

// ── Simulation state ───────────────────────────────────────────────────────
interface SimPosition {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: TradeSide;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number | undefined;
  takeProfit2: number | undefined;
  quantity: number;
  leverage: number;
  openTimestamp: number;
  highestPrice: number;
  lowestPrice: number;
  tp1Hit: boolean;
  sizeUsd: number;
}

interface SimState {
  cash: number;
  positions: SimPosition[];
  closedTrades: ClosedTradeMetric[];
  totalFees: number;
  peakEquity: number;
  maxDrawdown: number;
}

function initState(): SimState {
  return {
    cash: 10000,
    positions: [],
    closedTrades: [],
    totalFees: 0,
    peakEquity: 10000,
    maxDrawdown: 0,
  };
}

function equity(state: SimState, prices: Record<string, number>): number {
  let eq = state.cash;
  for (const p of state.positions) {
    const price = prices[p.symbol] ?? p.entryPrice;
    if (p.type === 'SPOT') {
      eq += p.quantity * price;
    } else {
      // Futures: PnL = quantity * (current - entry) * direction
      const dir = p.side === 'LONG' ? 1 : -1;
      eq += p.quantity * (price - p.entryPrice) * dir;
    }
  }
  return eq;
}

// ── Per-bar evaluation ─────────────────────────────────────────────────────
function getAtr(candles: Candle[], idx: number, period: number = 14): number {
  if (idx < period) return 0;
  const slice = candles.slice(0, idx + 1);
  return calculateATR(slice, period).atr;
}

function getAdx(candles: Candle[], idx: number, period: number = 14): number {
  if (idx < period * 2) return 0;
  const slice = candles.slice(0, idx + 1);
  return calculateADX(slice, period);
}

function getSupertrend(candles: Candle[], idx: number): { value: number; direction: 'BULL' | 'BEAR' } {
  const slice = candles.slice(0, idx + 1);
  return calculateSupertrend(slice);
}

function legacyEvaluate(
  symbol: string,
  candles: Candle[],
  idx: number,
  state: SimState
): { willExecute: boolean; tradeType: 'SPOT' | 'FUTURES' | 'HOLD'; side: TradeSide; signalScore: number; reason: string } {
  if (idx < 50) return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: 0, reason: 'insufficient data' };

  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;

  const regime = detectMarketRegime(slice, currentPrice);
  const signalResult = evaluateSignals(slice, currentPrice, symbol);
  const routeResult = routeTradeType(
    { action: signalResult.action, signalScore: signalResult.signalScore, symbol, confidence: signalResult.signalScore },
    regime,
    { hasExistingFutures: state.positions.some(p => p.symbol === symbol && p.type === 'FUTURES'), hasExistingSpot: state.positions.some(p => p.symbol === symbol && p.type === 'SPOT') }
  );

  if (routeResult.type === 'HOLD') {
    return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: signalResult.signalScore, reason: routeResult.reason };
  }

  const side: TradeSide = routeResult.side;
  return {
    willExecute: true,
    tradeType: routeResult.type,
    side,
    signalScore: signalResult.signalScore,
    reason: routeResult.reason,
  };
}

function proEvaluate(
  symbol: string,
  candles: Candle[],
  idx: number,
  state: SimState
): { willExecute: boolean; tradeType: 'SPOT' | 'FUTURES' | 'HOLD'; side: TradeSide; signalScore: number; reason: string } {
  if (idx < 50) return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: 0, reason: 'insufficient data' };

  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;

  const regime = detectProRegime(slice, currentPrice);
  const signalResult = evaluateProSignals(slice, currentPrice, symbol);
  const routeResult = routeProTradeType(
    signalResult,
    regime,
    { hasExistingFutures: state.positions.some(p => p.symbol === symbol && p.type === 'FUTURES'), hasExistingSpot: state.positions.some(p => p.symbol === symbol && p.type === 'SPOT') }
  );

  if (routeResult.type === 'HOLD') {
    return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: signalResult.rawConfidence, reason: routeResult.reason };
  }

  const side: TradeSide = routeResult.side as TradeSide;
  return {
    willExecute: true,
    tradeType: routeResult.type,
    side,
    signalScore: signalResult.rawConfidence,
    reason: routeResult.reason,
  };
}

// ── Exit check ─────────────────────────────────────────────────────────────
function checkExitLegacy(
  pos: SimPosition,
  candle: Candle,
  candles: Candle[],
  idx: number,
  state: SimState
): { shouldExit: boolean; exitType: 'FULL' | 'PARTIAL_50' | 'NONE'; pnl: number } {
  const activePos: ActivePosition = {
    id: `${pos.symbol}-${pos.openTimestamp}`,
    symbol: pos.symbol,
    type: pos.type,
    side: pos.side,
    entryPrice: pos.entryPrice,
    stopLoss: pos.stopLoss,
    takeProfit1: pos.takeProfit1,
    takeProfit2: pos.takeProfit2,
    quantity: pos.quantity,
    leverage: pos.leverage,
    openTimestamp: pos.openTimestamp,
    highestPrice: pos.highestPrice,
    lowestPrice: pos.lowestPrice,
    tp1Hit: pos.tp1Hit,
  };

  const currentAtr = getAtr(candles, idx);
  const eq = equity(state, { [pos.symbol]: candle.close });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;

  const exitResult = evaluateExit(
    activePos,
    candle.close,
    currentAtr,
    { buy: 50, sell: 50 },
    { dailyDrawdownPercent: dailyDD, weeklyDrawdownPercent: dailyDD, systemLocked: false, adx: getAdx(candles, idx) }
  );

  if (!exitResult.shouldExit) return { shouldExit: false, exitType: 'NONE', pnl: 0 };

  // Calculate PnL
  let pnl = 0;
  if (pos.type === 'SPOT') {
    pnl = (candle.close - pos.entryPrice) * pos.quantity;
  } else {
    const dir = pos.side === 'LONG' ? 1 : -1;
    pnl = (candle.close - pos.entryPrice) * pos.quantity * dir * pos.leverage;
  }

  return { shouldExit: true, exitType: exitResult.exitType, pnl };
}

function checkExitPro(
  pos: SimPosition,
  candle: Candle,
  candles: Candle[],
  idx: number,
  state: SimState
): { shouldExit: boolean; exitType: 'FULL' | 'PARTIAL_50' | 'NONE'; pnl: number } {
  const activePos: ProActivePosition = {
    id: `${pos.symbol}-${pos.openTimestamp}`,
    symbol: pos.symbol,
    type: pos.type,
    side: pos.side,
    entryPrice: pos.entryPrice,
    stopLoss: pos.stopLoss,
    takeProfit1: pos.takeProfit1,
    takeProfit2: pos.takeProfit2,
    quantity: pos.quantity,
    leverage: pos.leverage,
    openTimestamp: pos.openTimestamp,
    highestPrice: pos.highestPrice,
    lowestPrice: pos.lowestPrice,
    tp1Hit: pos.tp1Hit,
  };

  const currentAtr = getAtr(candles, idx);
  const eq = equity(state, { [pos.symbol]: candle.close });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;

  const exitResult = evaluateProExit(
    activePos,
    candle.close,
    currentAtr,
    { buy: 50, sell: 50 },
    { dailyDrawdownPercent: dailyDD, weeklyDrawdownPercent: dailyDD, systemLocked: false }
  );

  if (!exitResult.shouldExit) return { shouldExit: false, exitType: 'NONE', pnl: 0 };

  let pnl = 0;
  if (pos.type === 'SPOT') {
    pnl = (candle.close - pos.entryPrice) * pos.quantity;
  } else {
    const dir = pos.side === 'LONG' ? 1 : -1;
    pnl = (candle.close - pos.entryPrice) * pos.quantity * dir * pos.leverage;
  }

  return { shouldExit: true, exitType: exitResult.exitType, pnl };
}

// ── Open position ──────────────────────────────────────────────────────────
function openPositionLegacy(
  symbol: string,
  candles: Candle[],
  idx: number,
  state: SimState,
  tradeType: 'SPOT' | 'FUTURES',
  side: TradeSide,
  signalScore: number,
  slConfig: SlConfig
): SimPosition | null {
  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;
  const atr = getAtr(candles, idx);
  if (atr <= 0) return null;

  const regime = detectMarketRegime(slice, currentPrice);
  const eq = equity(state, { [symbol]: currentPrice });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;

  const perf = summarizeRecentPerformance(state.closedTrades);
  const mult = sizingMultiplierFromHistory(perf, dailyDD);

  const risk = calculateRiskParameters(
    currentPrice,
    tradeType,
    side,
    atr,
    regime.volatility,
    signalScore,
    eq,
    state.closedTrades,
    state.positions.length,
    state.positions.filter(p => p.type === 'FUTURES').length,
    0,
    undefined,
    mult,
    slConfig
  );

  if (!risk) return null;

  const sizeUsd = risk.betSizeUsd;
  const quantity = tradeType === 'SPOT' ? sizeUsd / currentPrice : sizeUsd / currentPrice;

  return {
    symbol,
    type: tradeType,
    side,
    entryPrice: currentPrice,
    stopLoss: risk.stopLoss,
    takeProfit1: risk.takeProfit1,
    takeProfit2: risk.takeProfit2,
    quantity,
    leverage: risk.leverage,
    openTimestamp: candles[idx].timestamp,
    highestPrice: currentPrice,
    lowestPrice: currentPrice,
    tp1Hit: false,
    sizeUsd,
  };
}

function openPositionPro(
  symbol: string,
  candles: Candle[],
  idx: number,
  state: SimState,
  tradeType: 'SPOT' | 'FUTURES',
  side: TradeSide,
  signalScore: number,
  slConfig: SlConfig
): SimPosition | null {
  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;
  const atr = getAtr(candles, idx);
  if (atr <= 0) return null;

  const regime = detectProRegime(slice, currentPrice);
  const eq = equity(state, { [symbol]: currentPrice });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;

  const perf = summarizeRecentPerformance(state.closedTrades);
  const mult = sizingMultiplierFromHistory(perf, dailyDD);

  const risk = calculateProRisk(
    currentPrice,
    tradeType,
    side,
    atr,
    regime.volatility,
    signalScore,
    eq,
    state.closedTrades,
    state.positions.length,
    state.positions.filter(p => p.type === 'FUTURES').length,
    0,
    dailyDD,
    mult,
    slConfig
  );

  if (!risk) return null;

  const sizeUsd = risk.betSizeUsd;
  const quantity = tradeType === 'SPOT' ? sizeUsd / currentPrice : sizeUsd / currentPrice;

  return {
    symbol,
    type: tradeType,
    side,
    entryPrice: currentPrice,
    stopLoss: risk.stopLoss,
    takeProfit1: risk.takeProfit1,
    takeProfit2: risk.takeProfit2,
    quantity,
    leverage: risk.leverage,
    openTimestamp: candles[idx].timestamp,
    highestPrice: currentPrice,
    lowestPrice: currentPrice,
    tp1Hit: false,
    sizeUsd,
  };
}

// ── Run single backtest ────────────────────────────────────────────────────
interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
}

function runBacktest(
  symbol: string,
  candles: Candle[],
  slConfig: SlConfig
): BacktestResult {
  const state = initState();
  const startEquity = 10000;

  for (let idx = 50; idx < candles.length; idx++) {
    const candle = candles[idx];
    const currentPrice = candle.close;

    // 1. Check exits for existing positions
    const toRemove: number[] = [];
    for (let i = 0; i < state.positions.length; i++) {
      const pos = state.positions[i];
      const check = ENGINE === 'legacy'
        ? checkExitLegacy(pos, candle, candles, idx, state)
        : checkExitPro(pos, candle, candles, idx, state);

      if (check.shouldExit) {
        if (check.exitType === 'FULL') {
          // Record closed trade
          state.closedTrades.push({
            pnl: check.pnl,
            symbol: symbol,
            at: candle.timestamp,
          });
          // Return capital
          if (pos.type === 'SPOT') {
            state.cash += pos.quantity * currentPrice;
          } else {
            state.cash += pos.sizeUsd + check.pnl;
          }
          toRemove.push(i);
        } else if (check.exitType === 'PARTIAL_50') {
          // 50% close
          const halfQty = pos.quantity / 2;
          const halfPnl = check.pnl / 2;
          state.closedTrades.push({
            pnl: halfPnl,
            symbol: symbol,
            at: candle.timestamp,
          });
          pos.quantity = halfQty;
          pos.tp1Hit = true;
          if (pos.type === 'SPOT') {
            state.cash += halfQty * currentPrice;
          } else {
            state.cash += (pos.sizeUsd / 2) + halfPnl;
          }
          pos.sizeUsd = pos.sizeUsd / 2;
        }
      } else {
        // Update trailing stop reference
        pos.highestPrice = Math.max(pos.highestPrice, candle.high);
        pos.lowestPrice = Math.min(pos.lowestPrice, candle.low);
      }
    }
    // Remove closed positions (reverse order to preserve indices)
    for (let i = toRemove.length - 1; i >= 0; i--) {
      state.positions.splice(toRemove[i], 1);
    }

    // 2. Update equity tracking
    const eq = equity(state, { [symbol]: currentPrice });
    state.peakEquity = Math.max(state.peakEquity, eq);
    const drawdown = state.peakEquity > 0 ? (state.peakEquity - eq) / state.peakEquity * 100 : 0;
    state.maxDrawdown = Math.max(state.maxDrawdown, drawdown);

    // 3. Check for new entry (only if no position on this symbol)
    if (state.positions.some(p => p.symbol === symbol)) continue;

    const evalResult = ENGINE === 'legacy'
      ? legacyEvaluate(symbol, candles, idx, state)
      : proEvaluate(symbol, candles, idx, state);

    if (!evalResult.willExecute) continue;

    // 4. Open position
    const pos = ENGINE === 'legacy'
      ? openPositionLegacy(symbol, candles, idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig)
      : openPositionPro(symbol, candles, idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig);

    if (pos) {
      if (pos.type === 'SPOT') {
        state.cash -= pos.quantity * currentPrice;
      } else {
        state.cash -= pos.sizeUsd;
      }
      state.positions.push(pos);
    }
  }

  // Calculate results
  const totalTrades = state.closedTrades.length;
  const wins = state.closedTrades.filter(t => t.pnl > 0).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const netProfit = state.closedTrades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = state.closedTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(state.closedTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const expectancy = totalTrades > 0 ? netProfit / totalTrades : 0;

  return {
    totalTrades,
    wins,
    losses,
    winRate,
    netProfit,
    profitFactor,
    expectancy,
    maxDrawdown: state.maxDrawdown,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
interface SlResult extends SlConfig {
  totalTrades: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
}

async function main() {
  console.log(`[backtest] engine=${ENGINE}, days=${DAYS}, symbols=${SYMS.length}`);
  console.log(`[backtest] SL constants: MIN_STOP_PERCENT=${MIN_STOP_PERCENT}, MAX_STOP_PERCENT=${MAX_STOP_PERCENT}`);

  // Fetch history
  const histories: { symbol: string; candles: Candle[] }[] = [];
  const queue = [...SYMS];
  async function worker() {
    while (queue.length) {
      const symbol = queue.shift()!;
      const candles = await fetchKlinesPaged(symbol, '1h', Date.now() - DAYS * 24 * 60 * 60 * 1000, Date.now());
      if (candles.length < 200) {
        console.log(`[backtest] ${symbol}: insufficient data (${candles.length} bars), skip`);
        continue;
      }
      histories.push({ symbol, candles });
      console.log(`[backtest] ${symbol}: ok (${candles.length} bars)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, SYMS.length) }, worker));

  if (histories.length === 0) {
    console.error('[backtest] no symbols with sufficient data');
    process.exit(1);
  }

  // Run sweep
  const slGrid = buildSlGrid();
  console.log(`[backtest] running ${slGrid.length} SL configs x ${histories.length} symbols...`);

  const results: SlResult[] = [];
  for (const slConfig of slGrid) {
    let totalTrades = 0, wins = 0, netProfit = 0, pfSum = 0, pfCount = 0, expSum = 0, maxDD = 0;

    for (const { symbol, candles } of histories) {
      const r = runBacktest(symbol, candles, slConfig);
      totalTrades += r.totalTrades;
      wins += r.wins;
      netProfit += r.netProfit;
      maxDD = Math.max(maxDD, r.maxDrawdown);
      if (r.totalTrades > 0) {
        pfSum += r.profitFactor;
        pfCount++;
        expSum += r.expectancy;
      }
    }

    results.push({
      ...slConfig,
      totalTrades,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
      netProfit,
      profitFactor: pfCount > 0 ? pfSum / pfCount : 0,
      expectancy: pfCount > 0 ? expSum / pfCount : 0,
      maxDrawdown: maxDD,
    });
  }

  // Sort by profit factor (descending)
  results.sort((a, b) => b.profitFactor - a.profitFactor);

  console.log('\n════════ SL PARAMETER SWEEP RESULTS ══════════════════════════════════');
  console.log(`Engine: ${ENGINE.toUpperCase()} | Symbols: ${histories.length} | Days: ${DAYS}`);
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log(`${'Min SL'.padEnd(8)} ${'Max SL'.padEnd(8)} ${'Trades'.padEnd(8)} ${'WR%'.padEnd(8)} ${'Net $'.padEnd(10)} ${'PF'.padEnd(8)} ${'Exp $'.padEnd(8)} ${'MaxDD%'.padEnd(8)}`);
  console.log('────────────────────────────────────────────────────────────────────────');
  for (const r of results) {
    console.log(
      `${r.minStop.toFixed(1)}%`.padEnd(8) +
      `${r.maxStop.toFixed(1)}%`.padEnd(8) +
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
  console.log(`BEST: MIN_STOP=${best.minStop}%, MAX_STOP=${best.maxStop}% → PF=${best.profitFactor.toFixed(2)}, Net=$${best.netProfit.toFixed(0)}, WR=${best.winRate.toFixed(1)}%`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

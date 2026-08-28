/**
 * Shared backtest runner — extracted from scripts/backtestLegacyPro.ts so both
 * the CLI script and the server can call the same logic without duplication.
 *
 * Runs a walk-forward backtest over real Binance H1 history, sweeping
 * MIN_STOP_PERCENT / MAX_STOP_PERCENT / softTrendBase to find the parameter
 * combination that best holds an edge.
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
  calculateTradingFee,
  ClosedTradeMetric,
  ActivePosition,
  TradeSide,
} from './tradeEngine';
import {
  detectProRegime,
  evaluateProSignals,
  routeProTradeType,
  calculateProRisk,
  evaluateProExit,
  ProActivePosition,
} from './proAlgEngine';
import { summarizeRecentPerformance, sizingMultiplierFromHistory, MIN_STOP_PERCENT, MAX_STOP_PERCENT } from './adaptiveRisk';
import { getCachedHistory, saveCachedHistory } from '../../server/historicalCandleCache';

const BINANCE = 'https://api.binance.com/api/v3';

export type EngineType = 'legacy' | 'pro';

export interface SlConfig {
  minStop: number;
  maxStop: number;
  softTrendBase: number;
}

export interface SweepResult extends SlConfig {
  engine: EngineType;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
}

export interface BacktestOptions {
  engine: EngineType;
  days: number;
  symbols: string[];
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Binance fetch ─────────────────────────────────────────────────────────
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
function buildSlGrid(): SlConfig[] {
  const slPairs = [
    { minStop: 1, maxStop: 4 },
    { minStop: 1.5, maxStop: 6 },
    { minStop: 2, maxStop: 8 },
    { minStop: 1, maxStop: 8 },
    { minStop: 2, maxStop: 6 },
  ];
  const softTrendBases = [55, 60, 65];
  const grid: SlConfig[] = [];
  for (const sl of slPairs) {
    for (const softTrendBase of softTrendBases) {
      grid.push({ ...sl, softTrendBase });
    }
  }
  return grid;
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
  return { cash: 10000, positions: [], closedTrades: [], totalFees: 0, peakEquity: 10000, maxDrawdown: 0 };
}

function equity(state: SimState, prices: Record<string, number>): number {
  let eq = state.cash;
  for (const p of state.positions) {
    const price = prices[p.symbol] ?? p.entryPrice;
    if (p.type === 'SPOT') {
      eq += p.quantity * price;
    } else {
      // Futures: PnL includes leverage multiplier
      const dir = p.side === 'LONG' ? 1 : -1;
      eq += p.quantity * (price - p.entryPrice) * dir * p.leverage;
    }
  }
  return eq;
}

// ── Per-bar evaluation ─────────────────────────────────────────────────────
function getAtr(candles: Candle[], idx: number, period: number = 14): number {
  if (idx < period) return 0;
  return calculateATR(candles.slice(0, idx + 1), period).atr;
}

function getAdx(candles: Candle[], idx: number, period: number = 14): number {
  if (idx < period * 2) return 0;
  return calculateADX(candles.slice(0, idx + 1), period);
}

function legacyEvaluate(
  symbol: string, candles: Candle[], idx: number, state: SimState, config: SlConfig
): { willExecute: boolean; tradeType: 'SPOT' | 'FUTURES' | 'HOLD'; side: TradeSide; signalScore: number; reason: string } {
  if (idx < 50) return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: 0, reason: 'insufficient data' };
  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;
  const regime = detectMarketRegime(slice, currentPrice);
  const signalResult = evaluateSignals(slice, currentPrice, symbol);
  const routeResult = routeTradeType(
    { action: signalResult.action, signalScore: signalResult.signalScore, symbol, confidence: signalResult.signalScore },
    regime,
    {
      hasExistingFutures: state.positions.some(p => p.symbol === symbol && p.type === 'FUTURES'),
      hasExistingSpot: state.positions.some(p => p.symbol === symbol && p.type === 'SPOT'),
      softTrendBaseOverride: config.softTrendBase
    }
  );
  if (routeResult.type === 'HOLD') {
    return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: signalResult.signalScore, reason: routeResult.reason };
  }
  return { willExecute: true, tradeType: routeResult.type, side: routeResult.side, signalScore: signalResult.signalScore, reason: routeResult.reason };
}

function proEvaluate(
  symbol: string, candles: Candle[], idx: number, state: SimState, config: SlConfig
): { willExecute: boolean; tradeType: 'SPOT' | 'FUTURES' | 'HOLD'; side: TradeSide; signalScore: number; reason: string } {
  if (idx < 50) return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: 0, reason: 'insufficient data' };
  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;
  const regime = detectProRegime(slice, currentPrice);
  const signalResult = evaluateProSignals(slice, currentPrice, symbol);
  const routeResult = routeProTradeType(
    signalResult, regime,
    {
      hasExistingFutures: state.positions.some(p => p.symbol === symbol && p.type === 'FUTURES'),
      softTrendBaseOverride: config.softTrendBase
    }
  );
  if (routeResult.type === 'HOLD') {
    return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: signalResult.rawConfidence, reason: routeResult.reason };
  }
  return { willExecute: true, tradeType: routeResult.type, side: routeResult.side as TradeSide, signalScore: signalResult.rawConfidence, reason: routeResult.reason };
}

// ── Exit check ─────────────────────────────────────────────────────────────
function checkExitLegacy(pos: SimPosition, candle: Candle, candles: Candle[], idx: number, state: SimState): { shouldExit: boolean; exitType: 'FULL' | 'PARTIAL_50' | 'NONE'; pnl: number } {
  const activePos: ActivePosition = {
    id: `${pos.symbol}-${pos.openTimestamp}`, symbol: pos.symbol, type: pos.type, side: pos.side,
    entryPrice: pos.entryPrice, stopLoss: pos.stopLoss, takeProfit1: pos.takeProfit1, takeProfit2: pos.takeProfit2,
    quantity: pos.quantity, leverage: pos.leverage, openTimestamp: pos.openTimestamp,
    highestPrice: pos.highestPrice, lowestPrice: pos.lowestPrice, tp1Hit: pos.tp1Hit,
  };
  const currentAtr = getAtr(candles, idx);
  const eq = equity(state, { [pos.symbol]: candle.close });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;
  // Compute actual signal scores for reversal exit detection
  const slice = candles.slice(0, idx + 1);
  const signalResult = evaluateSignals(slice, candle.close, pos.symbol);
  const signalScores = { buy: signalResult.action === 'BUY' ? signalResult.signalScore : 0, sell: signalResult.action === 'SELL' ? signalResult.signalScore : 0 };
  const exitResult = evaluateExit(activePos, candle.close, currentAtr, signalScores, { dailyDrawdownPercent: dailyDD, weeklyDrawdownPercent: dailyDD, systemLocked: false, adx: getAdx(candles, idx) });
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

function checkExitPro(pos: SimPosition, candle: Candle, candles: Candle[], idx: number, state: SimState): { shouldExit: boolean; exitType: 'FULL' | 'PARTIAL_50' | 'NONE'; pnl: number } {
  const activePos: ProActivePosition = {
    id: `${pos.symbol}-${pos.openTimestamp}`, symbol: pos.symbol, type: pos.type, side: pos.side,
    entryPrice: pos.entryPrice, stopLoss: pos.stopLoss, takeProfit1: pos.takeProfit1, takeProfit2: pos.takeProfit2,
    quantity: pos.quantity, leverage: pos.leverage, openTimestamp: pos.openTimestamp,
    highestPrice: pos.highestPrice, lowestPrice: pos.lowestPrice, tp1Hit: pos.tp1Hit,
  };
  const currentAtr = getAtr(candles, idx);
  const eq = equity(state, { [pos.symbol]: candle.close });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;
  // Compute actual signal scores for reversal exit detection
  const slice = candles.slice(0, idx + 1);
  const signalResult = evaluateProSignals(slice, candle.close, pos.symbol);
  const signalScores = { buy: signalResult.action === 'BUY' ? signalResult.rawConfidence : 0, sell: signalResult.action === 'SELL' ? signalResult.rawConfidence : 0 };
  const exitResult = evaluateProExit(activePos, candle.close, currentAtr, signalScores, { dailyDrawdownPercent: dailyDD, weeklyDrawdownPercent: dailyDD, systemLocked: false });
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
function openPositionLegacy(symbol: string, candles: Candle[], idx: number, state: SimState, tradeType: 'SPOT' | 'FUTURES', side: TradeSide, signalScore: number, slConfig: SlConfig): SimPosition | null {
  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;
  const atr = getAtr(candles, idx);
  if (atr <= 0) return null;
  const regime = detectMarketRegime(slice, currentPrice);
  const eq = equity(state, { [symbol]: currentPrice });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;
  const perf = summarizeRecentPerformance(state.closedTrades);
  const mult = sizingMultiplierFromHistory(perf, dailyDD);
  const risk = calculateRiskParameters(currentPrice, tradeType, side, atr, regime.volatility, signalScore, eq, state.closedTrades, state.positions.length, state.positions.filter(p => p.type === 'FUTURES').length, 0, undefined, mult, slConfig);
  if (!risk) return null;
  const sizeUsd = risk.betSizeUsd;
  const quantity = sizeUsd / currentPrice;
  return { symbol, type: tradeType, side, entryPrice: currentPrice, stopLoss: risk.stopLoss, takeProfit1: risk.takeProfit1, takeProfit2: risk.takeProfit2, quantity, leverage: risk.leverage, openTimestamp: candles[idx].timestamp, highestPrice: currentPrice, lowestPrice: currentPrice, tp1Hit: false, sizeUsd };
}

function openPositionPro(symbol: string, candles: Candle[], idx: number, state: SimState, tradeType: 'SPOT' | 'FUTURES', side: TradeSide, signalScore: number, slConfig: SlConfig): SimPosition | null {
  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;
  const atr = getAtr(candles, idx);
  if (atr <= 0) return null;
  const regime = detectProRegime(slice, currentPrice);
  const eq = equity(state, { [symbol]: currentPrice });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;
  const perf = summarizeRecentPerformance(state.closedTrades);
  const mult = sizingMultiplierFromHistory(perf, dailyDD);
  const risk = calculateProRisk(currentPrice, tradeType, side, atr, regime.volatility, signalScore, eq, state.closedTrades, state.positions.length, state.positions.filter(p => p.type === 'FUTURES').length, 0, dailyDD, mult, slConfig);
  if (!risk) return null;
  const sizeUsd = risk.betSizeUsd;
  const quantity = sizeUsd / currentPrice;
  return { symbol, type: tradeType, side, entryPrice: currentPrice, stopLoss: risk.stopLoss, takeProfit1: risk.takeProfit1, takeProfit2: risk.takeProfit2, quantity, leverage: risk.leverage, openTimestamp: candles[idx].timestamp, highestPrice: currentPrice, lowestPrice: currentPrice, tp1Hit: false, sizeUsd };
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

function runBacktest(symbol: string, candles: Candle[], slConfig: SlConfig, engine: EngineType): BacktestResult {
  const state = initState();
  const FEE_PERCENT = 0.001; // 0.1% taker fee (Bybit spot/futures)
  for (let idx = 50; idx < candles.length; idx++) {
    const candle = candles[idx];
    const currentPrice = candle.close;
    // 1. Check exits
    const toRemove: number[] = [];
    for (let i = 0; i < state.positions.length; i++) {
      const pos = state.positions[i];
      const check = engine === 'legacy' ? checkExitLegacy(pos, candle, candles, idx, state) : checkExitPro(pos, candle, candles, idx, state);
      if (check.shouldExit) {
        // Apply exit fee
        const exitValue = pos.type === 'SPOT' ? pos.quantity * currentPrice : pos.sizeUsd + check.pnl;
        const exitFee = exitValue * FEE_PERCENT;
        const pnlAfterFee = check.pnl - exitFee;
        state.totalFees += exitFee;
        if (check.exitType === 'FULL') {
          state.closedTrades.push({ pnl: pnlAfterFee, symbol, at: candle.timestamp });
          if (pos.type === 'SPOT') { state.cash += pos.quantity * currentPrice - exitFee; } else { state.cash += pos.sizeUsd + pnlAfterFee; }
          toRemove.push(i);
        } else if (check.exitType === 'PARTIAL_50') {
          const halfQty = pos.quantity / 2;
          const halfPnl = pnlAfterFee / 2;
          state.closedTrades.push({ pnl: halfPnl, symbol, at: candle.timestamp });
          pos.quantity = halfQty;
          pos.tp1Hit = true;
          if (pos.type === 'SPOT') { state.cash += halfQty * currentPrice - exitFee / 2; } else { state.cash += (pos.sizeUsd / 2) + halfPnl; }
          pos.sizeUsd = pos.sizeUsd / 2;
        }
      } else {
        pos.highestPrice = Math.max(pos.highestPrice, candle.high);
        pos.lowestPrice = Math.min(pos.lowestPrice, candle.low);
      }
    }
    for (let i = toRemove.length - 1; i >= 0; i--) state.positions.splice(toRemove[i], 1);
    // 2. Update equity
    const eq = equity(state, { [symbol]: currentPrice });
    state.peakEquity = Math.max(state.peakEquity, eq);
    const drawdown = state.peakEquity > 0 ? (state.peakEquity - eq) / state.peakEquity * 100 : 0;
    state.maxDrawdown = Math.max(state.maxDrawdown, drawdown);
    // 3. New entry
    if (state.positions.some(p => p.symbol === symbol)) continue;
    const evalResult = engine === 'legacy' ? legacyEvaluate(symbol, candles, idx, state, slConfig) : proEvaluate(symbol, candles, idx, state, slConfig);
    if (!evalResult.willExecute) continue;
    const pos = engine === 'legacy' ? openPositionLegacy(symbol, candles, idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig) : openPositionPro(symbol, candles, idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig);
    if (pos) {
      // Apply entry fee
      const entryValue = pos.type === 'SPOT' ? pos.quantity * currentPrice : pos.sizeUsd;
      const entryFee = entryValue * FEE_PERCENT;
      state.cash -= entryFee;
      state.totalFees += entryFee;
      if (pos.type === 'SPOT') { state.cash -= pos.quantity * currentPrice; } else { state.cash -= pos.sizeUsd; }
      state.positions.push(pos);
    }
  }
  const totalTrades = state.closedTrades.length;
  const wins = state.closedTrades.filter(t => t.pnl > 0).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const netProfit = state.closedTrades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = state.closedTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(state.closedTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const expectancy = totalTrades > 0 ? netProfit / totalTrades : 0;
  return { totalTrades, wins, losses, winRate, netProfit, profitFactor, expectancy, maxDrawdown: state.maxDrawdown };
}

// ── Main exported function ─────────────────────────────────────────────────
export async function runBacktestSweep(options: BacktestOptions): Promise<SweepResult[]> {
  const { engine, days, symbols, concurrency = 4, onProgress = () => {} } = options;
  const slGrid = buildSlGrid();

  // Fetch history (with cache)
  const histories: { symbol: string; candles: Candle[] }[] = [];
  const queue = [...symbols];
  async function worker() {
    while (queue.length) {
      const symbol = queue.shift()!;
      const end = Date.now();
      const start = end - days * 24 * 60 * 60 * 1000;
      let candles: Candle[];
      const cached = await getCachedHistory(symbol, '1h');
      if (cached && cached.length >= 200) {
        const oldestCached = cached[0].timestamp;
        const newestCached = cached[cached.length - 1].timestamp;
        if (oldestCached <= start + 3600_000 && newestCached >= end - 3600_000) {
          onProgress(`${symbol}: cache hit (${cached.length} bars)`);
          histories.push({ symbol, candles: cached });
          continue;
        }
      }
      candles = await fetchKlinesPaged(symbol, '1h', start, end);
      if (candles.length < 200) {
        onProgress(`${symbol}: insufficient data (${candles.length} bars), skip`);
        continue;
      }
      if (cached && cached.length > 0) {
        const cachedMax = cached[cached.length - 1].timestamp;
        const freshMin = candles.length > 0 ? candles[0].timestamp : Infinity;
        if (freshMin > cachedMax) {
          candles = [...cached, ...candles].sort((a, b) => a.timestamp - b.timestamp);
        }
      }
      await saveCachedHistory(symbol, '1h', candles);
      histories.push({ symbol, candles });
      onProgress(`${symbol}: ok (${candles.length} bars)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));

  if (histories.length === 0) {
    throw new Error('No symbols with sufficient data');
  }

  // Run sweep
  const results: SweepResult[] = [];
  for (const slConfig of slGrid) {
    let totalTrades = 0, wins = 0, netProfit = 0, pfSum = 0, pfCount = 0, expSum = 0, maxDD = 0;
    for (const { symbol, candles } of histories) {
      const r = runBacktest(symbol, candles, slConfig, engine);
      totalTrades += r.totalTrades;
      wins += r.wins;
      netProfit += r.netProfit;
      maxDD = Math.max(maxDD, r.maxDrawdown);
      if (r.totalTrades > 0) { pfSum += r.profitFactor; pfCount++; expSum += r.expectancy; }
    }
    results.push({
      ...slConfig, engine, totalTrades,
      winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
      wins: totalTrades > 0 ? wins : 0,
      losses: totalTrades > 0 ? totalTrades - wins : 0,
      netProfit,
      profitFactor: pfCount > 0 ? pfSum / pfCount : 0,
      expectancy: pfCount > 0 ? expSum / pfCount : 0,
      maxDrawdown: maxDD,
    });
  }

  // Sort by profit factor (descending)
  results.sort((a, b) => b.profitFactor - a.profitFactor);
  return results;
}

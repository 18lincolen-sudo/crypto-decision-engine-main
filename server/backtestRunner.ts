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
  ClosedTradeMetric,
} from '@cde/engine/execution';
import {
  detectProRegime,
  routeProTradeType,
  calculateProRisk,
  evaluateProExit,
  ProActivePosition,
  computeProAdvancedAnalysis,
} from '@cde/engine/analysis';
import { sizingMultiplierFromHistory, MIN_STOP_PERCENT, MAX_STOP_PERCENT } from '@cde/engine/execution';
import { getCachedHistory, saveCachedHistory } from './historicalCandleCache';
import type { ActivePosition, TradeSide, SignalEngineResult } from '@cde/engine';

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
    let list: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url);
        const rows = (await r.json()) as unknown;
        if (Array.isArray(rows)) {
          list = rows;
          break;
        }
      } catch { /* retry */ }
      await sleep(300 * (attempt + 1));
    }
    if (!Array.isArray(list) || !list.length) break;
    for (const c of list) {
      if (!Array.isArray(c)) continue;
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

// Exit type union for all possible exit reasons
type ExitType = 'FULL' | 'PARTIAL_50' | 'NONE' | 'TRAILING_STOP' | 'REVERSAL' | 'TIME_BASED';

function legacyEvaluate(
  symbol: string, candles: Candle[], idx: number, state: SimState, config: SlConfig
): { willExecute: boolean; tradeType: 'SPOT' | 'FUTURES' | 'HOLD'; side: TradeSide; signalScore: number; reason: string } {
  if (idx < 50) return { willExecute: false, tradeType: 'HOLD', side: 'BUY', signalScore: 0, reason: 'insufficient data' };
  const slice = candles.slice(0, idx + 1);
  const currentPrice = candles[idx].close;
  const regime = detectMarketRegime(slice, currentPrice);
  const signalResult = evaluateSignals(slice, currentPrice, 0, regime);
  const routeResult = routeTradeType(
    signalResult,
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
  const adv = computeProAdvancedAnalysis({
    candles: slice,
    currentPrice,
    priceChange24h: 0,
    fearGreedIndex: 50,
    marketCap: 0,
    volume24h: 0,
    symbol
  });
  const signalResult = {
    action: adv.action,
    buyScore: adv.action === 'BUY' ? adv.confidence : adv.action === 'SELL' ? 0 : 50,
    sellScore: adv.action === 'SELL' ? adv.confidence : adv.action === 'BUY' ? 0 : 50,
    rawConfidence: adv.confidence,
    confidence: adv.confidence,
    signals: [],
    penalties: adv.penalties
  } as unknown as Parameters<typeof routeProTradeType>[0];
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
function checkExitLegacy(pos: SimPosition, candle: Candle, candles: Candle[], idx: number, state: SimState): { shouldExit: boolean; exitType: ExitType; pnl: number } {
  const activePos: ActivePosition = {
    id: `${pos.symbol}-${pos.openTimestamp}`, symbol: pos.symbol, type: pos.type, side: pos.side as 'BUY' | 'SELL' | 'LONG' | 'SHORT',
    quantity: pos.quantity, entryPrice: pos.entryPrice, currentPrice: candle.close, avgPrice: pos.entryPrice,
    leverage: pos.leverage, marginUsd: pos.sizeUsd, notionalUsd: pos.sizeUsd,
    stopLoss: pos.stopLoss, takeProfit1: pos.takeProfit1, takeProfit2: pos.takeProfit2,
    highestPrice: pos.highestPrice, lowestPrice: pos.lowestPrice, tp1Hit: pos.tp1Hit,
    openedAt: new Date(pos.openTimestamp).toISOString(), openTimestamp: pos.openTimestamp,
    entryFee: 0, reason: '', confidence: 50,
  };
  const currentAtr = getAtr(candles, idx);
  const eq = equity(state, { [pos.symbol]: candle.close });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;
  // Compute actual signal scores for reversal exit detection
  const slice = candles.slice(0, idx + 1);
  const signalResult = evaluateSignals(slice, candle.close, 0, detectMarketRegime(slice, candle.close));
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

function checkExitPro(pos: SimPosition, candle: Candle, candles: Candle[], idx: number, state: SimState): { shouldExit: boolean; exitType: ExitType; pnl: number } {
  const activePos: ProActivePosition = {
    type: pos.type, side: pos.side as 'BUY' | 'SELL' | 'LONG' | 'SHORT',
    entryPrice: pos.entryPrice, stopLoss: pos.stopLoss, takeProfit1: pos.takeProfit1, takeProfit2: pos.takeProfit2,
    highestPrice: pos.highestPrice, lowestPrice: pos.lowestPrice, tp1Hit: pos.tp1Hit,
    openTimestamp: pos.openTimestamp,
  };
  const currentAtr = getAtr(candles, idx);
  const eq = equity(state, { [pos.symbol]: candle.close });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;
  const slice = candles.slice(0, idx + 1);
  const adv = computeProAdvancedAnalysis({
    candles: slice,
    currentPrice: candle.close,
    priceChange24h: 0,
    fearGreedIndex: 50,
    marketCap: 0,
    volume24h: 0,
    symbol: pos.symbol
  });
  const signalScores = { buy: adv.action === 'BUY' ? adv.confidence : 0, sell: adv.action === 'SELL' ? adv.confidence : 0 };
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

// ── Intrabar exit + position PnL ─────────────────────────────────────────────
// Fidelity helpers: a stop-loss / take-profit that the candle's RANGE crosses
// fires at the LEVEL, not at the H1 close. The old close-only check let
// intrabar SL/TP hits run through and close on a favourable close — WinRate
// and MaxDrawdown were systematically biased vs. the live engines.

type IntrabarExitType = 'SL' | 'TP1' | 'TP2';

function intrabarExit(pos: SimPosition, candle: Candle): { exitType: IntrabarExitType; price: number } | null {
  const isLong = pos.side === 'LONG' || pos.side === 'BUY';
  if (isLong) {
    if (candle.low <= pos.stopLoss) {
      return { exitType: 'SL', price: Math.min(pos.stopLoss, candle.open) };
    }
    if (!pos.tp1Hit && typeof pos.takeProfit1 === 'number' && candle.high >= pos.takeProfit1) {
      return { exitType: 'TP1', price: Math.max(pos.takeProfit1, candle.open) };
    }
    if (pos.tp1Hit && typeof pos.takeProfit2 === 'number' && candle.high >= pos.takeProfit2) {
      return { exitType: 'TP2', price: Math.max(pos.takeProfit2, candle.open) };
    }
  } else {
    if (candle.high >= pos.stopLoss) {
      return { exitType: 'SL', price: Math.max(pos.stopLoss, candle.open) };
    }
    if (!pos.tp1Hit && typeof pos.takeProfit1 === 'number' && candle.low <= pos.takeProfit1) {
      return { exitType: 'TP1', price: Math.min(pos.takeProfit1, candle.open) };
    }
    if (pos.tp1Hit && typeof pos.takeProfit2 === 'number' && candle.low <= pos.takeProfit2) {
      return { exitType: 'TP2', price: Math.min(pos.takeProfit2, candle.open) };
    }
  }
  return null;
}

function positionPnl(pos: SimPosition, price: number): number {
  if (pos.type === 'SPOT') {
    return (price - pos.entryPrice) * pos.quantity;
  }
  const dir = pos.side === 'LONG' || pos.side === 'BUY' ? 1 : -1;
  return (price - pos.entryPrice) * pos.quantity * dir * pos.leverage;
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
  const mult = sizingMultiplierFromHistory(state.closedTrades, dailyDD);
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
  const mult = sizingMultiplierFromHistory(state.closedTrades, dailyDD);
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

// Fee and slippage constants (matching simExecution.ts fillDueOrders)
const FEE_PERCENT = 0.001;      // 0.1% taker fee (entry + exit = 0.2% total)
const SLIPPAGE_PERCENT = 0.001; // 0.1% slippage on entry
// Per-symbol post-loss entry cooldown (matches the live per-symbol streak gate).
const STREAK_COOLDOWN_MS = 30 * 60 * 1000;

function runBacktest(symbol: string, candles: Candle[], slConfig: SlConfig, engine: EngineType): Promise<BacktestResult> {
  const state = initState();
  let lossCooldownUntil = 0; // per-symbol 30-min post-loss entry cooldown (matches the live streak gate)
  return (async () => {
  for (let idx = 50; idx < candles.length; idx++) {
    if (idx % 100 === 0) {
      await sleep(0);
    }
    const candle = candles[idx];
    const currentPrice = candle.close;
    // 1. Check exits
    const toRemove: number[] = [];
    for (let i = 0; i < state.positions.length; i++) {
      const pos = state.positions[i];
      // Intrabar SL/TP hit takes precedence over the close-based evaluation:
      // a level crossed by the candle's own range fires at the level.
      const intrabar = intrabarExit(pos, candle);
      const check = intrabar
        ? { shouldExit: true, exitType: (intrabar.exitType === 'TP1' ? 'PARTIAL_50' : 'FULL') as ExitType, pnl: positionPnl(pos, intrabar.price) }
        : (engine === 'legacy' ? checkExitLegacy(pos, candle, candles, idx, state) : checkExitPro(pos, candle, candles, idx, state));
      if (check.shouldExit) {
        // Apply exit fee (0.1% of notional value)
        const exitNotional = pos.type === 'SPOT' ? pos.quantity * currentPrice : pos.sizeUsd + check.pnl;
        const exitFee = exitNotional * FEE_PERCENT;
        const pnlAfterFee = check.pnl - exitFee;
        state.totalFees += exitFee;
        
        if (check.exitType === 'PARTIAL_50') {
          // Partial close: 50% of position
          const halfQty = pos.quantity / 2;
          const halfPnl = pnlAfterFee / 2;
          state.closedTrades.push({ pnl: halfPnl, at: candle.timestamp });
          pos.quantity = halfQty;
          pos.tp1Hit = true;
          if (pos.type === 'SPOT') { state.cash += halfQty * currentPrice - exitFee / 2; } else { state.cash += (pos.sizeUsd / 2) + halfPnl; }
          pos.sizeUsd = pos.sizeUsd / 2;
        } else {
          // FULL, TRAILING_STOP, REVERSAL, TIME_BASED: full close
          state.closedTrades.push({ pnl: pnlAfterFee, at: candle.timestamp });
          if (pnlAfterFee < 0) lossCooldownUntil = Math.max(lossCooldownUntil, candle.timestamp + STREAK_COOLDOWN_MS);
          if (pos.type === 'SPOT') { state.cash += pos.quantity * currentPrice - exitFee; } else { state.cash += pos.sizeUsd + pnlAfterFee; }
          toRemove.push(i);
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
    if (candle.timestamp < lossCooldownUntil) continue; // per-symbol post-loss cooldown
    const evalResult = engine === 'legacy' ? legacyEvaluate(symbol, candles, idx, state, slConfig) : proEvaluate(symbol, candles, idx, state, slConfig);
    if (!evalResult.willExecute) continue;
    const pos = engine === 'legacy' ? openPositionLegacy(symbol, candles, idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig) : openPositionPro(symbol, candles, idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig);
    if (pos) {
      // Apply entry fee (0.1%) and slippage (0.1%)
      const entryNotional = pos.type === 'SPOT' ? pos.quantity * currentPrice : pos.sizeUsd;
      const entryFee = entryNotional * FEE_PERCENT;
      const slippage = entryNotional * SLIPPAGE_PERCENT;
      const totalEntryCost = entryFee + slippage;
      state.cash -= totalEntryCost;
      state.totalFees += totalEntryCost;
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
  })();
}

// ── Portfolio backtest (cross-symbol) ──────────────────────────────────────
// Runs ALL symbols together on a merged time axis so the portfolio-level
// gates (maxPositions=7, maxFutures=2) actually bind — matching how the live
// bots trade. Per-bar logic (intrabar SL/TP, close-based exits, entries,
// per-symbol post-loss cooldown) is identical to runBacktest; positions stay
// scoped per-symbol while the capacity caps are global.

const PORTFOLIO_MAX_POSITIONS = 7;
const PORTFOLIO_MAX_FUTURES = 2;

async function runPortfolioBacktest(
  histories: { symbol: string; candles: Candle[] }[],
  slConfig: SlConfig,
  engine: EngineType
): Promise<BacktestResult> {
  const state = initState();
  const lossCooldownUntil = new Map<string, number>();

  // Merged, time-ordered event stream — one event per (symbol, bar).
  const events: { ts: number; symbol: string; idx: number }[] = [];
  for (const h of histories) {
    for (let i = 50; i < h.candles.length; i++) {
      events.push({ ts: h.candles[i].timestamp, symbol: h.symbol, idx: i });
    }
  }
  events.sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
  const candlesBySymbol = new Map(histories.map(h => [h.symbol, h.candles]));
  let processed = 0;

  for (const ev of events) {
    if (++processed % 1000 === 0) await sleep(0);
    const symbol = ev.symbol;
    const candles = candlesBySymbol.get(symbol)!;
    const candle = candles[ev.idx];

    // 1. Exits for THIS symbol's positions
    const toRemove: number[] = [];
    for (let i = 0; i < state.positions.length; i++) {
      const pos = state.positions[i];
      if (pos.symbol !== symbol) continue;
      const intrabar = intrabarExit(pos, candle);
      const check = intrabar
        ? { shouldExit: true, exitType: (intrabar.exitType === 'TP1' ? 'PARTIAL_50' : 'FULL') as ExitType, pnl: positionPnl(pos, intrabar.price) }
        : (engine === 'legacy' ? checkExitLegacy(pos, candle, candles, ev.idx, state) : checkExitPro(pos, candle, candles, ev.idx, state));
      if (check.shouldExit) {
        const exitPrice = intrabar ? intrabar.price : candle.close;
        const exitNotional = pos.type === 'SPOT' ? pos.quantity * exitPrice : pos.sizeUsd + check.pnl;
        const exitFee = exitNotional * FEE_PERCENT;
        const pnlAfterFee = check.pnl - exitFee;
        state.totalFees += exitFee;

        if (check.exitType === 'PARTIAL_50') {
          const halfQty = pos.quantity / 2;
          const halfPnl = pnlAfterFee / 2;
          state.closedTrades.push({ pnl: halfPnl, at: ev.ts });
          pos.quantity = halfQty;
          pos.tp1Hit = true;
          if (pos.type === 'SPOT') { state.cash += halfQty * exitPrice - exitFee / 2; } else { state.cash += (pos.sizeUsd / 2) + halfPnl; }
          pos.sizeUsd = pos.sizeUsd / 2;
        } else {
          state.closedTrades.push({ pnl: pnlAfterFee, at: ev.ts });
          if (pnlAfterFee < 0) lossCooldownUntil.set(symbol, Math.max(lossCooldownUntil.get(symbol) ?? 0, ev.ts + STREAK_COOLDOWN_MS));
          if (pos.type === 'SPOT') { state.cash += pos.quantity * exitPrice - exitFee; } else { state.cash += pos.sizeUsd + pnlAfterFee; }
          toRemove.push(i);
        }
      } else {
        pos.highestPrice = Math.max(pos.highestPrice, candle.high);
        pos.lowestPrice = Math.min(pos.lowestPrice, candle.low);
      }
    }
    for (let i = toRemove.length - 1; i >= 0; i--) state.positions.splice(toRemove[i], 1);

    // 2. Equity (this symbol at its live price; others at their entry price)
    const eq = equity(state, { [symbol]: candle.close });
    state.peakEquity = Math.max(state.peakEquity, eq);
    const drawdown = state.peakEquity > 0 ? (state.peakEquity - eq) / state.peakEquity * 100 : 0;
    state.maxDrawdown = Math.max(state.maxDrawdown, drawdown);

    // 3. New entry — portfolio-level capacity gates (fixes the old
    //    "one position per backtest run" fidelity gap)
    if (state.positions.some(p => p.symbol === symbol)) continue;
    if (ev.ts < (lossCooldownUntil.get(symbol) ?? 0)) continue; // per-symbol post-loss cooldown
    if (state.positions.length >= PORTFOLIO_MAX_POSITIONS) continue;
    const evalResult = engine === 'legacy'
      ? legacyEvaluate(symbol, candles, ev.idx, state, slConfig)
      : proEvaluate(symbol, candles, ev.idx, state, slConfig);
    if (!evalResult.willExecute) continue;
    if (evalResult.tradeType === 'FUTURES' && state.positions.filter(p => p.type === 'FUTURES').length >= PORTFOLIO_MAX_FUTURES) continue;
    const pos = engine === 'legacy'
      ? openPositionLegacy(symbol, candles, ev.idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig)
      : openPositionPro(symbol, candles, ev.idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig);
    if (pos) {
      const entryNotional = pos.type === 'SPOT' ? pos.quantity * candle.close : pos.sizeUsd;
      const entryFee = entryNotional * FEE_PERCENT;
      const slippage = entryNotional * SLIPPAGE_PERCENT;
      const totalEntryCost = entryFee + slippage;
      state.cash -= totalEntryCost;
      state.totalFees += totalEntryCost;
      if (pos.type === 'SPOT') { state.cash -= pos.quantity * candle.close; } else { state.cash -= pos.sizeUsd; }
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

  // Run sweep — multi-symbol runs use the portfolio backtest so the live
  // capacity gates (maxPositions=7, maxFutures=2) actually bind; a single
  // symbol still goes through the per-symbol runner.
  const results: SweepResult[] = [];
  for (const slConfig of slGrid) {
    let totalTrades = 0, wins = 0, netProfit = 0, pfSum = 0, pfCount = 0, expSum = 0, maxDD = 0;
    const r = await (histories.length > 1
      ? runPortfolioBacktest(histories, slConfig, engine)
      : runBacktest(histories[0].symbol, histories[0].candles, slConfig, engine));
    totalTrades += r.totalTrades;
    wins += r.wins;
    netProfit += r.netProfit;
    maxDD = Math.max(maxDD, r.maxDrawdown);
    if (r.totalTrades > 0) { pfSum += r.profitFactor; pfCount++; expSum += r.expectancy; }
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

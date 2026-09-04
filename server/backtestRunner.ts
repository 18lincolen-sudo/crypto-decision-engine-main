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
  evaluateProSignals,
} from '@cde/engine/analysis';
import { sizingMultiplierFromHistory, MIN_STOP_PERCENT, MAX_STOP_PERCENT } from '@cde/engine/execution';
import {
  evaluateIntradayDecision,
  evaluateIntradayExit,
  type IntradayDecision,
  type IntradayPositionView
} from '@cde/engine/analysis';
// The params live in the root barrel, not the analysis one.
import { DEFAULT_INTRADAY_PARAMS, withParams, type IntradayParams } from '@cde/engine';

/**
 * Intraday parameter overrides for a single run.
 *
 * Deliberately separate from SlConfig: SlConfig is the Legacy/Pro stop grid and
 * means nothing to this engine. Undefined reproduces DEFAULT_INTRADAY_PARAMS
 * exactly, so an unspecified run is the unmodified strategy.
 */
export type IntradayOverrides = Partial<IntradayParams>;
import { getCachedHistory, saveCachedHistory } from './historicalCandleCache';
import type { ActivePosition, TradeSide, SignalEngineResult } from '@cde/engine';

const BINANCE = 'https://api.binance.com/api/v3';

export type EngineType = 'legacy' | 'pro' | 'intraday';

/**
 * One symbol's history. `candles` is the H1 series every engine decides on;
 * `m15` and `m5` are required by the Intraday engine and ignored by the other
 * two.
 *
 * Optional rather than required on purpose: the existing H1-only snapshot stays
 * a valid input, so every legacy/pro run already recorded against it remains
 * comparable. Re-fetching that file would change the yardstick and silently
 * invalidate every earlier measurement.
 */
export interface SymbolHistory {
  symbol: string;
  candles: Candle[];
  m15?: Candle[];
  m5?: Candle[];
}

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
  /** Risk-at-entry, mirroring SimPosition.initialRiskUsd in simExecution.ts.
   *  Without it the backtest would feed Kelly dollar-based payoff ratios while
   *  production feeds R-multiples — i.e. measure a different engine. */
  initialRiskUsd: number;
  /** Intraday only. The engine's exit rules are time-aware — maxHold and the
   *  time-stop come out of the RiskPlan per setup type — so a position that
   *  drops them is not the same position the live bot holds. Legacy and Pro
   *  leave these undefined and their exits never read them. */
  maxHoldMs?: number;
  timeStopMs?: number;
  plannedStopDistance?: number;
  setupType?: IntradayPositionView['setupType'];
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
  // Mirrors proAdapter.ts's AdvancedAnalysisStage (2026-09-03: evaluateProSignals,
  // not computeProAdvancedAnalysis — see checkpoint-pro-advanced-analysis to revert
  // both together) so the backtest sweep scores entries the same way live does.
  const signalResult = evaluateProSignals(slice, currentPrice, 0, regime, 50);
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
  // Same source swap as proEvaluate() above — keeps the reversal-exit check
  // consistent with what live evaluations now carry (proSimExecution.ts
  // reuses the tick's own SignalEvaluation here rather than recomputing).
  const regimeForExit = detectProRegime(slice, candle.close);
  const signal = evaluateProSignals(slice, candle.close, 0, regimeForExit, 50);
  const signalScores = { buy: signal.action === 'BUY' ? signal.confidence : 0, sell: signal.action === 'SELL' ? signal.confidence : 0 };
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
  return { symbol, type: tradeType, side, entryPrice: currentPrice, stopLoss: risk.stopLoss, takeProfit1: risk.takeProfit1, takeProfit2: risk.takeProfit2, quantity, leverage: risk.leverage, openTimestamp: candles[idx].timestamp, highestPrice: currentPrice, lowestPrice: currentPrice, tp1Hit: false, sizeUsd, initialRiskUsd: Math.abs(currentPrice - risk.stopLoss) * quantity };
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
  return { symbol, type: tradeType, side, entryPrice: currentPrice, stopLoss: risk.stopLoss, takeProfit1: risk.takeProfit1, takeProfit2: risk.takeProfit2, quantity, leverage: risk.leverage, openTimestamp: candles[idx].timestamp, highestPrice: currentPrice, lowestPrice: currentPrice, tp1Hit: false, sizeUsd, initialRiskUsd: Math.abs(currentPrice - risk.stopLoss) * quantity };
}


// ── Intraday (Multi-Timeframe) ──────────────────────────────────────────────
//
// Parity notes, because this engine is not shaped like the other two:
//
//  * It needs three series. Its first gate is a hard NO_DATA on
//    1H < 200 || 15M < 300 || 5M < 500 bars, so an H1-only snapshot does not
//    produce a thin version of Intraday — it produces no Intraday at all.
//
//  * It sizes itself. `buildRiskPlan` returns quantity, leverage, stops,
//    targets AND a per-setup time budget. Routing it through
//    calculateRiskParameters the way Legacy and Pro are routed would be
//    measuring a different strategy under the Intraday name, so the plan is
//    used verbatim.
//
//  * It decides on the 5M clock, and that is production parity rather than a
//    convenience. The worker scans every BOT_SCAN_INTERVAL_SECONDS, default
//    300 — five minutes. Legacy and Pro decide hourly because their signal is
//    an H1 signal; Intraday's entry confirmation is a 5M trigger.
//
//    This was H1 in the first version of this file and the results were
//    meaningless. Intraday's hold budgets are 45-120 minutes
//    (params.maxHoldMinutes), so an hourly exit check reached a MEAN_REVERSION
//    position for the first time already past its 45-minute deadline: it could
//    never exit for any other reason. 71% of trades closed on MAX_DURATION and
//    only 19% ever reached a level, which reads as a strategy that cannot
//    resolve and was in fact a clock that could not see it resolve. A backtest
//    whose sampling interval is coarser than the strategy's holding period does
//    not measure the strategy.

/** Per-symbol read cursors into the 15M and 5M series. */
interface MtfCursors { h1: number; m15: number; m5: number }

/**
 * Advances a cursor to the last bar that CLOSED at or before `upTo`.
 *
 * Monotonic and amortised O(1) across the run. A `filter` per decision would be
 * O(bars) each and turns a six-month 5M series into minutes of wall clock for
 * no extra fidelity.
 */
function advanceCursor(series: Candle[], from: number, upTo: number): number {
  let i = from;
  while (i < series.length && series[i].timestamp <= upTo) i++;
  return i;
}

function intradayEvaluate(
  history: SymbolHistory, cursors: MtfCursors, now: number, currentPrice: number,
  state: SimState, params?: IntradayParams
): { decision: IntradayDecision | null; willExecute: boolean } {
  const m15 = history.m15, m5 = history.m5;
  if (!m15 || !m5) return { decision: null, willExecute: false };

  const eq = equity(state, { [history.symbol]: currentPrice });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;

  const decision = evaluateIntradayDecision({
    symbol: history.symbol,
    h1: history.candles.slice(0, cursors.h1),
    m15: m15.slice(0, cursors.m15),
    m5: m5.slice(0, cursors.m5),
    livePrice: currentPrice,
    params,
    now,
    portfolio: {
      portfolioValue: eq,
      initialAmount: 10000,
      dailyDrawdownPercent: dailyDD,
      weeklyDrawdownPercent: dailyDD,
      openPositionsCount: state.positions.length,
      openFuturesPositionsCount: state.positions.filter(p => p.type === 'FUTURES').length,
      totalLeveragedExposureUsd: state.positions
        .filter(p => p.type === 'FUTURES')
        .reduce((sum, p) => sum + p.quantity * p.entryPrice * p.leverage, 0),
      existingExposureByAsset: {},
      systemLocked: false
    },
    openPositions: state.positions.map(p => ({ symbol: p.symbol, type: p.type }))
  });

  const willExecute = decision.outcome === 'SIGNAL'
    && decision.risk !== null
    && decision.risk.approved
    && decision.tradeType !== null
    && (decision.direction === 'LONG' || decision.direction === 'SHORT');
  return { decision, willExecute };
}

function openPositionIntraday(
  symbol: string, candles: Candle[], idx: number, decision: IntradayDecision
): SimPosition | null {
  const plan = decision.risk;
  if (!plan || !plan.approved || plan.quantity <= 0) return null;
  const entryPrice = candles[idx].close;
  const side: TradeSide = decision.direction === 'SHORT' ? 'SHORT' : 'LONG';
  return {
    symbol,
    type: decision.tradeType as 'SPOT' | 'FUTURES',
    side,
    entryPrice,
    stopLoss: plan.stopLoss,
    takeProfit1: plan.takeProfit1,
    takeProfit2: plan.takeProfit2,
    quantity: plan.quantity,
    leverage: plan.leverage,
    openTimestamp: candles[idx].timestamp,
    highestPrice: entryPrice,
    lowestPrice: entryPrice,
    tp1Hit: false,
    // marginUsd for futures, notional for spot — the same money the accounting
    // loop below removes from cash.
    sizeUsd: decision.tradeType === 'FUTURES' ? plan.marginUsd : plan.notionalUsd,
    initialRiskUsd: plan.riskUsd,
    maxHoldMs: plan.maxHoldMs,
    timeStopMs: plan.timeStopMs,
    plannedStopDistance: plan.stopDistance,
    setupType: decision.setupType
  };
}

function checkExitIntraday(
  pos: SimPosition, candle: Candle, history: SymbolHistory, cursors: MtfCursors,
  state: SimState, params?: IntradayParams
): { shouldExit: boolean; exitType: ExitType; pnl: number; reasonCode?: string } {
  const m5 = history.m5;
  if (!m5) return { shouldExit: false, exitType: 'NONE', pnl: 0 };

  const eq = equity(state, { [pos.symbol]: candle.close });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;

  // The 5M ATR the live exit reads, from the 5M series — not the H1 ATR
  // rescaled. Trailing distance and the time-stop's progress test are both
  // measured against it, so borrowing the wrong timeframe would move every
  // trailing exit.
  const view = m5.slice(Math.max(0, cursors.m5 - 100), cursors.m5);
  const atr5 = view.length >= 15 ? calculateATR(view, 14).atr : 0;

  const posView: IntradayPositionView = {
    symbol: pos.symbol,
    type: pos.type,
    // TradeSide also carries 'NONE'; a held position never has it, and the
    // exit engine's two-sided view is the honest projection.
    side: pos.side === 'SHORT' || pos.side === 'SELL' ? 'SHORT' : 'LONG',
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
    stopLoss: pos.stopLoss,
    takeProfit1: pos.takeProfit1,
    takeProfit2: pos.takeProfit2,
    tp1Hit: pos.tp1Hit,
    openTimestamp: pos.openTimestamp,
    maxHoldMs: pos.maxHoldMs,
    timeStopMs: pos.timeStopMs,
    setupType: pos.setupType === 'NONE' ? undefined : pos.setupType,
    plannedStopDistance: pos.plannedStopDistance,
    highestPrice: pos.highestPrice,
    lowestPrice: pos.lowestPrice
  };

  const exit = evaluateIntradayExit(posView, {
    price: candle.close,
    now: candle.timestamp,
    atr5,
    params,
    portfolio: { dailyDrawdownPercent: dailyDD, weeklyDrawdownPercent: dailyDD, systemLocked: false }
  });

  if (!exit.shouldExit) return { shouldExit: false, exitType: 'NONE', pnl: 0 };
  return { shouldExit: true, exitType: exit.exitType, pnl: positionPnl(pos, candle.close), reasonCode: exit.reasonCode };
}

// ── Run single backtest ────────────────────────────────────────────────────
export interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  /** Per-trade records behind the aggregates above. Exposed for the A/B
   *  harness (scripts/abBacktest.ts), which needs the raw PnL series to
   *  compute dispersion metrics the aggregates cannot express — per-trade
   *  Sharpe today, and the R-multiple distribution once ClosedTradeRecord
   *  carries riskUsd. Purely additive: no caller is required to read it. */
  closedTrades: ClosedTradeMetric[];
  /**
   * How the trades ended, by reason.
   *
   * Aggregates hide the difference between "the stop was hit" and "the clock
   * ran out": both are a loss, and only one of them is the strategy working as
   * designed. A run whose exits are mostly time-based is paying a full
   * round-trip cost per trade to close positions that never resolved, which is
   * a cost problem wearing the costume of an edge problem.
   */
  exitReasons: Record<string, number>;
}

// Fee and slippage constants (matching simExecution.ts fillDueOrders)
const FEE_PERCENT = 0.001;      // 0.1% taker fee (entry + exit = 0.2% total)
const SLIPPAGE_PERCENT = 0.001; // 0.1% slippage on entry
// Per-symbol post-loss entry cooldown (matches the live per-symbol streak gate).
const STREAK_COOLDOWN_MS = 30 * 60 * 1000;

export function runBacktest(symbol: string, candles: Candle[], slConfig: SlConfig, engine: EngineType): Promise<BacktestResult> {
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
          state.closedTrades.push({ pnl: halfPnl, at: candle.timestamp, riskUsd: pos.initialRiskUsd / 2 });
          pos.quantity = halfQty;
          pos.initialRiskUsd = pos.initialRiskUsd / 2;
          pos.tp1Hit = true;
          if (pos.type === 'SPOT') { state.cash += halfQty * currentPrice - exitFee / 2; } else { state.cash += (pos.sizeUsd / 2) + halfPnl; }
          pos.sizeUsd = pos.sizeUsd / 2;
        } else {
          // FULL, TRAILING_STOP, REVERSAL, TIME_BASED: full close
          state.closedTrades.push({ pnl: pnlAfterFee, at: candle.timestamp, riskUsd: pos.initialRiskUsd });
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
  // The single-symbol path serves legacy/pro only and does not tally reasons;
  // an empty object says "not measured here", which is the honest value.
  return { totalTrades, wins, losses, winRate, netProfit, profitFactor, expectancy, maxDrawdown: state.maxDrawdown, closedTrades: state.closedTrades, exitReasons: {} };
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

export async function runPortfolioBacktest(
  histories: SymbolHistory[],
  slConfig: SlConfig,
  engine: EngineType,
  /** Intraday only. Omit for the unmodified strategy. */
  intradayOverrides?: IntradayOverrides
): Promise<BacktestResult> {
  // Merged over the defaults, never substituted for them: a partial object
  // handed straight to the engine blanks every threshold it does not name, and
  // every `x >= params.someThreshold` test then silently reads undefined.
  const intradayParams = intradayOverrides
    ? withParams(intradayOverrides)
    : DEFAULT_INTRADAY_PARAMS;
  const state = initState();
  const lossCooldownUntil = new Map<string, number>();
  const exitReasons: Record<string, number> = {};
  const tally = (reason: string) => { exitReasons[reason] = (exitReasons[reason] ?? 0) + 1; };

  // Intraday cannot run on an H1-only snapshot: its first gate is a hard
  // NO_DATA below 200/300/500 bars, so it would report zero trades and look
  // like a strategy that never fires rather than a snapshot that never fed it.
  // Fail loudly instead — a silent zero is the worst possible backtest result.
  if (engine === 'intraday') {
    const missing = histories.filter(h => !h.m15 || !h.m5).map(h => h.symbol);
    if (missing.length) {
      throw new Error(
        `intraday needs 15M and 5M series; missing for ${missing.join(', ')}. ` +
        `Build one with: npx tsx scripts/abBacktest.ts snapshot-mtf --from <date> --to <date>`
      );
    }
  }

  // Merged, time-ordered event stream — one event per (symbol, bar) on the
  // clock the engine actually runs on. Intraday ticks every 5 minutes like the
  // live worker; Legacy and Pro decide on their H1 signal.
  //
  // The warm-up offset is each engine's own minimum history: 50 H1 bars for the
  // two H1 engines, and for Intraday the 500 5M bars its NO_DATA gate demands
  // (the 1H and 15M minimums are checked per event, since those series reach
  // their own thresholds at different points).
  const events: { ts: number; symbol: string; idx: number }[] = [];
  for (const h of histories) {
    const clock = engine === 'intraday' ? h.m5! : h.candles;
    const warmup = engine === 'intraday' ? 500 : 50;
    for (let i = warmup; i < clock.length; i++) {
      events.push({ ts: clock[i].timestamp, symbol: h.symbol, idx: i });
    }
  }
  events.sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
  const historyBySymbol = new Map(histories.map(h => [h.symbol, h]));
  const candlesBySymbol = new Map(histories.map(h => [h.symbol, h.candles]));
  // Monotonic per-symbol read heads into the 15M/5M series. The event stream is
  // time-ordered and each symbol's own events are in increasing index order, so
  // these only ever move forward.
  const cursorsBySymbol = new Map<string, MtfCursors>(histories.map(h => [h.symbol, { h1: 0, m15: 0, m5: 0 }]));
  let processed = 0;

  for (const ev of events) {
    if (++processed % 1000 === 0) await sleep(0);
    const symbol = ev.symbol;
    const history = historyBySymbol.get(symbol)!;
    const candles = candlesBySymbol.get(symbol)!;
    // `ev.idx` indexes the engine's own clock: the 5M series for Intraday, H1
    // for the other two.
    const bars = engine === 'intraday' ? history.m5! : candles;
    const candle = bars[ev.idx];

    const cursors = cursorsBySymbol.get(symbol)!;
    if (engine === 'intraday') {
      // Advance the HIGHER-timeframe heads to the last bar that closed at or
      // before this 5M bar. A 1H bar that closes later has not happened yet;
      // letting one through would be look-ahead, the one bug a backtest cannot
      // survive. The 5M head is the event index itself.
      cursors.h1 = advanceCursor(candles, cursors.h1, candle.timestamp);
      cursors.m15 = advanceCursor(history.m15!, cursors.m15, candle.timestamp);
      cursors.m5 = ev.idx + 1;
      // The engine's own NO_DATA thresholds on the two slower series.
      if (cursors.h1 < 200 || cursors.m15 < 300) continue;
    }

    // 1. Exits for THIS symbol's positions
    const toRemove: number[] = [];
    for (let i = 0; i < state.positions.length; i++) {
      const pos = state.positions[i];
      if (pos.symbol !== symbol) continue;
      const intrabar = intrabarExit(pos, candle);
      const check = intrabar
        ? { shouldExit: true, exitType: (intrabar.exitType === 'TP1' ? 'PARTIAL_50' : 'FULL') as ExitType, pnl: positionPnl(pos, intrabar.price) }
        : engine === 'legacy' ? checkExitLegacy(pos, candle, candles, ev.idx, state)
          : engine === 'pro' ? checkExitPro(pos, candle, candles, ev.idx, state)
            : checkExitIntraday(pos, candle, history, cursors, state, intradayParams);
      if (check.shouldExit) {
        // Intrabar SL/TP is a level hit; everything else comes from the exit
        // engine and carries its own reason where the engine reports one.
        tally(intrabar ? intrabar.exitType : ((check as { reasonCode?: string }).reasonCode ?? check.exitType));
        const exitPrice = intrabar ? intrabar.price : candle.close;
        const exitNotional = pos.type === 'SPOT' ? pos.quantity * exitPrice : pos.sizeUsd + check.pnl;
        const exitFee = exitNotional * FEE_PERCENT;
        const pnlAfterFee = check.pnl - exitFee;
        state.totalFees += exitFee;

        if (check.exitType === 'PARTIAL_50') {
          const halfQty = pos.quantity / 2;
          const halfPnl = pnlAfterFee / 2;
          state.closedTrades.push({ pnl: halfPnl, at: ev.ts, riskUsd: pos.initialRiskUsd / 2 });
          pos.quantity = halfQty;
          pos.initialRiskUsd = pos.initialRiskUsd / 2;
          pos.tp1Hit = true;
          if (pos.type === 'SPOT') { state.cash += halfQty * exitPrice - exitFee / 2; } else { state.cash += (pos.sizeUsd / 2) + halfPnl; }
          pos.sizeUsd = pos.sizeUsd / 2;
        } else {
          state.closedTrades.push({ pnl: pnlAfterFee, at: ev.ts, riskUsd: pos.initialRiskUsd });
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
    let pos: SimPosition | null = null;
    if (engine === 'intraday') {
      const { decision, willExecute } = intradayEvaluate(history, cursors, candle.timestamp, candle.close, state, intradayParams);
      if (!willExecute || !decision) continue;
      if (decision.tradeType === 'FUTURES' && state.positions.filter(p => p.type === 'FUTURES').length >= PORTFOLIO_MAX_FUTURES) continue;
      pos = openPositionIntraday(symbol, bars, ev.idx, decision);
    } else {
      const evalResult = engine === 'legacy'
        ? legacyEvaluate(symbol, candles, ev.idx, state, slConfig)
        : proEvaluate(symbol, candles, ev.idx, state, slConfig);
      if (!evalResult.willExecute) continue;
      if (evalResult.tradeType === 'FUTURES' && state.positions.filter(p => p.type === 'FUTURES').length >= PORTFOLIO_MAX_FUTURES) continue;
      pos = engine === 'legacy'
        ? openPositionLegacy(symbol, candles, ev.idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig)
        : openPositionPro(symbol, candles, ev.idx, state, evalResult.tradeType as 'SPOT' | 'FUTURES', evalResult.side, evalResult.signalScore, slConfig);
    }
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
  return { totalTrades, wins, losses, winRate, netProfit, profitFactor, expectancy, maxDrawdown: state.maxDrawdown, closedTrades: state.closedTrades, exitReasons };
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

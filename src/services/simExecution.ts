// Shared engine core for the paper-trading simulation — used by BOTH the
// server's 24/7 engine (server/simEngine.ts) and the browser's intraday hook
// (src/hooks/useSimulationBot.ts), which share the same decision algorithm
// (evaluateSymbolFromSnapshot / intradayBridge.ts). The legacy engine
// (useLegacySimulationBot.ts) runs a genuinely different decision algorithm
// (routeTradeType / tradeEngine.ts's Layer 1/2/3) and is intentionally NOT
// folded in here — only its small numeric helpers (reanchorLevel etc. below)
// are shared with it.
//
// These two engines used to each carry their own ~500-line copy of the
// evaluation/order-generation/fill logic — which is exactly how the SL/TP
// re-anchoring bug and the held/queued dedup bug each shipped fixed in one
// copy and left broken in the other earlier in this project. No framework-
// specific dependency (works in the browser and in the Node worker bundle):
// each engine still owns ITS OWN state (React state+refs vs plain closure
// variables) and calls these as pure functions, passing its state in and
// applying the returned deltas however fits its own state mechanism.

import { CryptoData } from '../types/crypto';
import { calculateTradingFee, simulateSlippage, Candle } from './tradeEngine';
import {
  evaluateSymbolFromSnapshot,
  buildPortfolioRiskStats,
  evaluatePositionExit,
  MultiTimeframeSnapshot,
  SignalEvaluation
} from './intradayBridge';
import { DEFAULT_INTRADAY_PARAMS, IntradayParams, SetupType } from './intradayParams';
import {
  evaluateCorrelationGate,
  toPositionDirection,
  CorrelatedHolding,
  DEFAULT_CORRELATION_LOOKBACK,
  DEFAULT_CORRELATION_THRESHOLD,
  DEFAULT_MAX_CORRELATED
} from './correlation';
import {
  isInStreakCooldown,
  streakCooldownReason,
  streakCooldownFromHistory,
  adaptiveRiskPercentFromHistory,
  ClosedTradeRecord
} from './adaptiveRisk';

// Re-exported so the existing call sites (hooks, server engines) keep a
// single import surface; the implementation now lives in adaptiveRisk.ts
// where all three engines can reach it.
export {
  computeAdaptiveRiskPercent,
  adaptiveRiskPercentFromHistory,
  sizingMultiplierFromHistory,
  streakCooldownFromHistory,
  summarizeRecentPerformance,
  isInStreakCooldown
} from './adaptiveRisk';
export type { AdaptiveRiskInput, ClosedTradeRecord, PerformanceWindow } from './adaptiveRisk';

// Simulation-only tuning — NOT applied to the real bot: tradingWorker.ts's
// scan() calls evaluateIntradayDecision directly with no params override, so
// it always gets DEFAULT_INTRADAY_PARAMS unmodified. Both knobs are being
// evaluated against real simulation results before being considered for the
// live bot. See each flag's own doc comment in intradayParams.ts.
const SIM_INTRADAY_PARAMS_OVERRIDE: Partial<IntradayParams> = {
  allowShortDuringHighVolatility: true,
  meanReversionMinStopAtrMult: 1.6,
  meanReversionMinStopPercent: 0.25,
  meanReversionCloseConfirmStop: true
};

// ── Shared data shapes ───────────────────────────────────────────────────────

export interface SimPosition {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  avgPrice: number;
  currentPrice: number;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  trailingStopActive?: boolean;
  trailingStopPrice?: number;
  tp1Hit: boolean;
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
  highestPrice?: number;
  lowestPrice?: number;
  openedAt: string;
  openTimestamp: number;
  reason: string;
  confidence: number;
  entryFee: number;
  /** Per-setup-type hold budget from the entry-time RiskPlan (intradayRisk.ts).
   *  Without these, the exit engine falls back to a single hardcoded default
   *  (TREND_PULLBACK's 90min) for every position regardless of its actual
   *  setup type — e.g. a MEAN_REVERSION position (meant to time-stop at 45min)
   *  would incorrectly get held up to twice as long. */
  maxHoldMs?: number;
  timeStopMs?: number;
  /** Needed at exit-check time to apply MEAN_REVERSION-specific stop handling — see meanReversionCloseConfirmStop in intradayParams.ts. */
  setupType?: SetupType;
}

export interface SimTrade {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'buy' | 'sell' | 'long' | 'short' | 'close_long' | 'close_short' | 'partial_tp1';
  price: number;
  requestedPrice: number;
  slippagePercent: number;
  fee: number;
  delayMs: number;
  quantity: number;
  usdValue: number;
  leverage: number;
  timestamp: string;
  at: number;
  reason: string;
  confidence: number;
  pnl?: number;
  pnlPercent?: number;
}

export interface SimPoint {
  timestamp: string;
  at: number;
  portfolio: number;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'buy' | 'sell' | 'long' | 'short' | 'close_long' | 'close_short' | 'partial_tp1';
  signalPrice: number;
  quantity: number;
  budgetUsd?: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  reason: string;
  confidence: number;
  executeAt: number;
  createdAt: number;
  /** Carried from the entry-time RiskPlan through to the resulting SimPosition — see SimPosition.maxHoldMs. */
  maxHoldMs?: number;
  timeStopMs?: number;
  setupType?: SetupType;
}

export interface SimBotConfig {
  riskLevel: 'low' | 'medium' | 'high';
  initialAmount: number;
  stopLoss: number;
  takeProfit: number;
  maxPositions: number;
  maxFuturesPositions?: number;
  feePercent: number;
  slippagePercent: number;
  executionDelaySec: number;
  minConfidenceOverride?: number;
  positionPercent?: number;
}

const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * SL/TP were computed relative to the SIGNAL price at evaluation time, which
 * can be stale by the time the order actually fills (execution delay + live
 * price drift). Re-anchor by preserving the SIGNED offset from the signal
 * price — not just its distance — so SL stays below / TP stays above entry
 * for a LONG (opposite for SHORT) regardless of which way the price drifted.
 * Forcing a single sign here (an earlier version of this fix did) silently
 * flips TP1/TP2 to the wrong side of the fill price.
 */
export function reanchorLevel(fillPrice: number, signalPrice: number, level: number | undefined): number | undefined {
  return level === undefined ? undefined : fillPrice + (level - signalPrice);
}

/** Entry position sizing: FUTURES risk is capped in absolute $ terms (not just %) since leverage already amplifies exposure; SPOT is capped higher since there's no leverage multiplier. */
export function computeEntryBudget(cash: number, tradeType: 'SPOT' | 'FUTURES'): number {
  return tradeType === 'FUTURES'
    ? Math.min(cash * 0.05, 500)
    : Math.min(cash * 0.15, 1000);
}

/** Safety net against rapid re-entry churn: after a LOSING full exit, skip new entries on that symbol for this cooldown window even if the signal still fires. */
export const ENTRY_COOLDOWN_MS = 2 * 60 * 1000;

export function isInEntryCooldown(cooldownAt: number | undefined, now: number = Date.now()): boolean {
  return typeof cooldownAt === 'number' && now - cooldownAt < ENTRY_COOLDOWN_MS;
}

// ── 1. Evaluation ─────────────────────────────────────────────────────────────
// Builds the per-symbol SignalEvaluation list: runs the shared decision engine
// on every READY symbol, then applies the portfolio-level guards (circuit
// breakers, max positions, already-held/-queued) that the decision engine
// itself can't know about.

export interface EvaluationContext {
  cryptoData: CryptoData[];
  /** Multi-timeframe snapshots keyed by BASE asset (e.g. "LIT", not "LITUSDT") — normalize before calling. */
  mtfData: Record<string, MultiTimeframeSnapshot>;
  positions: SimPosition[];
  pending: PendingOrder[];
  config: SimBotConfig;
  equity: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  totalLeveragedExposureUsd: number;
  /** Current notional exposure per asset for per-asset cap checks. Optional:
   *  open positions are folded in below regardless, this is only for exposure
   *  the caller tracks outside `positions`. */
  existingExposureByAsset?: Record<string, number>;
  /** Adaptive risk-per-trade override (computed outside, passed in) */
  riskPerTradePercent?: number;
  /** Closed-trade history (newest- or oldest-first, `at` is what orders it)
   *  driving adaptive sizing and the post-losing-streak entry cooldown. Omit
   *  to run with base sizing and no cooldown. */
  closedTrades?: ClosedTradeRecord[];
  /** Correlation gate tuning — see correlation.ts for the defaults' rationale. */
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
  /** false only while the client engine is paused; the server engine is only ticked while running, so it never needs this. */
  isRunning?: boolean;
  /** Normalizes a symbol (bare or suffixed) to the base asset — differs slightly by caller (toBaseAsset vs a local equivalent) but must match how mtfData/positions/pending are keyed. */
  toBase: (symbol: string) => string;
}

export function buildEvaluations(ctx: EvaluationContext): SignalEvaluation[] {
  const {
    cryptoData, mtfData, positions: openPos, pending: queued, config,
    equity, initialAmount, dailyDrawdownPercent, weeklyDrawdownPercent,
    totalLeveragedExposureUsd, existingExposureByAsset, isRunning = true, toBase,
    closedTrades,
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    maxCorrelatedPositions = DEFAULT_MAX_CORRELATED,
    correlationLookback = DEFAULT_CORRELATION_LOOKBACK
  } = ctx;

  const streakCooldownUntil = streakCooldownFromHistory(closedTrades || []);
  const streakCooldownActive = isInStreakCooldown(streakCooldownUntil);

  // Adaptive risk-per-trade. Computed here rather than at the call site so
  // every runtime gets it — it previously lived in the browser hook alone,
  // which left the 24/7 server engine sizing every trade off the constant.
  const baseRiskPercent = DEFAULT_INTRADAY_PARAMS.riskPerTradePercent;
  const riskPerTradePercent =
    ctx.riskPerTradePercent ??
    adaptiveRiskPercentFromHistory(baseRiskPercent, closedTrades || [], dailyDrawdownPercent) ??
    baseRiskPercent;

  const maxTotalPositions = config.maxPositions || 7;
  const maxFutures = config.maxFuturesPositions || 2;
  const futuresCount = openPos.filter((p) => p.type === 'FUTURES').length;

  const isCircuitBreakerDaily = dailyDrawdownPercent >= 8;
  const isCircuitBreakerWeekly = weeklyDrawdownPercent >= 15;

  // Compute per-asset exposure from open positions (notional USD)
  const exposureByAsset: Record<string, number> = { ...(existingExposureByAsset || {}) };
  for (const p of openPos) {
    const base = toBase(p.symbol);
    exposureByAsset[base] = (exposureByAsset[base] || 0) + (p.notionalUsd || 0);
  }

  const portfolio = buildPortfolioRiskStats({
    portfolioValue: equity,
    initialAmount,
    dailyDrawdownPercent,
    weeklyDrawdownPercent,
    openPositionsCount: openPos.length,
    openFuturesPositionsCount: futuresCount,
    totalLeveragedExposureUsd,
    existingExposureByAsset: exposureByAsset
  });

  const openPositionsForEngine = openPos.map((p) => ({ symbol: p.symbol, type: p.type as 'SPOT' | 'FUTURES' }));

  // Correlation gate inputs. The H1 series from the multi-timeframe snapshot
  // is the right timeframe here: 72 H1 bars is the 3-day window the gate is
  // tuned for, and every symbol in mtfData carries the same bar grid, which
  // is what makes the pairwise numbers comparable.
  const correlationCandles: Record<string, Candle[] | undefined> = {};
  for (const key of Object.keys(mtfData)) correlationCandles[key] = mtfData[key]?.h1;
  // Queued entries count as held: they are already committed risk, and
  // without them a single tick can queue an entire correlated cluster before
  // any of it becomes a position.
  const heldForCorrelation: CorrelatedHolding[] = [
    ...openPos.map((p) => ({ symbol: toBase(p.symbol), direction: toPositionDirection(p.side) })),
    ...queued
      .filter((o) => ENTRY_ORDER_SIDES.has(o.side))
      .map((o) => ({ symbol: toBase(o.symbol), direction: toPositionDirection(o.side) }))
  ];

  const results: SignalEvaluation[] = [];

  for (const crypto of cryptoData) {
    const symbol = crypto.symbol.toUpperCase();
    const currentPrice = crypto.current_price;
    const priceChange24h = crypto.price_change_percentage_24h || 0;

    const snap = mtfData[toBase(symbol)];
    if (!snap || snap.status !== 'READY') continue;

    const ev = evaluateSymbolFromSnapshot(
      snap,
      { price: currentPrice, priceChange24h },
      portfolio,
      openPositionsForEngine,
      // Without this override, the decision engine's own internal position-
      // count gate silently used the DEFAULT (hardcoded 5) regardless of the
      // user's actual config.maxPositions/maxFuturesPositions — so raising
      // the limit in the UI had no real effect once past 5 positions.
      {
        ...DEFAULT_INTRADAY_PARAMS,
        ...SIM_INTRADAY_PARAMS_OVERRIDE,
        maxOpenPositions: config.maxPositions || DEFAULT_INTRADAY_PARAMS.maxOpenPositions,
        maxOpenFutures: config.maxFuturesPositions || DEFAULT_INTRADAY_PARAMS.maxOpenFutures,
        riskPerTradePercent
      }
    );

    // `symbol` here is bare (from cryptoData); queued/openPos entries store
    // the SUFFIXED symbol (ev.symbol → order.symbol → position.symbol traces
    // back to snap.symbol). Comparing them directly always returned false, so
    // the engine could never detect it already held or had queued a symbol.
    const isQueued = queued.some((o) => toBase(o.symbol) === symbol);
    const isHeld = openPos.some((p) => toBase(p.symbol) === symbol);
    const hasExistingFutures = openPos.some((p) => toBase(p.symbol) === symbol && p.type === 'FUTURES');

    let status = ev.status;
    let willExecute = ev.willExecute;

    if (!isRunning) { status = 'הבוט מושבת'; willExecute = false; }
    else if (isCircuitBreakerWeekly) { status = 'נעילת מערכת שבועית (הפסד >= 15%) — מושבת'; willExecute = false; }
    else if (isCircuitBreakerDaily) { status = 'הגנת תיק יומית (הפסד >= 8%) — חסום'; willExecute = false; }
    else if (isQueued) { status = 'פקודה כבר נמצאת בתור ביצוע'; willExecute = false; }
    else if (openPos.length >= maxTotalPositions) { status = `הגעת למקסימום ${maxTotalPositions} פוזיציות פתוחות`; willExecute = false; }
    else if (ev.tradeType === 'FUTURES' && futuresCount >= maxFutures) { status = `הגעת למקסימום ${maxFutures} פוזיציות Futures`; willExecute = false; }
    else if (ev.tradeType === 'FUTURES' && hasExistingFutures) { status = 'קיימת כבר פוזיציית Futures פתוחה'; willExecute = false; }
    else if (ev.tradeType === 'SPOT' && ev.tradeSide === 'BUY' && isHeld) { status = 'כבר מוחזק בתיק (Spot)'; willExecute = false; }
    else if (streakCooldownActive) { status = streakCooldownReason(streakCooldownUntil as number); willExecute = false; }

    // Confidence floor — minimum signal quality threshold
    if (willExecute && ev.tradeType !== 'HOLD' && ev.tradeSide !== 'NONE') {
      const minConf = config.minConfidenceOverride ?? 58;
      if (ev.confidence < minConf) { status = `Confidence נמוך מדי (${ev.confidence} < ${minConf})`; willExecute = false; }
    }

    // Correlation gate — last, because it is the most expensive check and
    // only meaningful for a candidate that survived every other gate.
    if (willExecute && ev.tradeType !== 'HOLD' && ev.tradeSide !== 'NONE') {
      const gate = evaluateCorrelationGate({
        symbol,
        direction: toPositionDirection(ev.tradeSide),
        held: heldForCorrelation,
        candlesBySymbol: correlationCandles,
        threshold: correlationThreshold,
        maxCorrelated: maxCorrelatedPositions,
        lookback: correlationLookback
      });
      if (!gate.allowed) { status = gate.reason as string; willExecute = false; }
    }

    results.push({ ...ev, status, willExecute });
  }

  return results;
}

// ── 2. Order generation ──────────────────────────────────────────────────────
// Checks every open position for an exit (SL/TP/trailing/reversal/time-stop
// via evaluatePositionExit), then queues new entry orders for evaluations
// that passed every gate above.

export interface OrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  /** Symbol (as stored on the position/order) → last-loss timestamp. Read-only here. */
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  buildCandlesForSymbol: (symbol: string) => Candle[];
  computeAtr5: (candles: Candle[]) => number;
  /** Position-count caps — evaluations were gated against the count as it
   *  stood at the START of this tick (see buildEvaluations), so several
   *  symbols can all carry willExecute=true simultaneously. Without
   *  re-checking a running total as THIS batch is built, a tick where N
   *  symbols qualify at once queues all N regardless of the cap — observed
   *  live: 10 MEAN_REVERSION signals fired in the same tick and opened 10
   *  positions against a configured max of 5. */
  maxPositions: number;
  maxFuturesPositions: number;
  /** Closed-trade history driving the post-losing-streak entry cooldown.
   *  buildEvaluations already reflects it in each evaluation's status, but
   *  this is the authoritative stop: evaluations are memoized per tick while
   *  order generation runs on every heartbeat. */
  closedTrades?: ClosedTradeRecord[];
  /** H1 candles per BASE asset for the WITHIN-BATCH correlation check.
   *  buildEvaluations gates each candidate against what is already open or
   *  queued, but every evaluation in a tick is judged against the same
   *  starting book — so a tick in which a whole correlated cluster fires at
   *  once passes that gate N times over. Omit to skip the batch check. */
  correlationCandles?: Record<string, Candle[] | undefined>;
  /** Must match how correlationCandles is keyed. Defaults to identity. */
  toBase?: (symbol: string) => string;
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
}

const ENTRY_ORDER_SIDES = new Set(['buy', 'sell', 'long', 'short']);

export function generateNewOrders(ctx: OrderGenContext): PendingOrder[] {
  const {
    positions, pending, evaluations, executionDelaySec, dailyDrawdownPercent, weeklyDrawdownPercent,
    exitCooldown, priceFor, buildCandlesForSymbol, computeAtr5, maxPositions, maxFuturesPositions,
    closedTrades, correlationCandles, toBase = (x: string) => x,
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    maxCorrelatedPositions = DEFAULT_MAX_CORRELATED,
    correlationLookback = DEFAULT_CORRELATION_LOOKBACK
  } = ctx;
  const delayMs = Math.max(0, executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];

  // Exits for open positions
  for (const pos of positions) {
    if (pending.some((o) => o.symbol === pos.symbol) || newOrders.some((o) => o.symbol === pos.symbol)) continue;

    const livePrice = priceFor(pos.symbol) ?? pos.currentPrice;
    const candles5 = buildCandlesForSymbol(pos.symbol);
    const atr5 = computeAtr5(candles5);
    // Last fully-CLOSED 5M candle's close — used only for MEAN_REVERSION's
    // close-confirmed stop (meanReversionCloseConfirmStop). candles5 already
    // excludes the forming candle, so its last element IS the last closed one.
    const lastClosedCandleClose = candles5.length ? candles5[candles5.length - 1].close : undefined;

    const currentEval = evaluations.find((e) => e.symbol === pos.symbol);
    const decision = currentEval?.decision;
    const reversal = decision && decision.outcome === 'SIGNAL'
      ? { direction: decision.direction, setupScore: decision.metrics.setupScore, entryConfirmed: !!decision.entry?.confirmed }
      : undefined;

    const exitCheck = evaluatePositionExit(
      {
        symbol: pos.symbol,
        type: pos.type,
        side: pos.side,
        entryPrice: pos.entryPrice,
        quantity: pos.quantity,
        stopLoss: pos.stopLoss,
        takeProfit1: pos.takeProfit1,
        takeProfit2: pos.takeProfit2,
        tp1Hit: pos.tp1Hit,
        openTimestamp: pos.openTimestamp,
        plannedStopDistance: Math.abs(pos.entryPrice - pos.stopLoss),
        highestPrice: pos.highestPrice,
        lowestPrice: pos.lowestPrice,
        highestPriceSinceTP1: pos.highestPriceSinceTP1,
        lowestPriceSinceTP1: pos.lowestPriceSinceTP1,
        maxHoldMs: pos.maxHoldMs,
        timeStopMs: pos.timeStopMs,
        setupType: pos.setupType
      },
      livePrice,
      atr5,
      { dailyDrawdownPercent, weeklyDrawdownPercent },
      reversal,
      { ...DEFAULT_INTRADAY_PARAMS, ...SIM_INTRADAY_PARAMS_OVERRIDE },
      lastClosedCandleClose
    );

    if (!exitCheck.shouldExit) continue;

    if (exitCheck.exitType === 'PARTIAL_50') {
      newOrders.push({
        id: uid(`${pos.symbol}-tp1-50`),
        symbol: pos.symbol,
        type: pos.type,
        side: 'partial_tp1',
        signalPrice: livePrice,
        quantity: pos.quantity * 0.5,
        reason: exitCheck.reason,
        confidence: pos.confidence,
        executeAt: Date.now() + delayMs,
        createdAt: Date.now()
      });
    } else {
      newOrders.push({
        id: uid(`${pos.symbol}-exit`),
        symbol: pos.symbol,
        type: pos.type,
        side: pos.side === 'LONG' || pos.side === 'BUY' ? 'close_long' : 'close_short',
        signalPrice: livePrice,
        quantity: pos.quantity,
        reason: exitCheck.reason,
        confidence: pos.confidence,
        executeAt: Date.now() + delayMs,
        createdAt: Date.now()
      });
    }
  }

  // New entries from evaluations that passed every gate. Running counts,
  // seeded from open positions PLUS already-pending entries (not yet
  // filled) and incremented as this batch adds more — the per-symbol
  // evaluations were all gated against the position count as it stood at
  // the START of this tick, so a batch cap here is the only thing standing
  // between "N symbols qualified simultaneously" and "N new positions
  // regardless of maxPositions".
  // A losing streak stops the book entirely — sizing down is not the same as
  // standing down. Exits above are deliberately NOT affected.
  if (isInStreakCooldown(streakCooldownFromHistory(closedTrades || []))) return newOrders;

  let totalPositionCount = positions.length + pending.filter((o) => ENTRY_ORDER_SIDES.has(o.side)).length;
  let futuresPositionCount = positions.filter((p) => p.type === 'FUTURES').length +
    pending.filter((o) => o.type === 'FUTURES' && ENTRY_ORDER_SIDES.has(o.side)).length;

  // Running correlation book: open positions + already-pending entries, grown
  // as this batch accepts more.
  const correlationBook: CorrelatedHolding[] = correlationCandles
    ? [
        ...positions.map((p) => ({ symbol: toBase(p.symbol), direction: toPositionDirection(p.side) })),
        ...pending
          .filter((o) => ENTRY_ORDER_SIDES.has(o.side))
          .map((o) => ({ symbol: toBase(o.symbol), direction: toPositionDirection(o.side) }))
      ]
    : [];

  for (const ev of evaluations) {
    if (!ev.willExecute || !ev.price || ev.tradeType === 'HOLD') continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;
    if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;
    if (totalPositionCount >= maxPositions) continue;
    if (ev.tradeType === 'FUTURES' && futuresPositionCount >= maxFuturesPositions) continue;

    const orderSide = ev.tradeType === 'FUTURES'
      ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
      : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

    const budget = computeEntryBudget(ctx.cash, ev.tradeType === 'FUTURES' ? 'FUTURES' : 'SPOT');
    if (budget < 5) continue;

    const evDirection = toPositionDirection(ev.tradeSide as string);
    if (correlationCandles) {
      const gate = evaluateCorrelationGate({
        symbol: toBase(ev.symbol),
        direction: evDirection,
        held: correlationBook,
        candlesBySymbol: correlationCandles,
        threshold: correlationThreshold,
        maxCorrelated: maxCorrelatedPositions,
        lookback: correlationLookback
      });
      if (!gate.allowed) continue;
    }

    totalPositionCount++;
    if (ev.tradeType === 'FUTURES') futuresPositionCount++;
    if (correlationCandles) correlationBook.push({ symbol: toBase(ev.symbol), direction: evDirection });

    newOrders.push({
      id: uid(`${ev.symbol}-${orderSide}`),
      symbol: ev.symbol,
      type: ev.tradeType as 'SPOT' | 'FUTURES',
      side: orderSide,
      signalPrice: ev.price,
      quantity: (budget * (ev.leverage || 1)) / ev.price,
      budgetUsd: budget,
      leverage: ev.leverage || 1,
      stopLoss: ev.stopLoss,
      takeProfit1: ev.takeProfit1,
      takeProfit2: ev.takeProfit2,
      takeProfit: ev.takeProfit,
      reason: ev.reasoning,
      confidence: ev.confidence,
      executeAt: Date.now() + delayMs,
      createdAt: Date.now(),
      // Carry the setup-type-correct hold budget from the entry-time RiskPlan
      // (see the SimPosition.maxHoldMs doc comment) — without this, every
      // position falls back to a single hardcoded default at exit-check time.
      maxHoldMs: ev.decision?.risk?.maxHoldMs,
      timeStopMs: ev.decision?.risk?.timeStopMs,
      setupType: ev.decision?.setupType
    });
  }

  return newOrders;
}

// ── 3. Order fill / execution ────────────────────────────────────────────────
// Fills every due pending order: opens a new position (buy/long/short),
// partially or fully closes an existing one, applying slippage/fees and the
// SL/TP reanchor. Pure — callers own applying the returned state and sending
// any notifications from `events`.

const EXIT_ORDER_SIDES = new Set(['close_long', 'close_short', 'partial_tp1']);

/** Matches tradingWorker.ts's own LIMIT_ORDER_TTL_MS for the real bot. */
export const LIMIT_ORDER_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface FillableOrdersResult {
  due: PendingOrder[];
  expired: PendingOrder[];
}

/**
 * Splits pending orders into those ready to fill now and those that expired
 * unfilled. EXIT orders (SL/TP/trailing/time-stop closes) behave like real
 * market/stop orders: once the execution delay elapses they fire
 * immediately, no price condition — matching how the real bot's SL/TP
 * brackets fire on the exchange side. ENTRY orders behave like a real
 * resting LIMIT order: the delay only marks the earliest check time: they
 * only actually become due once the live price has crossed to the order's
 * own limit (signalPrice) or better — a BUY/LONG limit only at or below its
 * price, a SELL/SHORT limit only at or above. If price never crosses within
 * LIMIT_ORDER_TTL_MS the order expires unfilled (mirrors the real bot's own
 * TTL-cancel in tradingWorker.ts) instead of being force-filled at whatever
 * the live price happens to be — which previously turned every "Limit"
 * order in this simulation into a delayed MARKET order and let entries fill
 * on the wrong side of their own stated limit (observed live: "Limit BUY @
 * $1.3680" filled at $1.3756).
 */
export function selectFillableOrders(pending: PendingOrder[], now: number, priceFor: (symbol: string) => number | undefined): FillableOrdersResult {
  const due: PendingOrder[] = [];
  const expired: PendingOrder[] = [];
  for (const o of pending) {
    if (now < o.executeAt) continue;
    if (EXIT_ORDER_SIDES.has(o.side)) {
      due.push(o);
      continue;
    }
    const live = priceFor(o.symbol) ?? o.signalPrice;
    const isLongSide = o.side === 'buy' || o.side === 'long';
    const crossed = isLongSide ? live <= o.signalPrice : live >= o.signalPrice;
    if (crossed) {
      due.push(o);
    } else if (now - o.createdAt >= LIMIT_ORDER_TTL_MS) {
      expired.push(o);
    }
  }
  return { due, expired };
}

export interface FillEvent {
  kind: 'entry' | 'partial_exit' | 'exit';
  symbol: string;
  text: string;
}

export interface FillResult {
  cash: number;
  positions: SimPosition[];
  newTrades: SimTrade[];
  feesAdded: number;
  slipAdded: number;
  /** Symbols that closed with a loss this batch — merge into the caller's cooldown map. */
  newCooldowns: Record<string, number>;
  events: FillEvent[];
}

export function fillDueOrders(due: PendingOrder[], cash: number, positions: SimPosition[], priceFor: (symbol: string) => number | undefined, formatPrice: (n: number) => string): FillResult {
  // Explicit timeZone: this runs both in the browser (whatever local TZ) and
  // on the server (Render defaults to UTC) — without it, a trade's displayed
  // "last: HH:MM:SS" silently used the server's UTC clock instead of Israel
  // time, making a trade from moments ago look ~3 hours stale in the UI.
  const now = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
  let workingCash = cash;
  let workingPositions = [...positions];
  const newTrades: SimTrade[] = [];
  const newCooldowns: Record<string, number> = {};
  const events: FillEvent[] = [];
  let feesAdded = 0;
  let slipAdded = 0;

  for (const order of due) {
    const market = priceFor(order.symbol) ?? order.signalPrice;
    const isEntryOrder = order.side === 'buy' || order.side === 'long' || order.side === 'short';
    // ENTRY orders are real resting LIMIT orders (see selectFillableOrders —
    // they only reach `due` once price has actually crossed the limit), so
    // they fill at their own limit price or BETTER, exactly like a real
    // exchange limit fill — never at "live price + adverse slippage", which
    // previously let a "Limit BUY @ $1.3680" fill at $1.3756. EXIT orders
    // (SL/TP/trailing/time-stop) stay market-style: urgent, fills at live
    // price with slippage, matching how the real bot's SL/TP brackets fire.
    const sideForSlippage = order.side === 'buy' || order.side === 'long' ? 'BUY' : 'SELL';
    const isLongSide = order.side === 'buy' || order.side === 'long';
    const { fillPrice, slippagePercent } = isEntryOrder
      ? { fillPrice: isLongSide ? Math.min(market, order.signalPrice) : Math.max(market, order.signalPrice), slippagePercent: 0 }
      : simulateSlippage(market, sideForSlippage);
    const delayMs = Date.now() - order.createdAt;

    if (isEntryOrder) {
      const budget = Math.min(order.budgetUsd ?? 100, workingCash);
      if (budget < 5) continue;

      const isFutures = order.type === 'FUTURES';
      const leverage = order.leverage || 1;
      const notional = budget * leverage;
      const fee = calculateTradingFee(notional, order.type, true);
      const totalCost = budget + fee;
      if (totalCost > workingCash) continue;
      const quantity = notional / fillPrice;

      workingCash -= totalCost;
      feesAdded += fee;
      slipAdded += Math.abs(fillPrice - market) * quantity;

      const reanchor = (level: number | undefined) => reanchorLevel(fillPrice, order.signalPrice, level);

      const newPos: SimPosition = {
        id: uid(order.symbol),
        symbol: order.symbol,
        type: order.type,
        side: order.side === 'long' ? 'LONG' : order.side === 'short' ? 'SHORT' : 'BUY',
        quantity,
        entryPrice: fillPrice,
        avgPrice: fillPrice,
        currentPrice: fillPrice,
        leverage,
        marginUsd: budget,
        notionalUsd: notional,
        stopLoss: reanchor(order.stopLoss) ?? (isLongSide ? fillPrice * 0.95 : fillPrice * 1.05),
        takeProfit1: reanchor(order.takeProfit1),
        takeProfit2: reanchor(order.takeProfit2),
        takeProfit: reanchor(order.takeProfit) ?? (isLongSide ? fillPrice * 1.05 : fillPrice * 0.95),
        tp1Hit: false,
        highestPrice: fillPrice,
        lowestPrice: fillPrice,
        openedAt: now,
        openTimestamp: Date.now(),
        reason: order.reason,
        confidence: order.confidence,
        entryFee: fee,
        maxHoldMs: order.maxHoldMs,
        timeStopMs: order.timeStopMs,
        setupType: order.setupType
      };

      workingPositions.push(newPos);
      newTrades.push({
        id: order.id, symbol: order.symbol, type: order.type, side: order.side,
        price: fillPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs,
        quantity, usdValue: notional, leverage, timestamp: now, at: Date.now(),
        reason: order.reason, confidence: order.confidence
      });

      events.push({
        kind: 'entry',
        symbol: order.symbol,
        text: `🟢 סימולציה — כניסה\n\n` +
          `סמל: ${order.symbol}\n` +
          `כיוון: ${newPos.side}${isFutures ? ` (${leverage}x)` : ''}\n` +
          `מחיר כניסה: $${formatPrice(fillPrice)}\n` +
          `SL: $${formatPrice(newPos.stopLoss)}\n` +
          (newPos.takeProfit1 ? `TP1: $${formatPrice(newPos.takeProfit1)}\n` : '') +
          (newPos.takeProfit2 ? `TP2: $${formatPrice(newPos.takeProfit2)}\n` : '') +
          `סיבה: ${order.reason || '-'}\n` +
          `זמן: ${now}`
      });
    } else if (order.side === 'partial_tp1') {
      const posIdx = workingPositions.findIndex((p) => p.symbol === order.symbol && p.type === 'FUTURES');
      if (posIdx >= 0) {
        const pos = workingPositions[posIdx];
        const closeQty = pos.quantity * 0.5;
        const notional = closeQty * fillPrice;
        const fee = calculateTradingFee(notional, 'FUTURES', true);
        const pnl = pos.side === 'LONG'
          ? (fillPrice - pos.entryPrice) * closeQty
          : (pos.entryPrice - fillPrice) * closeQty;

        workingCash += pos.marginUsd * 0.5 + pnl - fee;
        feesAdded += fee;
        slipAdded += Math.abs(fillPrice - market) * closeQty;

        workingPositions[posIdx] = {
          ...pos,
          quantity: pos.quantity - closeQty,
          marginUsd: pos.marginUsd * 0.5,
          notionalUsd: (pos.quantity - closeQty) * fillPrice,
          tp1Hit: true,
          highestPriceSinceTP1: fillPrice,
          lowestPriceSinceTP1: fillPrice
        };

        const partialPnlPercent = (pnl / (pos.marginUsd * 0.5)) * 100;
        newTrades.push({
          id: order.id, symbol: order.symbol, type: 'FUTURES', side: 'partial_tp1',
          price: fillPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs,
          quantity: closeQty, usdValue: notional, leverage: pos.leverage, timestamp: now, at: Date.now(),
          reason: order.reason, confidence: order.confidence, pnl, pnlPercent: partialPnlPercent
        });

        events.push({
          kind: 'partial_exit',
          symbol: order.symbol,
          text: `${pnl >= 0 ? '✅' : '🔴'} סימולציה — יציאה חלקית (TP1, 50%)\n\n` +
            `סמל: ${order.symbol}\n` +
            `כיוון: ${pos.side}\n` +
            `מחיר כניסה: $${formatPrice(pos.entryPrice)}\n` +
            `מחיר יציאה: $${formatPrice(fillPrice)}\n` +
            `רווח/הפסד (חלקי): ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${partialPnlPercent >= 0 ? '+' : ''}${partialPnlPercent.toFixed(2)}%)\n` +
            `זמן: ${now}`
        });
      }
    } else {
      const pos = workingPositions.find((p) => p.symbol === order.symbol);
      if (pos) {
        const notional = pos.quantity * fillPrice;
        const fee = calculateTradingFee(notional, pos.type, true);
        let pnl = 0;
        if (pos.type === 'SPOT') {
          const netProceeds = notional - fee;
          const costBasis = pos.quantity * pos.avgPrice;
          pnl = netProceeds - costBasis - pos.entryFee;
          workingCash += netProceeds;
        } else {
          pnl = pos.side === 'LONG'
            ? (fillPrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - fillPrice) * pos.quantity;
          workingCash += pos.marginUsd + pnl - fee;
        }

        feesAdded += fee;
        slipAdded += Math.abs(market - fillPrice) * pos.quantity;
        workingPositions = workingPositions.filter((p) => p.id !== pos.id);
        if (pnl < 0) newCooldowns[order.symbol] = Date.now();

        const pnlPercent = pos.type === 'SPOT'
          ? (pnl / (pos.quantity * pos.avgPrice)) * 100
          : (pnl / pos.marginUsd) * 100;
        newTrades.push({
          id: order.id, symbol: order.symbol, type: pos.type, side: order.side,
          price: fillPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs,
          quantity: pos.quantity, usdValue: notional, leverage: pos.leverage, timestamp: now, at: Date.now(),
          reason: order.reason, confidence: order.confidence, pnl, pnlPercent
        });

        events.push({
          kind: 'exit',
          symbol: order.symbol,
          text: `${pnl >= 0 ? '✅' : '🔴'} סימולציה — יציאה\n\n` +
            `סמל: ${order.symbol}\n` +
            `כיוון: ${pos.side}\n` +
            `מחיר כניסה: $${formatPrice(pos.entryPrice)}\n` +
            `מחיר יציאה: $${formatPrice(fillPrice)}\n` +
            `רווח/הפסד: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
            `סיבה: ${order.reason || '-'}\n` +
            `זמן: ${now}`
        });
      }
    }
  }

  return { cash: workingCash, positions: workingPositions, newTrades, feesAdded, slipAdded, newCooldowns, events };
}

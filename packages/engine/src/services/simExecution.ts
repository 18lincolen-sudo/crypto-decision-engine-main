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
export const SIM_INTRADAY_PARAMS_OVERRIDE: Partial<IntradayParams> = {
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
  /** Capital at risk at ENTRY: |entryPrice - stopLoss| × quantity, in the same
   *  units as the pnl computed at close (quantity already carries leverage for
   *  Futures, since it is derived from the leveraged notional).
   *
   *  Snapshotted here and never recomputed: stopLoss moves under trailing stops
   *  and TP1 reanchoring, so a close-time derivation gives the wrong risk. This
   *  is the denominator that turns Kelly's payoff ratio into R-multiples —
   *  see kellyPayoffRatio() in adaptiveRisk.ts. Optional because positions
   *  restored from state persisted before this field existed will not have it. */
  initialRiskUsd?: number;
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
  /** Risk-at-entry of the position this trade closed, carried from
   *  SimPosition.initialRiskUsd. Present on exit trades only — entries have no
   *  pnl and are filtered out before the Kelly history is built. */
  riskUsd?: number;
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
  /** EXIT orders only: the id of the SimPosition this order closes.
   *  Exit orders used to be matched back to a position by SYMBOL alone, which
   *  is only unambiguous while one position per symbol exists — and nothing
   *  enforced that. With two lots of the same asset open, the close filled
   *  against whichever lot sat first in the array rather than the one whose
   *  stop actually triggered, so P&L, riskUsd and the R-multiple were booked
   *  against the wrong entry price. Optional: orders persisted before this
   *  field existed fall back to the symbol match. */
  positionId?: string;
  /** Carried from the entry-time RiskPlan through to the resulting SimPosition — see SimPosition.maxHoldMs. */
  maxHoldMs?: number;
  timeStopMs?: number;
  setupType?: SetupType;
}

export interface SimBotConfig {
  riskLevel: 'low' | 'medium' | 'high';
  initialAmount: number;
  // No stopLoss/takeProfit here, deliberately. Both existed as configured
  // percentages (4.2 and 3) that survived the move to ATR-sized stops without
  // being deleted, so six config objects and a settings panel carried numbers
  // no engine has read since. Stops come from calculateRiskParameters /
  // intradayRisk (ATR-normalised, clamped to [1.5%, 6%]) and the target is
  // derived from the stop at a fixed 1.67 reward:risk, so a flat percentage
  // here has nothing to attach to — reinstating one would mean choosing to
  // override the volatility-scaled stop with a constant.
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

/** Percentage of free cash committed to one SPOT entry when the caller supplies
 *  no positionPercent. */
export const DEFAULT_POSITION_PERCENT = 15;

/** FUTURES commits a third of what SPOT does, because leverage multiplies
 *  whatever margin is posted. Kept as a ratio so a configured positionPercent
 *  moves both markets together instead of only one. */
export const FUTURES_POSITION_RATIO = 1 / 3;

/** Entry position sizing: FUTURES risk is capped in absolute $ terms (not just %) since leverage already amplifies exposure; SPOT is capped higher since there's no leverage multiplier.
 *
 *  `positionPercent` is SimBotConfig.positionPercent — the control that appears
 *  in the bot panel and in BOT_POSITION_PERCENT. It used to reach
 *  calculateRiskParameters as `_configuredPositionPercent` and stop there,
 *  which is to say the setting did nothing to any simulated trade. */
export function computeEntryBudget(
  cash: number,
  tradeType: 'SPOT' | 'FUTURES',
  positionPercent: number = DEFAULT_POSITION_PERCENT
): number {
  const percent = Number.isFinite(positionPercent) && positionPercent > 0
    ? positionPercent
    : DEFAULT_POSITION_PERCENT;
  return tradeType === 'FUTURES'
    ? Math.min(cash * (percent * FUTURES_POSITION_RATIO) / 100, 500)
    : Math.min(cash * percent / 100, 1000);
}

/** Multiplier applied to the entry budget for SimBotConfig.riskLevel.
 *  The selector had never been read by any engine, so this is the behaviour it
 *  is being given rather than one being restored: it scales conviction size,
 *  and deliberately leaves trade FREQUENCY (the confidence threshold) alone —
 *  one knob, one effect. */
export function riskLevelSizingMultiplier(riskLevel?: 'low' | 'medium' | 'high'): number {
  if (riskLevel === 'low') return 0.6;
  if (riskLevel === 'high') return 1.5;
  return 1;
}

/** Safety net against rapid re-entry churn: after a LOSING full exit, skip new
 *  entries on that symbol for this cooldown window even if the signal still
 *  fires. Raised from 2 to 30 minutes so reversal-churn in choppy markets
 *  (exit on reversal → immediate re-entry → another reversal) stops bleeding
 *  double fees/slippage every cycle. */
export const ENTRY_COOLDOWN_MS = 30 * 60 * 1000;

export function isInEntryCooldown(cooldownAt: number | undefined, now: number = Date.now()): boolean {
  return typeof cooldownAt === 'number' && now - cooldownAt < ENTRY_COOLDOWN_MS;
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
  /** Portfolio equity — the denominator for the losing-streak cooldown's
   *  "was this loss big enough to be a different regime" test. */
  equity: number;
  /** SimBotConfig.positionPercent / .riskLevel, the two sizing controls the bot
   *  panel exposes. Omitted — by tests and by any caller with no user config
   *  — they fall back to the engine defaults. */
  positionPercent?: number;
  riskLevel?: 'low' | 'medium' | 'high';
  /** Symbol (as stored on the position/order) → last-loss timestamp. Read-only here. */
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  buildCandlesForSymbol: (symbol: string) => Candle[];
  computeAtr5: (candles: Candle[]) => number;
  /** Position-count caps — several symbols can all carry willExecute=true
   *  simultaneously. Without re-checking a running total as THIS batch is
   *  built, a tick where N symbols qualify at once queues all N regardless
   *  of the cap — observed live: 10 MEAN_REVERSION signals fired in the
   *  same tick and opened 10 positions against a configured max of 5. */
  maxPositions: number;
  maxFuturesPositions: number;
  /** Closed-trade history driving the post-losing-streak entry cooldown.
   *  This is the authoritative stop: evaluations are memoized per tick while
   *  order generation runs on every heartbeat. */
  closedTrades?: ClosedTradeRecord[];
  /** H1 candles per BASE asset for the WITHIN-BATCH correlation check.
   *  Every evaluation in a tick is judged against the same starting book —
   *  so a tick in which a whole correlated cluster fires at once passes
   *  that gate N times over. Omit to skip the batch check. */
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

  // Exits for open positions.
  // The skip is per POSITION, not per symbol: keying it on the symbol meant
  // that while one lot's close sat pending, every other lot of the same asset
  // went unchecked for its own stop — so a book holding the same asset N times
  // released its stops one per tick and the rest kept bleeding in between.
  // Orders with no positionId (persisted before that field existed, and every
  // entry order) still match by symbol, so their old behaviour is unchanged.
  for (const pos of positions) {
    const claimed = (o: PendingOrder) => (o.positionId ? o.positionId === pos.id : o.symbol === pos.symbol);
    if (pending.some(claimed) || newOrders.some(claimed)) continue;

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
        positionId: pos.id,
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
        positionId: pos.id,
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
  // The per-symbol losing-streak cooldown is applied in the entry loop below.
  // It is deliberately per-symbol — a losing streak on one asset should not
  // block entries on unrelated ones.

  // Cash consumed by this batch. computeEntryBudget is a percentage of the
  // free balance, so reading ctx.cash for every order in the same tick sized
  // N simultaneous entries as if each one were the only entry of the tick.
  let workingCash = ctx.cash;

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
    // One position per symbol. Without this, the queue check below is not a
    // dedup at all: once an entry fills, its symbol leaves `pending`, and the
    // very same signal — unchanged, because it is read off a candle that moves
    // far slower than this loop runs — queues the asset again, and again,
    // stacking lots of one asset until the position cap is spent. Nothing
    // downstream merges them: fillDueOrders always pushes a NEW position, each
    // with its own stop, and they then all stop out together. Scaling into a
    // winner is not a feature this engine has.
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;
    if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;
    // Post-losing-streak pause. The helpers were imported here but never
    // called, so the streak brake was documented and inert.
    if (isInStreakCooldown(streakCooldownFromHistory(closedTrades ?? [], ctx.equity, ev.symbol))) continue;
    if (totalPositionCount >= maxPositions) continue;
    if (ev.tradeType === 'FUTURES' && futuresPositionCount >= maxFuturesPositions) continue;

    const orderSide = ev.tradeType === 'FUTURES'
      ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
      : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

    // Adaptive sizing (DecisionEngine path): the decision's risk plan carries
    // the multiplier computed from recent closed-trade performance (clamped to
    // [0,1] — it only ever de-risks). Evaluations built outside the engine
    // (tests / legacy paths) carry no multiplier → 1.
    const rawRisk = (ev.decision as { risk?: { sizingMultiplier?: number } | null } | null | undefined)?.risk;
    const riskMult = typeof rawRisk?.sizingMultiplier === 'number' && Number.isFinite(rawRisk.sizingMultiplier)
      ? Math.max(0, Math.min(1, rawRisk.sizingMultiplier))
      : 1;
    const budget = computeEntryBudget(workingCash, ev.tradeType === 'FUTURES' ? 'FUTURES' : 'SPOT', ctx.positionPercent)
      * riskMult * riskLevelSizingMultiplier(ctx.riskLevel);
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
    workingCash -= budget;
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

/** Deliberately SHORTER than the real bot's own LIMIT_ORDER_TTL_MS (4h in
 *  tradingWorker.ts): a 2h TTL makes the simulation's entries more
 *  stale-signal-resistant than the live bot's. Note the consequence when
 *  reading sim results as a forecast — an entry the simulation cancelled at
 *  2h is one the live bot may still fill at 3h. */
export const LIMIT_ORDER_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

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
      // Do not let a resting entry-limit fill into a move that has already
      // blown through the position's own stop level: the price that crossed
      // the limit here was reached on the WRONG side of the signal, and an
      // entry at this price would open underwater with the stop no longer
      // protecting the original risk plan. Cancel the order instead of
      // stacking a losing entry precisely where the entry was supposed to be
      // defended (adverse-selection guard).
      if (
        (isLongSide && typeof o.stopLoss === 'number' && live < o.stopLoss) ||
        (!isLongSide && typeof o.stopLoss === 'number' && live > o.stopLoss)
      ) {
        expired.push(o);
        continue;
      }
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

/** Simulation cost model overrides, from SimBotConfig. Omit either field to use
 *  the exchange's real fee schedule / the default slippage band. */
export interface SimCostOverrides {
  feePercent?: number;
  slippagePercent?: number;
}

export function fillDueOrders(due: PendingOrder[], cash: number, positions: SimPosition[], priceFor: (symbol: string) => number | undefined, formatPrice: (n: number) => string, costs: SimCostOverrides = {}): FillResult {
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
      : simulateSlippage(market, sideForSlippage, costs.slippagePercent);
    const delayMs = Date.now() - order.createdAt;

    if (isEntryOrder) {
      const budget = Math.min(order.budgetUsd ?? 100, workingCash);
      if (budget < 5) continue;

      const isFutures = order.type === 'FUTURES';
      const leverage = order.leverage || 1;
      const notional = budget * leverage;
      // Limit-entry fills are Maker-type (the order only fills at or better
      // than its own limit price — see selectFillableOrders): charging Taker
      // here inflated entry costs 2.75-5x and contradicted evaluateCostEdge,
      // which already models Maker entry cost (§25).
      const fee = calculateTradingFee(notional, order.type, false, costs.feePercent);
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
      // Snapshot risk-at-entry AFTER newPos is built: it needs the reanchored
      // stopLoss actually stored on the position, not order.stopLoss, which was
      // computed against the signal price rather than the fill price.
      newPos.initialRiskUsd = Math.abs(fillPrice - newPos.stopLoss) * quantity;

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
      const posIdx = workingPositions.findIndex((p) => (order.positionId ? p.id === order.positionId : p.symbol === order.symbol) && p.type === 'FUTURES');
      if (posIdx >= 0) {
        const pos = workingPositions[posIdx];
        const closeQty = pos.quantity * 0.5;
        const notional = closeQty * fillPrice;
        const fee = calculateTradingFee(notional, 'FUTURES', true, costs.feePercent);
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
          lowestPriceSinceTP1: fillPrice,
          // The remainder was opened against half the original risk. Without
          // halving here, the eventual full close would divide the remaining
          // half's pnl by the whole position's risk and understate its R.
          initialRiskUsd: pos.initialRiskUsd !== undefined ? pos.initialRiskUsd / 2 : undefined
        };

        const partialPnlPercent = (pnl / (pos.marginUsd * 0.5)) * 100;
        newTrades.push({
          id: order.id, symbol: order.symbol, type: 'FUTURES', side: 'partial_tp1',
          price: fillPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs,
          quantity: closeQty, usdValue: notional, leverage: pos.leverage, timestamp: now, at: Date.now(),
          reason: order.reason, confidence: order.confidence, pnl, pnlPercent: partialPnlPercent,
          // Half the position closed, so half the risk it was opened against —
          // matching how pnl above is already the half-position's pnl.
          riskUsd: pos.initialRiskUsd !== undefined ? pos.initialRiskUsd / 2 : undefined
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
      const pos = workingPositions.find((p) => (order.positionId ? p.id === order.positionId : p.symbol === order.symbol));
      if (pos) {
        const notional = pos.quantity * fillPrice;
        const fee = calculateTradingFee(notional, pos.type, true, costs.feePercent);
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
          reason: order.reason, confidence: order.confidence, pnl, pnlPercent,
          riskUsd: pos.initialRiskUsd
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

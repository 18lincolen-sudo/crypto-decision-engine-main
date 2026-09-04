// Shared engine core for the LEGACY (original alg.md) paper-trading
// simulation — used by BOTH the server's 24/7 engine (server/legacySimEngine.ts)
// and the browser fallback hook (src/hooks/useLegacySimulationBot.ts). Mirrors
// the role src/services/simExecution.ts plays for the new intraday engine:
// same idea (one evaluation/order-generation core, each runtime owns its own
// state and calls these as pure functions), but this one drives the DIFFERENT
// decision algorithm (routeTradeType / tradeEngine.ts Layer 1/2/3 — single-
// timeframe regime detection + weighted-confidence signal scoring), which is
// the one deliberate difference between the two bots. Order EXECUTION
// (fillDueOrders) is identical fee/slippage/reanchor mechanics for both bots,
// so that stays imported directly from simExecution.ts — no separate copy here.
import { CryptoData, MarketRegimeResult, TradeSide, RiskParametersResult } from '../types/crypto';
import {
  detectMarketRegime,
  evaluateSignals,
  routeTradeType,
  calculateOptimalEntry,
  calculateRiskParameters,
  evaluateExit,
  Candle,
  ClosedTradeMetric,
  MIN_ENTRY_RELATIVE_VOLUME
} from './tradeEngine';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import { computeEntryBudget, isInEntryCooldown, riskLevelSizingMultiplier } from './simExecution';
import {
  summarizeRecentPerformance,
  computeSizingMultiplier,
  streakCooldownFromHistory,
  isInStreakCooldown,
  streakCooldownReason,
  ClosedTradeRecord,
  MIN_RISK_REWARD_RATIO
} from './adaptiveRisk';
import {
  evaluateCorrelationGate,
  toPositionDirection,
  CorrelatedHolding,
  DEFAULT_CORRELATION_LOOKBACK,
  DEFAULT_CORRELATION_THRESHOLD,
  DEFAULT_MAX_CORRELATED
} from './correlation';
import type { SimPosition, PendingOrder, SimBotConfig } from './simExecution';

export const uid = (p: string) => `legacy-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Minimum candles needed for the legacy indicators (EMA50 warm-up + RSI14 + BB20 + ADX14).
export const MIN_LEGACY_CANDLES = 60;

// When confidence is at or above this threshold, Layer 3 risk blocks are
// bypassed: the trade proceeds with minimal fallback parameters instead of
// being rejected. This prevents high-confidence signals from being lost to
// portfolio-cap or sizing edge-cases.
export const HIGH_CONFIDENCE_BYPASS = 72;

// No per-asset exposure ceiling is enforced here, deliberately. Legacy holds at
// most one position per symbol (see the entry gate below) and that position's
// notional is already bounded by computeEntryBudget, so a per-asset cap in this
// function has nothing left to bind against: every path that could exceed it is
// a path the symbol gate rejects first. An earlier revision of this fix added
// one anyway — it shrank ordinary single positions from 15% of cash to 8% of
// equity, which is a sizing change, and once scoped narrowly enough to stop
// doing that it became unreachable. legacySimEngine.ts still computes
// existingExposureByAsset for the shared PortfolioRiskStats shape; on this path
// it is informational.

// ── 2. Order generation — exit checks (evaluateExit) + new entries ─────────────

/** Builds a minimal fallback risk plan when calculateRiskParameters returns null
 *  but the signal confidence is high enough (>= HIGH_CONFIDENCE_BYPASS). Uses
 *  fixed 1.8% SL / 3% TP so the trade has a defined risk profile. */
export function buildFallbackLegacyRisk(entryPrice: number, side: TradeSide, confidence: number): RiskParametersResult {
  const slPercent = 1.8;
  const tpPercent = 3.0;
  const isLong = side === 'LONG' || side === 'BUY';
  const stopLoss = isLong ? entryPrice * (1 - slPercent / 100) : entryPrice * (1 + slPercent / 100);
  const takeProfit = isLong ? entryPrice * (1 + tpPercent / 100) : entryPrice * (1 - tpPercent / 100);
  const takeProfit1 = takeProfit;
  const takeProfit2 = isLong ? entryPrice * (1 + tpPercent * 1.5 / 100) : entryPrice * (1 - tpPercent * 1.5 / 100);
  const stopDist = Math.abs(entryPrice - stopLoss);
  const riskRewardRatio = stopDist > 0 ? Math.abs(takeProfit - entryPrice) / stopDist : 1.67;
  return {
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit1: Number(takeProfit1.toFixed(8)),
    takeProfit2: Number(takeProfit2.toFixed(8)),
    takeProfit: Number(takeProfit.toFixed(8)),
    leverage: 1,
    betSizeUsd: 5,
    positionPercentOfPortfolio: 0,
    riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
    kellyFraction: 0,
    maxRiskAmountUsd: 5,
    stopDistanceUsd: Number(stopDist.toFixed(8))
  };
}

export function activeMarketRegimesFrom(evaluations: SignalEvaluation[]): Record<string, MarketRegimeResult> {
  const regimes: Record<string, MarketRegimeResult> = {};
  for (const ev of evaluations) if (ev.regime) regimes[ev.symbol] = ev.regime;
  return regimes;
}

// ── 2. Order generation — exit checks (evaluateExit) + new entries ─────────────

export interface LegacyOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  /** Portfolio equity value — used for streak cooldown threshold calculation. */
  equity: number;
  /** SimBotConfig.positionPercent / .riskLevel — see the identical fields on
   *  simExecution.ts's OrderGenContext. */
  positionPercent?: number;
  riskLevel?: 'low' | 'medium' | 'high';
  /** Symbol (as stored on the position/order) → last-loss timestamp. Read-only here. */
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  /** Single-timeframe (H1) candles keyed by BASE asset. */
  candlesBySymbol: Record<string, Candle[]>;
  /** Position-count caps — see the identical doc comment on simExecution.ts's
   *  OrderGenContext.maxPositions for why a running check within this batch
   *  (not just the per-symbol evaluations) is required. */
  maxPositions: number;
  maxFuturesPositions: number;
  /** Closed-trade history driving the post-losing-streak entry cooldown — see
   *  the identical field on simExecution.ts's OrderGenContext. */
  closedTradeMetrics?: ClosedTradeMetric[];
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
}

const LEGACY_ENTRY_ORDER_SIDES = new Set(['buy', 'sell', 'long', 'short']);

export function generateLegacyOrders(ctx: LegacyOrderGenContext): PendingOrder[] {
  const {
    positions, pending, evaluations, executionDelaySec, dailyDrawdownPercent, weeklyDrawdownPercent,
    exitCooldown, priceFor, candlesBySymbol, maxPositions, maxFuturesPositions,
    closedTradeMetrics = [],
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    maxCorrelatedPositions = DEFAULT_MAX_CORRELATED,
    correlationLookback = DEFAULT_CORRELATION_LOOKBACK
  } = ctx;
  const delayMs = Math.max(0, executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];

  // Per POSITION, not per symbol — see the identical loop in simExecution.ts.
  // Keyed on the symbol, one lot's pending close silenced the stop check on
  // every other lot of the same asset, so stops were released one per tick.
  for (const pos of positions) {
    const claimed = (o: PendingOrder) => (o.positionId ? o.positionId === pos.id : o.symbol === pos.symbol);
    if (pending.some(claimed) || newOrders.some(claimed)) continue;

    const livePrice = priceFor(pos.symbol) ?? pos.currentPrice;
    const candles = candlesBySymbol[pos.symbol];
    if (!candles || candles.length < MIN_LEGACY_CANDLES) continue;

    const layer0 = detectMarketRegime(candles, livePrice);
    const currentEval = evaluations.find((e) => e.symbol === pos.symbol);
    const scores = currentEval
      ? { buy: currentEval.action === 'buy' ? currentEval.confidence : 0, sell: currentEval.action === 'sell' ? currentEval.confidence : 0 }
      : { buy: 0, sell: 0 };

    const exitCheck = evaluateExit(
      {
        id: pos.id, symbol: pos.symbol, type: pos.type, side: pos.side,
        quantity: pos.quantity, entryPrice: pos.entryPrice, currentPrice: livePrice,
        avgPrice: pos.avgPrice, leverage: pos.leverage, marginUsd: pos.marginUsd,
        notionalUsd: pos.notionalUsd, stopLoss: pos.stopLoss, takeProfit1: pos.takeProfit1,
        takeProfit2: pos.takeProfit2, highestPriceSinceTP1: pos.highestPriceSinceTP1,
        lowestPriceSinceTP1: pos.lowestPriceSinceTP1, highestPrice: pos.highestPrice,
        lowestPrice: pos.lowestPrice, tp1Hit: pos.tp1Hit, openedAt: pos.openedAt,
        openTimestamp: pos.openTimestamp, entryFee: pos.entryFee, reason: pos.reason,
        confidence: pos.confidence
      },
      livePrice,
      layer0.atr,
      scores,
      { dailyDrawdownPercent, weeklyDrawdownPercent, adx: layer0.adx }
    );

    if (!exitCheck.shouldExit) continue;

    if (exitCheck.exitType === 'PARTIAL_50') {
      newOrders.push({
        id: uid(`${pos.symbol}-tp1-50`), symbol: pos.symbol, positionId: pos.id, type: pos.type, side: 'partial_tp1',
        signalPrice: livePrice, quantity: pos.quantity * 0.5, reason: exitCheck.reason,
        confidence: pos.confidence, executeAt: Date.now() + delayMs, createdAt: Date.now()
      });
    } else {
      newOrders.push({
        id: uid(`${pos.symbol}-exit`), symbol: pos.symbol, positionId: pos.id, type: pos.type,
        side: pos.side === 'LONG' || pos.side === 'BUY' ? 'close_long' : 'close_short',
        signalPrice: livePrice, quantity: pos.quantity, reason: exitCheck.reason,
        confidence: pos.confidence, executeAt: Date.now() + delayMs, createdAt: Date.now()
      });
    }
  }

  // The per-symbol losing-streak cooldown is applied in the entry loop below.
  // It is deliberately per-symbol — a losing streak on one asset should not
  // block entries on unrelated ones.

  // Cash consumed by this batch: computeEntryBudget is a percentage of the
  // free balance, so reading ctx.cash for every order of the same tick sized
  // N simultaneous entries as if each one were the only entry of the tick.
  let workingCash = ctx.cash;


  const correlationBook: CorrelatedHolding[] = [
    ...positions.map((p) => ({ symbol: p.symbol, direction: toPositionDirection(p.side) })),
    ...pending
      .filter((o) => LEGACY_ENTRY_ORDER_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  let totalPositionCount = positions.length + pending.filter((o) => LEGACY_ENTRY_ORDER_SIDES.has(o.side)).length;
  let futuresPositionCount = positions.filter((p) => p.type === 'FUTURES').length +
    pending.filter((o) => o.type === 'FUTURES' && LEGACY_ENTRY_ORDER_SIDES.has(o.side)).length;

  for (const ev of evaluations) {
    if (!ev.willExecute || !ev.price || ev.tradeType === 'HOLD') continue;
    // One position per symbol — see the identical guard in simExecution.ts.
    // This is the fix for the incident where four lots of one thin alt were
    // opened within seconds off a single unchanged H1 signal and stopped out
    // together: `pending` empties the moment an entry fills, so without this
    // the same signal re-queues the same asset on the very next tick.
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;
    if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;
    // Post-losing-streak pause. These helpers were imported here but never
    // called, so the streak brake was documented and inert.
    if (isInStreakCooldown(streakCooldownFromHistory(closedTradeMetrics, ctx.equity, ev.symbol))) continue;
    if (totalPositionCount >= maxPositions) continue;
    if (ev.tradeType === 'FUTURES' && futuresPositionCount >= maxFuturesPositions) continue;

    // Spot cannot open short positions — skip SELL side for SPOT
    // (Spot accounts don't support shorting without margin)
    if (ev.tradeType !== 'FUTURES' && ev.tradeSide === 'SELL') continue;

    const orderSide = ev.tradeType === 'FUTURES'
      ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
      : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

    const leverage = ev.leverage || 1;
    const budget = computeEntryBudget(workingCash, ev.tradeType === 'FUTURES' ? 'FUTURES' : 'SPOT', ctx.positionPercent)
      * riskLevelSizingMultiplier(ctx.riskLevel);
    if (budget < 5) continue;

    // Within-batch correlation check: every evaluation in this tick was
    // judged against the same starting book, so a cluster firing at once
    // passes that gate N times over. This one sees the batch as it grows.
    const evDirection = toPositionDirection(ev.tradeSide as string);
    const gate = evaluateCorrelationGate({
      symbol: ev.symbol,
      direction: evDirection,
      held: correlationBook,
      candlesBySymbol,
      threshold: correlationThreshold,
      maxCorrelated: maxCorrelatedPositions,
      lookback: correlationLookback
    });
    if (!gate.allowed) continue;

    totalPositionCount++;
    workingCash -= budget;
    if (ev.tradeType === 'FUTURES') futuresPositionCount++;
    correlationBook.push({ symbol: ev.symbol, direction: evDirection });

    newOrders.push({
      id: uid(`${ev.symbol}-${orderSide}`), symbol: ev.symbol, type: ev.tradeType as 'SPOT' | 'FUTURES',
      side: orderSide as PendingOrder['side'], signalPrice: ev.price, quantity: (budget * leverage) / ev.price,
      budgetUsd: budget, leverage, stopLoss: ev.stopLoss, takeProfit1: ev.takeProfit1,
      takeProfit2: ev.takeProfit2, takeProfit: ev.takeProfit, reason: ev.reasoning, confidence: ev.confidence,
      executeAt: Date.now() + delayMs, createdAt: Date.now()
    });
  }

  return newOrders;
}

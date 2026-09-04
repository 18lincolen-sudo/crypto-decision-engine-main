// Shared engine core for "Bot Pro" — a literal implementation of
// ASSETS/alg.md, independent from both existing engines (see the header
// comment in proAlgEngine.ts for the specific, verified differences from
// tradeEngine.ts, which is what the legacy bot actually runs today).
// Mirrors the role legacySimExecution.ts plays for the legacy bot: one
// evaluation/order-generation core shared by the server's 24/7 engine
// (server/proSimEngine.ts) and the browser fallback hook
// (src/hooks/useProSimulationBot.ts). Order EXECUTION (fillDueOrders) is
// identical fee/slippage/reanchor mechanics for every bot in this app, so
// that stays imported directly from simExecution.ts — no separate copy here.
import { CryptoData, MarketRegimeResult } from '../types/crypto';
import {
  detectProRegime,
  routeProTradeType,
  calculateProRisk,
  evaluateProExit,
  calculateProOptimalEntry,
  ProActivePosition,
  ProSignalResult,
  ProIndicatorSignal,
  ProTradeSide,
  ProRiskResult
} from './proAlgEngine';
import { Candle, formatDynamicPrice } from './tradeEngine';
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

export const uid = (p: string) => `pro-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Same warm-up requirement as the legacy engine (EMA50 + RSI14 + BB20 + ADX14
// all need history) — alg.md doesn't specify a candle count, this is purely
// an indicator-warm-up floor, not part of the algorithm itself.
export const MIN_PRO_CANDLES = 60;

// When confidence is at or above this threshold, Layer 3 risk blocks are
// bypassed: the trade proceeds with minimal fallback parameters instead of
// being rejected. This prevents high-confidence signals from being lost to
// portfolio-cap or sizing edge-cases.
export const HIGH_CONFIDENCE_BYPASS = 72;

// ── 2. Order generation — exit checks (evaluateProExit) + new entries ──────

/** Builds a minimal fallback risk plan when calculateProRisk returns null but
 *  the signal confidence is high enough (>= HIGH_CONFIDENCE_BYPASS). Uses
 *  fixed 1.8% SL / 3% TP so the trade has a defined risk profile even when
 *  portfolio caps or ATR edge-cases would otherwise block it. */
export function buildFallbackProRisk(entryPrice: number, side: ProTradeSide, confidence: number): ProRiskResult {
  const slPercent = 1.8;
  const tpPercent = 3.0;
  const isLong = side === 'LONG';
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
    kellyFraction: 0
  };
}

export function activeMarketRegimesFrom(evaluations: SignalEvaluation[]): Record<string, MarketRegimeResult> {
  const regimes: Record<string, MarketRegimeResult> = {};
  for (const ev of evaluations) if (ev.regime) regimes[ev.symbol] = ev.regime;
  return regimes;
}

// ── 2. Order generation — exit checks (evaluateProExit) + new entries ──────

export interface ProOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  /** Portfolio equity — the denominator for the losing-streak cooldown's
   *  big-loss escape hatch. */
  equity: number;
  /** SimBotConfig.positionPercent / .riskLevel — see the identical fields on
   *  simExecution.ts's OrderGenContext. */
  positionPercent?: number;
  riskLevel?: 'low' | 'medium' | 'high';
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
  closedTradeMetrics?: ClosedTradeRecord[];
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
}

const PRO_ENTRY_ORDER_SIDES = new Set(['buy', 'sell', 'long', 'short']);

export function generateProOrders(ctx: ProOrderGenContext): PendingOrder[] {
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
  for (const pos of positions) {
    const claimed = (o: PendingOrder) => (o.positionId ? o.positionId === pos.id : o.symbol === pos.symbol);
    if (pending.some(claimed) || newOrders.some(claimed)) continue;

    const livePrice = priceFor(pos.symbol) ?? pos.currentPrice;
    const candles = candlesBySymbol[pos.symbol];
    if (!candles || candles.length < MIN_PRO_CANDLES) continue;

    const regime = detectProRegime(candles, livePrice);
    const currentEval = evaluations.find((e) => e.symbol === pos.symbol);
    const scores = currentEval
      ? { buy: currentEval.action === 'buy' ? currentEval.confidence : 0, sell: currentEval.action === 'sell' ? currentEval.confidence : 0 }
      : { buy: 0, sell: 0 };

    const view: ProActivePosition = {
      type: pos.type, side: pos.side, entryPrice: pos.entryPrice, stopLoss: pos.stopLoss,
      takeProfit1: pos.takeProfit1, takeProfit2: pos.takeProfit2, tp1Hit: pos.tp1Hit,
      highestPrice: pos.highestPrice, lowestPrice: pos.lowestPrice,
      highestPriceSinceTP1: pos.highestPriceSinceTP1, lowestPriceSinceTP1: pos.lowestPriceSinceTP1,
      openTimestamp: pos.openTimestamp
    };

    const exitCheck = evaluateProExit(view, livePrice, regime.atr, scores, { dailyDrawdownPercent, weeklyDrawdownPercent });
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

  // Per-symbol streak cooldown is handled in the evaluation loop above,
  // not here. This is intentional — a losing streak on one symbol should not
  // block entries on other symbols.

  const correlationBook: CorrelatedHolding[] = [
    ...positions.map((p) => ({ symbol: p.symbol, direction: toPositionDirection(p.side) })),
    ...pending
      .filter((o) => PRO_ENTRY_ORDER_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  let totalPositionCount = positions.length + pending.filter((o) => PRO_ENTRY_ORDER_SIDES.has(o.side)).length;
  let futuresPositionCount = positions.filter((p) => p.type === 'FUTURES').length +
    pending.filter((o) => o.type === 'FUTURES' && PRO_ENTRY_ORDER_SIDES.has(o.side)).length;

  // Cash consumed by this batch — see the identical note in simExecution.ts.
  let workingCash = ctx.cash;

  for (const ev of evaluations) {
    if (!ev.willExecute || !ev.price || ev.tradeType === 'HOLD') continue;
    // One position per symbol — see the identical guard in simExecution.ts.
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;
    if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;
    // Post-losing-streak pause. These helpers were imported here but never called.
    if (isInStreakCooldown(streakCooldownFromHistory(closedTradeMetrics, ctx.equity, ev.symbol))) continue;
    if (totalPositionCount >= maxPositions) continue;
    if (ev.tradeType === 'FUTURES' && futuresPositionCount >= maxFuturesPositions) continue;

    // Spot cannot open short positions — skip SELL side for SPOT
    // (Spot accounts don't support shorting without margin)
    if (ev.tradeType !== 'FUTURES' && ev.tradeSide === 'SELL') continue;

    const orderSide = ev.tradeType === 'FUTURES'
      ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
      : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

    const budget = computeEntryBudget(workingCash, ev.tradeType === 'FUTURES' ? 'FUTURES' : 'SPOT', ctx.positionPercent)
      * riskLevelSizingMultiplier(ctx.riskLevel);
    if (budget < 5) continue;

    // Within-batch correlation check — see the identical comment in
    // legacySimExecution.ts for why the evaluation-time gate is not enough.
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
      side: orderSide as PendingOrder['side'], signalPrice: ev.price, quantity: (budget * (ev.leverage || 1)) / ev.price,
      budgetUsd: budget, leverage: ev.leverage || 1, stopLoss: ev.stopLoss, takeProfit1: ev.takeProfit1,
      takeProfit2: ev.takeProfit2, takeProfit: ev.takeProfit, reason: ev.reasoning, confidence: ev.confidence,
      executeAt: Date.now() + delayMs, createdAt: Date.now()
    });
  }

  return newOrders;
}

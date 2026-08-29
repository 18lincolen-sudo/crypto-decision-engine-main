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
  ProIndicatorSignal
} from './proAlgEngine';
import { computeProAdvancedAnalysis } from './proAdvancedAnalysis';
import { Candle, formatDynamicPrice } from './tradeEngine';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import { computeEntryBudget, isInEntryCooldown } from './simExecution';
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

// ── 1. Evaluation — Layers 0-3 of alg.md ────────────────────────────────────

export interface ProEvaluationContext {
  cryptoData: CryptoData[];
  /** Single-timeframe (H1) candles keyed by BASE asset — same source/shape as the legacy engine. */
  candlesBySymbol: Record<string, Candle[]>;
  positions: SimPosition[];
  pending: PendingOrder[];
  config: SimBotConfig;
  equity: number;
  /** Available cash — used by the budget floor. Falls back to equity when omitted. */
  cash?: number;
  totalLeveragedExposureUsd: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  fearGreedIndex: number;
  closedTradeMetrics: ClosedTradeRecord[];
  isRunning?: boolean;
  /** Correlation gate tuning — see correlation.ts for the defaults' rationale. */
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
}

export function buildProEvaluations(ctx: ProEvaluationContext): SignalEvaluation[] {
  const {
    cryptoData, candlesBySymbol, positions: openPos, pending: queued, config,
    equity, totalLeveragedExposureUsd, dailyDrawdownPercent, weeklyDrawdownPercent,
    fearGreedIndex, closedTradeMetrics, isRunning = true,
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    maxCorrelatedPositions = DEFAULT_MAX_CORRELATED,
    correlationLookback = DEFAULT_CORRELATION_LOOKBACK
  } = ctx;

  // Performance feedback into sizing — alg.md's §Layer3.3 Kelly bet fraction
  // adapts by a multiplier that can only de-risk (see computeSizingMultiplier).
  const performance = summarizeRecentPerformance(closedTradeMetrics);
  const sizingMultiplier = computeSizingMultiplier(performance, dailyDrawdownPercent);

  const heldForCorrelation: CorrelatedHolding[] = [
    ...openPos.map((p) => ({ symbol: p.symbol, direction: toPositionDirection(p.side) })),
    ...queued
      .filter((o) => PRO_ENTRY_ORDER_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  const maxTotalPositions = config.maxPositions || 7;
  const maxFutures = config.maxFuturesPositions || 2;
  const futuresCount = openPos.filter((p) => p.type === 'FUTURES').length;
  // alg.md's Layer 2 only documents a same-asset block for FUTURES re-entry
  // (§Layer2.1 condition 5) — it says nothing about blocking a second SPOT
  // entry on an already-held asset. That's execution/order-management
  // bookkeeping, not "the algorithm" — handled below via isHeld, the same
  // way every other engine in this app applies its own dedup guard on top
  // of the raw routing decision, not inside the router itself.
  const isWeeklyLocked = weeklyDrawdownPercent >= 15;
  const isDailyBlocked = dailyDrawdownPercent >= 8;

  const results: SignalEvaluation[] = [];

  for (const crypto of cryptoData) {
    const symbol = crypto.symbol.toUpperCase();
    const currentPrice = crypto.current_price;
    const priceChange24h = crypto.price_change_percentage_24h || 0;
    const candles = candlesBySymbol[symbol];
    if (!candles || candles.length < MIN_PRO_CANDLES) continue;

    // Per-symbol streak cooldown: only block entries on symbols that have
    // had consecutive losses, and only if the loss was <= 5% of portfolio.
    const symbolStreakCooldownUntil = streakCooldownFromHistory(
      closedTradeMetrics,
      equity,
      symbol
    );
    const symbolStreakCooldownActive = isInStreakCooldown(symbolStreakCooldownUntil);

    const regime = detectProRegime(candles, currentPrice);
    // FULL replacement (approved product decision): the entry signal is driven
    // by the site's Advanced Analysis / smart-recommendation engine (same pure
    // functions the Advanced Analysis page uses), NOT the internal pro signal
    // engine. `detectProRegime` is still needed below for Futures routing and
    // risk sizing (leverage / SL / R:R / Kelly).
    const adv = computeProAdvancedAnalysis({
      candles,
      currentPrice,
      priceChange24h,
      fearGreedIndex,
      marketCap: crypto.market_cap || 0,
      volume24h: crypto.total_volume || 0,
    });
    const signal: ProSignalResult = {
      action: adv.action,
      buyScore: adv.action === 'BUY' ? adv.confidence : adv.action === 'SELL' ? 0 : 50,
      sellScore: adv.action === 'SELL' ? adv.confidence : adv.action === 'BUY' ? 0 : 50,
      rawConfidence: adv.confidence,
      confidence: adv.confidence,
      signals: adv.signals as ProIndicatorSignal[],
      penalties: adv.penalties,
    };
    const hasExistingFutures = openPos.some((p) => p.symbol === symbol && p.type === 'FUTURES');
    const router = routeProTradeType(signal, regime, { hasExistingFutures, isDailyBlocked, isWeeklyLocked });

    // Entry timing layer: if the signal passed routing, check whether entering
    // now is wise or whether we should wait for a pullback. This prevents
    // chasing extended price and improves R:R by entering at a better level.
    // The layer now returns a sizeMultiplier so extended-price entries can
    // still execute with reduced exposure instead of being hard-blocked.
    let entryPrice = currentPrice;
    let entryTiming: { shouldEnter: boolean; sizeMultiplier: number; reason: string } | null = null;
    if (router.type !== 'HOLD' && !router.hardGateBlocked && signal.action !== 'HOLD') {
      const timing = calculateProOptimalEntry(currentPrice, regime.atr, signal.action, candles, signal.rawConfidence);
      entryPrice = timing.entryPrice;
      entryTiming = { shouldEnter: timing.shouldEnter, sizeMultiplier: timing.sizeMultiplier, reason: timing.reason };
    }

    // Combine the entry-timing size reduction with the adaptive performance
    // multiplier. Both are protective; neither alone should zero the position.
    const entrySizeMultiplier = entryTiming?.sizeMultiplier ?? 1.0;
    const combinedSizingMultiplier = Math.max(0, (sizingMultiplier || 1) * entrySizeMultiplier);

    const risk = router.type !== 'HOLD'
      ? calculateProRisk(
        entryPrice, router.type, router.side, regime.atr, regime.volatility,
        signal.rawConfidence, equity, closedTradeMetrics, openPos.length, futuresCount, totalLeveragedExposureUsd,
        dailyDrawdownPercent, combinedSizingMultiplier,
        undefined, // slConfig
        config.maxPositions ?? 7, config.maxFuturesPositions ?? 2
      )
      : null;

    const isQueued = queued.some((o) => o.symbol === symbol);
    const isHeld = openPos.some((p) => p.symbol === symbol);

    let willExecute = router.type !== 'HOLD' && !router.hardGateBlocked && !!risk && (!entryTiming || entryTiming.shouldEnter);
    let status = router.hardGateBlocked
      ? (router.blockReason ?? 'חסום')
      : router.type === 'HOLD'
      ? 'אין סיגנל (Layer 1/2)'
      : !entryTiming || entryTiming.shouldEnter
      ? risk
        ? 'מוכן לביצוע'
        : 'נפסל בניהול סיכונים (Layer 3)'
      : `נחסם בכניסה (Entry Timing): ${entryTiming.reason}`;

    if (!isRunning) {
      status = 'הבוט מושבת'; willExecute = false;
    } else if (isQueued) {
      status = 'פקודה כבר נמצאת בתור ביצוע'; willExecute = false;
    } else if (openPos.length >= maxTotalPositions) {
      status = `הגעת למקסימום ${maxTotalPositions} פוזיציות פתוחות`; willExecute = false;
    } else if (router.type === 'FUTURES' && futuresCount >= maxFutures) {
      status = `הגעת למקסימום ${maxFutures} פוזיציות Futures`; willExecute = false;
    } else if (router.type === 'SPOT' && router.side === 'BUY' && isHeld) {
      status = 'כבר מוחזק בתיק (Spot)'; willExecute = false;
    } else if (symbolStreakCooldownActive) {
      status = streakCooldownReason(symbolStreakCooldownUntil as number, symbol); willExecute = false;
    }

    // Budget floor — surface low cash before the order-generation layer silently
    // skips the trade. This makes the UI reason transparent instead of showing
    // "ready" and then never filling.
    if (willExecute && router.type !== 'HOLD' && router.side !== 'NONE') {
      const budget = computeEntryBudget(ctx.cash ?? ctx.equity, router.type === 'FUTURES' ? 'FUTURES' : 'SPOT');
      if (budget < 5) {
        status = `תקציב נמוך מדי ($${budget.toFixed(2)} < $5)`;
        willExecute = false;
      }
    }

    // Confidence floor — minimum signal quality threshold (in addition to Layer 2's dynamic threshold)
    if (willExecute && router.type !== 'HOLD' && router.side !== 'NONE') {
      const minConf = config.minConfidenceOverride ?? 60;
      if (signal.rawConfidence < minConf) { status = `Confidence נמוך מדי (${signal.rawConfidence} < ${minConf})`; willExecute = false; }
    }

    if (willExecute && router.type !== 'HOLD' && router.side !== 'NONE') {
      const gate = evaluateCorrelationGate({
        symbol,
        direction: toPositionDirection(router.side),
        held: heldForCorrelation,
        candlesBySymbol,
        threshold: correlationThreshold,
        maxCorrelated: maxCorrelatedPositions,
        lookback: correlationLookback
      });
      if (!gate.allowed) { status = gate.reason as string; willExecute = false; }
    }

    // Cost / Edge gate — refuse trades where the ATR-derived risk-reward
    // ratio doesn't clear the minimum threshold. risk.riskRewardRatio
    // is already computed from the ATR multipliers, so we use it directly.
    if (willExecute && risk && risk.riskRewardRatio < MIN_RISK_REWARD_RATIO) {
      status = `יחס סיכון-רווח נמוך מדי (${risk.riskRewardRatio.toFixed(2)} < ${MIN_RISK_REWARD_RATIO})`;
      willExecute = false;
    }

    const factors: DecisionFactor[] = [
      {
        label: 'משטר שוק (Layer 0)',
        value: `${regime.regime} / ${regime.direction} / ${regime.volatility} (ADX ${regime.adx.toFixed(1)})`,
        impact: regime.regime === 'TRANSITIONAL' ? 'negative' : 'neutral',
        note: `ATR% ${regime.atrPercent.toFixed(2)}`
      },
      {
        label: 'ציון ביטחון (Layer 1)',
        value: `${signal.action} — ${signal.confidence.toFixed(1)}%`,
        impact: signal.action === 'HOLD' ? 'neutral' : signal.action === 'BUY' ? 'positive' : 'negative',
        note: signal.penalties.join(' | ') || signal.signals.map((s) => `${s.name}:${s.signal}`).join(', ')
      },
      {
        label: 'ניתוב עסקה (Layer 2)',
        value: `${router.type} ${router.side}`,
        impact: router.type === 'HOLD' ? 'neutral' : 'positive',
        note: router.reason
      },
      ...(entryTiming ? [{
        label: 'כניסה (Entry Timing)',
        value: entryTiming.shouldEnter
          ? entryTiming.sizeMultiplier < 1
            ? `Limit @ ${formatDynamicPrice(entryPrice)} (גודל ${(entryTiming.sizeMultiplier * 100).toFixed(0)}%)`
            : `Limit @ ${formatDynamicPrice(entryPrice)}`
          : 'נמנע מרידפינג',
        impact: (entryTiming.shouldEnter ? 'positive' : 'negative') as DecisionFactor['impact'],
        note: entryTiming.reason
      }] : []),
      ...(risk ? [{
        label: 'ניהול סיכונים (Layer 3)',
        value: `SL ${risk.stopLoss.toFixed(4)} | R:R ${risk.riskRewardRatio.toFixed(2)} | ${risk.leverage}x`,
        impact: 'positive' as const,
        note: `Kelly ${(risk.kellyFraction * 100).toFixed(1)}% | גודל $${risk.betSizeUsd.toFixed(0)}`
      }] : [])
    ];

    results.push({
      symbol,
      action: signal.action.toLowerCase() as 'buy' | 'sell' | 'hold',
      tradeType: router.type,
      tradeSide: router.side,
      confidence: signal.confidence,
      price: entryPrice,
      priceChange24h,
      reasoning: `${adv.reasoning} | ${router.reason}`,
      status,
      willExecute,
      factors,
      confidenceGap: 0,
      regime: regime as unknown as MarketRegimeResult,
      leverage: risk?.leverage,
      stopLoss: risk?.stopLoss,
      takeProfit1: risk?.takeProfit1,
      takeProfit2: risk?.takeProfit2,
      takeProfit: risk?.takeProfit,
      advancedPredictions: adv.predictions,
      advancedReason: adv.reasoning,
      advancedSupport: adv.supportLevel,
      advancedResistance: adv.resistanceLevel,
      advancedRiskLevel: adv.riskLevel
    });
  }

  return results;
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
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  /** Single-timeframe (H1) candles keyed by BASE asset — same map passed to buildProEvaluations. */
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

  for (const pos of positions) {
    if (pending.some((o) => o.symbol === pos.symbol) || newOrders.some((o) => o.symbol === pos.symbol)) continue;

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
        id: uid(`${pos.symbol}-tp1-50`), symbol: pos.symbol, type: pos.type, side: 'partial_tp1',
        signalPrice: livePrice, quantity: pos.quantity * 0.5, reason: exitCheck.reason,
        confidence: pos.confidence, executeAt: Date.now() + delayMs, createdAt: Date.now()
      });
    } else {
      newOrders.push({
        id: uid(`${pos.symbol}-exit`), symbol: pos.symbol, type: pos.type,
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

  for (const ev of evaluations) {
    if (!ev.willExecute || !ev.price || ev.tradeType === 'HOLD') continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;
    if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;
    if (totalPositionCount >= maxPositions) continue;
    if (ev.tradeType === 'FUTURES' && futuresPositionCount >= maxFuturesPositions) continue;

    // Spot cannot open short positions — skip SELL side for SPOT
    // (Spot accounts don't support shorting without margin)
    if (ev.tradeType !== 'FUTURES' && ev.tradeSide === 'SELL') continue;

    const orderSide = ev.tradeType === 'FUTURES'
      ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
      : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

    const budget = computeEntryBudget(ctx.cash, ev.tradeType === 'FUTURES' ? 'FUTURES' : 'SPOT');
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

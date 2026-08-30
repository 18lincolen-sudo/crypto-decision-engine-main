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
import { CryptoData, MarketRegimeResult } from '../types/crypto';
import {
  detectMarketRegime,
  evaluateSignals,
  routeTradeType,
  calculateOptimalEntry,
  calculateRiskParameters,
  evaluateExit,
  Candle,
  ClosedTradeMetric
} from './tradeEngine';
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

export const uid = (p: string) => `legacy-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Minimum candles needed for the legacy indicators (EMA50 warm-up + RSI14 + BB20 + ADX14).
export const MIN_LEGACY_CANDLES = 60;

// When confidence is at or above this threshold, Layer 3 risk blocks are
// bypassed: the trade proceeds with minimal fallback parameters instead of
// being rejected. This prevents high-confidence signals from being lost to
// portfolio-cap or sizing edge-cases.
export const HIGH_CONFIDENCE_BYPASS = 72;

// ── 1. Evaluation — Layers 0-3 of the ORIGINAL alg.md algorithm ────────────────

export interface LegacyEvaluationContext {
  cryptoData: CryptoData[];
  /** Single-timeframe (H1) candles keyed by BASE asset (e.g. "LIT", not "LITUSDT") — normalize before calling. */
  candlesBySymbol: Record<string, Candle[]>;
  positions: SimPosition[];
  pending: PendingOrder[];
  config: SimBotConfig;
  equity: number;
  totalLeveragedExposureUsd: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  fearGreedIndex: number;
  closedTradeMetrics: ClosedTradeMetric[];
  /** false only while the client engine is paused; the server engine is only ticked while running, so it never needs this. */
  isRunning?: boolean;
  /** Correlation gate tuning — see correlation.ts for the defaults' rationale. */
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
}

export function buildLegacyEvaluations(ctx: LegacyEvaluationContext): SignalEvaluation[] {
  const {
    cryptoData, candlesBySymbol, positions: openPos, pending: queued, config,
    equity, totalLeveragedExposureUsd, dailyDrawdownPercent, weeklyDrawdownPercent,
    fearGreedIndex, closedTradeMetrics, isRunning = true,
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    maxCorrelatedPositions = DEFAULT_MAX_CORRELATED,
    correlationLookback = DEFAULT_CORRELATION_LOOKBACK
  } = ctx;

  // Performance feedback into sizing. This engine sizes from Kelly, not from
  // a risk percentage, so the adaptation lands as a multiplier on the bet
  // fraction (see computeSizingMultiplier for why it only ever de-risks).
  const performance = summarizeRecentPerformance(closedTradeMetrics as ClosedTradeRecord[]);
  const sizingMultiplier = computeSizingMultiplier(performance, dailyDrawdownPercent);

  const heldForCorrelation: CorrelatedHolding[] = [
    ...openPos.map((p) => ({ symbol: p.symbol, direction: toPositionDirection(p.side) })),
    ...queued
      .filter((o) => LEGACY_ENTRY_ORDER_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  const maxTotalPositions = config.maxPositions || 7;
  const maxFutures = config.maxFuturesPositions || 2;
  const futuresCount = openPos.filter((p) => p.type === 'FUTURES').length;
  // Legacy-specific circuit breaker thresholds (NOT Pro's 8%/15%)
  const LEGACY_WEEKLY_DRAWDOWN_LOCK_PERCENT = 15;
  const LEGACY_DAILY_DRAWDOWN_BLOCK_PERCENT = 8;
  const isWeeklyLocked = weeklyDrawdownPercent >= LEGACY_WEEKLY_DRAWDOWN_LOCK_PERCENT;
  const isDailyBlocked = dailyDrawdownPercent >= LEGACY_DAILY_DRAWDOWN_BLOCK_PERCENT;

  const results: SignalEvaluation[] = [];

  for (const crypto of cryptoData) {
    const symbol = crypto.symbol.toUpperCase();
    const currentPrice = crypto.current_price;
    const priceChange24h = crypto.price_change_percentage_24h || 0;
    const candles = candlesBySymbol[symbol];
    if (!candles || candles.length < MIN_LEGACY_CANDLES) continue;

    // Per-symbol streak cooldown: only block entries on symbols that have
    // had consecutive losses, and only if the loss was <= 5% of portfolio.
    const symbolStreakCooldownUntil = streakCooldownFromHistory(
      (closedTradeMetrics || []) as ClosedTradeRecord[],
      equity,
      symbol
    );
    const symbolStreakCooldownActive = isInStreakCooldown(symbolStreakCooldownUntil);

    const layer0 = detectMarketRegime(candles, currentPrice);
    const layer1 = evaluateSignals(candles, currentPrice, priceChange24h, layer0, fearGreedIndex);
    const hasExistingFutures = openPos.some((p) => p.symbol === symbol && p.type === 'FUTURES');
    const hasExistingSpot = openPos.some((p) => p.symbol === symbol && p.type === 'SPOT');
    const layer2 = routeTradeType(layer1, layer0, { hasExistingFutures, hasExistingSpot, isDailyBlocked, isWeeklyLocked });

    let entryPrice = currentPrice;
    let entryReason = '';
    let entryAccepted = true;
    let entryBlockReason = '';
    if (layer2.type !== 'HOLD' && layer2.side !== 'NONE') {
      const entryTiming = calculateOptimalEntry(currentPrice, layer0.atr, layer2.side, candles, 0.35, layer0.atrPercent);
      // The entry-timing layer is a REAL gate (matching Pro): when RSI is
      // overbought / price sits on the Bollinger top / price is extended
      // beyond 1.5×ATR from EMA20 / volume is too thin, `shouldEnterNow` is
      // false and the order must NOT be queued at the live price. Previously
      // only the (pullback-adjusted) PRICE was consumed and the block signal
      // itself ignored — entries fired straight into exactly the conditions
      // the layer exists to avoid.
      if (entryTiming.shouldEnterNow) {
        entryPrice = entryTiming.entryPrice;
        entryReason = entryTiming.reason;
      } else {
        entryAccepted = false;
        entryBlockReason = entryTiming.reason;
      }
    }

    const layer3 = layer2.type !== 'HOLD'
      ? calculateRiskParameters(
        entryPrice, layer2.type, layer2.side, layer0.atr, layer0.volatility,
        layer1.signalScore, equity, closedTradeMetrics, openPos.length, futuresCount, totalLeveragedExposureUsd,
        undefined, sizingMultiplier,
        undefined, // slConfig
        config.maxPositions ?? 7, config.maxFuturesPositions ?? 2
      )
      : null;

    const isQueued = queued.some((o) => o.symbol === symbol);
    const isHeld = openPos.some((p) => p.symbol === symbol);

    // High-confidence bypass: when signal confidence >= 72, a null risk plan
    // should not block the trade — use a minimal fallback with fixed 1.8% SL
    // and 3% TP instead.
    const effectiveLayer3 = layer3 ?? (layer1.confidence >= HIGH_CONFIDENCE_BYPASS && layer2.type !== 'HOLD'
      ? buildFallbackLegacyRisk(entryPrice, layer2.side, layer1.confidence)
      : null);

    let willExecute = layer2.type !== 'HOLD' && !layer2.hardGateBlocked && !!effectiveLayer3 && entryAccepted;
    let status = layer2.hardGateBlocked
      ? (layer2.blockReason ?? 'חסום')
      : layer2.type === 'HOLD'
      ? 'אין סיגנל (Layer 1/2)'
      : !entryAccepted
      ? `נחסם בתזמון כניסה: ${entryBlockReason}`
      : effectiveLayer3
      ? 'מוכן לביצוע'
      : 'נפסל בניהול סיכונים (Layer 3)';

    if (!isRunning) {
      status = 'הבוט מושבת'; willExecute = false;
    } else if (isQueued) {
      status = 'פקודה כבר נמצאת בתור ביצוע'; willExecute = false;
    } else if (openPos.length >= maxTotalPositions) {
      status = `הגעת למקסימום ${maxTotalPositions} פוזיציות פתוחות`; willExecute = false;
    } else if (layer2.type === 'FUTURES' && futuresCount >= maxFutures) {
      status = `הגעת למקסימום ${maxFutures} פוזיציות Futures`; willExecute = false;
    } else if (layer2.type === 'SPOT' && layer2.side === 'BUY' && isHeld) {
      status = 'כבר מוחזק בתיק (Spot)'; willExecute = false;
    } else if (symbolStreakCooldownActive) {
      status = streakCooldownReason(symbolStreakCooldownUntil as number, symbol); willExecute = false;
    }

    // Confidence floor — minimum signal quality threshold, evaluated on the
    // POST-PENALTY score (layer1.confidence), not raw signalScore, so the
    // volume/RANGING penalties actually gate entries.
    if (willExecute && layer2.type !== 'HOLD' && layer2.side !== 'NONE') {
      const minConf = config.minConfidenceOverride ?? 58;
      if (layer1.confidence < minConf) { status = `Confidence נמוך מדי (${layer1.confidence.toFixed(1)} < ${minConf})`; willExecute = false; }
    }

    // Correlation gate — refuses a candidate that would make the book hold
    // the same risk factor a third time over.
    if (willExecute && layer2.type !== 'HOLD' && layer2.side !== 'NONE') {
      const gate = evaluateCorrelationGate({
        symbol,
        direction: toPositionDirection(layer2.side),
        held: heldForCorrelation,
        candlesBySymbol,
        threshold: correlationThreshold,
        maxCorrelated: maxCorrelatedPositions,
        lookback: correlationLookback
      });
      if (!gate.allowed) { status = gate.reason as string; willExecute = false; }
    }

    // Cost / Edge gate — refuse trades where the ATR-derived risk-reward
    // ratio doesn't clear the minimum threshold. effectiveLayer3.riskRewardRatio
    // is already computed from the ATR multipliers, so we use it directly.
    if (willExecute && effectiveLayer3 && effectiveLayer3.riskRewardRatio < MIN_RISK_REWARD_RATIO) {
      status = `יחס סיכון-רווח נמוך מדי (${effectiveLayer3.riskRewardRatio.toFixed(2)} < ${MIN_RISK_REWARD_RATIO})`;
      willExecute = false;
    }

    const factors: DecisionFactor[] = [
      {
        label: 'משטר שוק (Layer 0)',
        value: `${layer0.regime} / ${layer0.direction} / ${layer0.volatility} (ADX ${layer0.adx.toFixed(1)})`,
        impact: layer0.regime === 'TRANSITIONAL' ? 'negative' : 'neutral',
        note: `ATR% ${layer0.atrPercent.toFixed(2)}`
      },
      {
        label: 'ציון ביטחון משוקלל (Layer 1)',
        value: `${layer1.action} — ${layer1.confidence.toFixed(1)}%`,
        impact: layer1.action === 'HOLD' ? 'neutral' : layer1.action === 'BUY' ? 'positive' : 'negative',
        note: layer1.penalties.join(' | ') || layer1.signals.map((s) => `${s.name}:${s.signal}`).join(', ')
      },
      {
        label: 'ניתוב עסקה (Layer 2)',
        value: `${layer2.type} ${layer2.side}`,
        impact: layer2.type === 'HOLD' ? 'neutral' : 'positive',
        note: layer2.reason
      },
      ...(effectiveLayer3 ? [{
        label: 'ניהול סיכונים (Layer 3)',
        value: `SL ${effectiveLayer3.stopLoss.toFixed(4)} | R:R ${effectiveLayer3.riskRewardRatio.toFixed(2)} | ${effectiveLayer3.leverage}x`,
        impact: 'positive' as const,
        note: `Kelly ${(effectiveLayer3.kellyFraction * 100).toFixed(1)}% | גודל $${effectiveLayer3.betSizeUsd.toFixed(0)}`
      }] : [])
    ];

    results.push({
      symbol,
      action: layer1.action.toLowerCase() as 'buy' | 'sell' | 'hold',
      tradeType: layer2.type,
      tradeSide: layer2.side,
      confidence: layer1.confidence,
      price: entryPrice,
      priceChange24h,
      reasoning: entryReason || layer2.reason,
      status,
      willExecute,
      factors,
      confidenceGap: 0,
      regime: layer0,
      leverage: effectiveLayer3?.leverage,
      stopLoss: effectiveLayer3?.stopLoss,
      takeProfit1: effectiveLayer3?.takeProfit1,
      takeProfit2: effectiveLayer3?.takeProfit2,
      takeProfit: effectiveLayer3?.takeProfit
    });
  }

  return results;
}

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
  /** Symbol (as stored on the position/order) → last-loss timestamp. Read-only here. */
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  /** Single-timeframe (H1) candles keyed by BASE asset — same map passed to buildLegacyEvaluations. */
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

  for (const pos of positions) {
    if (pending.some((o) => o.symbol === pos.symbol) || newOrders.some((o) => o.symbol === pos.symbol)) continue;

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
      .filter((o) => LEGACY_ENTRY_ORDER_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  let totalPositionCount = positions.length + pending.filter((o) => LEGACY_ENTRY_ORDER_SIDES.has(o.side)).length;
  let futuresPositionCount = positions.filter((p) => p.type === 'FUTURES').length +
    pending.filter((o) => o.type === 'FUTURES' && LEGACY_ENTRY_ORDER_SIDES.has(o.side)).length;

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

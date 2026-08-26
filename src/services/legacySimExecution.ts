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
import type { SimPosition, PendingOrder, SimBotConfig } from './simExecution';

export const uid = (p: string) => `legacy-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Minimum candles needed for the legacy indicators (EMA50 warm-up + RSI14 + BB20 + ADX14).
export const MIN_LEGACY_CANDLES = 60;

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
}

export function buildLegacyEvaluations(ctx: LegacyEvaluationContext): SignalEvaluation[] {
  const {
    cryptoData, candlesBySymbol, positions: openPos, pending: queued, config,
    equity, totalLeveragedExposureUsd, dailyDrawdownPercent, weeklyDrawdownPercent,
    fearGreedIndex, closedTradeMetrics, isRunning = true
  } = ctx;

  const maxTotalPositions = config.maxPositions || 7;
  const maxFutures = config.maxFuturesPositions || 2;
  const futuresCount = openPos.filter((p) => p.type === 'FUTURES').length;
  const isWeeklyLocked = weeklyDrawdownPercent >= 15;
  const isDailyBlocked = dailyDrawdownPercent >= 8;

  const results: SignalEvaluation[] = [];

  for (const crypto of cryptoData) {
    const symbol = crypto.symbol.toUpperCase();
    const currentPrice = crypto.current_price;
    const priceChange24h = crypto.price_change_percentage_24h || 0;
    const candles = candlesBySymbol[symbol];
    if (!candles || candles.length < MIN_LEGACY_CANDLES) continue;

    const layer0 = detectMarketRegime(candles, currentPrice);
    const layer1 = evaluateSignals(candles, currentPrice, priceChange24h, layer0, fearGreedIndex);
    const hasExistingFutures = openPos.some((p) => p.symbol === symbol && p.type === 'FUTURES');
    const hasExistingSpot = openPos.some((p) => p.symbol === symbol && p.type === 'SPOT');
    const layer2 = routeTradeType(layer1, layer0, { hasExistingFutures, hasExistingSpot, isDailyBlocked, isWeeklyLocked });

    let entryPrice = currentPrice;
    let entryReason = '';
    if (layer2.type !== 'HOLD' && layer2.side !== 'NONE') {
      const entryTiming = calculateOptimalEntry(currentPrice, layer0.atr, layer2.side, candles);
      entryPrice = entryTiming.entryPrice;
      entryReason = entryTiming.reason;
    }

    const layer3 = layer2.type !== 'HOLD'
      ? calculateRiskParameters(
        entryPrice, layer2.type, layer2.side, layer0.atr, layer0.volatility,
        layer1.signalScore, equity, closedTradeMetrics, openPos.length, futuresCount, totalLeveragedExposureUsd
      )
      : null;

    const isQueued = queued.some((o) => o.symbol === symbol);
    const isHeld = openPos.some((p) => p.symbol === symbol);

    let willExecute = layer2.type !== 'HOLD' && !layer2.hardGateBlocked && !!layer3;
    let status = layer2.hardGateBlocked
      ? (layer2.blockReason ?? 'חסום')
      : layer2.type === 'HOLD'
      ? 'אין סיגנל (Layer 1/2)'
      : layer3
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
        value: `${layer1.action} — ${layer1.signalScore.toFixed(1)}%`,
        impact: layer1.action === 'HOLD' ? 'neutral' : layer1.action === 'BUY' ? 'positive' : 'negative',
        note: layer1.penalties.join(' | ') || layer1.signals.map((s) => `${s.name}:${s.signal}`).join(', ')
      },
      {
        label: 'ניתוב עסקה (Layer 2)',
        value: `${layer2.type} ${layer2.side}`,
        impact: layer2.type === 'HOLD' ? 'neutral' : 'positive',
        note: layer2.reason
      },
      ...(layer3 ? [{
        label: 'ניהול סיכונים (Layer 3)',
        value: `SL ${layer3.stopLoss.toFixed(4)} | R:R ${layer3.riskRewardRatio.toFixed(2)} | ${layer3.leverage}x`,
        impact: 'positive' as const,
        note: `Kelly ${(layer3.kellyFraction * 100).toFixed(1)}% | גודל $${layer3.betSizeUsd.toFixed(0)}`
      }] : [])
    ];

    results.push({
      symbol,
      action: layer1.action.toLowerCase() as 'buy' | 'sell' | 'hold',
      tradeType: layer2.type,
      tradeSide: layer2.side,
      confidence: layer1.signalScore,
      price: entryPrice,
      priceChange24h,
      reasoning: entryReason || layer2.reason,
      status,
      willExecute,
      factors,
      confidenceGap: 0,
      regime: layer0,
      leverage: layer3?.leverage,
      stopLoss: layer3?.stopLoss,
      takeProfit1: layer3?.takeProfit1,
      takeProfit2: layer3?.takeProfit2,
      takeProfit: layer3?.takeProfit
    });
  }

  return results;
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
}

const LEGACY_ENTRY_ORDER_SIDES = new Set(['buy', 'sell', 'long', 'short']);

export function generateLegacyOrders(ctx: LegacyOrderGenContext): PendingOrder[] {
  const { positions, pending, evaluations, executionDelaySec, dailyDrawdownPercent, weeklyDrawdownPercent, exitCooldown, priceFor, candlesBySymbol, maxPositions, maxFuturesPositions } = ctx;
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
      { dailyDrawdownPercent, weeklyDrawdownPercent }
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

  let totalPositionCount = positions.length + pending.filter((o) => LEGACY_ENTRY_ORDER_SIDES.has(o.side)).length;
  let futuresPositionCount = positions.filter((p) => p.type === 'FUTURES').length +
    pending.filter((o) => o.type === 'FUTURES' && LEGACY_ENTRY_ORDER_SIDES.has(o.side)).length;

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

    totalPositionCount++;
    if (ev.tradeType === 'FUTURES') futuresPositionCount++;

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

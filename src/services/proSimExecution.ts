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
  evaluateProSignals,
  routeProTradeType,
  calculateProRisk,
  evaluateProExit,
  ProActivePosition
} from './proAlgEngine';
import { Candle } from './tradeEngine';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import { computeEntryBudget, isInEntryCooldown } from './simExecution';
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
  totalLeveragedExposureUsd: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  fearGreedIndex: number;
  closedTradeMetrics: { pnl: number }[];
  isRunning?: boolean;
}

export function buildProEvaluations(ctx: ProEvaluationContext): SignalEvaluation[] {
  const {
    cryptoData, candlesBySymbol, positions: openPos, pending: queued, config,
    equity, totalLeveragedExposureUsd, dailyDrawdownPercent, weeklyDrawdownPercent,
    fearGreedIndex, closedTradeMetrics, isRunning = true
  } = ctx;

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

    const regime = detectProRegime(candles, currentPrice);
    const signal = evaluateProSignals(candles, currentPrice, priceChange24h, regime, fearGreedIndex);
    const hasExistingFutures = openPos.some((p) => p.symbol === symbol && p.type === 'FUTURES');
    const router = routeProTradeType(signal, regime, { hasExistingFutures, isDailyBlocked, isWeeklyLocked });

    // alg.md has no entry-timing layer (unlike the legacy engine's
    // calculateOptimalEntry) — entries are taken at the live market price,
    // matching the document literally.
    const entryPrice = currentPrice;

    const risk = router.type !== 'HOLD'
      ? calculateProRisk(
        entryPrice, router.type, router.side, regime.atr, regime.volatility,
        signal.confidence, equity, closedTradeMetrics, openPos.length, futuresCount, totalLeveragedExposureUsd
      )
      : null;

    const isQueued = queued.some((o) => o.symbol === symbol);
    const isHeld = openPos.some((p) => p.symbol === symbol);

    let willExecute = router.type !== 'HOLD' && !router.hardGateBlocked && !!risk;
    let status = router.hardGateBlocked
      ? (router.blockReason ?? 'חסום')
      : router.type === 'HOLD'
      ? 'אין סיגנל (Layer 1/2)'
      : risk
      ? 'מוכן לביצוע'
      : 'נפסל בניהול סיכונים (Layer 3)';

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
      reasoning: router.reason,
      status,
      willExecute,
      factors,
      confidenceGap: 0,
      regime: regime as unknown as MarketRegimeResult,
      leverage: risk?.leverage,
      stopLoss: risk?.stopLoss,
      takeProfit1: risk?.takeProfit1,
      takeProfit2: risk?.takeProfit2,
      takeProfit: risk?.takeProfit
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
}

const PRO_ENTRY_ORDER_SIDES = new Set(['buy', 'sell', 'long', 'short']);

export function generateProOrders(ctx: ProOrderGenContext): PendingOrder[] {
  const { positions, pending, evaluations, executionDelaySec, dailyDrawdownPercent, weeklyDrawdownPercent, exitCooldown, priceFor, candlesBySymbol, maxPositions, maxFuturesPositions } = ctx;
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

  let totalPositionCount = positions.length + pending.filter((o) => PRO_ENTRY_ORDER_SIDES.has(o.side)).length;
  let futuresPositionCount = positions.filter((p) => p.type === 'FUTURES').length +
    pending.filter((o) => o.type === 'FUTURES' && PRO_ENTRY_ORDER_SIDES.has(o.side)).length;

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

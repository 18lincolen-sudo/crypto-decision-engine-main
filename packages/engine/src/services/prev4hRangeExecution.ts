// Order generation for the Prev-4H Range bot ("נתיב 4H"). One position per
// symbol, no scale-in. Shares the fill/fee/slippage core (fillDueOrders), the
// entry cooldown and the drawdown / exposure constants with the other three
// sim bots — a difference in results is a difference in DECISIONS.
//
// Its own:
//   · sizing: risk-based, notional = (equity × riskPerTrade) / (R / entry),
//     hard-capped by the shared per-asset (8%) / total (20%) caps and the
//     $100 MIN_SIM_ENTRY_USD floor.
//   · exits: SL (= range midpoint), TP (= break level ± range × tpRangeMult),
//     END OF THE 4H WINDOW (barOpenFor(openTs) + BAR_MS), and an EMA(20) 4H
//     trend flip against the position.

import { Candle, calculateEMA } from './tradeEngine';
import { aggregateToH4 } from './pathEngine';
import { barOpenFor, BAR_MS } from './pathStudy';
import type { SignalEvaluation } from './intradayBridge';
import type { SimPosition, PendingOrder } from './simExecution';
import { isInEntryCooldown, MIN_SIM_ENTRY_USD } from './simExecution';
import {
  DAILY_DRAWDOWN_BLOCK_PERCENT,
  WEEKLY_DRAWDOWN_LOCK_PERCENT,
  PER_ASSET_EXPOSURE_CAP_PERCENT
} from './intradayParams';
import { DEFAULT_PREV4H_RANGE_PARAMS, Prev4hRangeParams, readPrev4hRangePlan } from './prev4hRange';

export const uid = (p: string) => `p4h-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Spec: total leveraged + spot exposure ceiling, as a fraction of equity. */
export const MAX_TOTAL_EXPOSURE_PERCENT = 20;

export interface Prev4hRangeCandleSet {
  h1: Candle[];
}

export interface Prev4hRangeOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  equity: number;
  totalLeveragedExposureUsd: number;
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  /** Keyed by BASE asset — same keys the evaluations and positions use. */
  candlesBySymbol: Record<string, Prev4hRangeCandleSet | undefined>;
  maxPositions: number;
  /** SHORTs are simulated as 1x FUTURES; this caps how many can be open at
   *  once (SIM_MAX_FUTURES_POSITIONS.path). LONGs are SPOT and unaffected. */
  maxFuturesPositions: number;
  params?: Partial<Prev4hRangeParams>;
}

const ENTRY_SIDES = new Set(['buy', 'sell', 'long', 'short']);

function h4EmaTrend(h1: Candle[] | undefined, emaPeriod: number): 'UP' | 'DOWN' | 'FLAT' | undefined {
  if (!h1 || h1.length < emaPeriod * 4) return undefined;
  const h4 = aggregateToH4(h1);
  if (h4.length < emaPeriod + 2) return undefined;
  const ema = calculateEMA(h4.map((c) => c.close), emaPeriod);
  const last = ema[ema.length - 1];
  const prev = ema[ema.length - 2];
  const close = h4[h4.length - 1].close;
  if (last > prev && close > last) return 'UP';
  if (last < prev && close < last) return 'DOWN';
  return 'FLAT';
}

export function generatePrev4hRangeOrders(ctx: Prev4hRangeOrderGenContext): PendingOrder[] {
  const p: Prev4hRangeParams = { ...DEFAULT_PREV4H_RANGE_PARAMS, ...(ctx.params ?? {}) };
  const now = Date.now();
  const delayMs = Math.max(0, ctx.executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];
  const claimed = new Set(ctx.pending.filter((o) => o.positionId).map((o) => o.positionId as string));

  // ── Exits ──────────────────────────────────────────────────────────────
  const closingSymbols = new Set<string>();
  for (const pos of ctx.positions) {
    if (claimed.has(pos.id)) continue;
    const live = ctx.priceFor(pos.symbol) ?? pos.currentPrice ?? pos.entryPrice;
    const isLong = pos.side === 'LONG' || pos.side === 'BUY';
    let reason = '';

    if (now >= barOpenFor(pos.openTimestamp) + BAR_MS) {
      reason = 'יציאה בסוף נר ה-4H (time stop)';
    } else if (isLong ? live <= pos.stopLoss : live >= pos.stopLoss) {
      reason = `Stop Loss ב-${pos.stopLoss} (אמצע הטווח)`;
    } else if (pos.takeProfit && (isLong ? live >= pos.takeProfit : live <= pos.takeProfit)) {
      reason = `Take Profit ב-${pos.takeProfit}`;
    } else {
      const trend = h4EmaTrend(ctx.candlesBySymbol[pos.symbol]?.h1, p.emaPeriod);
      // Close only on an outright REVERSAL (trend now points the other way),
      // not on a merely-flat bar — that would churn the position out early.
      if (trend && (isLong ? trend === 'DOWN' : trend === 'UP')) {
        reason = `היפוך מגמה — EMA20 (4H) התהפך ל${isLong ? 'ירידה' : 'עלייה'}`;
      }
    }

    if (!reason) continue;
    closingSymbols.add(pos.symbol);
    newOrders.push({
      id: uid(`${pos.symbol}-exit`),
      symbol: pos.symbol,
      positionId: pos.id,
      type: pos.type,
      side: isLong ? 'close_long' : 'close_short',
      signalPrice: live,
      quantity: pos.quantity,
      reason,
      confidence: pos.confidence,
      executeAt: now + delayMs,
      createdAt: now
    });
  }

  // ── Circuit breaker — exits only past this point ───────────────────────
  if (
    ctx.dailyDrawdownPercent >= DAILY_DRAWDOWN_BLOCK_PERCENT ||
    ctx.weeklyDrawdownPercent >= WEEKLY_DRAWDOWN_LOCK_PERCENT
  ) {
    return newOrders;
  }

  // Running exposure / cash / count.
  let workingCash = ctx.cash;
  const perAssetCap = ctx.equity * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
  const totalCap = ctx.equity * (MAX_TOTAL_EXPOSURE_PERCENT / 100);
  const exposureByBase = new Map<string, number>();
  let totalExposure = 0;
  for (const pos of ctx.positions) {
    const n = (ctx.priceFor(pos.symbol) ?? pos.currentPrice ?? pos.entryPrice) * pos.quantity;
    exposureByBase.set(pos.symbol, (exposureByBase.get(pos.symbol) ?? 0) + n);
    totalExposure += n;
  }
  for (const o of ctx.pending) {
    if (!ENTRY_SIDES.has(o.side)) continue;
    exposureByBase.set(o.symbol, (exposureByBase.get(o.symbol) ?? 0) + (o.budgetUsd ?? 0));
    totalExposure += o.budgetUsd ?? 0;
  }

  const openSymbols = new Set(ctx.positions.map((pos) => pos.symbol));
  const pendingEntrySymbols = new Set(ctx.pending.filter((o) => ENTRY_SIDES.has(o.side)).map((o) => o.symbol));
  let positionCount = openSymbols.size + pendingEntrySymbols.size;
  let futuresCount =
    ctx.positions.filter((pos) => pos.type === 'FUTURES').length +
    ctx.pending.filter((o) => o.type === 'FUTURES' && ENTRY_SIDES.has(o.side)).length;

  const ranked = [...ctx.evaluations]
    .filter((ev) => ev.willExecute && ev.price)
    .sort((a, b) => b.confidence - a.confidence);

  for (const ev of ranked) {
    const plan = readPrev4hRangePlan(ev);
    if (!plan) continue;
    if (openSymbols.has(ev.symbol) || pendingEntrySymbols.has(ev.symbol) || closingSymbols.has(ev.symbol)) continue;
    if (isInEntryCooldown(ctx.exitCooldown[ev.symbol], now)) continue;
    if (positionCount >= ctx.maxPositions) continue;

    const isLong = plan.direction === 'LONG';
    if (!isLong && futuresCount >= ctx.maxFuturesPositions) continue; // SHORT = futures
    const price = plan.entryRef;
    const rFraction = plan.riskPerUnit / price;
    if (!(rFraction > 0)) continue;
    const desiredNotional = (ctx.equity * p.riskPerTrade) / rFraction;

    const assetUsed = exposureByBase.get(ev.symbol) ?? 0;
    let notional = Math.min(
      desiredNotional,
      Math.max(0, perAssetCap - assetUsed),
      Math.max(0, totalCap - totalExposure),
      workingCash
    );
    if (notional < MIN_SIM_ENTRY_USD) {
      // Operator floor: round a small entry UP to $100 when free cash covers
      // it (may exceed the per-asset / total caps — accepted for the
      // "$100 minimum, always" rule). Skip only when the cash / equity is not
      // there.
      if (workingCash >= MIN_SIM_ENTRY_USD && ctx.equity >= MIN_SIM_ENTRY_USD) notional = MIN_SIM_ENTRY_USD;
      else continue;
    }

    exposureByBase.set(ev.symbol, assetUsed + notional);
    totalExposure += notional;
    workingCash -= notional;
    positionCount++;
    if (!isLong) futuresCount++;
    pendingEntrySymbols.add(ev.symbol);

    newOrders.push({
      id: uid(`${ev.symbol}-${isLong ? 'buy' : 'short'}`),
      symbol: ev.symbol,
      type: isLong ? 'SPOT' : 'FUTURES',
      side: isLong ? 'buy' : 'short',
      signalPrice: price,
      quantity: notional / price,
      budgetUsd: notional,
      leverage: 1,
      // Fire at the delayed market price — this is a breakout entry, not a
      // resting discount limit.
      fill: 'market',
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      takeProfit1: plan.takeProfit,
      reason: ev.reasoning,
      confidence: ev.confidence,
      executeAt: now + delayMs,
      createdAt: now
    });
  }

  return newOrders;
}

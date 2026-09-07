// Order generation, sizing, scale-in and exit management for the TrendBreakout
// bot. Shares the fill/fee/slippage core (fillDueOrders), the entry/streak
// cooldowns and the drawdown / exposure constants with the other three sim
// bots — so a difference in results is a difference in DECISIONS, not in
// plumbing. What is genuinely its own:
//
//   · risk-based sizing: full size = (equity × riskPerTrade) / |entry − SL|
//     (spec §14), then hard-capped by the shared per-asset / total exposure
//     limits (spec §15). Tight ATR stops make the per-asset 8% cap the usual
//     binding constraint — by design.
//   · scale-in (spec §11): the shared fill core cannot add to a position, so
//     each of the 50/30/20 % lots is its OWN SimPosition. One logical trade =
//     every lot with the same base asset + side. Lots share one logical
//     SL/TP and are closed together.
//   · stop management (spec §12): break-even at +1R, ATR trailing from +1.5R,
//     recomputed every tick from the immutable entry + the factory-tracked
//     highest/lowest price (the codebase never mutates pos.stopLoss).
//   · exits (spec §13): effective stop, TP (2R), H1 Supertrend reversal,
//     24×H1 time stop.

import { Candle, calculateATR, calculateSupertrend } from './tradeEngine';
import type { SignalEvaluation } from './intradayBridge';
import type { SimPosition, PendingOrder } from './simExecution';
import { isInEntryCooldown, MIN_SIM_ENTRY_USD } from './simExecution';
import {
  isInStreakCooldown,
  streakCooldownFromHistory,
  ClosedTradeRecord
} from './adaptiveRisk';
import {
  DAILY_DRAWDOWN_BLOCK_PERCENT,
  WEEKLY_DRAWDOWN_LOCK_PERCENT,
  PER_ASSET_EXPOSURE_CAP_PERCENT
} from './intradayParams';
import {
  DEFAULT_TREND_BREAKOUT_PARAMS,
  TrendBreakoutParams,
  readTrendBreakoutPlan
} from './trendBreakout';

export const uid = (p: string) => `tb-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Spec §15 — total leveraged + spot exposure ceiling, as a fraction of equity. */
export const MAX_TOTAL_EXPOSURE_PERCENT = 20;

const H4_MS = 4 * 60 * 60 * 1000;

export interface TrendBreakoutCandleSet {
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
}

export interface TrendBreakoutOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  equity: number;
  /** FUTURES notional already open (from the engine factory). */
  totalLeveragedExposureUsd: number;
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  /** Keyed by BASE asset — same keys the evaluations and positions use. */
  candlesBySymbol: Record<string, TrendBreakoutCandleSet | undefined>;
  closedTradeMetrics?: ClosedTradeRecord[];
  /** Max concurrent LOGICAL trades (base+side groups), not lots. */
  maxConcurrentTrades: number;
  params?: Partial<TrendBreakoutParams>;
}

interface LogicalTrade {
  base: string;
  side: 'LONG' | 'SHORT';
  lots: SimPosition[];
}

const ENTRY_SIDES = new Set(['buy', 'sell', 'long', 'short']);

function groupLogicalTrades(positions: SimPosition[]): LogicalTrade[] {
  const map = new Map<string, LogicalTrade>();
  for (const pos of positions) {
    const side: 'LONG' | 'SHORT' = pos.side === 'SHORT' || pos.side === 'SELL' ? 'SHORT' : 'LONG';
    const key = `${pos.symbol}|${side}`;
    let lt = map.get(key);
    if (!lt) {
      lt = { base: pos.symbol, side, lots: [] };
      map.set(key, lt);
    }
    lt.lots.push(pos);
  }
  // Oldest lot first — it anchors the logical entry / R.
  for (const lt of map.values()) lt.lots.sort((a, b) => a.openTimestamp - b.openTimestamp);
  return [...map.values()];
}

function positionNotional(pos: SimPosition, priceFor: (s: string) => number | undefined): number {
  const live = priceFor(pos.symbol) ?? pos.currentPrice ?? pos.entryPrice;
  // quantity already carries leverage for FUTURES (=1 here), so notional is
  // quantity × price for both position types.
  return pos.quantity * live;
}

function currentH1Supertrend(
  set: TrendBreakoutCandleSet | undefined,
  p: TrendBreakoutParams
): 'BULL' | 'BEAR' | undefined {
  if (!set || !set.h1 || set.h1.length < p.supertrendAtrPeriod + 2) return undefined;
  return calculateSupertrend(set.h1, p.supertrendAtrPeriod, p.supertrendMultiplier).direction;
}

function currentAtrM15(set: TrendBreakoutCandleSet | undefined, p: TrendBreakoutParams): number | undefined {
  if (!set || !set.m15 || set.m15.length < p.atrPeriod + 1) return undefined;
  return calculateATR(set.m15, p.atrPeriod).atr;
}

/**
 * Effective stop for a logical trade this tick — break-even at +breakEvenR,
 * ATR trailing from +trailingStartR, never looser than the entry stop.
 */
export function effectiveStop(
  lt: LogicalTrade,
  livePrice: number,
  atrM15Now: number | undefined,
  p: TrendBreakoutParams
): { stop: number; progressR: number } {
  const first = lt.lots[0];
  const isLong = lt.side === 'LONG';
  const entry0 = first.entryPrice;
  const stop0 = first.stopLoss;
  const rUnit = Math.abs(entry0 - stop0) || (Math.abs(entry0) * 0.005);

  const extreme = isLong
    ? Math.max(...lt.lots.map((l) => l.highestPrice ?? l.entryPrice), livePrice)
    : Math.min(...lt.lots.map((l) => l.lowestPrice ?? l.entryPrice), livePrice);
  const progressR = ((extreme - entry0) * (isLong ? 1 : -1)) / rUnit;

  let stop = stop0;
  if (progressR >= p.breakEvenR) {
    stop = isLong ? Math.max(stop, entry0) : Math.min(stop, entry0);
  }
  if (progressR >= p.trailingStartR && atrM15Now && atrM15Now > 0) {
    const trail = isLong
      ? extreme - p.trailingAtrMultiplier * atrM15Now
      : extreme + p.trailingAtrMultiplier * atrM15Now;
    stop = isLong ? Math.max(stop, trail) : Math.min(stop, trail);
  }
  // Never loosen past the original protective stop.
  stop = isLong ? Math.max(stop, stop0) : Math.min(stop, stop0);
  return { stop, progressR };
}

export function generateTrendBreakoutOrders(ctx: TrendBreakoutOrderGenContext): PendingOrder[] {
  const p: TrendBreakoutParams = { ...DEFAULT_TREND_BREAKOUT_PARAMS, ...(ctx.params ?? {}) };
  const now = Date.now();
  const delayMs = Math.max(0, ctx.executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];

  const trades = groupLogicalTrades(ctx.positions);
  const claimedPositionIds = new Set(
    ctx.pending.filter((o) => o.positionId).map((o) => o.positionId as string)
  );

  // ── Exits (spec §13) — per logical trade; closes every lot together ──────
  const closingBaseSides = new Set<string>();
  for (const lt of trades) {
    if (lt.lots.every((l) => claimedPositionIds.has(l.id))) continue;
    const set = ctx.candlesBySymbol[lt.base];
    const live = ctx.priceFor(lt.base) ?? lt.lots[0].currentPrice ?? lt.lots[0].entryPrice;
    const isLong = lt.side === 'LONG';
    const first = lt.lots[0];
    const tp = first.takeProfit ?? first.takeProfit1;
    const atrM15Now = currentAtrM15(set, p);
    const { stop, progressR } = effectiveStop(lt, live, atrM15Now, p);

    let reason = '';
    if (isLong ? live <= stop : live >= stop) {
      reason = progressR >= p.breakEvenR
        ? `Trailing/BE stop ב-${stop.toFixed(6)} (${progressR.toFixed(2)}R)`
        : `Stop Loss ב-${stop.toFixed(6)}`;
    } else if (tp && (isLong ? live >= tp : live <= tp)) {
      reason = `Take Profit ב-${tp.toFixed(6)} (${p.tpRMultiplier}R)`;
    } else {
      const stNow = currentH1Supertrend(set, p);
      if (stNow && (isLong ? stNow === 'BEAR' : stNow === 'BULL')) {
        reason = `היפוך מגמה — H1 Supertrend התהפך ל-${stNow}`;
      } else if (now - first.openTimestamp >= p.maxHoldHours * 60 * 60 * 1000) {
        reason = `Time Stop — ${p.maxHoldHours} נרות H1 (${progressR.toFixed(2)}R)`;
      }
    }

    if (!reason) continue;
    closingBaseSides.add(`${lt.base}|${lt.side}`);
    for (const lot of lt.lots) {
      if (claimedPositionIds.has(lot.id)) continue;
      newOrders.push({
        id: uid(`${lt.base}-exit`),
        symbol: lt.base,
        positionId: lot.id,
        type: lot.type,
        side: isLong ? 'close_long' : 'close_short',
        signalPrice: live,
        quantity: lot.quantity,
        reason,
        confidence: lot.confidence,
        executeAt: now + delayMs,
        createdAt: now
      });
    }
  }

  // ── Circuit breaker (spec §16) — exits only past this point ─────────────
  if (
    ctx.dailyDrawdownPercent >= DAILY_DRAWDOWN_BLOCK_PERCENT ||
    ctx.weeklyDrawdownPercent >= WEEKLY_DRAWDOWN_LOCK_PERCENT
  ) {
    return newOrders;
  }

  // Running exposure / cash / count as this batch adds orders.
  let workingCash = ctx.cash;
  const perAssetCap = ctx.equity * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
  const totalCap = ctx.equity * (MAX_TOTAL_EXPOSURE_PERCENT / 100);

  const exposureByBase = new Map<string, number>();
  let totalExposure = 0;
  for (const pos of ctx.positions) {
    const n = positionNotional(pos, ctx.priceFor);
    exposureByBase.set(pos.symbol, (exposureByBase.get(pos.symbol) ?? 0) + n);
    totalExposure += n;
  }
  for (const o of ctx.pending) {
    if (!ENTRY_SIDES.has(o.side)) continue;
    const n = o.budgetUsd ?? 0;
    exposureByBase.set(o.symbol, (exposureByBase.get(o.symbol) ?? 0) + n);
    totalExposure += n;
  }

  const tradeKey = (base: string, side: 'LONG' | 'SHORT') => `${base}|${side}`;
  const openLogicalKeys = new Set(trades.map((lt) => tradeKey(lt.base, lt.side)));
  const pendingEntryKeys = new Set(
    ctx.pending
      .filter((o) => ENTRY_SIDES.has(o.side))
      .map((o) => tradeKey(o.symbol, o.side === 'sell' || o.side === 'short' ? 'SHORT' : 'LONG'))
  );
  let logicalTradeCount = openLogicalKeys.size;

  /** Places one entry lot, respecting cash + both exposure caps. Returns the
   *  notional actually committed (0 if nothing could be placed). */
  const placeLot = (opts: {
    base: string;
    side: 'LONG' | 'SHORT';
    desiredNotional: number;
    price: number;
    stopLoss: number;
    takeProfit: number;
    confidence: number;
    reason: string;
    scaleLabel: string;
    /** SCALE_1 only: round a sub-$100 first entry UP to the floor (cash
     *  permitting). Scale-in lots keep the skip — bloating a 30% add to $100
     *  would break the 50/30/20 proportion. */
    floorBump?: boolean;
  }): number => {
    const isLong = opts.side === 'LONG';
    const assetUsed = exposureByBase.get(opts.base) ?? 0;
    const assetHeadroom = Math.max(0, perAssetCap - assetUsed);
    const totalHeadroom = Math.max(0, totalCap - totalExposure);
    let notional = Math.min(opts.desiredNotional, assetHeadroom, totalHeadroom, workingCash);
    // Operator floor: no sim entry below MIN_SIM_ENTRY_USD.
    if (notional < MIN_SIM_ENTRY_USD) {
      if (opts.floorBump && workingCash >= MIN_SIM_ENTRY_USD && ctx.equity >= MIN_SIM_ENTRY_USD) {
        notional = MIN_SIM_ENTRY_USD;
      } else {
        return 0;
      }
    }

    exposureByBase.set(opts.base, assetUsed + notional);
    totalExposure += notional;
    workingCash -= notional;

    newOrders.push({
      id: uid(`${opts.base}-${isLong ? 'buy' : 'short'}`),
      symbol: opts.base,
      type: isLong ? 'SPOT' : 'FUTURES',
      side: isLong ? 'buy' : 'short',
      signalPrice: opts.price,
      quantity: notional / opts.price,
      budgetUsd: notional,
      leverage: 1,
      // Fire at the delayed market price — TrendBreakout enters on the M5
      // confirmation, "the next closed M5 / the simulation's execution price"
      // (spec §8), not as a resting discount limit.
      fill: 'market',
      stopLoss: opts.stopLoss,
      takeProfit: opts.takeProfit,
      takeProfit1: opts.takeProfit,
      reason: `TrendBreakout ${opts.side} ${opts.scaleLabel} · ${opts.reason}`,
      confidence: opts.confidence,
      executeAt: now + delayMs,
      createdAt: now
    });
    return notional;
  };

  // ── Scale-in for existing logical trades (spec §11) ────────────────────
  for (const lt of trades) {
    const key = tradeKey(lt.base, lt.side);
    if (closingBaseSides.has(key)) continue;
    if (pendingEntryKeys.has(key)) continue; // a lot is already queued
    const lotCount = lt.lots.length;
    if (lotCount >= p.scaleFractions.length) continue;

    const set = ctx.candlesBySymbol[lt.base];
    const stNow = currentH1Supertrend(set, p);
    const isLong = lt.side === 'LONG';
    // Trend must still be valid (spec §11 SCALE_2/§13E invalidated setup).
    if (stNow && (isLong ? stNow !== 'BULL' : stNow !== 'BEAR')) continue;

    const live = ctx.priceFor(lt.base) ?? lt.lots[0].currentPrice ?? lt.lots[0].entryPrice;
    const first = lt.lots[0];
    const rUnit = Math.abs(first.entryPrice - first.stopLoss) || Math.abs(first.entryPrice) * 0.005;
    const progressR = ((live - first.entryPrice) * (isLong ? 1 : -1)) / rUnit;
    if (progressR <= 0) continue; // never average down (no martingale)

    const nextScaleMinR = lotCount === 1 ? p.scale2MinR : p.scale3MinR;
    if (progressR < nextScaleMinR) continue;

    const fraction = p.scaleFractions[lotCount] ?? 0;
    if (!(fraction > 0)) continue;

    // Full position notional recomputed against current equity + the logical R.
    const riskUsd = ctx.equity * p.riskPerTrade;
    const rFraction = rUnit / first.entryPrice;
    const fullNotional = rFraction > 0 ? riskUsd / rFraction : 0;
    if (!(fullNotional > 0)) continue;

    placeLot({
      base: lt.base,
      side: lt.side,
      desiredNotional: fullNotional * fraction,
      price: live,
      stopLoss: first.stopLoss,
      takeProfit: first.takeProfit ?? first.takeProfit1 ?? live,
      confidence: first.confidence,
      reason: `scale ${lotCount + 1}/${p.scaleFractions.length} ב-${progressR.toFixed(2)}R`,
      scaleLabel: `scale ${lotCount + 1}/${p.scaleFractions.length}`
    });
  }

  // ── Fresh entries (SCALE_1) from SIGNAL evaluations ────────────────────
  const ranked = [...ctx.evaluations]
    .filter((ev) => ev.willExecute && ev.price)
    .sort((a, b) => b.confidence - a.confidence);

  for (const ev of ranked) {
    const plan = readTrendBreakoutPlan(ev);
    if (!plan) continue;
    const side = plan.direction;
    const key = tradeKey(ev.symbol, side);
    if (openLogicalKeys.has(key) || pendingEntryKeys.has(key)) continue; // one logical trade per base+side; blocks double-entry on the same breakout
    if (closingBaseSides.has(key)) continue;
    if (isInEntryCooldown(ctx.exitCooldown[ev.symbol], now)) continue;
    if (isInStreakCooldown(streakCooldownFromHistory(ctx.closedTradeMetrics ?? [], ctx.equity, ev.symbol))) continue;
    if (logicalTradeCount >= ctx.maxConcurrentTrades) continue;

    const price = plan.entryRef || ev.price;
    const riskUsd = ctx.equity * p.riskPerTrade;
    const rFraction = plan.riskPerUnit / price;
    const fullNotional = rFraction > 0 ? riskUsd / rFraction : 0;
    if (!(fullNotional > 0)) continue;

    const committed = placeLot({
      base: ev.symbol,
      side,
      desiredNotional: fullNotional * (p.scaleFractions[0] ?? 1),
      price,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      confidence: ev.confidence,
      reason: `כניסה ראשונית · SL ${plan.stopLoss.toFixed(6)} TP ${plan.takeProfit.toFixed(6)}`,
      scaleLabel: `scale 1/${p.scaleFractions.length}`,
      floorBump: true
    });
    if (committed > 0) {
      logicalTradeCount++;
      openLogicalKeys.add(key);
      pendingEntryKeys.add(key);
    }
  }

  return newOrders;
}

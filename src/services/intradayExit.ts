/**
 * Intraday Exit Engine (§29/§31/§32/§52)
 * ============================================================================
 * Exit priority (never re-ordered):
 *      Weekly emergency protection
 *        ↓ Stop Loss
 *        ↓ Take Profit (TP2 → TP1 partial)
 *        ↓ Trailing (only after the trade proved itself)
 *        ↓ Reversal
 *        ↓ Time Stop / Max duration
 *
 * The exit engine keeps running even when new entries are blocked.
 */

import { formatDynamicPrice } from './tradeEngine';
import { DEFAULT_INTRADAY_PARAMS, Direction, IntradayParams, SetupType } from './intradayParams';

export type ExitReasonCode =
  | 'WEEKLY_PROTECTION'
  | 'STOP_LOSS'
  | 'TAKE_PROFIT_2'
  | 'TAKE_PROFIT_1'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'REVERSAL'
  | 'TIME_STOP'
  | 'MAX_DURATION'
  | 'NONE';

export interface IntradayPositionView {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'LONG' | 'SHORT' | 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  tp1Hit?: boolean;
  openTimestamp: number;
  maxHoldMs?: number;
  timeStopMs?: number;
  setupType?: SetupType;
  plannedStopDistance?: number;
  highestPrice?: number;
  lowestPrice?: number;
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
}

export interface IntradayExitContext {
  price: number;
  now: number;
  atr5: number;
  params?: IntradayParams;
  portfolio: {
    dailyDrawdownPercent: number;
    weeklyDrawdownPercent: number;
    systemLocked?: boolean;
  };
  reversalSignal?: {
    direction: Direction;
    setupScore: number;
    entryConfirmed: boolean;
  };
  /** Close of the last fully-CLOSED 5M candle (not the live/forming price) —
   *  only used for MEAN_REVERSION's stop-loss check when
   *  params.meanReversionCloseConfirmStop is on. See that flag's doc comment
   *  in intradayParams.ts. */
  lastClosedCandleClose?: number;
}

export interface IntradayExitDecision {
  shouldExit: boolean;
  exitType: 'FULL' | 'PARTIAL_50' | 'NONE';
  reasonCode: ExitReasonCode;
  reason: string;
  trailingStopPrice?: number;
  /** Favourable progress measured in R at decision time */
  progressR: number;
  /** Maximum favourable excursion in R */
  mfeR: number;
  heldMinutes: number;
}

export function evaluateIntradayExit(pos: IntradayPositionView, ctx: IntradayExitContext): IntradayExitDecision {
  const params = ctx.params ?? DEFAULT_INTRADAY_PARAMS;
  const isLong = pos.side === 'LONG' || pos.side === 'BUY';
  const s = isLong ? 1 : -1;
  const price = ctx.price;
  const atr5 = ctx.atr5 > 0 ? ctx.atr5 : pos.entryPrice * 0.001;

  const stopDistance = pos.plannedStopDistance && pos.plannedStopDistance > 0
    ? pos.plannedStopDistance
    : Math.max(Math.abs(pos.entryPrice - pos.stopLoss), 1e-12);

  const progressR = ((price - pos.entryPrice) * s) / stopDistance;
  const peak = isLong
    ? Math.max(pos.highestPrice ?? pos.entryPrice, price)
    : Math.min(pos.lowestPrice ?? pos.entryPrice, price);
  const mfeR = ((peak - pos.entryPrice) * s) / stopDistance;
  const heldMs = Math.max(0, ctx.now - pos.openTimestamp);
  const heldMinutes = Number((heldMs / 60_000).toFixed(1));

  const base = { progressR: Number(progressR.toFixed(2)), mfeR: Number(mfeR.toFixed(2)), heldMinutes };

  // 1 ── Weekly emergency protection ─────────────────────────────────────────
  if (ctx.portfolio.systemLocked || ctx.portfolio.weeklyDrawdownPercent >= params.weeklyDrawdownFlattenPercent) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'WEEKLY_PROTECTION',
      reason: `הגנת תיק שבועית (Drawdown ${ctx.portfolio.weeklyDrawdownPercent.toFixed(1)}% >= ${params.weeklyDrawdownFlattenPercent}%) — סגירת פוזיציה`,
      ...base
    };
  }

  // 2 ── Stop loss ───────────────────────────────────────────────────────────
  // MEAN_REVERSION can optionally require the SL breach to survive a full 5M
  // candle close (not just a live-price touch) — see meanReversionCloseConfirmStop
  // in intradayParams.ts. Every other setup type keeps the live-price check.
  const useCloseConfirmStop =
    pos.setupType === 'MEAN_REVERSION' &&
    !!params.meanReversionCloseConfirmStop &&
    ctx.lastClosedCandleClose !== undefined;
  const slCheckPrice = useCloseConfirmStop ? ctx.lastClosedCandleClose! : price;
  if ((isLong && slCheckPrice <= pos.stopLoss) || (!isLong && slCheckPrice >= pos.stopLoss)) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'STOP_LOSS',
      reason: useCloseConfirmStop
        ? `Stop Loss ב-$${formatDynamicPrice(pos.stopLoss)} (אושר בסגירת נר 5M ב-$${formatDynamicPrice(slCheckPrice)})`
        : `Stop Loss ב-$${formatDynamicPrice(pos.stopLoss)} (מחיר $${formatDynamicPrice(price)})`,
      ...base
    };
  }

  // 3 ── Take profit ─────────────────────────────────────────────────────────
  if (pos.type === 'FUTURES') {
    if (pos.takeProfit2 && ((isLong && price >= pos.takeProfit2) || (!isLong && price <= pos.takeProfit2))) {
      return {
        shouldExit: true,
        exitType: 'FULL',
        reasonCode: 'TAKE_PROFIT_2',
        reason: `TP2 הושג ב-$${formatDynamicPrice(pos.takeProfit2)}`,
        ...base
      };
    }
    if (!pos.tp1Hit && pos.takeProfit1 && ((isLong && price >= pos.takeProfit1) || (!isLong && price <= pos.takeProfit1))) {
      return {
        shouldExit: true,
        exitType: 'PARTIAL_50',
        reasonCode: 'TAKE_PROFIT_1',
        reason: `TP1 הושג ב-$${formatDynamicPrice(pos.takeProfit1)} — סגירת 50% והפעלת Trailing`,
        ...base
      };
    }
  } else if (pos.takeProfit1 && ((isLong && price >= pos.takeProfit1) || (!isLong && price <= pos.takeProfit1))) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'TAKE_PROFIT',
      reason: `Take Profit ב-$${formatDynamicPrice(pos.takeProfit1)}`,
      ...base
    };
  }

  // 4 ── Trailing — only after the trade proved itself (§32) ─────────────────
  const trailingActive = pos.type === 'FUTURES' ? !!pos.tp1Hit : mfeR >= params.trailingActivationR;
  if (trailingActive) {
    const anchor = pos.type === 'FUTURES'
      ? isLong
        ? Math.max(pos.highestPriceSinceTP1 ?? peak, price)
        : Math.min(pos.lowestPriceSinceTP1 ?? peak, price)
      : peak;
    const trailingStopPrice = anchor - s * params.trailingAtrMult * atr5;
    const trailingHit = isLong ? price <= trailingStopPrice : price >= trailingStopPrice;
    if (trailingHit && mfeR >= params.trailingActivationR * 0.8) {
      return {
        shouldExit: true,
        exitType: 'FULL',
        reasonCode: 'TRAILING_STOP',
        reason: `Trailing Stop ב-$${formatDynamicPrice(trailingStopPrice)} (MFE ${mfeR.toFixed(2)}R)`,
        trailingStopPrice,
        ...base
      };
    }
  }

  // 5 ── Reversal — an opposite, CONFIRMED setup, not a single indicator ─────
  if (ctx.reversalSignal && ctx.reversalSignal.entryConfirmed && ctx.reversalSignal.setupScore >= 70) {
    const opposite = isLong ? ctx.reversalSignal.direction === 'SHORT' : ctx.reversalSignal.direction === 'LONG';
    if (opposite) {
      return {
        shouldExit: true,
        exitType: 'FULL',
        reasonCode: 'REVERSAL',
        reason: `היפוך מאושר בכיוון הנגדי (SetupScore ${ctx.reversalSignal.setupScore})`,
        ...base
      };
    }
  }

  // 6 ── Time stops (§28/§29) ────────────────────────────────────────────────
  const maxHoldMs = pos.maxHoldMs ?? params.maxHoldMinutes.TREND_PULLBACK * 60_000;
  const timeStopMs = pos.timeStopMs ?? Math.round(maxHoldMs * params.timeStopFraction);

  if (heldMs >= maxHoldMs) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'MAX_DURATION',
      reason: `משך החזקה מקסימלי (${Math.round(maxHoldMs / 60_000)} דק') — יציאת זמן`,
      ...base
    };
  }

  if (heldMs >= timeStopMs && progressR < params.timeStopMinProgressR) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'TIME_STOP',
      reason: `Time Stop: אחרי ${heldMinutes} דק' התקדמות ${progressR.toFixed(2)}R < ${params.timeStopMinProgressR}R`,
      ...base
    };
  }

  return {
    shouldExit: false,
    exitType: 'NONE',
    reasonCode: 'NONE',
    reason: 'הפוזיציה ממשיכה להתנהל',
    ...base
  };
}

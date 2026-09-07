// Prev-4H Range — a simple 4-hour breakout strategy: read the last CLOSED 4H
// candle's high/low, then during the next 4H window trade a breakout of those
// levels IN THE DIRECTION OF THE 4H EMA(20) TREND.
//
// This replaces the empirical-bucket "Path" engine, whose own offline backtest
// (ASSETS/path-slot-study33) showed no bucket with positive expectancy after
// costs. Prev-4H Range is deliberately simple — no lookup table, no Wilson
// bound, four plain conditions:
//
//   1. previous 4H bar fully closed  →  H, L, mid, range
//   2. we are inside the very next 4H window
//   3. 4H EMA(20) trend agrees with the breakout direction
//   4. the previous bar's range is neither dead-tight nor already blown out
//
// SIMULATION ONLY. Decisions use CLOSED candles only — aggregateToH4 emits a
// bar only once all four of its H1 candles have closed, so `prev` is never the
// forming bar and nothing here reads a future value.

import { Candle, calculateEMA } from './tradeEngine';
import { aggregateToH4 } from './pathEngine';
import { barOpenFor, BAR_MS } from './pathStudy';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import { POSITION_TARGET_PCT } from './intradayParams';

// ── Parameters (all configurable — no auto-optimisation) ────────────────────

export interface Prev4hRangeParams {
  /** 4H EMA period for the trend filter. */
  emaPeriod: number;
  /** Previous-bar range as a fraction of price must be >= this (else too tight
   *  — a compressed bar breaks out on noise). */
  minRangePct: number;
  /** ...and <= this (else the move is already made; a late breakout is a bad
   *  entry). */
  maxRangePct: number;
  /** TP distance from entry = range * this. Actual R:R depends on breakout
    *  distance: at d=0 RR=2.0, at d=0.5*range RR=0.5. The old comment claiming
    *  "~2:1" was only true for a perfect touch of H/L. */
  tpRangeMult: number;
  /** Risk budget for the position, as a fraction of equity. */
  riskPerTrade: number;
  /** Target notional as a fraction of equity (e.g. 0.10 = 10%).
   *  Single source of truth for position sizing. */
  positionTargetPct: number;
  /** Confidence SCORE (0-100) required to open. Not a probability. */
  minConfidence: number;
  /** Minimum fully-closed 4H bars before the bot will evaluate a symbol. */
  minH4Bars: number;
  /** Don't chase: the break must be at most `range × this` past H/L. Beyond
    *  that the move is already made and the stop (at `mid`) is too far to size
    *  a sane position — the bot abstains (`ENTRY_TOO_EXTENDED`). */
  maxExtensionRangeMult: number;
  /** Minimum gross risk:reward ratio required to enter. */
  minRR: number;
}

export const DEFAULT_PREV4H_RANGE_PARAMS: Prev4hRangeParams = {
  emaPeriod: 20,
  minRangePct: 0.005,
  maxRangePct: 0.08,
  tpRangeMult: 1.0,
  riskPerTrade: 0.005,
  positionTargetPct: POSITION_TARGET_PCT,
  minConfidence: 55,
  minH4Bars: 24,
  maxExtensionRangeMult: 0.5,
  minRR: 1.2
};

/** 4H bars needed (params default) → H1 candles needed to build them. */
export const PREV4H_MIN_H4_BARS = 24;
export const PREV4H_MIN_H1_CANDLES = PREV4H_MIN_H4_BARS * 4;

// ── State / reasons ────────────────────────────────────────────────────────

export type Prev4hRangeState =
  | 'NO_DATA'
  | 'NO_SIGNAL'
  | 'ARMED'      // reference bar + trend valid, waiting for a breakout
  | 'SIGNAL';

export type Prev4hRangeReason =
  | 'OK'
  | 'NO_DATA'
  | 'STALE_BAR'         // last closed 4H bar is not the immediately-previous window
  | 'AGAINST_TREND'     // EMA(20) trend is flat / against both breakout sides
  | 'RANGE_TOO_TIGHT'
  | 'RANGE_TOO_WIDE'
  | 'NO_BREAKOUT'        // price still inside [L, H]
  | 'ENTRY_TOO_EXTENDED' // broke out but price already ran too far past H/L
  | 'CONFIDENCE_BELOW_MIN'
  | 'RR_BELOW_MIN';      // actual R:R below threshold

export interface Prev4hRangePlan {
  direction: 'LONG' | 'SHORT';
  state: Prev4hRangeState;
  reasonCode: Prev4hRangeReason;
  /** Start of the 4H window we are trading in. Dedupe key with the symbol. */
  windowStart: number;
  /** End of that window — the time stop. */
  windowEnd: number;
  prevHigh: number;
  prevLow: number;
  mid: number;
  range: number;
  rangePct: number;
  ema: number;
  emaPrev: number;
  entryRef: number;
  stopLoss: number;
  takeProfit: number;
  riskPerUnit: number;
  actualRR: number;
  confidence: number;
  components: { breakout: number; trend: number; range: number };
}

// ── Evaluation ─────────────────────────────────────────────────────────────

export interface Prev4hRangeInput {
  symbol: string;
  h1: Candle[];
  currentPrice: number;
  priceChange24h?: number;
  now?: number;
  params?: Partial<Prev4hRangeParams>;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function evaluatePrev4hRange(input: Prev4hRangeInput): SignalEvaluation {
  const p: Prev4hRangeParams = { ...DEFAULT_PREV4H_RANGE_PARAMS, ...(input.params ?? {}) };
  const { symbol, h1, currentPrice } = input;
  const now = input.now ?? Date.now();
  const priceChange24h = input.priceChange24h ?? 0;

  const base = (
    state: Prev4hRangeState,
    reason: Prev4hRangeReason,
    factors: DecisionFactor[] = [],
    extra: Partial<SignalEvaluation> = {}
  ): SignalEvaluation => ({
    symbol,
    action: 'hold',
    tradeType: 'HOLD',
    tradeSide: 'NONE',
    confidence: 0,
    price: currentPrice,
    priceChange24h,
    reasoning: `[${state}] ${reason}`,
    status: state === 'SIGNAL' ? 'SIGNAL' : `NO_SIGNAL [${reason}]`,
    willExecute: false,
    factors,
    confidenceGap: 0,
    ...extra
  });

  if (!h1 || h1.length < PREV4H_MIN_H1_CANDLES) {
    return base('NO_DATA', 'NO_DATA', [{
      label: 'נתונים', value: `H1 ${h1?.length ?? 0}/${PREV4H_MIN_H1_CANDLES}`, impact: 'neutral', note: 'אין מספיק נרות'
    }]);
  }

  const h4 = aggregateToH4(h1);
  if (h4.length < p.minH4Bars) {
    return base('NO_DATA', 'NO_DATA', [{
      label: 'נתונים', value: `H4 ${h4.length}/${p.minH4Bars}`, impact: 'neutral', note: 'אין מספיק נרות 4H'
    }]);
  }

  const prev = h4[h4.length - 1]; // last FULLY-CLOSED 4H bar
  const windowStart = prev.timestamp + BAR_MS;
  const windowEnd = windowStart + BAR_MS;

  // We must be inside the window that immediately follows `prev`.
  if (barOpenFor(now) !== windowStart) {
    return base('NO_SIGNAL', 'STALE_BAR', [{
      label: 'חלון', value: `נר קודם נסגר ${new Date(prev.timestamp).toISOString()}`, impact: 'neutral',
      note: 'נתוני H1 לא עדכניים לחלון הנוכחי'
    }]);
  }

  const H = prev.high;
  const L = prev.low;
  const mid = (H + L) / 2;
  const range = H - L;
  const rangePct = prev.close > 0 ? range / prev.close : 0;

  const emaSeries = calculateEMA(h4.map((c) => c.close), p.emaPeriod);
  const ema = emaSeries[emaSeries.length - 1] ?? prev.close;
  const emaPrev = emaSeries[emaSeries.length - 2] ?? ema;
  const trendUp = ema > emaPrev && prev.close > ema;
  const trendDown = ema < emaPrev && prev.close < ema;

  const debug: DecisionFactor[] = [
    { label: 'נר 4H קודם', value: `H ${H} · L ${L} · טווח ${range.toFixed(6)} (${(rangePct * 100).toFixed(2)}%)`, impact: 'neutral', note: '' },
    { label: 'מגמת EMA20 (4H)', value: trendUp ? 'עולה' : trendDown ? 'יורדת' : 'שטוחה', impact: 'neutral', note: `EMA ${ema.toFixed(6)} (קודם ${emaPrev.toFixed(6)})` },
    { label: 'מחיר', value: `${currentPrice}`, impact: 'neutral', note: currentPrice > H ? 'מעל הגבוה' : currentPrice < L ? 'מתחת לנמוך' : 'בתוך הטווח' }
  ];

  if (!trendUp && !trendDown) {
    return base('NO_SIGNAL', 'AGAINST_TREND', debug);
  }
  if (rangePct < p.minRangePct) return base('NO_SIGNAL', 'RANGE_TOO_TIGHT', debug);
  if (rangePct > p.maxRangePct) return base('NO_SIGNAL', 'RANGE_TOO_WIDE', debug);

  let direction: 'LONG' | 'SHORT' | null = null;
  if (trendUp && currentPrice > H) direction = 'LONG';
  else if (trendDown && currentPrice < L) direction = 'SHORT';

  if (!direction) {
    return base('ARMED', 'NO_BREAKOUT', debug);
  }

  const isLong = direction === 'LONG';
  const breakoutDist = isLong ? currentPrice - H : L - currentPrice;
  if (breakoutDist > range * p.maxExtensionRangeMult) {
    return base('ARMED', 'ENTRY_TOO_EXTENDED', debug);
  }

  const entryRef = currentPrice;
  const stopLoss = mid;
  const riskPerUnit = Math.abs(entryRef - stopLoss);
  const takeProfit = isLong ? H + range * p.tpRangeMult : L - range * p.tpRangeMult;

  // Gross R:R from actual levels (not the misleading ~2:1 claim).
  const grossReward = Math.abs(takeProfit - entryRef);
  const grossRisk = Math.abs(entryRef - stopLoss);
  const actualRR = grossRisk > 0 ? grossReward / grossRisk : 0;

  if (actualRR < p.minRR) {
    return base('ARMED', 'RR_BELOW_MIN', debug, { confidence: 0 });
  }

  // Confidence SCORE 0-100.
  const breakout = clamp01(breakoutDist / (range * 0.5)) * 30;
  const trendStrength = clamp01(Math.abs(ema - emaPrev) / (emaPrev * 0.01)) * 20;
  // Reward a range that sits in the middle of the allowed band.
  const bandPos = (rangePct - p.minRangePct) / Math.max(1e-9, p.maxRangePct - p.minRangePct);
  const rangeScore = (1 - Math.abs(bandPos - 0.4) / 0.6) * 10;
  const confidence = Math.round(40 + breakout + trendStrength + Math.max(0, rangeScore));

  const plan: Prev4hRangePlan = {
    direction,
    state: confidence >= p.minConfidence ? 'SIGNAL' : 'ARMED',
    reasonCode: confidence >= p.minConfidence ? 'OK' : 'CONFIDENCE_BELOW_MIN',
    windowStart,
    windowEnd,
    prevHigh: H,
    prevLow: L,
    mid,
    range,
    rangePct,
    ema,
    emaPrev,
    entryRef,
    stopLoss,
    takeProfit,
    riskPerUnit,
    actualRR,
    confidence,
    components: { breakout, trend: trendStrength, range: Math.max(0, rangeScore) }
  };

  const factors: DecisionFactor[] = [
    ...debug,
    { label: 'ציון ביטחון', value: `${confidence}/100 (סף ${p.minConfidence})`, impact: confidence >= p.minConfidence ? 'positive' : 'neutral',
      note: `פריצה ${plan.components.breakout.toFixed(0)} · מגמה ${plan.components.trend.toFixed(0)} · טווח ${plan.components.range.toFixed(0)} · RR ${actualRR.toFixed(2)} (סף ${p.minRR})` }
  ];

  if (confidence < p.minConfidence) {
    const ev = base('ARMED', 'CONFIDENCE_BELOW_MIN', factors, { confidence });
    (ev as { prev4hRange?: Prev4hRangePlan }).prev4hRange = plan;
    ev.decision = plan as unknown as SignalEvaluation['decision'];
    return ev;
  }

  const ev: SignalEvaluation = {
    symbol,
    action: isLong ? 'buy' : 'sell',
    tradeType: isLong ? 'SPOT' : 'FUTURES', // SHORT can only be simulated as 1x futures
    tradeSide: direction,
    confidence,
    price: currentPrice,
    priceChange24h,
    reasoning: `[SIGNAL] פריצת ${isLong ? 'הגבוה' : 'הנמוך'} של נר ה-4H הקודם (${isLong ? H : L}) בכיוון מגמת EMA20 · SL ${stopLoss.toFixed(6)} (אמצע הטווח) · TP ${takeProfit.toFixed(6)} · יציאה בסוף הנר`,
    status: `SIGNAL ${isLong ? 'SPOT LONG' : 'FUTURES SHORT'}`,
    willExecute: true,
    factors,
    confidenceGap: confidence - p.minConfidence,
    leverage: 1,
    stopLoss,
    takeProfit,
    takeProfit1: takeProfit
  };
  (ev as { prev4hRange?: Prev4hRangePlan }).prev4hRange = plan;
  ev.decision = plan as unknown as SignalEvaluation['decision'];
  return ev;
}

export function readPrev4hRangePlan(ev: SignalEvaluation | undefined): Prev4hRangePlan | undefined {
  if (!ev) return undefined;
  const tagged = (ev as { prev4hRange?: Prev4hRangePlan }).prev4hRange;
  if (tagged) return tagged;
  const viaDecision = ev.decision as unknown as Prev4hRangePlan | undefined;
  return viaDecision && typeof viaDecision === 'object' && 'direction' in viaDecision && 'windowStart' in viaDecision
    ? viaDecision
    : undefined;
}

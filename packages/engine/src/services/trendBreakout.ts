// TrendBreakout — an independent multi-timeframe trend-following breakout
// strategy. It is NOT a consensus of Intraday / Pro / Path and shares none of
// their signal logic; it only shares this project's market-data layer,
// indicator primitives, execution cost model and simulation plumbing.
//
// Simulation only. Nothing here sends a real order.
//
// Flow (see TRENDBREAKOUT_SPEC.md — the user's spec — §1-§13):
//   H1 defines the trend (Supertrend + EMA50/EMA200).
//   M15 defines the breakout (Donchian(20) + volume confirmation).
//   M5 times the entry (EMA9/EMA21 alignment + price still near the breakout).
// Every decision is taken on CLOSED candles only — the caller passes candle
// series that already exclude the forming bar, and nothing here reads a future
// bar, high, low, volume or indicator value.

import {
  Candle,
  calculateATR,
  calculateEMA,
  calculateSupertrend
} from './tradeEngine';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';

// ── Parameters (spec §23 — every knob configurable, no auto-optimisation) ────

export interface TrendBreakoutParams {
  /** H1 Supertrend. */
  supertrendAtrPeriod: number;
  supertrendMultiplier: number;
  /** Donchian channel period (M15 breakout, H1 context). */
  donchianPeriod: number;
  /** ATR period on every timeframe. */
  atrPeriod: number;
  /** M15 breakout volume must be >= volumeSMA20 * this. */
  volumeMultiplier: number;
  /** Confidence score (0-100) required to open. A SCORE, not a probability. */
  minConfidence: number;
  /** SL distance = ATR(M15) * this. */
  slAtrMultiplier: number;
  /** TP distance = R * this (R = |entry - SL|). */
  tpRMultiplier: number;
  /** Risk budget for the FULL position, as a fraction of equity. */
  riskPerTrade: number;
  /** Move stop to break-even once the trade is this many R in profit. */
  breakEvenR: number;
  /** Begin ATR trailing once the trade is this many R in profit. */
  trailingStartR: number;
  /** Trailing distance = ATR(M15) * this. */
  trailingAtrMultiplier: number;
  /** Time stop: close after this many H1 bars. */
  maxHoldHours: number;
  /** Scale-in lot fractions of the full position (spec §11). */
  scaleFractions: number[];
  /** SCALE_2 allowed only at >= this many R. */
  scale2MinR: number;
  /** SCALE_3 allowed only at >= this many R. */
  scale3MinR: number;
  /** EMA periods. */
  h1EmaFast: number;
  h1EmaSlow: number;
  m15EmaFast: number;
  m15EmaSlow: number;
  m5EmaFast: number;
  m5EmaSlow: number;
  /** Minimum closed candles per timeframe. */
  minH1: number;
  minM15: number;
  minM5: number;
  /** Confidence sub-score shaping (see computeConfidence). */
  emaTrendFullSpread: number;
  breakoutFullAtr: number;
  volumeFullMultiplier: number;
  m5MaxAtrDistance: number;
}

export const DEFAULT_TREND_BREAKOUT_PARAMS: TrendBreakoutParams = {
  supertrendAtrPeriod: 10,
  supertrendMultiplier: 3.0,
  donchianPeriod: 20,
  atrPeriod: 14,
  volumeMultiplier: 1.2,
  minConfidence: 70,
  slAtrMultiplier: 1.5,
  tpRMultiplier: 2.0,
  riskPerTrade: 0.005,
  breakEvenR: 1.0,
  trailingStartR: 1.5,
  trailingAtrMultiplier: 1.0,
  maxHoldHours: 24,
  scaleFractions: [0.5, 0.3, 0.2],
  scale2MinR: 0.5,
  scale3MinR: 1.0,
  h1EmaFast: 50,
  h1EmaSlow: 200,
  m15EmaFast: 20,
  m15EmaSlow: 50,
  m5EmaFast: 9,
  m5EmaSlow: 21,
  minH1: 200,
  minM15: 300,
  minM5: 30,
  emaTrendFullSpread: 0.02,
  breakoutFullAtr: 1.0,
  volumeFullMultiplier: 1.5,
  m5MaxAtrDistance: 1.0
};

// ── State machine (spec §6) ─────────────────────────────────────────────────

export type TrendBreakoutState =
  | 'NO_DATA'
  | 'NO_SIGNAL'
  | 'TREND_DETECTED'
  | 'SETUP'
  | 'ENTRY_CONFIRMATION'
  | 'SIGNAL';

/** Every no-trade path names itself (spec §22). */
export type TrendBreakoutReason =
  | 'OK'
  | 'NO_DATA'
  | 'H1_TREND_NEUTRAL'
  | 'BREAKOUT_NOT_CONFIRMED'
  | 'VOLUME_TOO_LOW'
  | 'M5_CONFIRMATION_FAILED'
  | 'ENTRY_TOO_EXTENDED'
  | 'CONFIDENCE_BELOW_MIN';

export type TrendDirection = 'LONG' | 'SHORT' | 'NEUTRAL';

/** The exact levels the execution layer trades on. Stashed on
 *  SignalEvaluation.decision (cast) the same way the Path bot stashes its
 *  bucket — no shared type change. */
export interface TrendBreakoutPlan {
  direction: 'LONG' | 'SHORT';
  state: TrendBreakoutState;
  reasonCode: TrendBreakoutReason;
  breakoutPrice: number;
  entryRef: number;
  atrH1: number;
  atrM15: number;
  atrM5: number;
  supertrendH1: 'BULL' | 'BEAR';
  supertrendValueH1: number;
  ema50H1: number;
  ema200H1: number;
  donchianHighM15: number;
  donchianLowM15: number;
  volumeRatioM15: number;
  ema9M5: number;
  ema21M5: number;
  stopLoss: number;
  takeProfit: number;
  /** R in price units: |entryRef - stopLoss|. */
  riskPerUnit: number;
  confidence: number;
  components: { supertrend: number; emaTrend: number; breakout: number; volume: number; m5: number };
}

// ── Small pure indicator helpers (no existing equivalent) ───────────────────

/** Highest high / lowest low over the last `period` candles. */
export function donchian(candles: Candle[], period: number): { upper: number; lower: number } {
  const slice = candles.slice(-period);
  let upper = -Infinity;
  let lower = Infinity;
  for (const c of slice) {
    if (c.high > upper) upper = c.high;
    if (c.low < lower) lower = c.low;
  }
  return { upper, lower };
}

/** Mean volume over the last `period` candles. */
export function volumeSMA(candles: Candle[], period: number): number {
  const slice = candles.slice(-period);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + (c.volume || 0), 0) / slice.length;
}

function emaLast(closes: number[], period: number): number {
  const series = calculateEMA(closes, period);
  return series.length ? series[series.length - 1] : (closes.length ? closes[closes.length - 1] : 0);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ── Evaluation ─────────────────────────────────────────────────────────────

export interface TrendBreakoutInput {
  symbol: string;
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
  currentPrice: number;
  priceChange24h?: number;
  params?: Partial<TrendBreakoutParams>;
}

/**
 * One symbol → one SignalEvaluation. `willExecute` is true only in the SIGNAL
 * state (every §3-§7 condition met and confidence >= minConfidence).
 */
export function evaluateTrendBreakout(input: TrendBreakoutInput): SignalEvaluation {
  const p: TrendBreakoutParams = { ...DEFAULT_TREND_BREAKOUT_PARAMS, ...(input.params ?? {}) };
  const { symbol, h1, m15, m5, currentPrice } = input;
  const priceChange24h = input.priceChange24h ?? 0;

  const base = (state: TrendBreakoutState, reason: TrendBreakoutReason, extra: Partial<SignalEvaluation> = {}, factors: DecisionFactor[] = []): SignalEvaluation => ({
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

  // ── §1 data sufficiency ──────────────────────────────────────────────────
  if (h1.length < p.minH1 || m15.length < p.minM15 || m5.length < p.minM5) {
    return base('NO_DATA', 'NO_DATA', {}, [{
      label: 'נתונים',
      value: `H1 ${h1.length}/${p.minH1} · M15 ${m15.length}/${p.minM15} · M5 ${m5.length}/${p.minM5}`,
      impact: 'neutral',
      note: 'אין מספיק נרות סגורים לחישוב'
    }]);
  }

  // ── §2 indicators (closed candles only) ─────────────────────────────────
  const h1Closes = h1.map((c) => c.close);
  const atrH1 = calculateATR(h1, p.atrPeriod).atr;
  const st = calculateSupertrend(h1, p.supertrendAtrPeriod, p.supertrendMultiplier);
  const ema50 = emaLast(h1Closes, p.h1EmaFast);
  const ema200 = emaLast(h1Closes, p.h1EmaSlow);
  const h1Close = h1Closes[h1Closes.length - 1];

  const m15Closes = m15.map((c) => c.close);
  const atrM15 = calculateATR(m15, p.atrPeriod).atr;
  // "previous" Donchian (spec §4) — exclude the breakout candle itself.
  const donch = donchian(m15.slice(0, -1), p.donchianPeriod);
  const volSma = volumeSMA(m15.slice(0, -1), p.donchianPeriod);
  const m15Last = m15[m15.length - 1];
  const volRatio = volSma > 0 ? (m15Last.volume || 0) / volSma : 0;
  const ema20M15 = emaLast(m15Closes, p.m15EmaFast);
  const ema50M15 = emaLast(m15Closes, p.m15EmaSlow);

  const m5Closes = m5.map((c) => c.close);
  const atrM5 = calculateATR(m5, p.atrPeriod).atr;
  const ema9 = emaLast(m5Closes, p.m5EmaFast);
  const ema21 = emaLast(m5Closes, p.m5EmaSlow);
  const m5Close = m5Closes[m5Closes.length - 1];

  const debugFactors: DecisionFactor[] = [
    { label: 'H1 Supertrend', value: `${st.direction} @ ${st.value}`, impact: 'neutral', note: `ATR(H1)=${atrH1.toFixed(6)}` },
    { label: 'H1 EMA', value: `EMA50=${ema50.toFixed(6)} EMA200=${ema200.toFixed(6)} close=${h1Close.toFixed(6)}`, impact: 'neutral', note: '' },
    { label: 'M15 Donchian', value: `high=${donch.upper.toFixed(6)} low=${donch.lower.toFixed(6)}`, impact: 'neutral', note: `M15 close=${m15Last.close.toFixed(6)}` },
    { label: 'M15 volume', value: `x${volRatio.toFixed(2)} (סף x${p.volumeMultiplier})`, impact: 'neutral', note: `SMA20=${volSma.toFixed(2)}` },
    { label: 'M15 EMA', value: `EMA20=${ema20M15.toFixed(6)} EMA50=${ema50M15.toFixed(6)}`, impact: 'neutral', note: 'הקשר בלבד' },
    { label: 'M5 EMA', value: `EMA9=${ema9.toFixed(6)} EMA21=${ema21.toFixed(6)} close=${m5Close.toFixed(6)}`, impact: 'neutral', note: `ATR(M5)=${atrM5.toFixed(6)}` }
  ];

  // ── §3 trend ───────────────────────────────────────────────────────────
  let direction: TrendDirection = 'NEUTRAL';
  if (st.direction === 'BULL' && ema50 > ema200 && h1Close > ema50) direction = 'LONG';
  else if (st.direction === 'BEAR' && ema50 < ema200 && h1Close < ema50) direction = 'SHORT';

  if (direction === 'NEUTRAL') {
    return base('NO_SIGNAL', 'H1_TREND_NEUTRAL', {}, debugFactors);
  }

  const isLong = direction === 'LONG';

  // ── §4 breakout ────────────────────────────────────────────────────────
  const brokeLevel = isLong ? donch.upper : donch.lower;
  const priceBroke = isLong ? m15Last.close > donch.upper : m15Last.close < donch.lower;
  const volumeOk = volRatio >= p.volumeMultiplier;

  if (!priceBroke) {
    return base('TREND_DETECTED', 'BREAKOUT_NOT_CONFIRMED', {}, debugFactors);
  }
  if (!volumeOk) {
    return base('TREND_DETECTED', 'VOLUME_TOO_LOW', {}, debugFactors);
  }

  const breakoutPrice = m15Last.close;

  // ── §5 M5 entry confirmation ───────────────────────────────────────────
  const m5Aligned = isLong
    ? ema9 > ema21 && m5Close > ema9
    : ema9 < ema21 && m5Close < ema9;
  if (!m5Aligned) {
    return base('SETUP', 'M5_CONFIRMATION_FAILED', {}, debugFactors);
  }
  const distanceFromBreakout = Math.abs(currentPrice - breakoutPrice);
  if (distanceFromBreakout > p.m5MaxAtrDistance * atrM5) {
    // Price already ran away — do not chase.
    return base('SETUP', 'ENTRY_TOO_EXTENDED', {}, debugFactors);
  }

  // ── §9/§10 levels ──────────────────────────────────────────────────────
  const entryRef = currentPrice;
  const rUnit = p.slAtrMultiplier * atrM15;
  const stopLoss = isLong ? entryRef - rUnit : entryRef + rUnit;
  const takeProfit = isLong ? entryRef + rUnit * p.tpRMultiplier : entryRef - rUnit * p.tpRMultiplier;

  // ── §7 confidence score (0-100, weights sum to 100) ────────────────────
  const c = computeConfidence(direction, {
    st, ema50, ema200, atrM15, breakoutPrice, brokeLevel,
    volRatio, distanceFromBreakout, atrM5, params: p
  });
  const confidence = Math.round(c.total);

  const plan: TrendBreakoutPlan = {
    direction,
    state: confidence >= p.minConfidence ? 'SIGNAL' : 'ENTRY_CONFIRMATION',
    reasonCode: confidence >= p.minConfidence ? 'OK' : 'CONFIDENCE_BELOW_MIN',
    breakoutPrice,
    entryRef,
    atrH1,
    atrM15,
    atrM5,
    supertrendH1: st.direction,
    supertrendValueH1: st.value,
    ema50H1: ema50,
    ema200H1: ema200,
    donchianHighM15: donch.upper,
    donchianLowM15: donch.lower,
    volumeRatioM15: volRatio,
    ema9M5: ema9,
    ema21M5: ema21,
    stopLoss,
    takeProfit,
    riskPerUnit: Math.abs(entryRef - stopLoss),
    confidence,
    components: c.components
  };

  const evalFactors: DecisionFactor[] = [
    ...debugFactors,
    {
      label: 'ציון ביטחון',
      value: `${confidence}/100 (סף ${p.minConfidence})`,
      impact: confidence >= p.minConfidence ? 'positive' : 'neutral',
      note: `ST ${c.components.supertrend.toFixed(0)} · EMA ${c.components.emaTrend.toFixed(0)} · פריצה ${c.components.breakout.toFixed(0)} · ווליום ${c.components.volume.toFixed(0)} · M5 ${c.components.m5.toFixed(0)}`
    }
  ];

  if (confidence < p.minConfidence) {
    const ev = base('ENTRY_CONFIRMATION', 'CONFIDENCE_BELOW_MIN', { confidence }, evalFactors);
    (ev as { trendBreakout?: TrendBreakoutPlan }).trendBreakout = plan;
    ev.decision = plan as unknown as SignalEvaluation['decision'];
    return ev;
  }

  const ev: SignalEvaluation = {
    symbol,
    action: isLong ? 'buy' : 'sell',
    // SHORT can only be simulated as a 1x FUTURES position (spot cannot short).
    tradeType: isLong ? 'SPOT' : 'FUTURES',
    tradeSide: direction,
    confidence,
    price: currentPrice,
    priceChange24h,
    reasoning: `[SIGNAL] TrendBreakout ${direction} · פריצת Donchian(${p.donchianPeriod}) ב-M15 עם אישור ווליום x${volRatio.toFixed(2)} ואישור M5 · SL ${stopLoss.toFixed(6)} TP ${takeProfit.toFixed(6)} (R=${plan.riskPerUnit.toFixed(6)})`,
    status: `SIGNAL ${isLong ? 'SPOT LONG' : 'FUTURES SHORT'}`,
    willExecute: true,
    factors: evalFactors,
    confidenceGap: confidence - p.minConfidence,
    leverage: isLong ? 1 : 1,
    stopLoss,
    takeProfit,
    takeProfit1: takeProfit,
    regime: undefined
  };
  (ev as { trendBreakout?: TrendBreakoutPlan }).trendBreakout = plan;
  ev.decision = plan as unknown as SignalEvaluation['decision'];
  return ev;
}

/** Reads the plan the strategy stashed on an evaluation, if present. */
export function readTrendBreakoutPlan(ev: SignalEvaluation | undefined): TrendBreakoutPlan | undefined {
  if (!ev) return undefined;
  const tagged = (ev as { trendBreakout?: TrendBreakoutPlan }).trendBreakout;
  if (tagged) return tagged;
  const viaDecision = ev.decision as unknown as TrendBreakoutPlan | undefined;
  return viaDecision && typeof viaDecision === 'object' && 'direction' in viaDecision && 'riskPerUnit' in viaDecision
    ? viaDecision
    : undefined;
}

interface ConfidenceInput {
  st: { value: number; direction: 'BULL' | 'BEAR' };
  ema50: number;
  ema200: number;
  atrM15: number;
  breakoutPrice: number;
  brokeLevel: number;
  volRatio: number;
  distanceFromBreakout: number;
  atrM5: number;
  params: TrendBreakoutParams;
}

export function computeConfidence(direction: 'LONG' | 'SHORT', i: ConfidenceInput): {
  total: number;
  components: { supertrend: number; emaTrend: number; breakout: number; volume: number; m5: number };
} {
  const isLong = direction === 'LONG';
  const p = i.params;

  // H1 Supertrend (25): aligned or not.
  const stAligned = isLong ? i.st.direction === 'BULL' : i.st.direction === 'BEAR';
  const supertrend = (stAligned ? 1 : 0) * 25;

  // H1 EMA trend (20): aligned, scaled by the EMA50/EMA200 spread.
  const emaAligned = isLong ? i.ema50 > i.ema200 : i.ema50 < i.ema200;
  const spread = i.ema200 > 0 ? Math.abs(i.ema50 - i.ema200) / i.ema200 : 0;
  const emaTrend = (emaAligned ? 1 : 0) * clamp01(spread / p.emaTrendFullSpread) * 20;

  // M15 Donchian breakout (25): scaled by how far past the channel it closed.
  const breakoutDist = Math.abs(i.breakoutPrice - i.brokeLevel);
  const breakout = clamp01(breakoutDist / (p.breakoutFullAtr * (i.atrM15 || 1))) * 25;

  // Volume confirmation (15): scaled toward volumeFullMultiplier * threshold.
  const volume = clamp01(i.volRatio / (p.volumeMultiplier * p.volumeFullMultiplier)) * 15;

  // M5 entry confirmation (15): closer to the breakout price = higher.
  const m5 = clamp01(1 - i.distanceFromBreakout / (p.m5MaxAtrDistance * (i.atrM5 || 1))) * 15;

  return {
    total: supertrend + emaTrend + breakout + volume + m5,
    components: { supertrend, emaTrend, breakout, volume, m5 }
  };
}

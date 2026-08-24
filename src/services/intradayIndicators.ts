/**
 * IntradayIndicators — Pure indicator math for the Multi-Timeframe engine
 * ============================================================================
 * Everything here is a PURE function of the candle array it receives.
 * Callers pass only CLOSED candles up to the decision timestamp, which is what
 * makes the backtest look-ahead free (§42): an indicator cannot see a candle
 * that was not handed to it.
 *
 * EMA / ATR / ADX / Supertrend are re-used from tradeEngine.ts so simulation,
 * live trading and backtest share one implementation (§53, §59).
 */

import { Candle, calculateEMA, calculateATR, calculateADX, calculateSupertrend } from './tradeEngine';

export type { Candle };
export { calculateEMA, calculateATR, calculateADX, calculateSupertrend };

// ═══════════════════════════════════════════════════════════════════════════
// GENERIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════

export function last<T>(arr: T[], offset = 0): T | undefined {
  return arr.length > offset ? arr[arr.length - 1 - offset] : undefined;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Maps any value to a 0..100 score with a linear ramp between lo and hi */
export function ramp(value: number, lo: number, hi: number): number {
  if (hi === lo) return value >= hi ? 100 : 0;
  return clamp(((value - lo) / (hi - lo)) * 100, 0, 100);
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

/** Percentile rank (0..100) of `value` inside `values` */
export function percentileRank(values: number[], value: number): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return 50;
  const below = finite.filter((v) => v < value).length;
  const equal = finite.filter((v) => v === value).length;
  return clamp(((below + equal / 2) / finite.length) * 100, 0, 100);
}

export function simpleMovingAverage(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : sum / (i + 1));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// RSI / MACD / BOLLINGER / STOCHASTIC
// ═══════════════════════════════════════════════════════════════════════════

/** Wilder RSI series aligned to `closes` (first `period` entries are seeded) */
export function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(50);
  if (closes.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function rsi(closes: number[], period = 14): number {
  const series = rsiSeries(closes, period);
  return series[series.length - 1] ?? 50;
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
  prevHistogram: number;
  histogramSlope: number;
  crossUp: boolean;
  crossDown: boolean;
  direction: 'BULL' | 'BEAR' | 'FLAT';
  macdSeries: number[];
  signalSeries: number[];
  histSeries: number[];
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macdSeries = emaFast.map((v, i) => v - (emaSlow[i] ?? v));
  const signalSeries = calculateEMA(macdSeries, signalPeriod);
  const histSeries = macdSeries.map((v, i) => v - (signalSeries[i] ?? v));

  const m = last(macdSeries) ?? 0;
  const s = last(signalSeries) ?? 0;
  const h = last(histSeries) ?? 0;
  const hPrev = last(histSeries, 1) ?? h;
  const mPrev = last(macdSeries, 1) ?? m;
  const sPrev = last(signalSeries, 1) ?? s;

  return {
    macd: m,
    signal: s,
    histogram: h,
    prevHistogram: hPrev,
    histogramSlope: h - hPrev,
    crossUp: mPrev <= sPrev && m > s,
    crossDown: mPrev >= sPrev && m < s,
    direction: m > s ? 'BULL' : m < s ? 'BEAR' : 'FLAT',
    macdSeries,
    signalSeries,
    histSeries
  };
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  /** (upper-lower)/middle */
  bandwidth: number;
  /** 0 = at lower band, 1 = at upper band */
  percentB: number;
  bandwidthSeries: number[];
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerResult {
  const bandwidthSeries: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const windowStart = Math.max(0, i - period + 1);
    const win = closes.slice(windowStart, i + 1);
    const m = mean(win);
    const sd = stdDev(win);
    bandwidthSeries.push(m > 0 ? (2 * mult * sd) / m : 0);
  }

  const win = closes.slice(-period);
  const middle = mean(win);
  const sd = stdDev(win);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  const price = last(closes) ?? middle;
  const width = upper - lower;

  return {
    upper,
    middle,
    lower,
    bandwidth: middle > 0 ? width / middle : 0,
    percentB: width > 0 ? (price - lower) / width : 0.5,
    bandwidthSeries
  };
}

export interface StochasticResult {
  k: number;
  d: number;
  prevK: number;
  prevD: number;
  crossUp: boolean;
  crossDown: boolean;
  rising: boolean;
}

export function stochastic(candles: Candle[], kPeriod = 14, kSmooth = 3, dPeriod = 3): StochasticResult {
  if (candles.length < kPeriod + kSmooth + dPeriod) {
    return { k: 50, d: 50, prevK: 50, prevD: 50, crossUp: false, crossDown: false, rising: false };
  }
  const rawK: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const win = candles.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...win.map((c) => c.high));
    const ll = Math.min(...win.map((c) => c.low));
    const range = hh - ll;
    rawK.push(range > 0 ? ((candles[i].close - ll) / range) * 100 : 50);
  }
  const kSeries = simpleMovingAverage(rawK, kSmooth);
  const dSeries = simpleMovingAverage(kSeries, dPeriod);

  const k = last(kSeries) ?? 50;
  const d = last(dSeries) ?? 50;
  const prevK = last(kSeries, 1) ?? k;
  const prevD = last(dSeries, 1) ?? d;

  return {
    k,
    d,
    prevK,
    prevD,
    crossUp: prevK <= prevD && k > d,
    crossDown: prevK >= prevD && k < d,
    rising: k > prevK
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ATR REGIME (relative to the asset itself — §9)
// ═══════════════════════════════════════════════════════════════════════════

export type VolatilityBucket = 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';

export interface AtrRegimeResult {
  atr: number;
  atrPercent: number;
  /** Percentile of the CURRENT ATR% inside this asset's own recent ATR% history */
  atrPercentile: number;
  bucket: VolatilityBucket;
  sampleSize: number;
}

/**
 * Rolling ATR% history → percentile of the current reading.
 * A 5% ATR means something completely different for BTC vs an altcoin, so the
 * engine grades volatility against the asset's own distribution.
 */
export function atrRegime(
  candles: Candle[],
  period = 14,
  lookback = 200,
  thresholds: { low: number; high: number; extreme: number } = { low: 30, high: 80, extreme: 95 }
): AtrRegimeResult {
  const { atr, atrPercent } = calculateATR(candles, period);

  // Build the ATR% history with a rolling window (each point uses only past data)
  const history: number[] = [];
  const start = Math.max(period + 1, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - (period * 4)), i + 1);
    if (slice.length < period + 1) continue;
    const r = calculateATR(slice, period);
    if (Number.isFinite(r.atrPercent) && r.atrPercent > 0) history.push(r.atrPercent);
  }

  const pct = history.length >= 20 ? percentileRank(history, atrPercent) : 50;
  const bucket: VolatilityBucket =
    pct >= thresholds.extreme ? 'EXTREME' : pct > thresholds.high ? 'HIGH' : pct < thresholds.low ? 'LOW' : 'NORMAL';

  return {
    atr,
    atrPercent: Number(atrPercent.toFixed(4)),
    atrPercentile: Number(pct.toFixed(1)),
    bucket,
    sampleSize: history.length
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION VWAP (§14 — mandatory for intraday)
// ═══════════════════════════════════════════════════════════════════════════

export interface VwapResult {
  vwap: number;
  /** (price - vwap) / vwap * 100 */
  deviationPercent: number;
  /** (price - vwap) / atr — normalized distance */
  deviationAtr: number;
  above: boolean;
  /** Number of candles included in the current session */
  sessionCandles: number;
  /** Rising / falling VWAP slope over the session tail */
  slope: number;
}

/**
 * Session VWAP anchored to the UTC trading day (00:00 UTC).
 * Crypto has no exchange session, so the UTC day is the industry convention.
 */
export function sessionVwap(candles: Candle[], referenceAtr = 0, sessionMs = 24 * 60 * 60 * 1000): VwapResult {
  if (!candles.length) {
    return { vwap: 0, deviationPercent: 0, deviationAtr: 0, above: false, sessionCandles: 0, slope: 0 };
  }
  const lastCandle = candles[candles.length - 1];
  const sessionStart = Math.floor(lastCandle.timestamp / sessionMs) * sessionMs;

  let pv = 0;
  let vol = 0;
  let count = 0;
  const series: number[] = [];
  for (const c of candles) {
    if (c.timestamp < sessionStart) continue;
    const typical = (c.high + c.low + c.close) / 3;
    const v = c.volume > 0 ? c.volume : 1e-9;
    pv += typical * v;
    vol += v;
    count++;
    series.push(pv / vol);
  }

  // Session just opened (fewer than 3 candles) → fall back to a rolling VWAP so
  // the engine is never blind right after 00:00 UTC.
  if (count < 3) {
    pv = 0;
    vol = 0;
    count = 0;
    series.length = 0;
    for (const c of candles.slice(-48)) {
      const typical = (c.high + c.low + c.close) / 3;
      const v = c.volume > 0 ? c.volume : 1e-9;
      pv += typical * v;
      vol += v;
      count++;
      series.push(pv / vol);
    }
  }

  const vwap = vol > 0 ? pv / vol : lastCandle.close;
  const price = lastCandle.close;
  const deviationPercent = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
  const prev = series.length > 5 ? series[series.length - 6] : vwap;

  return {
    vwap,
    deviationPercent: Number(deviationPercent.toFixed(4)),
    deviationAtr: referenceAtr > 0 ? (price - vwap) / referenceAtr : 0,
    above: price >= vwap,
    sessionCandles: count,
    slope: vwap - prev
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// VOLUME / PARTICIPATION
// ═══════════════════════════════════════════════════════════════════════════

export interface VolumeStats {
  latest: number;
  average: number;
  /** latest / average */
  relative: number;
  zScore: number;
  /** Mean of the last 3 candles vs the baseline average */
  shortTermRelative: number;
  expanding: boolean;
  drying: boolean;
}

export function volumeStats(candles: Candle[], lookback = 20): VolumeStats {
  const volumes = candles.map((c) => c.volume);
  const baseline = volumes.slice(-(lookback + 1), -1);
  const avg = baseline.length ? mean(baseline) : volumes[volumes.length - 1] || 1;
  const sd = stdDev(baseline);
  const latest = volumes[volumes.length - 1] || 0;
  const recent3 = mean(volumes.slice(-3));

  return {
    latest,
    average: avg,
    relative: avg > 0 ? latest / avg : 1,
    zScore: sd > 0 ? (latest - avg) / sd : 0,
    shortTermRelative: avg > 0 ? recent3 / avg : 1,
    expanding: avg > 0 && latest >= avg * 1.3,
    drying: avg > 0 && latest < avg * 0.6
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET STRUCTURE (§15)
// ═══════════════════════════════════════════════════════════════════════════

export interface Swing {
  index: number;
  timestamp: number;
  price: number;
}

export type StructureBias = 'BULLISH' | 'BEARISH' | 'RANGE';

export interface MarketStructureResult {
  bias: StructureBias;
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
  /** Break of structure direction confirmed by a candle CLOSE beyond the swing */
  breakOfStructure: 'UP' | 'DOWN' | null;
  swingHighs: Swing[];
  swingLows: Swing[];
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  recentHigh: number;
  recentLow: number;
  /** Position of price inside the recent range (0 = low, 1 = high) */
  rangePosition: number;
}

/** Fractal pivot detection with a symmetric window */
export function findSwings(candles: Candle[], window = 2): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = window; i < candles.length - window; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, timestamp: c.timestamp, price: c.high });
    if (isLow) lows.push({ index: i, timestamp: c.timestamp, price: c.low });
  }
  return { highs, lows };
}

export function marketStructure(candles: Candle[], window = 2, lookback = 60): MarketStructureResult {
  const slice = candles.slice(-lookback);
  const { highs, lows } = findSwings(slice, window);

  const h1 = last(highs);
  const h2 = last(highs, 1);
  const l1 = last(lows);
  const l2 = last(lows, 1);

  const higherHigh = !!(h1 && h2 && h1.price > h2.price);
  const lowerHigh = !!(h1 && h2 && h1.price < h2.price);
  const higherLow = !!(l1 && l2 && l1.price > l2.price);
  const lowerLow = !!(l1 && l2 && l1.price < l2.price);

  let bias: StructureBias = 'RANGE';
  if (higherHigh && higherLow) bias = 'BULLISH';
  else if (lowerHigh && lowerLow) bias = 'BEARISH';
  else if (higherLow && !lowerLow && h1 && l1 && l1.index > h1.index) bias = 'BULLISH';
  else if (lowerHigh && !higherHigh && h1 && l1 && h1.index > l1.index) bias = 'BEARISH';

  // Break of structure: the most recent CLOSED candle closed beyond the last swing
  const lastClose = last(slice)?.close ?? 0;
  let breakOfStructure: 'UP' | 'DOWN' | null = null;
  if (h1 && lastClose > h1.price) breakOfStructure = 'UP';
  else if (l1 && lastClose < l1.price) breakOfStructure = 'DOWN';

  const recentHigh = slice.length ? Math.max(...slice.map((c) => c.high)) : 0;
  const recentLow = slice.length ? Math.min(...slice.map((c) => c.low)) : 0;
  const range = recentHigh - recentLow;

  return {
    bias,
    higherHigh,
    higherLow,
    lowerHigh,
    lowerLow,
    breakOfStructure,
    swingHighs: highs,
    swingLows: lows,
    lastSwingHigh: h1 ? h1.price : null,
    lastSwingLow: l1 ? l1.price : null,
    recentHigh,
    recentLow,
    rangePosition: range > 0 ? (lastClose - recentLow) / range : 0.5
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPRESSION / CONSOLIDATION (Breakout Retest pre-condition — §18)
// ═══════════════════════════════════════════════════════════════════════════

export interface CompressionResult {
  isCompressed: boolean;
  bandwidthPercentile: number;
  /** High-low range of the consolidation window, in ATR units */
  rangeAtr: number;
  boxHigh: number;
  boxLow: number;
  windowSize: number;
}

export function compression(candles: Candle[], window = 12, atr = 0, lookback = 120): CompressionResult {
  const closes = candles.map((c) => c.close);
  const bb = bollinger(closes, 20, 2);
  const history = bb.bandwidthSeries.slice(-lookback);
  const bandwidthPercentile = history.length >= 20 ? percentileRank(history, bb.bandwidth) : 50;

  const win = candles.slice(-window);
  const boxHigh = win.length ? Math.max(...win.map((c) => c.high)) : 0;
  const boxLow = win.length ? Math.min(...win.map((c) => c.low)) : 0;
  const rangeAtr = atr > 0 ? (boxHigh - boxLow) / atr : 0;

  return {
    isCompressed: bandwidthPercentile <= 40 || (rangeAtr > 0 && rangeAtr <= 2.2),
    bandwidthPercentile: Number(bandwidthPercentile.toFixed(1)),
    rangeAtr: Number(rangeAtr.toFixed(2)),
    boxHigh,
    boxLow,
    windowSize: win.length
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CANDLE QUALITY (5M entry confirmation — §22/§23)
// ═══════════════════════════════════════════════════════════════════════════

export interface CandleQuality {
  bullish: boolean;
  bearish: boolean;
  /** |close-open| / (high-low) */
  bodyRatio: number;
  /** 0 = closed at the low, 1 = closed at the high */
  closePosition: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  /** Rejection from below (long lower wick + close in the upper half) */
  bullishRejection: boolean;
  /** Rejection from above */
  bearishRejection: boolean;
  engulfsPrevious: boolean;
  rangePercent: number;
}

export function candleQuality(candles: Candle[]): CandleQuality {
  const c = last(candles);
  const prev = last(candles, 1);
  if (!c) {
    return {
      bullish: false,
      bearish: false,
      bodyRatio: 0,
      closePosition: 0.5,
      upperWickRatio: 0,
      lowerWickRatio: 0,
      bullishRejection: false,
      bearishRejection: false,
      engulfsPrevious: false,
      rangePercent: 0
    };
  }
  const range = Math.max(1e-12, c.high - c.low);
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const closePosition = (c.close - c.low) / range;

  return {
    bullish: c.close > c.open,
    bearish: c.close < c.open,
    bodyRatio: body / range,
    closePosition,
    upperWickRatio: upperWick / range,
    lowerWickRatio: lowerWick / range,
    bullishRejection: lowerWick / range >= 0.35 && closePosition >= 0.5,
    bearishRejection: upperWick / range >= 0.35 && closePosition <= 0.5,
    engulfsPrevious: !!prev && ((c.close > prev.high && c.open <= prev.close) || (c.close < prev.low && c.open >= prev.close)),
    rangePercent: c.close > 0 ? (range / c.close) * 100 : 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC RNG (reproducible simulation/backtest fills — §39)
// ═══════════════════════════════════════════════════════════════════════════

/** mulberry32 — small, fast, deterministic PRNG */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (used to seed per-order randomness) */
export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

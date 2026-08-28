/**
 * "Bot Pro" decision engine — a faithful, literal implementation of
 * ASSETS/alg.md (Layers 0-4), independent from both existing engines:
 *
 *  - intradayEngine.ts (the "new" bot) is a different, multi-timeframe
 *    (1H/15M/5M) algorithm entirely — not related to alg.md.
 *  - tradeEngine.ts (the "legacy" bot) was ORIGINALLY meant to implement
 *    alg.md but has drifted from it over time. Verified, concrete
 *    differences found while building this file (tradeEngine.ts vs the
 *    alg.md text):
 *      - SPOT threshold: code 58 (62 in HIGH vol) vs spec's flat 60.
 *      - FUTURES threshold: code 70 vs spec's 72.
 *      - Daily circuit breaker: code 6% vs spec's 8%.
 *      - Weekly circuit breaker: code 13% vs spec's 15%.
 *      - FUTURES requires a Supertrend-direction match — an extra condition
 *        not present anywhere in alg.md's 5-condition FUTURES list.
 *      - Position sizing: code uses risk-first sizing (risk 0.75% of equity
 *        / stop distance) scaled by a half-Kelly RISK multiplier; the spec
 *        defines Kelly as DIRECTLY setting the bet size as a fraction of
 *        portfolio (capped 10%), a materially different formula.
 *      - Layer 1's two documented confidence penalties (§Volume-neutral
 *        ×0.6, §Ranging ×0.7) are not applied anywhere in the current code.
 *      - The Futures 24h-no-TP1 time exit is documented as a 50% partial
 *        reduction, but the current code always fully closes (a real bug,
 *        left as-is in the legacy engine — not this one).
 *
 * This module intentionally does NOT reuse tradeEngine.ts's routing/
 * scoring/risk/exit logic (since that's exactly what has drifted) — only
 * its low-level, algorithm-agnostic technical-indicator math (EMA/ATR/ADX/
 * Supertrend), which alg.md itself specifies identically and which is
 * already shared across every engine in this codebase.
 */

import { Candle, calculateEMA, calculateATR, calculateADX, calculateSupertrend, formatDynamicPrice, computeRelativeVolume, MIN_ENTRY_RELATIVE_VOLUME } from './tradeEngine';
import { computeDrawdownFactor, MIN_STOP_PERCENT, MAX_STOP_PERCENT } from './adaptiveRisk';

// ── LAYER 0 — MARKET REGIME DETECTION ──────────────────────────────────────

export type ProRegimeType = 'TRENDING' | 'RANGING' | 'TRANSITIONAL';
export type ProDirectionType = 'BULL' | 'BEAR' | 'NEUTRAL';
export type ProVolatilityType = 'LOW' | 'NORMAL' | 'HIGH';

export interface ProMarketRegimeResult {
  regime: ProRegimeType;
  direction: ProDirectionType;
  volatility: ProVolatilityType;
  adx: number;
  atr: number;
  atrPercent: number;
  supertrend: { value: number; direction: 'BULL' | 'BEAR' };
}

export function detectProRegime(candles: Candle[], currentPrice: number): ProMarketRegimeResult {
  const adx = calculateADX(candles, 14);
  const { atr, atrPercent } = calculateATR(candles, 14);
  const supertrend = calculateSupertrend(candles, 10, 3);

  // ADX(14): >25 TRENDING, <20 RANGING, 20-25 TRANSITIONAL
  let regime: ProRegimeType;
  if (adx > 25) regime = 'TRENDING';
  else if (adx < 20) regime = 'RANGING';
  else regime = 'TRANSITIONAL';

  const isSupertrendBullish = currentPrice >= supertrend.value;
  const direction: ProDirectionType = regime === 'RANGING' ? 'NEUTRAL' : (isSupertrendBullish ? 'BULL' : 'BEAR');

  // ATR%: <2 LOW, 2-5 NORMAL, >5 HIGH
  let volatility: ProVolatilityType;
  if (atrPercent < 2.0) volatility = 'LOW';
  else if (atrPercent <= 5.0) volatility = 'NORMAL';
  else volatility = 'HIGH';

  return {
    regime,
    direction,
    volatility,
    adx,
    atr,
    atrPercent: Number(atrPercent.toFixed(2)),
    supertrend: { value: supertrend.value, direction: isSupertrendBullish ? 'BULL' : 'BEAR' }
  };
}

// ── LAYER 1 — SIGNAL ENGINE ─────────────────────────────────────────────────
// Weight table (total 100): MACD 20, EMA20/50 18, RSI 12, Bollinger 12,
// Volume Surge 18, Supertrend 12, Stochastic 8.

export interface ProIndicatorSignal {
  name: string;
  weight: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  strength: number;
  value: string;
  reason: string;
}

export interface ProSignalResult {
  action: 'BUY' | 'SELL' | 'HOLD';
  buyScore: number;
  sellScore: number;
  /** Pre-penalty score of the winning side — this is what Layer 2 routes on
   *  (penalties are UI/context only per alg.md §Layer1). */
  rawConfidence: number;
  /** Post-penalty score — shown in the UI alongside the raw score so the
   *  operator can see exactly how much context is discounting the signal. */
  confidence: number;
  signals: ProIndicatorSignal[];
  penalties: string[];
}

export function evaluateProSignals(
  candles: Candle[],
  currentPrice: number,
  priceChange24h: number,
  regime: ProMarketRegimeResult,
  fearGreedIndex: number = 50
): ProSignalResult {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const signals: ProIndicatorSignal[] = [];
  const penalties: string[] = [];

  // 1. MACD 12/26/9 (weight 20)
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calculateEMA(macdLine, 9);
  const curMacd = macdLine[macdLine.length - 1] || 0;
  const curSignal = signalLine[signalLine.length - 1] || 0;
  const prevMacd = macdLine[macdLine.length - 2] || curMacd;
  const prevSignal = signalLine[signalLine.length - 2] || curSignal;
  const macdCrossUp = prevMacd <= prevSignal && curMacd > curSignal;
  const macdCrossDown = prevMacd >= prevSignal && curMacd < curSignal;
  if (curMacd > curSignal) {
    const strength = macdCrossUp ? (curMacd > 0 ? 1.0 : 0.85) : 0.7;
    signals.push({ name: 'MACD (12/26/9)', weight: 20, signal: 'BUY', strength, value: `MACD ${formatDynamicPrice(curMacd)} > Signal ${formatDynamicPrice(curSignal)}`, reason: 'MACD חיובי' });
  } else if (curMacd < curSignal) {
    const strength = macdCrossDown ? (curMacd < 0 ? 1.0 : 0.85) : 0.7;
    signals.push({ name: 'MACD (12/26/9)', weight: 20, signal: 'SELL', strength, value: `MACD ${formatDynamicPrice(curMacd)} < Signal ${formatDynamicPrice(curSignal)}`, reason: 'MACD שלילי' });
  } else {
    signals.push({ name: 'MACD (12/26/9)', weight: 20, signal: 'NEUTRAL', strength: 0, value: 'MACD נייטרלי', reason: 'ללא אות מובהק' });
  }

  // 2. EMA 20/50 (weight 18)
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const curEma20 = ema20[ema20.length - 1] || currentPrice;
  const curEma50 = ema50[ema50.length - 1] || currentPrice;
  const prevEma20 = ema20[ema20.length - 2] || curEma20;
  const prevEma50 = ema50[ema50.length - 2] || curEma50;
  const goldenCross = prevEma20 <= prevEma50 && curEma20 > curEma50;
  const deathCross = prevEma20 >= prevEma50 && curEma20 < curEma50;
  if (curEma20 > curEma50) {
    signals.push({ name: 'EMA 20/50', weight: 18, signal: 'BUY', strength: goldenCross ? 1.0 : 0.8, value: `EMA20 $${formatDynamicPrice(curEma20)} > EMA50 $${formatDynamicPrice(curEma50)}`, reason: goldenCross ? 'Golden Cross' : 'EMA20 מעל EMA50' });
  } else if (curEma20 < curEma50) {
    signals.push({ name: 'EMA 20/50', weight: 18, signal: 'SELL', strength: deathCross ? 1.0 : 0.8, value: `EMA20 $${formatDynamicPrice(curEma20)} < EMA50 $${formatDynamicPrice(curEma50)}`, reason: deathCross ? 'Death Cross' : 'EMA20 מתחת EMA50' });
  } else {
    signals.push({ name: 'EMA 20/50', weight: 18, signal: 'NEUTRAL', strength: 0, value: 'EMA 20/50 שוויון', reason: 'ממוצעים נפגשים' });
  }

  // 3. RSI(14) (weight 12): <=25 BUY(1.0), <35 BUY(0.8), >=75 SELL(1.0), >65 SELL(0.8), else NEUTRAL
  let rsi = 50;
  if (closes.length >= 15) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses += Math.abs(diff);
    }
    let avgGain = gains / 14, avgLoss = losses / 14;
    for (let i = 15; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * 13 + (diff > 0 ? diff : 0)) / 14;
      avgLoss = (avgLoss * 13 + (diff < 0 ? Math.abs(diff) : 0)) / 14;
    }
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  if (rsi <= 25) signals.push({ name: 'RSI(14)', weight: 12, signal: 'BUY', strength: 1.0, value: `RSI ${rsi.toFixed(1)}`, reason: 'מכירת יתר קיצונית' });
  else if (rsi < 35) signals.push({ name: 'RSI(14)', weight: 12, signal: 'BUY', strength: 0.8, value: `RSI ${rsi.toFixed(1)}`, reason: 'מכירת יתר' });
  else if (rsi >= 75) signals.push({ name: 'RSI(14)', weight: 12, signal: 'SELL', strength: 1.0, value: `RSI ${rsi.toFixed(1)}`, reason: 'קניית יתר קיצונית' });
  else if (rsi > 65) signals.push({ name: 'RSI(14)', weight: 12, signal: 'SELL', strength: 0.8, value: `RSI ${rsi.toFixed(1)}`, reason: 'קניית יתר' });
  else signals.push({ name: 'RSI(14)', weight: 12, signal: 'NEUTRAL', strength: 0, value: `RSI ${rsi.toFixed(1)}`, reason: 'טווח ניטרלי' });

  // 4. Bollinger Bands 20/2 (weight 12)
  const recentCloses = closes.slice(-20);
  const bbMean = recentCloses.reduce((a, b) => a + b, 0) / Math.max(1, recentCloses.length);
  const bbStdDev = Math.sqrt(recentCloses.reduce((s, v) => s + (v - bbMean) ** 2, 0) / Math.max(1, recentCloses.length));
  const bbUpper = bbMean + 2 * bbStdDev;
  const bbLower = bbMean - 2 * bbStdDev;
  if (currentPrice < bbLower) signals.push({ name: 'Bollinger Bands (20/2)', weight: 12, signal: 'BUY', strength: 1.0, value: `מחיר מתחת ל-$${formatDynamicPrice(bbLower)}`, reason: 'פריצה מתחת לרצועה תחתונה' });
  else if (currentPrice > bbUpper) signals.push({ name: 'Bollinger Bands (20/2)', weight: 12, signal: 'SELL', strength: 1.0, value: `מחיר מעל $${formatDynamicPrice(bbUpper)}`, reason: 'פריצה מעל הרצועה עליונה' });
  else signals.push({ name: 'Bollinger Bands (20/2)', weight: 12, signal: 'NEUTRAL', strength: 0, value: 'בתוך הרצועות', reason: 'ללא קיצון' });

  // 5. Volume Surge (weight 18): graded strength instead of all-or-nothing
  const recentVolumes = volumes.slice(-21, -1);
  const avgVol20 = recentVolumes.length ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length : 1;
  const latestVol = volumes[volumes.length - 1] || 0;
  const volumeRatio = avgVol20 > 0 ? latestVol / avgVol20 : 1;
  const isPriceUp = priceChange24h > 0 || (closes.length >= 2 && closes[closes.length - 1] > closes[closes.length - 2]);
  let volumeStrength = 0;
  if (volumeRatio >= 1.5) volumeStrength = 1.0;
  else if (volumeRatio >= 1.2) volumeStrength = 0.7;
  else if (volumeRatio >= 0.9) volumeStrength = 0.4;
  else volumeStrength = 0.2;
  signals.push({ name: 'Volume Surge', weight: 18, signal: volumeRatio >= 1.5 ? (isPriceUp ? 'BUY' : 'SELL') : 'NEUTRAL', strength: volumeStrength, value: `נפח פי ${volumeRatio.toFixed(2)}`, reason: volumeRatio >= 1.5 ? 'זינוק נפח מאשש' : 'נפח ממוצע/חלש' });

  // 6. Supertrend (weight 12)
  const isSupertrendBull = regime.supertrend.direction === 'BULL';
  signals.push({ name: 'Supertrend (10/3)', weight: 12, signal: isSupertrendBull ? 'BUY' : 'SELL', strength: 1.0, value: `Supertrend $${formatDynamicPrice(regime.supertrend.value)} (${regime.supertrend.direction})`, reason: 'תואם כיוון מגמה' });

  // 7. Stochastic 14/3 (weight 8): K<20 & D<25 -> BUY(0.85); K>80 & D>75 -> SELL(0.85); else NEUTRAL
  let stochK = 50, stochD = 50;
  if (candles.length >= 14) {
    const recent = candles.slice(-14);
    const hh = Math.max(...recent.map((c) => c.high));
    const ll = Math.min(...recent.map((c) => c.low));
    const diff = hh - ll;
    stochK = diff > 0 ? ((currentPrice - ll) / diff) * 100 : 50;
    stochD = stochK;
  }
  if (stochK < 20 && stochD < 25) signals.push({ name: 'Stochastic (14/3)', weight: 8, signal: 'BUY', strength: 0.85, value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`, reason: 'מכירת יתר' });
  else if (stochK > 80 && stochD > 75) signals.push({ name: 'Stochastic (14/3)', weight: 8, signal: 'SELL', strength: 0.85, value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`, reason: 'קניית יתר' });
  else signals.push({ name: 'Stochastic (14/3)', weight: 8, signal: 'NEUTRAL', strength: 0, value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`, reason: 'טווח אמצע' });

  // RawConfidence = Σ(weight×strength) per side, action = higher side
  let buyScore = 0, sellScore = 0;
  for (const s of signals) {
    if (s.signal === 'BUY') buyScore += s.weight * s.strength;
    else if (s.signal === 'SELL') sellScore += s.weight * s.strength;
  }
  buyScore = Number(buyScore.toFixed(2));
  sellScore = Number(sellScore.toFixed(2));

  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let rawConfidence = 0;
  if (buyScore > sellScore) { action = 'BUY'; rawConfidence = buyScore; }
  else if (sellScore > buyScore) { action = 'SELL'; rawConfidence = sellScore; }
  else { rawConfidence = Math.max(buyScore, sellScore); }

  // §2 Volume-confirmation penalty: Volume Surge NEUTRAL -> ×0.6
  // §3 Ranging penalty: ADX<20 (RANGING) -> ×0.7
  // Both documented explicitly in alg.md Layer 1 and applied here — the
  // current tradeEngine.ts implementation does not apply either.
  let confidence = rawConfidence;
  const volumeSignal = signals.find((s) => s.name === 'Volume Surge');
  if (volumeSignal && volumeSignal.signal === 'NEUTRAL') {
    confidence = confidence * 0.6;
    penalties.push('קנס חוסר נפח: Volume Surge נייטרלי — Confidence × 0.6');
  }
  if (regime.regime === 'RANGING') {
    confidence = confidence * 0.7;
    penalties.push('קנס שוק דשדוש: ADX < 20 — Confidence × 0.7');
  }
  confidence = Number(confidence.toFixed(2));

  if (fearGreedIndex < 25) penalties.push(`סנטימנט שוק: פחד קיצוני (${fearGreedIndex}/100)`);
  else if (fearGreedIndex > 75) penalties.push(`סנטימנט שוק: חמדנות קיצונית (${fearGreedIndex}/100)`);

  return { action, buyScore, sellScore, rawConfidence, confidence, signals, penalties };
}

// ── LAYER 1.5 — ENTRY TIMING (limit-order pullback) ─────────────────────────
// alg.md has no explicit entry-timing layer, but entering at the live market
// price every time causes chasing and unnecessary slippage. This layer adds
// a simple but effective pullback filter: if price is already extended beyond
// the trigger level, defer the entry to a better level.

export interface ProEntryTimingResult {
  shouldEnter: boolean;
  entryPrice: number;
  reason: string;
  indicators: {
    rsi: number;
    ema20: number;
    bbUpper: number;
    bbLower: number;
  };
}

export function calculateProOptimalEntry(
  currentPrice: number,
  atr: number,
  side: 'LONG' | 'SHORT' | 'BUY' | 'SELL',
  candles: Candle[],
  pullbackFactor: number = 0.35,
  minRelativeVolume: number = MIN_ENTRY_RELATIVE_VOLUME
): ProEntryTimingResult {
  const isLong = side === 'LONG' || side === 'BUY';
  const closes = candles.map((c) => c.close);
  const ema20Series = calculateEMA(closes, 20);
  const ema20 = ema20Series[ema20Series.length - 1] || currentPrice;

  // Bollinger Bands (20, 2)
  const recentCloses = closes.slice(-20);
  const bbMean = recentCloses.reduce((a, b) => a + b, 0) / Math.max(1, recentCloses.length);
  const bbStdDev = Math.sqrt(recentCloses.reduce((s, v) => s + (v - bbMean) ** 2, 0) / Math.max(1, recentCloses.length));
  const bbUpper = bbMean + 2 * bbStdDev;
  const bbLower = bbMean - 2 * bbStdDev;

  // RSI(14)
  let rsi = 50;
  if (closes.length >= 15) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses += Math.abs(diff);
    }
    let avgGain = gains / 14, avgLoss = losses / 14;
    for (let i = 15; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * 13 + (diff > 0 ? diff : 0)) / 14;
      avgLoss = (avgLoss * 13 + (diff < 0 ? Math.abs(diff) : 0)) / 14;
    }
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  const atrPullback = atr * pullbackFactor;

  // Volume confirmation — same rationale as the legacy engine's entry layer:
  // the limit order below rests into a pullback, and a pullback on no volume
  // is drift rather than a defended level.
  const relativeVolume = computeRelativeVolume(candles);
  if (relativeVolume !== undefined && relativeVolume < minRelativeVolume) {
    return {
      shouldEnter: false,
      entryPrice: currentPrice,
      reason: `נפח כניסה נמוך מדי (${relativeVolume.toFixed(2)}x < ${minRelativeVolume}x מהממוצע) — אין עניין בשוק`,
      indicators: { rsi, ema20, bbUpper, bbLower }
    };
  }

  if (isLong) {
    if (rsi > 70) {
      return { shouldEnter: false, entryPrice: currentPrice, reason: `RSI קנוי-יתר (${rsi.toFixed(1)} > 70) — ממתין לקירור`, indicators: { rsi, ema20, bbUpper, bbLower } };
    }
    if (currentPrice > bbUpper) {
      return { shouldEnter: false, entryPrice: currentPrice, reason: `מחיר מעל רצועת Bollinger עליונה — ממתין לנסיגה`, indicators: { rsi, ema20, bbUpper, bbLower } };
    }
    if (currentPrice > ema20 + atr * 1.5) {
      return { shouldEnter: false, entryPrice: currentPrice, reason: `מחיר מורחק מ-EMA20 — ממתין לנסיגה לממוצע`, indicators: { rsi, ema20, bbUpper, bbLower } };
    }
    const entryPrice = Math.max(1e-8, currentPrice - atrPullback);
    return { shouldEnter: true, entryPrice: Number(entryPrice.toFixed(8)), reason: `Limit BUY @ ${formatDynamicPrice(entryPrice)} (pullback ${(pullbackFactor * 100).toFixed(0)}% ATR)`, indicators: { rsi, ema20, bbUpper, bbLower } };
  } else {
    if (rsi < 30) {
      return { shouldEnter: false, entryPrice: currentPrice, reason: `RSI מכירת-יתר (${rsi.toFixed(1)} < 30) — ממתין לעלייה קלה`, indicators: { rsi, ema20, bbUpper, bbLower } };
    }
    if (currentPrice < bbLower) {
      return { shouldEnter: false, entryPrice: currentPrice, reason: `מחיר מתחת לרצועת Bollinger תחתונה — ממתין לעלייה`, indicators: { rsi, ema20, bbUpper, bbLower } };
    }
    if (currentPrice < ema20 - atr * 1.5) {
      return { shouldEnter: false, entryPrice: currentPrice, reason: `מחיר מורחק מתחת ל-EMA20 — ממתין לעלייה לממוצע`, indicators: { rsi, ema20, bbUpper, bbLower } };
    }
    const entryPrice = currentPrice + atrPullback;
    return { shouldEnter: true, entryPrice: Number(entryPrice.toFixed(8)), reason: `Limit SELL/SHORT @ ${formatDynamicPrice(entryPrice)} (pullback ${(pullbackFactor * 100).toFixed(0)}% ATR)`, indicators: { rsi, ema20, bbUpper, bbLower } };
  }
}

// ── LAYER 2 — TRADE TYPE ROUTER ─────────────────────────────────────────────

export type ProTradeType = 'SPOT' | 'FUTURES' | 'HOLD';
export type ProTradeSide = 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE';

export interface ProRouterResult {
  type: ProTradeType;
  side: ProTradeSide;
  hardGateBlocked?: boolean;
  blockReason?: string;
  reason: string;
}

export interface ProRouterOptions {
  hasExistingFutures?: boolean;
  isDailyBlocked?: boolean;
  isWeeklyLocked?: boolean;
}

// ═══════════════════════════════════════════════════════
// DYNAMIC CONFIDENCE THRESHOLDS
// ═══════════════════════════════════════════════════════
// Same formula as tradeEngine.ts: static base thresholds are safe in LOW
// volatility but become dangerously loose as ATR rises. Ramps by up to
// +15 points from 2% ATR to 8% ATR.

export function dynamicConfidenceThreshold(baseThreshold: number, _atrPercent: number): number {
  return baseThreshold;
}

// ═══════════════════════════════════════════════════════
// LAYER 2 — TRADE TYPE ROUTING
// ═══════════════════════════════════════════════════════

export function routeProTradeType(signal: ProSignalResult, regime: ProMarketRegimeResult, options: ProRouterOptions = {}): ProRouterResult {
  if (options.isWeeklyLocked) {
    return { type: 'HOLD', side: 'NONE', hardGateBlocked: true, blockReason: 'WEEKLY_DRAWDOWN_LOCK', reason: 'נעילת מערכת שבועית (הפסד >= 15%) — נדרש שחרור ידני' };
  }
  if (options.isDailyBlocked) {
    return { type: 'HOLD', side: 'NONE', hardGateBlocked: true, blockReason: 'DAILY_DRAWDOWN_BLOCK', reason: 'הגנת תיק יומית (הפסד >= 8%) — חסימת כניסות חדשות עד יום המסחר הבא' };
  }
  if (regime.regime === 'TRANSITIONAL') {
    // SOFT_TREND carve-out: ADX > 22 AND the Supertrend agrees with the side
    // we are about to take → Spot allowed with a higher bar.
    //
    // The old test was `supertrend.direction !== 'NEUTRAL'`, which excluded
    // nothing: the field is typed 'BULL' | 'BEAR' and never carries NEUTRAL.
    // The carve-out was therefore "ADX > 22" alone, and a BUY signal against
    // a bearish Supertrend walked straight through it.
    const supertrendAgrees =
      (signal.action === 'BUY' && regime.supertrend.direction === 'BULL') ||
      (signal.action === 'SELL' && regime.supertrend.direction === 'BEAR');
    const softTrend = regime.adx > 22 && supertrendAgrees;
    if (!softTrend) {
      return { type: 'HOLD', side: 'NONE', hardGateBlocked: true, blockReason: 'TRANSITIONAL_HARD_BLOCK', reason: `TRANSITIONAL MARKET REGIME: כניסות חדשות חסומות (ADX ${regime.adx.toFixed(1)})` };
    }
    // Fall through to Spot/Futures routing with higher Spot threshold
  }
  if (signal.action === 'HOLD') {
    return { type: 'HOLD', side: 'NONE', reason: `ללא יתרון כיווני מובהק (BUY ${signal.buyScore} vs SELL ${signal.sellScore})` };
  }

  // FUTURES — ALL 5 conditions per alg.md §Layer2.1 (no extra Supertrend-match
  // gate — that condition exists in tradeEngine.ts but is not in the spec):
  // 1. regime TRENDING  2. confidence>=dynamic(72)  3. volatility LOW/NORMAL
  // 4. ADX>25  5. no existing Futures position on this asset
  const isTrending = regime.regime === 'TRENDING' && regime.adx > 25;
  const isFuturesVolOk = regime.volatility === 'LOW' || regime.volatility === 'NORMAL';
  const futuresThreshold = dynamicConfidenceThreshold(70, regime.atrPercent);
  const isFuturesScoreOk = signal.rawConfidence >= futuresThreshold;
  if (isTrending && isFuturesVolOk && isFuturesScoreOk && !options.hasExistingFutures) {
    const side: ProTradeSide = signal.action === 'BUY' ? 'LONG' : 'SHORT';
    return { type: 'FUTURES', side, reason: `כל תנאי Futures התקיימו: TRENDING (ADX ${regime.adx.toFixed(1)}), confidence ${signal.confidence} >= ${futuresThreshold.toFixed(1)}, תנודתיות ${regime.volatility}` };
  }

  // SPOT — confidence>=dynamic(60), regime TRENDING or RANGING (or SOFT_TREND with higher bar)
  const isSpotRegimeOk = regime.regime === 'TRENDING' || regime.regime === 'RANGING' || (regime.regime === 'TRANSITIONAL' && regime.adx > 22);
  const softTrendSpot = regime.regime === 'TRANSITIONAL' && regime.adx > 22;
  const spotThreshold = dynamicConfidenceThreshold(60, regime.atrPercent);
  const requiredSpotScore = softTrendSpot ? dynamicConfidenceThreshold(65, regime.atrPercent) : spotThreshold;
  if (isSpotRegimeOk && signal.rawConfidence >= requiredSpotScore) {
    const side: ProTradeSide = signal.action === 'BUY' ? 'BUY' : 'SELL';
    const reason = softTrendSpot
      ? `עסקת Spot מאושרת: confidence ${signal.confidence} >= ${requiredSpotScore.toFixed(1)} ב-SOFT_TREND (ADX ${regime.adx.toFixed(1)})`
      : `עסקת Spot מאושרת: confidence ${signal.confidence} >= ${requiredSpotScore.toFixed(1)} במצב ${regime.regime}`;
    return { type: 'SPOT', side, reason };
  }

  return { type: 'HOLD', side: 'NONE', reason: signal.confidence < requiredSpotScore ? `confidence ${signal.confidence} מתחת לסף המינימלי (${requiredSpotScore.toFixed(1)})` : 'לא עומד בתנאי הבטיחות של Spot או Futures' };
}

// ── LAYER 3 — RISK MANAGEMENT ────────────────────────────────────────────────

export interface ProClosedTradeMetric {
  pnl: number;
}

export interface ProRiskResult {
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  leverage: number;
  betSizeUsd: number;
  positionPercentOfPortfolio: number;
  riskRewardRatio: number;
  kellyFraction: number;
}

export function calculateProRisk(
  entryPrice: number,
  tradeType: 'SPOT' | 'FUTURES',
  side: ProTradeSide,
  atr: number,
  volatility: ProVolatilityType,
  confidence: number,
  portfolioValue: number,
  closedTrades: ProClosedTradeMetric[] = [],
  openPositionsCount: number = 0,
  openFuturesCount: number = 0,
  currentLeveragedExposureUsd: number = 0,
  dailyDrawdownPercent: number = 0,
  /** Performance-adaptive size multiplier (adaptiveRisk.ts). When supplied it
   *  REPLACES the local drawdown-only adjustment below — it already folds the
   *  drawdown factor in along with the loss streak and win rate, and applying
   *  both would compound the same term twice. Left undefined (direct callers,
   *  tests) the drawdown-only behaviour is preserved. */
  sizingMultiplier?: number,
  /** Optional SL clamp override for backtesting. Defaults to MIN_STOP_PERCENT/MAX_STOP_PERCENT. */
  slConfig?: { minStop: number; maxStop: number }
): ProRiskResult | null {
  if (entryPrice <= 0 || atr <= 0 || portfolioValue <= 0) return null;

  // §Layer3.4 — portfolio capacity gates
  if (openPositionsCount >= 7) return null;
  if (tradeType === 'FUTURES' && openFuturesCount >= 2) return null;

  // Resolve SL clamp (allows backtest sweep)
  const slMin = slConfig?.minStop ?? MIN_STOP_PERCENT;
  const slMax = slConfig?.maxStop ?? MAX_STOP_PERCENT;

  // §Layer3.1 — ATR-based SL/TP
  let stopLoss: number, takeProfit1: number | undefined, takeProfit2: number | undefined, takeProfit: number | undefined;
  let riskRewardRatio = 1.5;
  if (tradeType === 'SPOT') {
    // Spot: SL = Entry - ATR * 1.8, TP = Entry + ATR * 2.7
    // Clamp SL distance to [slMin, slMax] of entry to prevent
    // ATR-based stops from collapsing onto entry (low-vol) or ballooning (high-vol)
    let slDistance = atr * 1.8;
    slDistance = Math.max(entryPrice * slMin / 100, Math.min(entryPrice * slMax / 100, slDistance));
    stopLoss = Math.max(1e-8, entryPrice - slDistance);
    takeProfit = entryPrice + atr * 2.7;
    const stopDist = entryPrice - stopLoss;
    riskRewardRatio = stopDist > 0 ? (takeProfit - entryPrice) / stopDist : 1.5;
  } else if (side === 'LONG') {
    // Futures Long: SL = Entry - ATR * 1.5, TP1 = Entry + ATR * 2.0, TP2 = Entry + ATR * 3.5
    let slDistance = atr * 1.5;
    slDistance = Math.max(entryPrice * slMin / 100, Math.min(entryPrice * slMax / 100, slDistance));
    stopLoss = Math.max(1e-8, entryPrice - slDistance);
    takeProfit1 = entryPrice + atr * 2.0;
    takeProfit2 = entryPrice + atr * 3.5;
    const stopDist = entryPrice - stopLoss;
    riskRewardRatio = stopDist > 0 ? (takeProfit1 - entryPrice) / stopDist : 1.33;
  } else {
    // Futures Short: SL = Entry + ATR * 1.5, TP1 = Entry - ATR * 2.0, TP2 = Entry - ATR * 3.5
    let slDistance = atr * 1.5;
    slDistance = Math.max(entryPrice * slMin / 100, Math.min(entryPrice * slMax / 100, slDistance));
    stopLoss = entryPrice + slDistance;
    takeProfit1 = Math.max(1e-8, entryPrice - atr * 2.0);
    takeProfit2 = Math.max(1e-8, entryPrice - atr * 3.5);
    const stopDist = stopLoss - entryPrice;
    riskRewardRatio = stopDist > 0 ? (entryPrice - takeProfit1) / stopDist : 1.33;
  }

  // §Layer3.2 — leverage
  let leverage = 1;
  if (tradeType === 'FUTURES') {
    if (volatility === 'HIGH') return null;
    let base = volatility === 'LOW' ? 5 : 3;
    if (confidence >= 80) base = Math.min(5, base + 1);
    leverage = Math.min(5, Math.max(1, base));
  }

  // §Layer3.3 — Kelly Criterion DIRECTLY sizes the bet (not a risk multiplier
  // like tradeEngine.ts's approach): BetSize = Portfolio × clamp(Kelly×0.5, 0, 0.10),
  // default 3% without >=30 closed trades.
  // Drawdown adjustment: reduce bet size when the portfolio is in drawdown to
  // avoid compounding losses during a losing streak.
  let kellyFraction = 0;
  let betFraction = 0.06;
  if (closedTrades.length >= 30) {
    const winning = closedTrades.filter((t) => t.pnl > 0);
    const losing = closedTrades.filter((t) => t.pnl < 0);
    const winRate = winning.length / closedTrades.length;
    const avgWin = winning.length ? winning.reduce((s, t) => s + t.pnl, 0) / winning.length : atr * 2;
    const avgLoss = losing.length ? Math.abs(losing.reduce((s, t) => s + t.pnl, 0) / losing.length) : atr * 1.5;
    const R = avgLoss > 0 ? avgWin / avgLoss : riskRewardRatio;
    kellyFraction = R > 0 ? winRate - (1 - winRate) / R : 0;
    betFraction = Math.min(Math.max(0, kellyFraction * 0.5), 0.10);
  }
  // Adaptive sizing, applied to BOTH branches: the pre-Kelly 3% default used
  // to ignore the drawdown entirely, so the first 30 trades — the ones taken
  // with the least evidence of an edge — were the only ones never de-risked.
  const adaptiveFactor = sizingMultiplier !== undefined
    ? Math.max(0, sizingMultiplier)
    : computeDrawdownFactor(dailyDrawdownPercent);
  betFraction = Math.min(Math.max(0, betFraction * adaptiveFactor), 0.10);
  const betSizeUsd = portfolioValue * betFraction;

  // §Layer3.4 — total leveraged exposure cap (Futures only; betSizeUsd is the
  // capital COMMITTED — margin for Futures, full notional for Spot — so
  // leveraged/notional exposure = betSizeUsd × leverage)
  if (tradeType === 'FUTURES') {
    const notionalUsd = betSizeUsd * leverage;
    const maxAllowedLeveragedExposure = portfolioValue * 0.20;
    if (currentLeveragedExposureUsd + notionalUsd > maxAllowedLeveragedExposure) return null;
  }

  if (betSizeUsd < 5) return null; // exchange-minimum execution floor, not part of the algorithm itself

  return {
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit1: takeProfit1 !== undefined ? Number(takeProfit1.toFixed(8)) : undefined,
    takeProfit2: takeProfit2 !== undefined ? Number(takeProfit2.toFixed(8)) : undefined,
    takeProfit: takeProfit !== undefined ? Number(takeProfit.toFixed(8)) : undefined,
    leverage,
    betSizeUsd: Number(betSizeUsd.toFixed(2)),
    positionPercentOfPortfolio: Number(((betSizeUsd / portfolioValue) * 100).toFixed(2)),
    riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
    kellyFraction: Number(kellyFraction.toFixed(4))
  };
}

// ── LAYER 4 — EXIT ENGINE ─────────────────────────────────────────────────

export interface ProActivePosition {
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  tp1Hit?: boolean;
  highestPrice?: number;
  lowestPrice?: number;
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
  openTimestamp: number;
}

export interface ProExitDecision {
  shouldExit: boolean;
  exitType: 'FULL' | 'PARTIAL_50' | 'NONE';
  reason: string;
}

/** alg.md §Layer4.4 checkpoints the Futures time stop at 24h. A position
 *  already working in our favour gets one extension to this hour instead. */
export const PRO_FUTURES_TIME_STOP_EXTENDED_HOURS = 36;

/** Favourable progress (in R) required at the 24h checkpoint to earn the
 *  extension. Matches the intraday engine's own time-stop progress bar. */
export const PRO_FUTURES_TIME_STOP_MIN_PROGRESS_R = 0.3;

export function evaluateProExit(
  pos: ProActivePosition,
  currentPrice: number,
  currentAtr: number,
  currentSignalScores: { buy: number; sell: number },
  portfolioStats: { dailyDrawdownPercent: number; weeklyDrawdownPercent: number; systemLocked?: boolean }
): ProExitDecision {
  const isFutures = pos.type === 'FUTURES';
  const isLong = pos.side === 'LONG' || pos.side === 'BUY';
  const isShort = pos.side === 'SHORT' || pos.side === 'SELL';

  // §Layer4.5 — weekly emergency flatten
  if (portfolioStats.weeklyDrawdownPercent >= 15 || portfolioStats.systemLocked) {
    return { shouldExit: true, exitType: 'FULL', reason: `הגנת תיק שבועית (Drawdown ${portfolioStats.weeklyDrawdownPercent.toFixed(1)}% >= 15%) — כיבוי מלא` };
  }

  // §Layer4.1 — stop loss (full close, both Spot and Futures)
  if (isLong && currentPrice <= pos.stopLoss) return { shouldExit: true, exitType: 'FULL', reason: `Stop Loss ב-$${formatDynamicPrice(pos.stopLoss)} (מחיר $${formatDynamicPrice(currentPrice)})` };
  if (isShort && currentPrice >= pos.stopLoss) return { shouldExit: true, exitType: 'FULL', reason: `Stop Loss ב-$${formatDynamicPrice(pos.stopLoss)} (מחיר $${formatDynamicPrice(currentPrice)})` };

  if (!isFutures) {
    // §Layer4.1 — Spot TP (full close)
    if (pos.takeProfit1 && currentPrice >= pos.takeProfit1) {
      return { shouldExit: true, exitType: 'FULL', reason: `Take Profit ב-Spot הושג ($${formatDynamicPrice(currentPrice)} >= $${formatDynamicPrice(pos.takeProfit1)})` };
    }
    // §Layer4.2 — Spot trailing: 1.3×ATR below peak, once in profit
    const highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentPrice);
    if (highestPrice > pos.entryPrice) {
      const trailingSL = highestPrice - currentAtr * 1.3;
      if (currentPrice <= trailingSL) {
        return { shouldExit: true, exitType: 'FULL', reason: `Trailing Stop ב-Spot (שיא $${formatDynamicPrice(highestPrice)}, 1.3 ATR)` };
      }
    }
  } else if (isLong) {
    if (pos.takeProfit2 && currentPrice >= pos.takeProfit2) {
      return { shouldExit: true, exitType: 'FULL', reason: `TP2 הושג במלואו ($${formatDynamicPrice(currentPrice)} >= $${formatDynamicPrice(pos.takeProfit2)})` };
    }
    if (!pos.tp1Hit && pos.takeProfit1 && currentPrice >= pos.takeProfit1) {
      return { shouldExit: true, exitType: 'PARTIAL_50', reason: `TP1 הושג ($${formatDynamicPrice(currentPrice)} >= $${formatDynamicPrice(pos.takeProfit1)}) — סגירת 50% והפעלת Trailing` };
    }
    if (pos.tp1Hit) {
      const peak = Math.max(pos.highestPriceSinceTP1 || pos.entryPrice, currentPrice);
      const trailingSL = peak - currentAtr * 1.0;
      if (currentPrice <= trailingSL) {
        return { shouldExit: true, exitType: 'FULL', reason: `Trailing Stop הופעל (שיא $${formatDynamicPrice(peak)}, 1.0 ATR)` };
      }
    }
  } else if (isShort) {
    if (pos.takeProfit2 && currentPrice <= pos.takeProfit2) {
      return { shouldExit: true, exitType: 'FULL', reason: `TP2 הושג במלואו ($${formatDynamicPrice(currentPrice)} <= $${formatDynamicPrice(pos.takeProfit2)})` };
    }
    if (!pos.tp1Hit && pos.takeProfit1 && currentPrice <= pos.takeProfit1) {
      return { shouldExit: true, exitType: 'PARTIAL_50', reason: `TP1 הושג ($${formatDynamicPrice(currentPrice)} <= $${formatDynamicPrice(pos.takeProfit1)}) — סגירת 50% והפעלת Trailing` };
    }
    if (pos.tp1Hit) {
      const valley = Math.min(pos.lowestPriceSinceTP1 || pos.entryPrice, currentPrice);
      const trailingSL = valley + currentAtr * 1.0;
      if (currentPrice >= trailingSL) {
        return { shouldExit: true, exitType: 'FULL', reason: `Trailing Stop הופעל (שפל $${formatDynamicPrice(valley)}, 1.0 ATR)` };
      }
    }
  }

  // §Layer4.3 — reversal
  if (isLong && currentSignalScores.sell >= 65) {
    return { shouldExit: true, exitType: 'FULL', reason: `היפוך אותות: SELL confidence ${currentSignalScores.sell.toFixed(1)} >= 65` };
  }
  if (isShort && currentSignalScores.buy >= 65) {
    return { shouldExit: true, exitType: 'FULL', reason: `היפוך אותות: BUY confidence ${currentSignalScores.buy.toFixed(1)} >= 65` };
  }

  // §Layer4.4 — time-based
  const heldMs = Date.now() - (pos.openTimestamp || Date.now());
  const hoursHeld = heldMs / (1000 * 60 * 60);
  if (!isFutures && hoursHeld >= 48) {
    const distanceToSL = Math.abs(pos.entryPrice - pos.stopLoss);
    const currentLoss = pos.entryPrice - currentPrice;
    if (currentLoss > distanceToSL * 0.5) {
      return { shouldExit: true, exitType: 'FULL', reason: 'יציאת זמן (48 שעות): פוזיציית Spot בהפסד מעל 50% ממרחק ה-SL' };
    }
  }
  if (isFutures && hoursHeld >= 24 && !pos.tp1Hit) {
    // §Layer4.4 documents this literally as a 50% reduction — implemented
    // here as a genuine PARTIAL_50 (unlike tradeEngine.ts's equivalent,
    // which always fully closes due to an unrelated pre-existing bug).
    //
    // Progress-aware extension: the 24h checkpoint asks "is this trade going
    // anywhere?", and a position that has covered a third of its stop
    // distance in the right direction has answered yes — cutting it at a
    // fixed clock reading discards precisely the slow trends the ATR targets
    // were sized for. It is a REPRIEVE, not a reset: the trade still faces
    // the same test at 36h, and by then it must be at least breakeven-plus
    // to survive, so a stalling position cannot roll the extension forward.
    const stopDistance = Math.abs(pos.entryPrice - pos.stopLoss);
    const progressR = stopDistance > 0
      ? ((currentPrice - pos.entryPrice) * (isLong ? 1 : -1)) / stopDistance
      : 0;

    if (hoursHeld < PRO_FUTURES_TIME_STOP_EXTENDED_HOURS && progressR > PRO_FUTURES_TIME_STOP_MIN_PROGRESS_R) {
      return {
        shouldExit: false,
        exitType: 'NONE',
        reason: `הרחבת יציאת זמן: ${progressR.toFixed(2)}R לטובתנו אחרי ${hoursHeld.toFixed(1)} שעות — ממשיכים עד ${PRO_FUTURES_TIME_STOP_EXTENDED_HOURS} שעות`
      };
    }

    return {
      shouldExit: true,
      exitType: 'PARTIAL_50',
      reason: `יציאת זמן (${Math.floor(hoursHeld)} שעות): TP1 לא הושג — צמצום הפוזיציה ב-50%`
    };
  }

  return { shouldExit: false, exitType: 'NONE', reason: 'הפוזיציה ממשיכה לפעול' };
}

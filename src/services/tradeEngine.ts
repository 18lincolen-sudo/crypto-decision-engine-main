/**
 * TradeEngine - Core Autonomous Algorithmic Trading Decision & Risk Engine
 * Implements Layers 0-5 of the algorithmic decision & risk management system.
 * Shared between Simulation and Live Bybit Trading for 100% strict parity.
 *
 * Core Principle:
 * Capital Protection → Trade Quality → Positive Expectancy → Trade Frequency.
 */

import {
  MarketRegimeResult,
  MarketRegimeType,
  MarketDirectionType,
  VolatilityRegimeType,
  SignalEngineResult,
  IndicatorSignalDetail,
  TradeRouterResult,
  TradeType,
  TradeSide,
  RiskParametersResult,
  ActivePosition
} from '../types/crypto';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PortfolioRiskStats {
  portfolioValue: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  openPositionsCount: number;
  openFuturesPositionsCount: number;
  totalLeveragedExposureUsd: number;
  systemLocked?: boolean;
  lockReason?: string;
  lockedAt?: number;
}

// ═══════════════════════════════════════════════════════
// DYNAMIC PRICE PRECISION UTILITY
// ═══════════════════════════════════════════════════════

/**
 * Formats a price or numeric value with dynamic precision according to its magnitude
 * Ensures low-cost meme coins (e.g. FLOKI, PEPE, SHIB) and small values remain readable
 */
export function formatDynamicPrice(price: number): string {
  if (price === 0 || isNaN(price)) return '0.00';
  const abs = Math.abs(price);
  if (abs >= 1000) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(4);
  if (abs >= 0.01) return price.toFixed(6);
  if (abs >= 0.0001) return price.toFixed(8);
  return price.toFixed(10);
}

// ═══════════════════════════════════════════════════════
// TECHNICAL INDICATOR UTILITIES (Clean Math)
// ═══════════════════════════════════════════════════════

/**
 * Calculates EMA series
 */
export function calculateEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  
  // First point SMA
  let sum = 0;
  const initialCount = Math.min(period, values.length);
  for (let i = 0; i < initialCount; i++) {
    sum += values[i];
  }
  ema.push(sum / initialCount);

  for (let i = 1; i < values.length; i++) {
    const current = values[i] * k + ema[i - 1] * (1 - k);
    ema.push(current);
  }
  return ema;
}

/**
 * Calculates Average True Range (ATR)
 */
export function calculateATR(candles: Candle[], period: number = 14): { atr: number; atrPercent: number; trSeries: number[] } {
  if (candles.length < 2) {
    const defaultAtr = candles[0]?.close ? candles[0].close * 0.02 : 1;
    return { atr: defaultAtr, atrPercent: 2.0, trSeries: [defaultAtr] };
  }

  const trSeries: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trSeries.push(candles[i].high - candles[i].low);
    } else {
      const highLow = candles[i].high - candles[i].low;
      const highClose = Math.abs(candles[i].high - candles[i - 1].close);
      const lowClose = Math.abs(candles[i].low - candles[i - 1].close);
      trSeries.push(Math.max(highLow, highClose, lowClose));
    }
  }

  // Wilder's smoothing
  let atr = trSeries.slice(0, Math.min(period, trSeries.length)).reduce((a, b) => a + b, 0) / Math.min(period, trSeries.length);
  for (let i = period; i < trSeries.length; i++) {
    atr = (atr * (period - 1) + trSeries[i]) / period;
  }

  const currentPrice = candles[candles.length - 1].close || 1;
  const atrPercent = (atr / currentPrice) * 100;

  return { atr, atrPercent, trSeries };
}

/**
 * Calculates ADX (Average Directional Index)
 */
export function calculateADX(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 22; // default transitional

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
  }

  if (tr.length < period) return 22;

  // Initial smoothed values
  let smoothedTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues: number[] = [];

  for (let i = period; i < tr.length; i++) {
    smoothedTR = smoothedTR - smoothedTR / period + tr[i];
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDM[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDM[i];

    const plusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
    const minusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    dxValues.push(dx);
  }

  if (dxValues.length === 0) return 22;
  const adx = dxValues.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, dxValues.length);
  return Number(adx.toFixed(2));
}

/**
 * Calculates Supertrend(10, 3)
 */
export function calculateSupertrend(candles: Candle[], period: number = 10, multiplier: number = 3): { value: number; direction: 'BULL' | 'BEAR' } {
  if (candles.length < period) {
    const lastPrice = candles[candles.length - 1]?.close || 100;
    return { value: lastPrice * 0.98, direction: 'BULL' };
  }

  const { trSeries } = calculateATR(candles, period);
  
  let upperBand = 0;
  let lowerBand = 0;
  let supertrend = 0;
  let direction: 'BULL' | 'BEAR' = 'BULL';

  // Calculate rolling ATR
  for (let i = period - 1; i < candles.length; i++) {
    const sliceTR = trSeries.slice(i - period + 1, i + 1);
    const currentATR = sliceTR.reduce((a, b) => a + b, 0) / period;
    const hl2 = (candles[i].high + candles[i].low) / 2;

    const basicUpper = hl2 + multiplier * currentATR;
    const basicLower = hl2 - multiplier * currentATR;

    if (i === period - 1) {
      upperBand = basicUpper;
      lowerBand = basicLower;
      supertrend = basicLower;
      direction = 'BULL';
      continue;
    }

    // Upper band logic
    upperBand = (basicUpper < upperBand || candles[i - 1].close > upperBand) ? basicUpper : upperBand;
    // Lower band logic
    lowerBand = (basicLower > lowerBand || candles[i - 1].close < lowerBand) ? basicLower : lowerBand;

    const prevSupertrend = supertrend;
    if (prevSupertrend === upperBand) {
      direction = candles[i].close > upperBand ? 'BULL' : 'BEAR';
    } else {
      direction = candles[i].close < lowerBand ? 'BEAR' : 'BULL';
    }

    supertrend = direction === 'BULL' ? lowerBand : upperBand;
  }

  return { value: Number(supertrend.toFixed(6)), direction };
}

// ═══════════════════════════════════════════════════════
// LAYER 0 — MARKET REGIME DETECTION
// ═══════════════════════════════════════════════════════

export function detectMarketRegime(candles: Candle[], currentPrice: number): MarketRegimeResult {
  const adx = calculateADX(candles, 14);
  const { atr, atrPercent } = calculateATR(candles, 14);
  const supertrend = calculateSupertrend(candles, 10, 3);

  // 1. ADX(14) Classification:
  // ADX > 25 -> TRENDING
  // ADX < 20 -> RANGING
  // 20 <= ADX <= 25 -> TRANSITIONAL
  let regime: MarketRegimeType;
  if (adx > 25) {
    regime = 'TRENDING';
  } else if (adx < 20) {
    regime = 'RANGING';
  } else {
    regime = 'TRANSITIONAL';
  }

  // 2. Supertrend(10, 3):
  // Supertrend below price -> BULL
  // Supertrend above price -> BEAR
  const isSupertrendBullish = currentPrice >= supertrend.value;
  const direction: MarketDirectionType = regime === 'RANGING'
    ? 'NEUTRAL'
    : (isSupertrendBullish ? 'BULL' : 'BEAR');

  // 3. Volatility Regime (ATR%):
  // ATR% < 2% -> LOW
  // 2% <= ATR% <= 5% -> NORMAL
  // ATR% > 5% -> HIGH
  let volatility: VolatilityRegimeType;
  if (atrPercent < 2.0) {
    volatility = 'LOW';
  } else if (atrPercent <= 5.0) {
    volatility = 'NORMAL';
  } else {
    volatility = 'HIGH';
  }

  return {
    regime,
    direction,
    volatility,
    adx,
    atr,
    atrPercent: Number(atrPercent.toFixed(2)),
    supertrend: {
      value: supertrend.value,
      direction: isSupertrendBullish ? 'BULL' : 'BEAR'
    }
  };
}

// ═══════════════════════════════════════════════════════
// LAYER 1 — SIGNAL ENGINE
// Total Weight = 100:
// MACD (20), EMA 20/50 (18), RSI (12), Bollinger Bands (12),
// Volume Surge (18), Supertrend (12), Stochastic (8)
// ═══════════════════════════════════════════════════════

export function evaluateSignals(
  candles: Candle[],
  currentPrice: number,
  priceChange24h: number,
  layer0: MarketRegimeResult,
  fearGreedIndex: number = 50,
  _riskLevel?: 'low' | 'medium' | 'high'
): SignalEngineResult {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const signals: IndicatorSignalDetail[] = [];
  const penalties: string[] = [];

  // Note regime facts for logging
  if (layer0.regime === 'TRANSITIONAL') {
    penalties.push(`משטר מעבר (ADX ${layer0.adx}) — חסימת כניסות חדשות (TRANSITIONAL HARD GATE)`);
  }
  if (layer0.volatility === 'HIGH') {
    penalties.push(`תנודתיות גבוהה (${layer0.atrPercent}%) — חסימת Futures מוחלטת`);
  }

  // 1. MACD 12/26/9 (Weight: 20)
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = ema12.map((val, i) => val - ema26[i]);
  const signalLine = calculateEMA(macdLine, 9);
  
  const curMacd = macdLine[macdLine.length - 1] || 0;
  const curSignal = signalLine[signalLine.length - 1] || 0;
  const prevMacd = macdLine[macdLine.length - 2] || curMacd;
  const prevSignal = signalLine[signalLine.length - 2] || curSignal;
  
  const macdCrossUp = prevMacd <= prevSignal && curMacd > curSignal;
  const macdCrossDown = prevMacd >= prevSignal && curMacd < curSignal;

  if (curMacd > curSignal) {
    const isAboveZero = curMacd > 0;
    const strength = macdCrossUp ? (isAboveZero ? 1.0 : 0.85) : 0.7;
    signals.push({
      name: 'MACD (12/26/9)',
      weight: 20,
      signal: 'BUY',
      strength,
      value: `MACD ${formatDynamicPrice(curMacd)} > Signal ${formatDynamicPrice(curSignal)}`,
      reason: macdCrossUp
        ? (isAboveZero ? 'חציית MACD עולה מעל אפס (עוצמה 1.0)' : 'חציית MACD עולה (עוצמה 0.85)')
        : 'מומנטום MACD חיובי (עוצמה 0.7)'
    });
  } else if (curMacd < curSignal) {
    const isBelowZero = curMacd < 0;
    const strength = macdCrossDown ? (isBelowZero ? 1.0 : 0.85) : 0.7;
    signals.push({
      name: 'MACD (12/26/9)',
      weight: 20,
      signal: 'SELL',
      strength,
      value: `MACD ${formatDynamicPrice(curMacd)} < Signal ${formatDynamicPrice(curSignal)}`,
      reason: macdCrossDown
        ? (isBelowZero ? 'חציית MACD יורדת מתחת לאפס (עוצמה 1.0)' : 'חציית MACD יורדת (עוצמה 0.85)')
        : 'מומנטום MACD שלילי (עוצמה 0.7)'
    });
  } else {
    signals.push({
      name: 'MACD (12/26/9)',
      weight: 20,
      signal: 'NEUTRAL',
      strength: 0,
      value: 'MACD נייטרלי',
      reason: 'ללא אות מובהק'
    });
  }

  // 2. EMA 20/50 (Weight: 18)
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const curEma20 = ema20[ema20.length - 1] || currentPrice;
  const curEma50 = ema50[ema50.length - 1] || currentPrice;
  const prevEma20 = ema20[ema20.length - 2] || curEma20;
  const prevEma50 = ema50[ema50.length - 2] || curEma50;

  const goldenCross = prevEma20 <= prevEma50 && curEma20 > curEma50;
  const deathCross = prevEma20 >= prevEma50 && curEma20 < curEma50;

  if (curEma20 > curEma50) {
    const strength = goldenCross ? 1.0 : 0.8;
    signals.push({
      name: 'EMA 20/50',
      weight: 18,
      signal: 'BUY',
      strength,
      value: `EMA20 ($${formatDynamicPrice(curEma20)}) > EMA50 ($${formatDynamicPrice(curEma50)})`,
      reason: goldenCross ? 'Golden Cross טרי בין ממוצע 20 ל-50 (עוצמה 1.0)' : 'מגמה חיובית EMA20 מעל EMA50 (עוצמה 0.8)'
    });
  } else if (curEma20 < curEma50) {
    const strength = deathCross ? 1.0 : 0.8;
    signals.push({
      name: 'EMA 20/50',
      weight: 18,
      signal: 'SELL',
      strength,
      value: `EMA20 ($${formatDynamicPrice(curEma20)}) < EMA50 ($${formatDynamicPrice(curEma50)})`,
      reason: deathCross ? 'Death Cross טרי בין ממוצע 20 ל-50 (עוצמה 1.0)' : 'מגמה שלילית EMA20 מתחת ל-EMA50 (עוצמה 0.8)'
    });
  } else {
    signals.push({
      name: 'EMA 20/50',
      weight: 18,
      signal: 'NEUTRAL',
      strength: 0,
      value: 'EMA 20/50 שוויון',
      reason: 'ממוצעים נפגשים'
    });
  }

  // 3. RSI 14 (Weight: 12)
  // RSI <= 25 -> BUY strong (1.0)
  // 25 < RSI < 35 -> BUY (0.8)
  // 35 <= RSI <= 65 -> NEUTRAL (0)
  // 65 < RSI < 75 -> SELL (0.8)
  // RSI >= 75 -> SELL strong (1.0)
  let rsi = 50;
  if (closes.length >= 15) {
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= 14; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;
    for (let i = 15; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
    }
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  if (rsi <= 25) {
    signals.push({
      name: 'RSI(14)',
      weight: 12,
      signal: 'BUY',
      strength: 1.0,
      value: `RSI ${rsi.toFixed(1)}`,
      reason: 'RSI במכירת יתר קיצונית (<=25, עוצמה 1.0)'
    });
  } else if (rsi < 35) {
    signals.push({
      name: 'RSI(14)',
      weight: 12,
      signal: 'BUY',
      strength: 0.8,
      value: `RSI ${rsi.toFixed(1)}`,
      reason: 'RSI במכירת יתר (25-35, עוצמה 0.8)'
    });
  } else if (rsi >= 75) {
    signals.push({
      name: 'RSI(14)',
      weight: 12,
      signal: 'SELL',
      strength: 1.0,
      value: `RSI ${rsi.toFixed(1)}`,
      reason: 'RSI בקניית יתר קיצונית (>=75, עוצמה 1.0)'
    });
  } else if (rsi > 65) {
    signals.push({
      name: 'RSI(14)',
      weight: 12,
      signal: 'SELL',
      strength: 0.8,
      value: `RSI ${rsi.toFixed(1)}`,
      reason: 'RSI בקניית יתר (65-75, עוצמה 0.8)'
    });
  } else {
    signals.push({
      name: 'RSI(14)',
      weight: 12,
      signal: 'NEUTRAL',
      strength: 0,
      value: `RSI ${rsi.toFixed(1)}`,
      reason: 'RSI בטווח ניטרלי (35-65)'
    });
  }

  // 4. Bollinger Bands 20/2 (Weight: 12)
  // Price < Lower Band -> BUY (strength = 1.0)
  // Price > Upper Band -> SELL (strength = 1.0)
  // Inside -> NEUTRAL (strength = 0)
  const bbPeriod = 20;
  const recentCloses = closes.slice(-bbPeriod);
  const bbMean = recentCloses.reduce((a, b) => a + b, 0) / Math.max(1, recentCloses.length);
  const bbStdDev = Math.sqrt(recentCloses.reduce((sum, val) => sum + Math.pow(val - bbMean, 2), 0) / Math.max(1, recentCloses.length));
  const bbUpper = bbMean + 2 * bbStdDev;
  const bbLower = bbMean - 2 * bbStdDev;
  const bandwidth = bbMean > 0 ? (bbUpper - bbLower) / bbMean : 0;

  if (currentPrice < bbLower) {
    signals.push({
      name: 'Bollinger Bands (20/2)',
      weight: 12,
      signal: 'BUY',
      strength: 1.0,
      value: `מחיר מתחת לרצועה תחתונה ($${formatDynamicPrice(bbLower)})`,
      reason: 'פריצה מתחת לרצועת בולינגר תחתונה (Oversold, עוצמה 1.0)'
    });
  } else if (currentPrice > bbUpper) {
    signals.push({
      name: 'Bollinger Bands (20/2)',
      weight: 12,
      signal: 'SELL',
      strength: 1.0,
      value: `מחיר מעל לרצועה עליונה ($${formatDynamicPrice(bbUpper)})`,
      reason: 'פריצה מעל לרצועת בולינגר עליונה (Overbought, עוצמה 1.0)'
    });
  } else {
    signals.push({
      name: 'Bollinger Bands (20/2)',
      weight: 12,
      signal: 'NEUTRAL',
      strength: 0,
      value: `רוחב רצועות ${(bandwidth * 100).toFixed(1)}%`,
      reason: 'מחיר בתוך רצועות בולינגר'
    });
  }

  // 5. Volume Surge (Weight: 18)
  // Volume >= 1.5x average -> strong confirmation (1.0)
  // 0.8x <= Volume < 1.5x -> NEUTRAL (0)
  // Volume < 0.8x -> weak confirmation (0.3)
  const recentVolumes = volumes.slice(-21, -1);
  const avgVol20 = recentVolumes.length ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length : 1;
  const latestVol = volumes[volumes.length - 1] || 0;
  const volumeRatio = avgVol20 > 0 ? latestVol / avgVol20 : 1;

  const isPriceUp = priceChange24h > 0 || (closes.length >= 2 && closes[closes.length - 1] > closes[closes.length - 2]);

  if (volumeRatio >= 1.5) {
    if (isPriceUp) {
      signals.push({
        name: 'Volume Surge',
        weight: 18,
        signal: 'BUY',
        strength: 1.0,
        value: `נפח פי ${volumeRatio.toFixed(2)} מהממוצע`,
        reason: 'זינוק בנפח המסחר עם עליית מחיר (אישור תנועה חזק, עוצמה 1.0)'
      });
    } else {
      signals.push({
        name: 'Volume Surge',
        weight: 18,
        signal: 'SELL',
        strength: 1.0,
        value: `נפח פי ${volumeRatio.toFixed(2)} מהממוצע`,
        reason: 'זינוק בנפח המסחר עם ירידת מחיר (לחץ מכירות, עוצמה 1.0)'
      });
    }
  } else if (volumeRatio < 0.8) {
    if (isPriceUp) {
      signals.push({
        name: 'Volume Surge',
        weight: 18,
        signal: 'BUY',
        strength: 0.3,
        value: `נפח חלש פי ${volumeRatio.toFixed(2)} מהממוצע`,
        reason: 'נפח נמוך (עוצמה חלשה 0.3)'
      });
    } else {
      signals.push({
        name: 'Volume Surge',
        weight: 18,
        signal: 'SELL',
        strength: 0.3,
        value: `נפח חלש פי ${volumeRatio.toFixed(2)} מהממוצע`,
        reason: 'נפח נמוך (עוצמה חלשה 0.3)'
      });
    }
  } else {
    signals.push({
      name: 'Volume Surge',
      weight: 18,
      signal: 'NEUTRAL',
      strength: 0,
      value: `נפח פי ${volumeRatio.toFixed(2)} מהממוצע`,
      reason: 'נפח מסחר ממוצע רגיל (0.8x-1.5x)'
    });
  }

  // 6. Supertrend 10/3 (Weight: 12)
  // Supertrend = BULL -> BUY strength = 1.0
  // Supertrend = BEAR -> SELL strength = 1.0
  const isSupertrendBull = layer0.supertrend.direction === 'BULL';
  signals.push({
    name: 'Supertrend (10/3)',
    weight: 12,
    signal: isSupertrendBull ? 'BUY' : 'SELL',
    strength: 1.0,
    value: `Supertrend $${formatDynamicPrice(layer0.supertrend.value)} (${layer0.supertrend.direction})`,
    reason: isSupertrendBull ? 'Supertrend תומך במגמה שורית (Bullish, עוצמה 1.0)' : 'Supertrend תומך במגמה דובית (Bearish, עוצמה 1.0)'
  });

  // 7. Stochastic 14/3 (Weight: 8)
  // K < 20 && D < 25 -> BUY (strength = 0.85)
  // K > 80 && D > 75 -> SELL (strength = 0.85)
  // Otherwise -> NEUTRAL (strength = 0)
  const stochPeriod = 14;
  let stochK = 50;
  let stochD = 50;
  if (candles.length >= stochPeriod) {
    const recentCandles = candles.slice(-stochPeriod);
    const highestH = Math.max(...recentCandles.map(c => c.high));
    const lowestL = Math.min(...recentCandles.map(c => c.low));
    const diff = highestH - lowestL;
    stochK = diff > 0 ? ((currentPrice - lowestL) / diff) * 100 : 50;
    stochD = stochK;
  }

  if (stochK < 20 && stochD < 25) {
    signals.push({
      name: 'Stochastic (14/3)',
      weight: 8,
      signal: 'BUY',
      strength: 0.85,
      value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`,
      reason: 'סטוכסטיק במכירת יתר (<20, עוצמה 0.85)'
    });
  } else if (stochK > 80 && stochD > 75) {
    signals.push({
      name: 'Stochastic (14/3)',
      weight: 8,
      signal: 'SELL',
      strength: 0.85,
      value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`,
      reason: 'סטוכסטיק בקניית יתר (>80, עוצמה 0.85)'
    });
  } else {
    signals.push({
      name: 'Stochastic (14/3)',
      weight: 8,
      signal: 'NEUTRAL',
      strength: 0,
      value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`,
      reason: 'סטוכסטיק בטווח אמצע'
    });
  }

  // ═══════════════════════════════════════════════════════
  // Mathematical Definition of SignalScore:
  // SignalScore = Σ(weight × strength)
  // Maximum SignalScore = 100
  // Direction: BUY Score vs SELL Score
  // ═══════════════════════════════════════════════════════
  let buyScore = 0;
  let sellScore = 0;

  for (const s of signals) {
    if (s.signal === 'BUY') {
      buyScore += s.weight * s.strength;
    } else if (s.signal === 'SELL') {
      sellScore += s.weight * s.strength;
    }
  }

  buyScore = Number(buyScore.toFixed(2));
  sellScore = Number(sellScore.toFixed(2));

  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let signalScore = 0;

  if (buyScore > sellScore) {
    action = 'BUY';
    signalScore = buyScore;
  } else if (sellScore > buyScore) {
    action = 'SELL';
    signalScore = sellScore;
  } else {
    action = 'HOLD';
    signalScore = Math.max(buyScore, sellScore);
  }

  // Log sentiment context without bypassing Hard Gates
  if (fearGreedIndex < 25) {
    penalties.push(`סנטימנט שוק: פחד קיצוני (${fearGreedIndex}/100)`);
  } else if (fearGreedIndex > 75) {
    penalties.push(`סנטימנט שוק: חמדנות קיצונית (${fearGreedIndex}/100)`);
  }

  return {
    action,
    buyScore,
    sellScore,
    signalScore,
    confidence: signalScore, // alias for backward compatibility
    signals,
    rawConfidence: signalScore,
    penalties
  };
}

// ═══════════════════════════════════════════════════════
// LAYER 2 — TRADE ROUTER & HARD GATES
// Hard Gate Order:
// 1. Weekly Drawdown Lock (>= 13%)
// 2. Daily Drawdown Block (>= 6%)
// 3. Transitional Market Regime Block (20 <= ADX <= 25)
// 4. Same-Asset Cross-Market Block (No dual Spot + Futures)
// 5. High Volatility Futures Block (ATR% > 5%)
// 6. Routing Thresholds (Futures >= 70 & TRENDING; Spot >= 58 [or >= 62 in High Vol])
// ═══════════════════════════════════════════════════════

export interface TradeRouterOptions {
  hasExistingFutures?: boolean;
  hasExistingSpot?: boolean;
  isDailyBlocked?: boolean;
  isWeeklyLocked?: boolean;
}

export function routeTradeType(
  signalResult: SignalEngineResult,
  layer0: MarketRegimeResult,
  hasExistingFuturesOrOptions: boolean | TradeRouterOptions = false,
  _riskLevel?: 'low' | 'medium' | 'high'
): TradeRouterResult {
  const options: TradeRouterOptions = typeof hasExistingFuturesOrOptions === 'boolean'
    ? { hasExistingFutures: hasExistingFuturesOrOptions }
    : hasExistingFuturesOrOptions;

  const { action, signalScore } = signalResult;

  // 1. Hard Gate: Weekly Circuit Breaker (Lock)
  if (options.isWeeklyLocked) {
    return {
      type: 'HOLD',
      side: 'NONE',
      hardGateBlocked: true,
      blockReason: 'WEEKLY_DRAWDOWN_LOCK',
      reason: 'נעילת מערכת שבועית (הפסד >= 13%) — נדרש שחרור ידני'
    };
  }

  // 2. Hard Gate: Daily Circuit Breaker (Entry Block)
  if (options.isDailyBlocked) {
    return {
      type: 'HOLD',
      side: 'NONE',
      hardGateBlocked: true,
      blockReason: 'DAILY_DRAWDOWN_BLOCK',
      reason: 'הגנת תיק יומית (הפסד >= 6%) — חסימת כניסות חדשות עד יום המסחר הבא'
    };
  }

  // 3. Hard Gate: Transitional Market Regime (ADX 20..25)
  // When 20 <= ADX <= 25 -> NEW ENTRIES = BLOCKED (Spot & Futures)
  if (layer0.regime === 'TRANSITIONAL') {
    return {
      type: 'HOLD',
      side: 'NONE',
      hardGateBlocked: true,
      blockReason: 'TRANSITIONAL_HARD_BLOCK',
      reason: `TRANSITIONAL MARKET REGIME: כניסות חדשות חסומות במעבר משטר שוק (ADX ${layer0.adx})`
    };
  }

  // 4. Hard Gate: Same-Asset Cross-Market Policy
  // No simultaneous Spot & Futures on same asset
  if (options.hasExistingFutures) {
    return {
      type: 'HOLD',
      side: 'NONE',
      hardGateBlocked: true,
      blockReason: 'SAME_ASSET_EXPOSURE_BLOCK',
      reason: 'קיימת כבר פוזיציית Futures פתוחה על נכס זה — חסימת כניסה נוספת'
    };
  }
  if (options.hasExistingSpot) {
    return {
      type: 'HOLD',
      side: 'NONE',
      hardGateBlocked: true,
      blockReason: 'SAME_ASSET_EXPOSURE_BLOCK',
      reason: 'קיימת כבר פוזיציית Spot פתוחה על נכס זה — חסימת כניסה נוספת'
    };
  }

  // 5. Check directional action
  if (action === 'HOLD') {
    return {
      type: 'HOLD',
      side: 'NONE',
      reason: `ללא יתרון כיווני מובהק (BUY ${signalResult.buyScore} vs SELL ${signalResult.sellScore})`
    };
  }

  // ═══════════════════════════════════════════════════════
  // FUTURES ROUTING EVALUATION
  // All conditions required:
  // 1. Regime = TRENDING (ADX > 25)
  // 2. Volatility = LOW or NORMAL (ATR% <= 5%) [HIGH VOL -> FUTURES BLOCKED]
  // 3. SignalScore >= 72
  // 4. Supertrend matches trade direction (LONG -> BULL, SHORT -> BEAR)
  // 5. No existing position on this asset
  // ═══════════════════════════════════════════════════════
  const isTrending = layer0.regime === 'TRENDING' && layer0.adx > 25;
  const isVolatilitySafeForFutures = layer0.volatility === 'LOW' || layer0.volatility === 'NORMAL';
  const isSupertrendDirectionMatched =
    (action === 'BUY' && layer0.supertrend.direction === 'BULL') ||
    (action === 'SELL' && layer0.supertrend.direction === 'BEAR');
  const isFuturesScorePassed = signalScore >= 70;

  if (isTrending && isVolatilitySafeForFutures && isSupertrendDirectionMatched && isFuturesScorePassed) {
    const side: TradeSide = action === 'BUY' ? 'LONG' : 'SHORT';
    return {
      type: 'FUTURES',
      side,
      reason: `התקיימו כל תנאי Futures: מגמתי (ADX ${layer0.adx}), SignalScore ${signalScore} >= 72, תנודתיות ${layer0.volatility}, Supertrend ${layer0.supertrend.direction}`
    };
  }

  // ═══════════════════════════════════════════════════════
  // SPOT ROUTING EVALUATION (Evaluated independently)
  // Conditions:
  // 1. Regime in ['TRENDING', 'RANGING'] (Never TRANSITIONAL)
  // 2. In LOW/NORMAL Volatility: SignalScore >= 58
  // 3. In HIGH Volatility: SignalScore >= 62
  // ═══════════════════════════════════════════════════════
  const isSpotRegimeValid = layer0.regime === 'TRENDING' || layer0.regime === 'RANGING';
  const requiredSpotScore = layer0.volatility === 'HIGH' ? 62 : 58;
  const isSpotScorePassed = signalScore >= requiredSpotScore;

  if (isSpotRegimeValid && isSpotScorePassed) {
    const side: TradeSide = action === 'BUY' ? 'BUY' : 'SELL';
    let reason = `עסקת Spot מאושרת: SignalScore ${signalScore} >= ${requiredSpotScore} במצב ${layer0.regime} (${layer0.volatility} VOL)`;
    if (layer0.volatility === 'HIGH') {
      reason += ' [HIGH VOL: Futures חסום, Spot מאושר בסף מוגבר 62]';
    } else if (!isTrending) {
      reason += ' [Ranging: רק Spot מותר]';
    } else if (!isSupertrendDirectionMatched) {
      reason += ` [Supertrend ${layer0.supertrend.direction} לא תואם Futures — Spot מאושר]`;
    } else if (signalScore < 70) {
      reason += ` [ציון ${signalScore} מתחת ל-70 של Futures — Spot מאושר]`;
    }
    return {
      type: 'SPOT',
      side,
      reason
    };
  }

  // ═══════════════════════════════════════════════════════
  // SPECIFIC BLOCK REASONS FOR TELEMETRY & LOGS
  // ═══════════════════════════════════════════════════════
  if (layer0.volatility === 'HIGH' && !isSpotScorePassed) {
    return {
      type: 'HOLD',
      side: 'NONE',
      hardGateBlocked: true,
      blockReason: 'SPOT_SCORE_BELOW_HIGH_VOL_THRESHOLD',
      reason: `SPOT SCORE BELOW HIGH-VOL THRESHOLD: ציון ${signalScore} < סף נדרש 62 בתנודתיות גבוהה (${layer0.atrPercent}%)`
    };
  }

  if (signalScore < 58) {
    return {
      type: 'HOLD',
      side: 'NONE',
      reason: `SignalScore ${signalScore} מתחת לסף המינימלי לפעולה (58)`
    };
  }

  return {
    type: 'HOLD',
    side: 'NONE',
    reason: 'לא עומד בתנאי הבטיחות של Spot או Futures'
  };
}

// ═══════════════════════════════════════════════════════
// LAYER 3.5 — ENTRY TIMING VALIDATOR (REAL GATE)
// ═══════════════════════════════════════════════════════

export interface EntryTimingResult {
  shouldEnterNow: boolean;
  entryPrice: number;
  reason: string;
  indicators: {
    rsi: number;
    ema20: number;
    bbUpper: number;
    bbLower: number;
    atrPullback: number;
  };
}

export function computeEntryIndicators(
  candles: Candle[],
  currentPrice: number
): { rsi: number; ema20: number; bbUpper: number; bbLower: number } {
  const closes = candles.map(c => c.close);

  // RSI(14)
  let rsi = 50;
  if (closes.length >= 15) {
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= 14; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;
    for (let i = 15; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
    }
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  // EMA20
  const ema20Series = calculateEMA(closes, 20);
  const ema20 = ema20Series[ema20Series.length - 1] || currentPrice;

  // Bollinger Bands (20, 2)
  const bbPeriod = 20;
  const recentCloses = closes.slice(-bbPeriod);
  const bbMean = recentCloses.reduce((a, b) => a + b, 0) / Math.max(1, recentCloses.length);
  const bbStdDev = Math.sqrt(
    recentCloses.reduce((sum, val) => sum + Math.pow(val - bbMean, 2), 0) / Math.max(1, recentCloses.length)
  );
  const bbUpper = bbMean + 2 * bbStdDev;
  const bbLower = bbMean - 2 * bbStdDev;

  return { rsi, ema20, bbUpper, bbLower };
}

/**
 * Validates entry timing to prevent chasing local tops/bottoms
 * BUY / LONG: Block if RSI > 72, Price > BB Upper * 0.999, Price > EMA20 + 1.5*ATR
 * SELL / SHORT: Block if RSI < 28, Price < BB Lower * 1.001, Price < EMA20 - 1.5*ATR
 * Limit Pullback: Entry = CurrentPrice - ATR * 0.35 (BUY) / CurrentPrice + ATR * 0.35 (SELL)
 */
export function calculateOptimalEntry(
  currentPrice: number,
  atr: number,
  side: 'BUY' | 'LONG' | 'SELL' | 'SHORT',
  candles: Candle[],
  pullbackFactor: number = 0.35
): EntryTimingResult {
  const isBuy = side === 'BUY' || side === 'LONG';
  const { rsi, ema20, bbUpper, bbLower } = computeEntryIndicators(candles, currentPrice);
  const atrPullback = atr * pullbackFactor;

  if (isBuy) {
    if (rsi > 72) {
      return {
        shouldEnterNow: false,
        entryPrice: currentPrice,
        reason: `RSI קנוי-יתר (${rsi.toFixed(1)} > 72) — ממתין לקירור לפני כניסה`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }
    if (currentPrice > bbUpper * 0.999) {
      return {
        shouldEnterNow: false,
        entryPrice: currentPrice,
        reason: `מחיר בשיא רצועת Bollinger עליונה ($${formatDynamicPrice(bbUpper)}) — ממתין לנסיגה`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }
    if (currentPrice > ema20 + atr * 1.5) {
      return {
        shouldEnterNow: false,
        entryPrice: currentPrice,
        reason: `מחיר מורחק יותר מ-1.5×ATR מעל EMA20 ($${formatDynamicPrice(ema20)}) — ממתין לנסיגה לממוצע`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }

    const entryPrice = Math.max(0.00000001, currentPrice - atrPullback);
    return {
      shouldEnterNow: true,
      entryPrice: Number(entryPrice.toFixed(8)),
      reason: `Limit BUY @ $${formatDynamicPrice(entryPrice)} (pullback ${(pullbackFactor * 100).toFixed(0)}% ATR מתחת למחיר) | RSI=${rsi.toFixed(1)}`,
      indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
    };
  } else {
    if (rsi < 28) {
      return {
        shouldEnterNow: false,
        entryPrice: currentPrice,
        reason: `RSI מכירת-יתר (${rsi.toFixed(1)} < 28) — ממתין לעלייה קלה לפני שורט`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }
    if (currentPrice < bbLower * 1.001) {
      return {
        shouldEnterNow: false,
        entryPrice: currentPrice,
        reason: `מחיר בשפל רצועת Bollinger תחתונה ($${formatDynamicPrice(bbLower)}) — ממתין לעלייה`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }
    if (currentPrice < ema20 - atr * 1.5) {
      return {
        shouldEnterNow: false,
        entryPrice: currentPrice,
        reason: `מחיר מורחק יותר מ-1.5×ATR מתחת ל-EMA20 ($${formatDynamicPrice(ema20)}) — ממתין לעלייה`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }

    const entryPrice = currentPrice + atrPullback;
    return {
      shouldEnterNow: true,
      entryPrice: Number(entryPrice.toFixed(8)),
      reason: `Limit SELL/SHORT @ $${formatDynamicPrice(entryPrice)} (pullback ${(pullbackFactor * 100).toFixed(0)}% ATR מעל המחיר) | RSI=${rsi.toFixed(1)}`,
      indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
    };
  }
}

// ═══════════════════════════════════════════════════════
// LAYER 3 — RISK MANAGEMENT & POSITION SIZING
// Principles:
// 1. MaxRiskAmount = PortfolioValue × 0.0075 (0.75% max risk per trade)
// 2. StopDistance = |EntryPrice - StopLoss|
// 3. PositionSize = MaxRiskAmount / StopDistance
// 4. Constrained Kelly Modifier (>= 30 closed trades, half Kelly, capped at 0.75%)
// 5. Max total open positions = 7, Max Futures = 2
// 6. Max leveraged exposure = 20% of Portfolio
// 7. Minimum trade size = $5
// 8. Leverage: LOW 5x, NORMAL 3x, HIGH BLOCKED; +1x if SignalScore >= 80 (max 5x)
// ═══════════════════════════════════════════════════════

export interface ClosedTradeMetric {
  pnl: number;
}

export function calculateRiskParameters(
  entryPrice: number,
  tradeType: TradeType,
  side: TradeSide,
  atr: number,
  volatility: VolatilityRegimeType,
  signalScore: number,
  portfolioValue: number,
  closedTrades: ClosedTradeMetric[] = [],
  openPositionsCount: number = 0,
  openFuturesCount: number = 0,
  currentLeveragedExposureUsd: number = 0,
  _configuredPositionPercent?: number
): RiskParametersResult | null {
  if (tradeType === 'HOLD' || entryPrice <= 0 || atr <= 0 || portfolioValue <= 0) return null;

  // Portfolio Level Capacity Gates:
  // Max total open positions = 7
  // Max Futures positions = 2
  if (openPositionsCount >= 7) return null;
  if (tradeType === 'FUTURES' && openFuturesCount >= 2) return null;

  // 1. Dynamic ATR-based TP/SL
  let stopLoss: number;
  let takeProfit1: number | undefined;
  let takeProfit2: number | undefined;
  let takeProfit: number | undefined;
  let riskRewardRatio = 1.5;

  if (tradeType === 'SPOT') {
    // Spot: SL = Entry - ATR * 1.8, TP = Entry + ATR * 2.7
    stopLoss = Math.max(0.00000001, entryPrice - atr * 1.8);
    takeProfit = entryPrice + atr * 2.7;
    const stopDist = entryPrice - stopLoss;
    riskRewardRatio = stopDist > 0 ? (takeProfit - entryPrice) / stopDist : 1.5;
  } else if (side === 'LONG') {
    // Futures Long: SL = Entry - ATR * 1.5, TP1 = Entry + ATR * 2.0, TP2 = Entry + ATR * 3.5
    stopLoss = Math.max(0.00000001, entryPrice - atr * 1.5);
    takeProfit1 = entryPrice + atr * 2.0;
    takeProfit2 = entryPrice + atr * 3.5;
    const stopDist = entryPrice - stopLoss;
    riskRewardRatio = stopDist > 0 ? (takeProfit1 - entryPrice) / stopDist : 1.33;
  } else {
    // Futures Short: SL = Entry + ATR * 1.5, TP1 = Entry - ATR * 2.0, TP2 = Entry - ATR * 3.5
    stopLoss = entryPrice + atr * 1.5;
    takeProfit1 = Math.max(0.00000001, entryPrice - atr * 2.0);
    takeProfit2 = Math.max(0.00000001, entryPrice - atr * 3.5);
    const stopDist = stopLoss - entryPrice;
    riskRewardRatio = stopDist > 0 ? (entryPrice - takeProfit1) / stopDist : 1.33;
  }

  // 2. Leverage Sizing:
  // LOW Vol -> base 5x
  // NORMAL Vol -> base 3x
  // HIGH Vol -> Futures blocked
  // SignalScore >= 80 -> +1x (up to 5x max)
  let leverage = 1;
  if (tradeType === 'FUTURES') {
    if (volatility === 'HIGH') return null; // Hard block Futures in High Vol
    let baseLeverage = volatility === 'LOW' ? 5 : 3;
    if (signalScore >= 80) {
      baseLeverage = Math.min(5, baseLeverage + 1);
    }
    leverage = Math.min(5, Math.max(1, baseLeverage));
  }

  // 3. Position Sizing — Risk First (0.75% Portfolio Risk Budget)
  const maxPortfolioRiskRate = 0.0075; // 0.75% max risk
  let maxRiskAmount = portfolioValue * maxPortfolioRiskRate;

  // Kelly Modifier (only with >= 30 closed trades)
  let kellyFraction = 0;
  if (closedTrades.length >= 30) {
    const winning = closedTrades.filter(t => t.pnl > 0);
    const losing = closedTrades.filter(t => t.pnl < 0);
    const winRate = winning.length / closedTrades.length;

    const avgWin = winning.length ? winning.reduce((s, t) => s + t.pnl, 0) / winning.length : atr * 2;
    const avgLoss = losing.length ? Math.abs(losing.reduce((s, t) => s + t.pnl, 0) / losing.length) : atr * 1.5;
    const historicalR = avgLoss > 0 ? avgWin / avgLoss : riskRewardRatio;

    if (historicalR > 0) {
      kellyFraction = winRate - (1 - winRate) / historicalR;
    }
    // Half Kelly scaling, strictly capped so risk never exceeds 0.75%
    const kellyScale = Math.min(1.0, Math.max(0.2, kellyFraction * 0.5));
    maxRiskAmount = maxRiskAmount * kellyScale;
  }

  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance <= 0) return null;

  // Total position size (Notional in USD) based on stop distance
  const positionSizeUnits = maxRiskAmount / stopDistance;
  let notionalUsd = positionSizeUnits * entryPrice;

  // Sizing Caps:
  // Spot: Notional cap (e.g. 15% of portfolio)
  // Futures: Margin required = notionalUsd / leverage
  if (tradeType === 'SPOT') {
    notionalUsd = Math.min(notionalUsd, portfolioValue * 0.15);
  } else {
    // Futures leveraged exposure check:
    // Total leveraged exposure must NOT exceed 20% of portfolio value
    const maxAllowedLeveragedExposure = portfolioValue * 0.20;
    const remainingExposureRoom = maxAllowedLeveragedExposure - currentLeveragedExposureUsd;

    // Hard block if new trade causes leveraged exposure to exceed 20%
    if (notionalUsd > remainingExposureRoom) {
      return null; // Exposure Hard Block
    }
  }

  // Margin/Cash required for order
  const betSizeUsd = tradeType === 'FUTURES' ? notionalUsd / leverage : notionalUsd;

  // Minimal order size constraint ($5)
  if (betSizeUsd < 5) return null;

  return {
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit1: takeProfit1 ? Number(takeProfit1.toFixed(8)) : undefined,
    takeProfit2: takeProfit2 ? Number(takeProfit2.toFixed(8)) : undefined,
    takeProfit: takeProfit ? Number(takeProfit.toFixed(8)) : undefined,
    leverage,
    betSizeUsd: Number(betSizeUsd.toFixed(2)),
    positionPercentOfPortfolio: Number(((betSizeUsd / portfolioValue) * 100).toFixed(2)),
    riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
    kellyFraction: Number(kellyFraction.toFixed(4)),
    maxRiskAmountUsd: Number(maxRiskAmount.toFixed(2)),
    stopDistanceUsd: Number(stopDistance.toFixed(8))
  };
}

// ═══════════════════════════════════════════════════════
// LAYER 4 — EXIT ENGINE
// ═══════════════════════════════════════════════════════

export interface ExitDecision {
  shouldExit: boolean;
  exitType: 'FULL' | 'PARTIAL_50' | 'TRAILING_STOP' | 'REVERSAL' | 'TIME_BASED' | 'NONE';
  reason: string;
  exitPrice?: number;
  newTrailingStopPrice?: number;
}

export function evaluateExit(
  pos: ActivePosition,
  currentPrice: number,
  currentAtr: number,
  currentSignalScores: { buy: number; sell: number },
  portfolioStats: { dailyDrawdownPercent: number; weeklyDrawdownPercent: number; systemLocked?: boolean }
): ExitDecision {
  const isFutures = pos.type === 'FUTURES';
  const isLong = pos.side === 'LONG' || pos.side === 'BUY';
  const isShort = pos.side === 'SHORT';

  // 1. Drawdown Circuit Breakers (Weekly lock / Daily block)
  if (portfolioStats.weeklyDrawdownPercent >= 15 || portfolioStats.systemLocked) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reason: `הגנת תיק שבועית הופעלה (Drawdown ${portfolioStats.weeklyDrawdownPercent.toFixed(1)}% >= 15%) — סגירת פוזיציה להגנת הון`
    };
  }

  // 2. Stop Loss Hit
  if (isLong && currentPrice <= pos.stopLoss) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reason: `Stop Loss הופעל במחיר $${formatDynamicPrice(currentPrice)} (SL: $${formatDynamicPrice(pos.stopLoss)})`
    };
  }
  if (isShort && currentPrice >= pos.stopLoss) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reason: `Stop Loss הופעל במחיר $${formatDynamicPrice(currentPrice)} (SL: $${formatDynamicPrice(pos.stopLoss)})`
    };
  }

  // 3. Take Profit & Trailing Stop Logic
  if (!isFutures) {
    // Spot Take Profit (TP = Entry + ATR * 2.7)
    if (pos.takeProfit1 && currentPrice >= pos.takeProfit1) {
      return {
        shouldExit: true,
        exitType: 'FULL',
        reason: `Take Profit מלא ב-Spot ($${formatDynamicPrice(currentPrice)} >= $${formatDynamicPrice(pos.takeProfit1)})`
      };
    }

    // Spot Trailing Stop: 1.3 ATR below peak (activated after price is in profit by 1.0 ATR)
    const highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentPrice);
    const spotTrailingSL = highestPrice - currentAtr * 1.3;
    if (highestPrice > pos.entryPrice + currentAtr && currentPrice <= spotTrailingSL) {
      return {
        shouldExit: true,
        exitType: 'TRAILING_STOP',
        reason: `Trailing Stop ב-Spot נסגר במחיר $${formatDynamicPrice(currentPrice)} (שיא: $${formatDynamicPrice(highestPrice)}, Trailing: 1.3 ATR)`
      };
    }
  } else {
    // Futures TP1 / TP2 & Trailing Stop Logic
    if (isLong) {
      // TP2 (100% exit)
      if (pos.takeProfit2 && currentPrice >= pos.takeProfit2) {
        return {
          shouldExit: true,
          exitType: 'FULL',
          reason: `Take Profit 2 בפיוצ'רס הושג במלואו ($${formatDynamicPrice(currentPrice)} >= $${formatDynamicPrice(pos.takeProfit2)})`
        };
      }

      // TP1 (50% exit and activate 1.0 ATR trailing stop)
      if (!pos.tp1Hit && pos.takeProfit1 && currentPrice >= pos.takeProfit1) {
        return {
          shouldExit: true,
          exitType: 'PARTIAL_50',
          reason: `Take Profit 1 הושג ($${formatDynamicPrice(currentPrice)} >= $${formatDynamicPrice(pos.takeProfit1)}) — סגירת 50% והפעלת Trailing Stop (1.0 ATR)`
        };
      }

      // Trailing Stop (Futures Long: 1.0 ATR below peak after TP1)
      if (pos.tp1Hit) {
        const peak = Math.max(pos.highestPriceSinceTP1 || pos.entryPrice, currentPrice);
        const trailingSL = peak - currentAtr * 1.0;
        if (currentPrice <= trailingSL) {
          return {
            shouldExit: true,
            exitType: 'TRAILING_STOP',
            reason: `Trailing Stop בפיוצ'רס Long הופעל ($${formatDynamicPrice(currentPrice)} <= $${formatDynamicPrice(trailingSL)}, שיא: $${formatDynamicPrice(peak)})`
          };
        }
      }
    } else if (isShort) {
      // Short TP2
      if (pos.takeProfit2 && currentPrice <= pos.takeProfit2) {
        return {
          shouldExit: true,
          exitType: 'FULL',
          reason: `Take Profit 2 בשורט הושג במלואו ($${formatDynamicPrice(currentPrice)} <= $${formatDynamicPrice(pos.takeProfit2)})`
        };
      }

      // Short TP1
      if (!pos.tp1Hit && pos.takeProfit1 && currentPrice <= pos.takeProfit1) {
        return {
          shouldExit: true,
          exitType: 'PARTIAL_50',
          reason: `Take Profit 1 בשורט הושג ($${formatDynamicPrice(currentPrice)} <= $${formatDynamicPrice(pos.takeProfit1)}) — סגירת 50% והפעלת Trailing Stop (1.0 ATR)`
        };
      }

      // Trailing Stop (Futures Short: 1.0 ATR above valley after TP1)
      if (pos.tp1Hit) {
        const valley = Math.min(pos.lowestPriceSinceTP1 || pos.entryPrice, currentPrice);
        const trailingSL = valley + currentAtr * 1.0;
        if (currentPrice >= trailingSL) {
          return {
            shouldExit: true,
            exitType: 'TRAILING_STOP',
            reason: `Trailing Stop בפיוצ'רס Short הופעל ($${formatDynamicPrice(currentPrice)} >= $${formatDynamicPrice(trailingSL)}, שפל: $${formatDynamicPrice(valley)})`
          };
        }
      }
    }
  }

  // 4. Reversal Exit
  // Long/BUY exits when SELL SignalScore >= 65
  // Short/SELL exits when BUY SignalScore >= 65
  if (isLong && currentSignalScores.sell >= 65) {
    return {
      shouldExit: true,
      exitType: 'REVERSAL',
      reason: `היפוך אותות: זוהה ציון מכירה גבוה (${currentSignalScores.sell.toFixed(1)} >= 65)`
    };
  }
  if (isShort && currentSignalScores.buy >= 65) {
    return {
      shouldExit: true,
      exitType: 'REVERSAL',
      reason: `היפוך אותות: זוהה ציון קנייה גבוה (${currentSignalScores.buy.toFixed(1)} >= 65)`
    };
  }

  // 5. Time-Based Exit
  const heldMs = Date.now() - (pos.openTimestamp || Date.now());
  const hoursHeld = heldMs / (1000 * 60 * 60);

  if (!isFutures && hoursHeld >= 48) {
    // Spot: if after 48h position is in loss > 50% of distance to SL
    const distanceToSL = Math.abs(pos.entryPrice - pos.stopLoss);
    const currentLoss = pos.entryPrice - currentPrice;
    if (currentLoss > distanceToSL * 0.5) {
      return {
        shouldExit: true,
        exitType: 'TIME_BASED',
        reason: `יציאת זמן (48 שעות): פוזיציית Spot בהפסד מעל 50% ממרחק ה-SL`
      };
    }
  }

  if (isFutures && hoursHeld >= 24 && !pos.tp1Hit) {
    // Futures: if after 24h TP1 wasn't hit -> reduce position by 50%
    return {
      shouldExit: true,
      exitType: 'TIME_BASED',
      reason: `יציאת זמן (24 שעות): TP1 לא הושג — צמצום הפוזיציה ב-50%`
    };
  }

  return {
    shouldExit: false,
    exitType: 'NONE',
    reason: 'פוזיציה ממשיכה לפעול'
  };
}

// ═══════════════════════════════════════════════════════
// LAYER 5 — FEES & REALISTIC SLIPPAGE
// Spot: Maker 0.1%, Taker 0.1%
// Futures: Maker 0.02%, Taker 0.055%
// Slippage: 0.05% - 0.15%
// Break-Even includes Round Trip Fees
// ═══════════════════════════════════════════════════════

export const BYBIT_FEES = {
  spot: {
    maker: 0.001, // 0.1%
    taker: 0.001  // 0.1%
  },
  futures: {
    maker: 0.0002, // 0.02%
    taker: 0.00055 // 0.055%
  }
};

/**
 * Calculates trading fee for order
 */
export function calculateTradingFee(usdValue: number, tradeType: 'SPOT' | 'FUTURES', isTaker: boolean = true): number {
  const rate = tradeType === 'SPOT'
    ? (isTaker ? BYBIT_FEES.spot.taker : BYBIT_FEES.spot.maker)
    : (isTaker ? BYBIT_FEES.futures.taker : BYBIT_FEES.futures.maker);
  return usdValue * rate;
}

/**
 * Generates realistic simulation slippage between 0.05% and 0.15%
 */
export function simulateSlippage(marketPrice: number, side: 'BUY' | 'SELL' | 'LONG' | 'SHORT'): { fillPrice: number; slippagePercent: number } {
  const slipPercent = 0.05 + Math.random() * 0.10;
  const multiplier = (side === 'BUY' || side === 'LONG') ? (1 + slipPercent / 100) : (1 - slipPercent / 100);
  const fillPrice = marketPrice * multiplier;
  return { fillPrice, slippagePercent: slipPercent };
}

/**
 * Computes break-even price including round-trip fees
 */
export function calculateBreakEvenPrice(entryPrice: number, tradeType: 'SPOT' | 'FUTURES', isLong: boolean = true): number {
  const roundTripFeeRate = tradeType === 'SPOT' ? 0.002 : 0.0011; // 2x taker
  return isLong
    ? entryPrice * (1 + roundTripFeeRate)
    : entryPrice * (1 - roundTripFeeRate);
}

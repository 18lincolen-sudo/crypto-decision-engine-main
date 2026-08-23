/**
 * TradeEngine - Core Autonomous Trading Engine (Spot + Futures)
 * Implements Layers 0-5 of the algorithmic decision & risk management system.
 * Shared between Simulation and Live Bybit Trading for 100% parity.
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

  return { value: Number(supertrend.toFixed(4)), direction };
}

// ═══════════════════════════════════════════════════════
// LAYER 0 — MARKET REGIME DETECTION
// ═══════════════════════════════════════════════════════

export function detectMarketRegime(candles: Candle[], currentPrice: number): MarketRegimeResult {
  const adx = calculateADX(candles, 14);
  const { atr, atrPercent } = calculateATR(candles, 14);
  const supertrend = calculateSupertrend(candles, 10, 3);

  // 1. ADX(14)
  let regime: MarketRegimeType;
  if (adx > 25) {
    regime = 'TRENDING';
  } else if (adx < 20) {
    regime = 'RANGING';
  } else {
    regime = 'TRANSITIONAL';
  }

  // 2. Supertrend(10, 3)
  // When supertrend is below price -> BULLISH TREND, when above price -> BEARISH TREND
  const isSupertrendBullish = currentPrice >= supertrend.value;
  const direction: MarketDirectionType = regime === 'RANGING'
    ? 'NEUTRAL'
    : (isSupertrendBullish ? 'BULL' : 'BEAR');

  // 3. Volatility Regime: ATR%
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
// ═══════════════════════════════════════════════════════

export function evaluateSignals(
  candles: Candle[],
  currentPrice: number,
  priceChange24h: number,
  layer0: MarketRegimeResult,
  fearGreedIndex: number = 50,
  riskLevel: 'low' | 'medium' | 'high' = 'medium'
): SignalEngineResult {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const signals: IndicatorSignalDetail[] = [];
  const penalties: string[] = [];

  // Note regime constraints for telemetry
  if (layer0.regime === 'TRANSITIONAL') {
    penalties.push(`משטר מעבר (ADX ${layer0.adx}) - מוגבל ל-Spot בלבד`);
  }
  if (layer0.volatility === 'HIGH') {
    penalties.push(`תנודתיות גבוהה (${layer0.atrPercent}%) - מוגבל ל-Spot בלבד עם בקרת סיכון`);
  }

  // 1. MACD Cross (Weight: 20)
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
      name: 'MACD Cross',
      weight: 20,
      signal: 'BUY',
      strength,
      value: `MACD ${curMacd.toFixed(4)} > Signal ${curSignal.toFixed(4)}`,
      reason: macdCrossUp
        ? (isAboveZero ? 'חציית MACD עולה מעל אפס (עוצמה מרבית)' : 'חציית MACD עולה')
        : 'מומנטום MACD חיובי'
    });
  } else if (curMacd < curSignal) {
    const isBelowZero = curMacd < 0;
    const strength = macdCrossDown ? (isBelowZero ? 1.0 : 0.85) : 0.7;
    signals.push({
      name: 'MACD Cross',
      weight: 20,
      signal: 'SELL',
      strength,
      value: `MACD ${curMacd.toFixed(4)} < Signal ${curSignal.toFixed(4)}`,
      reason: macdCrossDown
        ? (isBelowZero ? 'חציית MACD יורדת מתחת לאפס (עוצמה מרבית)' : 'חציית MACD יורדת')
        : 'מומנטום MACD שלילי'
    });
  } else {
    signals.push({
      name: 'MACD Cross',
      weight: 20,
      signal: 'NEUTRAL',
      strength: 0,
      value: 'MACD נייטרלי',
      reason: 'ללא אות מובהק'
    });
  }

  // 2. EMA 20/50 Cross (Weight: 18)
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
      name: 'EMA 20/50 Cross',
      weight: 18,
      signal: 'BUY',
      strength,
      value: `EMA20 ($${curEma20.toFixed(2)}) > EMA50 ($${curEma50.toFixed(2)})`,
      reason: goldenCross ? 'Golden Cross טרי בין ממוצע 20 ל-50' : 'מגמת ביניים חיובית (EMA20 מעל EMA50)'
    });
  } else if (curEma20 < curEma50) {
    const strength = deathCross ? 1.0 : 0.8;
    signals.push({
      name: 'EMA 20/50 Cross',
      weight: 18,
      signal: 'SELL',
      strength,
      value: `EMA20 ($${curEma20.toFixed(2)}) < EMA50 ($${curEma50.toFixed(2)})`,
      reason: deathCross ? 'Death Cross טרי בין ממוצע 20 ל-50' : 'מגמת ביניים שלילית (EMA20 מתחת ל-EMA50)'
    });
  } else {
    signals.push({
      name: 'EMA 20/50 Cross',
      weight: 18,
      signal: 'NEUTRAL',
      strength: 0,
      value: 'EMA 20/50 שוויון',
      reason: 'ממוצעים נפגשים'
    });
  }

  // 3. RSI(14) (Weight: 12) - Conservative: <35 Buy, >65 Sell
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

  if (rsi < 35) {
    const strength = rsi <= 25 ? 1.0 : 0.8;
    signals.push({
      name: 'RSI(14)',
      weight: 12,
      signal: 'BUY',
      strength,
      value: `RSI ${rsi.toFixed(1)}`,
      reason: rsi <= 25 ? 'RSI במכירת יתר קיצונית (<25)' : 'RSI במכירת יתר (<35)'
    });
  } else if (rsi > 65) {
    const strength = rsi >= 75 ? 1.0 : 0.8;
    signals.push({
      name: 'RSI(14)',
      weight: 12,
      signal: 'SELL',
      strength,
      value: `RSI ${rsi.toFixed(1)}`,
      reason: rsi >= 75 ? 'RSI בקניית יתר קיצונית (>75)' : 'RSI בקניית יתר (>65)'
    });
  } else {
    signals.push({
      name: 'RSI(14)',
      weight: 12,
      signal: 'NEUTRAL',
      strength: 0.2,
      value: `RSI ${rsi.toFixed(1)}`,
      reason: 'RSI בטווח נייטרלי (35-65)'
    });
  }

  // 4. Bollinger Bands (Weight: 12)
  const bbPeriod = 20;
  const recentCloses = closes.slice(-bbPeriod);
  const bbMean = recentCloses.reduce((a, b) => a + b, 0) / Math.max(1, recentCloses.length);
  const bbStdDev = Math.sqrt(recentCloses.reduce((sum, val) => sum + Math.pow(val - bbMean, 2), 0) / Math.max(1, recentCloses.length));
  const bbUpper = bbMean + 2 * bbStdDev;
  const bbLower = bbMean - 2 * bbStdDev;
  const bandwidth = (bbUpper - bbLower) / bbMean;

  if (currentPrice < bbLower) {
    signals.push({
      name: 'Bollinger Bands',
      weight: 12,
      signal: 'BUY',
      strength: 0.9,
      value: `מחיר מתחת לרצועה התחתונה ($${bbLower.toFixed(2)})`,
      reason: 'פריצה מתחת לרצועת בולינגר תחתונה (Oversold)'
    });
  } else if (currentPrice > bbUpper) {
    signals.push({
      name: 'Bollinger Bands',
      weight: 12,
      signal: 'SELL',
      strength: 0.9,
      value: `מחיר מעל לרצועה העליונה ($${bbUpper.toFixed(2)})`,
      reason: 'פריצה מעל לרצועת בולינגר עליונה (Overbought)'
    });
  } else {
    signals.push({
      name: 'Bollinger Bands',
      weight: 12,
      signal: 'NEUTRAL',
      strength: 0.3,
      value: `רוחב רצועות ${(bandwidth * 100).toFixed(1)}%`,
      reason: 'מחיר בתוך רצועות בולינגר'
    });
  }

  // 5. Volume Surge (Weight: 18) - min 1.5x of 20-period volume average
  const recentVolumes = volumes.slice(-21, -1);
  const avgVol20 = recentVolumes.length ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length : 1;
  const latestVol = volumes[volumes.length - 1] || 0;
  const volumeRatio = avgVol20 > 0 ? latestVol / avgVol20 : 1;

  let volumeSignal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  let volumeStrength = 0;

  if (volumeRatio >= 1.5) {
    if (priceChange24h > 0 || (closes[closes.length - 1] > closes[Math.max(0, closes.length - 2)])) {
      volumeSignal = 'BUY';
      volumeStrength = 1.0;
      signals.push({
        name: 'Volume Surge',
        weight: 18,
        signal: 'BUY',
        strength: 1.0,
        value: `נפח פי ${volumeRatio.toFixed(2)} מהממוצע`,
        reason: 'זינוק בנפח המסחר עם עליית מחיר (אישור תנועה חזק)'
      });
    } else {
      volumeSignal = 'SELL';
      volumeStrength = 1.0;
      signals.push({
        name: 'Volume Surge',
        weight: 18,
        signal: 'SELL',
        strength: 1.0,
        value: `נפח פי ${volumeRatio.toFixed(2)} מהממוצע`,
        reason: 'זינוק בנפח המסחר עם לחץ מכירות'
      });
    }
  } else {
    signals.push({
      name: 'Volume Surge',
      weight: 18,
      signal: 'NEUTRAL',
      strength: 0,
      value: `נפח פי ${volumeRatio.toFixed(2)} מהממוצע`,
      reason: 'נפח רגיל (פחות מ-1.5x ממוצע 20) — אין אישור פריצה'
    });
  }

  // 6. Supertrend (Weight: 12)
  const isSupertrendBull = layer0.supertrend.direction === 'BULL';
  signals.push({
    name: 'Supertrend',
    weight: 12,
    signal: isSupertrendBull ? 'BUY' : 'SELL',
    strength: 1.0,
    value: `Supertrend $${layer0.supertrend.value.toFixed(2)} (${layer0.supertrend.direction})`,
    reason: isSupertrendBull ? 'Supertrend תומך במגמה שורית (Bullish)' : 'Supertrend תומך במגמה דובית (Bearish)'
  });

  // 7. Stochastic(14, 3) (Weight: 8) - Filter only
  const stochPeriod = 14;
  let stochK = 50;
  let stochD = 50;
  if (candles.length >= stochPeriod) {
    const recentCandles = candles.slice(-stochPeriod);
    const highestH = Math.max(...recentCandles.map(c => c.high));
    const lowestL = Math.min(...recentCandles.map(c => c.low));
    const diff = highestH - lowestL;
    stochK = diff > 0 ? ((currentPrice - lowestL) / diff) * 100 : 50;
    stochD = stochK; // simplified SMA
  }

  if (stochK < 20 && stochD < 25) {
    signals.push({
      name: 'Stochastic(14,3)',
      weight: 8,
      signal: 'BUY',
      strength: 0.85,
      value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`,
      reason: 'פילטר סטוכסטיק מאשר מכירת יתר (<20)'
    });
  } else if (stochK > 80 && stochD > 75) {
    signals.push({
      name: 'Stochastic(14,3)',
      weight: 8,
      signal: 'SELL',
      strength: 0.85,
      value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`,
      reason: 'פילטר סטוכסטיק מאשר קניית יתר (>80)'
    });
  } else {
    signals.push({
      name: 'Stochastic(14,3)',
      weight: 8,
      signal: 'NEUTRAL',
      strength: 0.3,
      value: `K ${stochK.toFixed(1)} / D ${stochD.toFixed(1)}`,
      reason: 'סטוכסטיק בטווח אמצע'
    });
  }

  // ═══════════════════════════════════════════════════════
  // Confidence & Action Aggregation
  // ═══════════════════════════════════════════════════════
  let buyScore = 0;
  let sellScore = 0;
  let totalWeight = 0;

  for (const s of signals) {
    if (s.signal === 'BUY') {
      buyScore += s.weight * s.strength;
    } else if (s.signal === 'SELL') {
      sellScore += s.weight * s.strength;
    }
    totalWeight += s.weight;
  }

  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let rawConfidence = 0;

  // Risk profile controls how much buy/sell consensus is required to act.
  // High risk acts on weaker signals; low risk requires stronger confirmation.
  const actionThreshold = riskLevel === 'high' ? 28 : riskLevel === 'low' ? 40 : 35;

  if (buyScore > sellScore && buyScore >= actionThreshold) {
    action = 'BUY';
    rawConfidence = (buyScore / totalWeight) * 100;
  } else if (sellScore > buyScore && sellScore >= actionThreshold) {
    action = 'SELL';
    rawConfidence = (sellScore / totalWeight) * 100;
  } else {
    action = 'HOLD';
    rawConfidence = 45;
  }

  let finalConfidence = rawConfidence;

  // NOTE: Volume Surge = NEUTRAL is the NORMAL market state and must NOT block
  // trades. A volume surge remains a positive (weight 18) BUY/SELL signal when
  // present, but its absence no longer penalizes an otherwise valid setup.

  // RULE: If ADX < 20 (ranging) -> apply balanced adjustment (0.88x)
  if (layer0.adx < 20 && action !== 'HOLD') {
    finalConfidence *= 0.88;
    penalties.push(`התאמת שוק דשדוש (ADX ${layer0.adx} < 20): ביטחון הותאם ב-0.88x`);
  }

  // RULE: If regime is TRANSITIONAL -> apply light adjustment (0.92x)
  if (layer0.regime === 'TRANSITIONAL' && action !== 'HOLD') {
    finalConfidence *= 0.92;
  }

  // RULE: Market Sentiment (Fear & Greed Index 0-100)
  if (fearGreedIndex < 25) {
    if (action === 'BUY') {
      finalConfidence *= 1.06;
      penalties.push(`חיזוק סנטימנט: פחד קיצוני (${fearGreedIndex}/100) — אישור מוגבר לקנייה בהיפוך (Oversold)`);
    } else if (action === 'SELL') {
      finalConfidence *= 0.90;
      penalties.push(`ריסון סנטימנט: פחד קיצוני (${fearGreedIndex}/100) — זהירות ממכירת פאניקה בתחתית`);
    }
  } else if (fearGreedIndex > 75) {
    if (action === 'SELL') {
      finalConfidence *= 1.06;
      penalties.push(`חיזוק סנטימנט: חמדנות קיצונית (${fearGreedIndex}/100) — אישור למימוש רווחים/SHORT`);
    } else if (action === 'BUY') {
      finalConfidence *= 0.90;
      penalties.push(`ריסון סנטימנט: חמדנות קיצונית (${fearGreedIndex}/100) — זהירות מרכישת FOMO בשיא`);
    }
  }

  finalConfidence = Math.min(98, Math.max(0, Math.round(finalConfidence * 10) / 10));

  return {
    action,
    confidence: finalConfidence,
    signals,
    rawConfidence: Math.round(rawConfidence * 10) / 10,
    penalties
  };
}

// ═══════════════════════════════════════════════════════
// LAYER 2 — TRADE TYPE ROUTER
// ═══════════════════════════════════════════════════════

export function routeTradeType(
  signalResult: SignalEngineResult,
  layer0: MarketRegimeResult,
  hasExistingFuturesPosition: boolean = false,
  riskLevel: 'low' | 'medium' | 'high' = 'medium'
): TradeRouterResult {
  const { action, confidence } = signalResult;

  // Risk profile controls the confidence thresholds for entering trades.
  // High risk lowers the bar (trades more aggressively); low risk raises it.
  // Thresholds are calibrated so a clear 3-signal trend consensus
  // (MACD + EMA + Supertrend) can trigger a SPOT trade without requiring a
  // rare volume surge, which previously made the bot never trade.
  const spotMinConfidence = riskLevel === 'high' ? 35 : riskLevel === 'low' ? 48 : 40;
  const futuresMinConfidence = riskLevel === 'high' ? 42 : riskLevel === 'low' ? 56 : 46;

  if (action === 'HOLD' || confidence < spotMinConfidence) {
    return {
      type: 'HOLD',
      side: 'NONE',
      reason: `ביטחון נמוך מהסף לפעולה (${confidence}% < ${spotMinConfidence}%)`
    };
  }

  // FUTURES Conditions Check:
  // ✓ regime === TRENDING
  // ✓ confidence >= futuresMinConfidence
  // ✓ volatility: LOW / NORMAL / HIGH (HIGH -> lower leverage)
  // ✓ ADX > 25
  // ✓ no open Futures position for this asset
  const isFuturesEligible =
    layer0.regime === 'TRENDING' &&
    confidence >= futuresMinConfidence &&
    layer0.adx > 25 &&
    !hasExistingFuturesPosition;

  if (isFuturesEligible) {
    const side: TradeSide = action === 'BUY' ? 'LONG' : 'SHORT';
    return {
      type: 'FUTURES',
      side,
      reason: `התקיימו כל תנאי Futures: מגמתי (ADX ${layer0.adx}), ביטחון ${confidence}%, תנודתיות ${layer0.volatility}`
    };
  }

  // SPOT Conditions Check:
  // confidence >= spotMinConfidence across any regime
  const isSpotEligible =
    confidence >= spotMinConfidence &&
    (layer0.regime === 'TRENDING' || layer0.regime === 'RANGING' || layer0.regime === 'TRANSITIONAL');

  if (isSpotEligible) {
    const side: TradeSide = action === 'BUY' ? 'BUY' : 'SELL';
    let reason = `עסקת Spot: ביטחון ${confidence}% במצב ${layer0.regime}`;
    if (layer0.regime === 'TRENDING' && confidence < futuresMinConfidence) {
      reason += ` (ביטחון מתחת ל-${futuresMinConfidence}% הנדרש ל-Futures)`;
    } else if (layer0.regime === 'TRANSITIONAL') {
      reason += ' (משטר מעבר — Spot מוגן ללא מינוף)';
    } else if (layer0.volatility === 'HIGH') {
      reason += ' (תנודתיות גבוהה — Spot בלבד ללא מינוף)';
    } else if (hasExistingFuturesPosition) {
      reason += ' (קיימת כבר פוזיציית Futures פתוחה)';
    }
    return {
      type: 'SPOT',
      side,
      reason
    };
  }

  return {
    type: 'HOLD',
    side: 'NONE',
    reason: 'לא עומד בתנאי Spot או Futures'
  };
}

// ═══════════════════════════════════════════════════════
// LAYER 3.5 — ENTRY TIMING VALIDATOR
// Determines the optimal limit price and validates that
// market conditions are suitable for entry right now.
// Prevents buying at local peaks (RSI overbought, price
// at BB upper, price far above EMA20).
// ═══════════════════════════════════════════════════════

export interface EntryTimingResult {
  /** Whether conditions are right to place an entry order now */
  shouldEnterNow: boolean;
  /** Optimal limit price (ATR-based pullback from current price) */
  entryPrice: number;
  /** Human-readable reason for the decision */
  reason: string;
  /** Computed indicators used for the decision */
  indicators: {
    rsi: number;
    ema20: number;
    bbUpper: number;
    bbLower: number;
    atrPullback: number;
  };
}

/**
 * Compute entry timing indicators from candle data.
 * Reuses the same math already in evaluateSignals but exposed
 * as a standalone helper so executeOrder can call it.
 */
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
 * Layer 3.5 — Entry Timing Validator
 *
 * Validates that this is a good moment to enter a trade (not at a local peak)
 * and computes an optimal limit price using an ATR-based pullback.
 *
 * Rules for BUY / LONG:
 *   - RSI must be < 72 (not overbought — avoid chasing)
 *   - Price must be < BB_Upper × 0.999 (not at the top of the band)
 *   - Price must be < EMA20 + 1.5×ATR  (not excessively extended)
 *   - Limit price = currentPrice − ATR × pullbackFactor (default 0.35)
 *
 * Rules for SELL / SHORT:
 *   - RSI must be > 28 (not oversold — avoid shorting the bottom)
 *   - Price must be > BB_Lower × 1.001 (not at the bottom of the band)
 *   - Price must be > EMA20 − 1.5×ATR  (not excessively compressed)
 *   - Limit price = currentPrice + ATR × pullbackFactor
 */
export function calculateOptimalEntry(
  currentPrice: number,
  atr: number,
  side: 'BUY' | 'LONG' | 'SELL' | 'SHORT',
  candles: Candle[],
  /** ATR multiplier for the pullback distance (default 0.35 = gentle limit) */
  pullbackFactor: number = 0.35
): EntryTimingResult {
  const isBuy = side === 'BUY' || side === 'LONG';

  // Derive indicators (safe even with short candle history)
  const { rsi, ema20, bbUpper, bbLower } = computeEntryIndicators(candles, currentPrice);
  const atrPullback = atr * pullbackFactor;

  if (isBuy) {
    // ── Rejection gates for BUY/LONG ──────────────────────────────
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
        reason: `מחיר מעל/בשיא רצועת Bollinger עליונה ($${bbUpper.toFixed(4)}) — ממתין לנסיגה`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }
    if (currentPrice > ema20 + atr * 1.5) {
      return {
        shouldEnterNow: false,
        entryPrice: currentPrice,
        reason: `מחיר מורחק יותר מ-1.5×ATR מ-EMA20 ($${ema20.toFixed(4)}) — ממתין לנסיגה לממוצע`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }

    // ── Optimal limit price: slight pullback below current price ───
    const entryPrice = Math.max(0.0001, currentPrice - atrPullback);
    return {
      shouldEnterNow: true,
      entryPrice: Number(entryPrice.toFixed(8)),
      reason: `Limit BUY @ $${entryPrice.toFixed(4)} (pullback ${(pullbackFactor * 100).toFixed(0)}% ATR מתחת למחיר הנוכחי) | RSI=${rsi.toFixed(1)}`,
      indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
    };
  } else {
    // ── Rejection gates for SELL/SHORT ────────────────────────────
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
        reason: `מחיר בשפל רצועת Bollinger תחתונה ($${bbLower.toFixed(4)}) — ממתין לעלייה`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }
    if (currentPrice < ema20 - atr * 1.5) {
      return {
        shouldEnterNow: false,
        entryPrice: currentPrice,
        reason: `מחיר מורחק יותר מ-1.5×ATR מתחת ל-EMA20 ($${ema20.toFixed(4)}) — ממתין לעלייה`,
        indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
      };
    }

    // ── Optimal limit price: slight bounce above current price ─────
    const entryPrice = currentPrice + atrPullback;
    return {
      shouldEnterNow: true,
      entryPrice: Number(entryPrice.toFixed(8)),
      reason: `Limit SELL/SHORT @ $${entryPrice.toFixed(4)} (pullback ${(pullbackFactor * 100).toFixed(0)}% ATR מעל המחיר הנוכחי) | RSI=${rsi.toFixed(1)}`,
      indicators: { rsi, ema20, bbUpper, bbLower, atrPullback }
    };
  }
}

// ═══════════════════════════════════════════════════════
// LAYER 3 — RISK MANAGEMENT ENGINE
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
  confidence: number,
  portfolioValue: number,
  closedTrades: ClosedTradeMetric[] = [],
  openPositionsCount: number = 0,
  openFuturesCount: number = 0,
  currentLeveragedExposureUsd: number = 0,
  configuredPositionPercent: number = 0.03
): RiskParametersResult | null {
  if (tradeType === 'HOLD' || entryPrice <= 0 || atr <= 0) return null;

  // Portfolio Level Safety Checks:
  // - Max 5 total open positions
  // - Max 2 Futures positions
  if (openPositionsCount >= 5) return null;
  if (tradeType === 'FUTURES' && openFuturesCount >= 2) return null;

  // 1. Dynamic ATR-based TP/SL
  let stopLoss: number;
  let takeProfit1: number | undefined;
  let takeProfit2: number | undefined;
  let takeProfit: number | undefined;
  let riskRewardRatio = 1.5;

  if (tradeType === 'SPOT') {
    // Spot: SL = entry - (ATR * 1.8), TP = entry + (ATR * 2.7)
    stopLoss = Math.max(0.0001, entryPrice - atr * 1.8);
    takeProfit = entryPrice + atr * 2.7;
    riskRewardRatio = (takeProfit - entryPrice) / (entryPrice - stopLoss);
  } else if (side === 'LONG') {
    // Futures Long: SL = entry - (ATR * 1.5), TP1 = entry + (ATR * 2.0), TP2 = entry + (ATR * 3.5)
    stopLoss = Math.max(0.0001, entryPrice - atr * 1.5);
    takeProfit1 = entryPrice + atr * 2.0;
    takeProfit2 = entryPrice + atr * 3.5;
    riskRewardRatio = (takeProfit1 - entryPrice) / (entryPrice - stopLoss);
  } else {
    // Futures Short: SL = entry + (ATR * 1.5), TP1 = entry - (ATR * 2.0), TP2 = entry - (ATR * 3.5)
    stopLoss = entryPrice + atr * 1.5;
    takeProfit1 = Math.max(0.0001, entryPrice - atr * 2.0);
    takeProfit2 = Math.max(0.0001, entryPrice - atr * 3.5);
    riskRewardRatio = (entryPrice - takeProfit1) / (stopLoss - entryPrice);
  }

  // 2. Leverage Logic
  // - volatility === LOW -> max 5x
  // - volatility === NORMAL -> max 3x
  // - volatility === HIGH -> max 2x
  // - confidence >= 80 -> +1x (up to 5x max)
  // - Never above 5x
  let leverage = 1;
  if (tradeType === 'FUTURES') {
    let baseLeverage = volatility === 'LOW' ? 5 : volatility === 'HIGH' ? 2 : 3;
    if (confidence >= 80) {
      baseLeverage = Math.min(5, baseLeverage + 1);
    }
    leverage = Math.min(5, Math.max(1, baseLeverage));
  }

  // 3. Position Sizing — Constrained Kelly Criterion
  // winRate from trade history (min 30 trades)
  // R = avgWin / avgLoss (or calculated R:R)
  let kellyFraction = 0.06; // Default conservative
  let betFraction = configuredPositionPercent; // Use configured percent (e.g., 0.10 for 10%)

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
    // betSize = portfolioValue * MIN(kellyFraction * 0.5, 0.1)
    betFraction = Math.min(Math.max(0.01, kellyFraction * 0.5), 0.10);
  } else {
    betFraction = configuredPositionPercent; // Use configured percent when no Kelly history
  }

  let betSizeUsd = portfolioValue * betFraction;

  // 4. Leveraged Portfolio Exposure Check
  // Total leveraged exposure must NOT exceed 20% of portfolio value
  if (tradeType === 'FUTURES') {
    const newExposure = betSizeUsd * leverage;
    const maxAllowedLeveragedExposure = portfolioValue * 0.20;
    const remainingExposureRoom = Math.max(0, maxAllowedLeveragedExposure - currentLeveragedExposureUsd);

    if (newExposure > remainingExposureRoom) {
      betSizeUsd = remainingExposureRoom / leverage;
    }
  }

  // Ensure minimal sensible order
  if (betSizeUsd < 5) return null;

  return {
    stopLoss: Number(stopLoss.toFixed(4)),
    takeProfit1: takeProfit1 ? Number(takeProfit1.toFixed(4)) : undefined,
    takeProfit2: takeProfit2 ? Number(takeProfit2.toFixed(4)) : undefined,
    takeProfit: takeProfit ? Number(takeProfit.toFixed(4)) : undefined,
    leverage,
    betSizeUsd: Number(betSizeUsd.toFixed(2)),
    positionPercentOfPortfolio: Number(((betSizeUsd / portfolioValue) * 100).toFixed(2)),
    riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
    kellyFraction: Number(kellyFraction.toFixed(4))
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
  currentSignalConfidence: { buy: number; sell: number },
  portfolioStats: { dailyDrawdownPercent: number; weeklyDrawdownPercent: number }
): ExitDecision {
  const isFutures = pos.type === 'FUTURES';
  const isLong = pos.side === 'LONG' || pos.side === 'BUY';
  const isShort = pos.side === 'SHORT';

  // 1. Drawdown Protection (Portfolio Level Circuit Breaker)
  if (portfolioStats.weeklyDrawdownPercent >= 15) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reason: `מנגנון הגנת תיק שבועי הופעל (Drawdown ${portfolioStats.weeklyDrawdownPercent.toFixed(1)}% >= 15%)`
    };
  }

  // 2. Stop Loss Hit
  if (isLong && currentPrice <= pos.stopLoss) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reason: `Stop Loss הופעל במחיר $${currentPrice.toFixed(4)} (SL: $${pos.stopLoss.toFixed(4)})`
    };
  }
  if (isShort && currentPrice >= pos.stopLoss) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reason: `Stop Loss הופעל במחיר $${currentPrice.toFixed(4)} (SL: $${pos.stopLoss.toFixed(4)})`
    };
  }

  // 3. Take Profit Logic
  if (!isFutures) {
    // Spot Take Profit
    if (pos.takeProfit1 && currentPrice >= pos.takeProfit1) {
      return {
        shouldExit: true,
        exitType: 'FULL',
        reason: `Take Profit מלא ב-Spot ($${currentPrice.toFixed(4)} >= $${pos.takeProfit1.toFixed(4)})`
      };
    }

    // Spot Trailing Stop (if in profit by 1.3 ATR from peak)
    const highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentPrice);
    const spotTrailingSL = highestPrice - currentAtr * 1.3;
    if (highestPrice > pos.entryPrice + currentAtr && currentPrice <= spotTrailingSL) {
      return {
        shouldExit: true,
        exitType: 'TRAILING_STOP',
        reason: `Trailing Stop ב-Spot נסגר במחיר $${currentPrice.toFixed(4)} (שיא: $${highestPrice.toFixed(4)})`
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
          reason: `Take Profit 2 הושג במלואו ($${currentPrice.toFixed(4)} >= $${pos.takeProfit2.toFixed(4)})`
        };
      }

      // TP1 (50% exit and activate trailing stop)
      if (!pos.tp1Hit && pos.takeProfit1 && currentPrice >= pos.takeProfit1) {
        return {
          shouldExit: true,
          exitType: 'PARTIAL_50',
          reason: `Take Profit 1 הושג ($${currentPrice.toFixed(4)} >= $${pos.takeProfit1.toFixed(4)}) — סגירת 50% והפעלת Trailing Stop`
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
            reason: `Trailing Stop בפיוצ'רס Long הופעל ($${currentPrice.toFixed(4)} <= $${trailingSL.toFixed(4)}, שיא: $${peak.toFixed(4)})`
          };
        }
      }
    } else if (isShort) {
      // Short TP2
      if (pos.takeProfit2 && currentPrice <= pos.takeProfit2) {
        return {
          shouldExit: true,
          exitType: 'FULL',
          reason: `Take Profit 2 בשורט הושג במלואו ($${currentPrice.toFixed(4)} <= $${pos.takeProfit2.toFixed(4)})`
        };
      }

      // Short TP1
      if (!pos.tp1Hit && pos.takeProfit1 && currentPrice <= pos.takeProfit1) {
        return {
          shouldExit: true,
          exitType: 'PARTIAL_50',
          reason: `Take Profit 1 בשורט הושג ($${currentPrice.toFixed(4)} <= $${pos.takeProfit1.toFixed(4)}) — סגירת 50% והפעלת Trailing Stop`
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
            reason: `Trailing Stop בפיוצ'רס Short הופעל ($${currentPrice.toFixed(4)} >= $${trailingSL.toFixed(4)}, שפל: $${valley.toFixed(4)})`
          };
        }
      }
    }
  }

  // 4. Signal Reversal Exit
  if (isLong && currentSignalConfidence.sell >= 65) {
    return {
      shouldExit: true,
      exitType: 'REVERSAL',
      reason: `היפוך אותות: זוהה ביטחון מכירה גבוה (${currentSignalConfidence.sell.toFixed(1)}% >= 65%)`
    };
  }
  if (isShort && currentSignalConfidence.buy >= 65) {
    return {
      shouldExit: true,
      exitType: 'REVERSAL',
      reason: `היפוך אותות: זוהה ביטחון קנייה גבוה (${currentSignalConfidence.buy.toFixed(1)}% >= 65%)`
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
 * Generates realistic slippage between 0.05% and 0.15%
 */
export function simulateSlippage(marketPrice: number, side: 'BUY' | 'SELL' | 'LONG' | 'SHORT'): { fillPrice: number; slippagePercent: number } {
  // Random slippage between 0.05% and 0.15%
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

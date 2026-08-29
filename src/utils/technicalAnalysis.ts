import { HistoricalPrice, TechnicalIndicators, BollingerBands, VolumeProfile } from '../types/crypto';
import { calculateAdvancedIndicators } from './advancedTechnicalAnalysis';

export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  // Calculate initial average gain and loss
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Calculate RSI using Wilder's smoothing method (more accurate)
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    // Wilder's smoothing formula
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calculateMovingAverage(prices: number[], period: number = 20): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  
  const recentPrices = prices.slice(-period);
  const sum = recentPrices.reduce((acc, price) => acc + price, 0);
  return sum / period;
}

export function calculateStandardDeviation(prices: number[], period: number = 20): number {
  if (prices.length < period) return 0;
  
  const recentPrices = prices.slice(-period);
  const mean = calculateMovingAverage(prices, period);
  
  const squaredDiffs = recentPrices.map(price => Math.pow(price - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / period;
  
  return Math.sqrt(avgSquaredDiff);
}

export function calculateBollingerBands(prices: number[], period: number = 20, multiplier: number = 2): BollingerBands {
  const middle = calculateMovingAverage(prices, period);
  const stdDev = calculateStandardDeviation(prices, period);
  
  const upper = middle + (stdDev * multiplier);
  const lower = middle - (stdDev * multiplier);
  const currentPrice = prices[prices.length - 1];
  
  let position: 'above' | 'below' | 'between';
  if (currentPrice > upper) {
    position = 'above';
  } else if (currentPrice < lower) {
    position = 'below';
  } else {
    position = 'between';
  }
  
  return {
    upper,
    middle,
    lower,
    position
  };
}

export function calculateVolumeProfile(historicalData: HistoricalPrice[], volumes: number[]): VolumeProfile {
  if (historicalData.length === 0 || volumes.length === 0) {
    const defaultPrice = historicalData[historicalData.length - 1]?.price || 0;
    return {
      poc: defaultPrice,
      valueAreaHigh: defaultPrice * 1.02,
      valueAreaLow: defaultPrice * 0.98,
      position: 'in_value_area'
    };
  }

  // יצירת טווחי מחירים עם נפח מצטבר
  const priceVolumeMap = new Map<number, number>();
  
  for (let i = 0; i < Math.min(historicalData.length, volumes.length); i++) {
    const price = historicalData[i].price;
    if (!(price > 0)) continue;
    // Bucket by price MAGNITUDE, not absolute dollar rounding: Math.round()
    // buckets every sub-dollar coin (e.g. 0.02667, 0.000003647) into the 0/1
    // bin, collapsing the profile to poc/VAH/VAL = 0 with a bogus
    // 'above_vah' position. Bucket scale ≈ 1% of the price's order of
    // magnitude so BTC (78k) and micro-caps (< 0.0001) both profile normally.
    const scale = Math.pow(10, Math.floor(Math.log10(price)) - 1);
    const bucket = Math.round(price / scale) * scale;
    const volume = volumes[i] || 0;
    
    priceVolumeMap.set(bucket, (priceVolumeMap.get(bucket) || 0) + volume);
  }
  
  // מציאת POC (Point of Control) - המחיר עם הנפח הגבוה ביותר
  let maxVolume = 0;
  let poc = 0;
  
  for (const [price, volume] of priceVolumeMap.entries()) {
    if (volume > maxVolume) {
      maxVolume = volume;
      poc = price;
    }
  }
  
  // חישוב Value Area (70% מהנפח הכולל)
  const totalVolume = Array.from(priceVolumeMap.values()).reduce((sum, vol) => sum + vol, 0);
  const targetVolume = totalVolume * 0.7;
  
  // מיון מחירים לפי נפח (יורד)
  const sortedByVolume = Array.from(priceVolumeMap.entries())
    .sort((a, b) => b[1] - a[1]);
  
  let accumulatedVolume = 0;
  const valueAreaPrices: number[] = [];
  
  for (const [price, volume] of sortedByVolume) {
    accumulatedVolume += volume;
    valueAreaPrices.push(price);
    
    if (accumulatedVolume >= targetVolume) break;
  }
  
  const valueAreaHigh = Math.max(...valueAreaPrices);
  const valueAreaLow = Math.min(...valueAreaPrices);
  
  // קביעת מיקום המחיר הנוכחי
  const currentPrice = historicalData[historicalData.length - 1]?.price || poc;
  let position: 'above_vah' | 'below_val' | 'in_value_area';
  
  if (currentPrice > valueAreaHigh) {
    position = 'above_vah';
  } else if (currentPrice < valueAreaLow) {
    position = 'below_val';
  } else {
    position = 'in_value_area';
  }
  
  return {
    poc,
    valueAreaHigh,
    valueAreaLow,
    position
  };
}

export function analyzeVolumeTrend(volumes: number[]): 'increasing' | 'decreasing' | 'stable' {
  if (volumes.length < 10) return 'stable';
  
  const recent = volumes.slice(-5);
  const previous = volumes.slice(-10, -5);
  
  const recentAvg = recent.reduce((sum, vol) => sum + vol, 0) / recent.length;
  const previousAvg = previous.reduce((sum, vol) => sum + vol, 0) / previous.length;
  
  const change = (recentAvg - previousAvg) / previousAvg;
  
  if (change > 0.1) return 'increasing';
  if (change < -0.1) return 'decreasing';
  return 'stable';
}

export function calculateTechnicalIndicators(
  historicalData: HistoricalPrice[],
  volumes: number[]
): TechnicalIndicators {
  const prices = historicalData.map(d => d.price);
  
  // Calculate basic indicators
  const basicIndicators = {
    rsi: calculateRSI(prices),
    ma20: calculateMovingAverage(prices),
    volumeTrend: analyzeVolumeTrend(volumes),
    bollingerBands: calculateBollingerBands(prices),
    volumeProfile: calculateVolumeProfile(historicalData, volumes)
  };
  
  // Calculate advanced indicators
  let advancedIndicators = {};
  try {
    if (historicalData.length >= 30) { // Ensure we have enough data
      advancedIndicators = calculateAdvancedIndicators(historicalData);
    }
  } catch (error) {
    console.warn('Error calculating advanced indicators:', error);
  }
  
  return {
    ...basicIndicators,
    ...advancedIndicators
  };
}

// Calculate composite technical score (0-100)
export function calculateTechnicalScore(indicators: TechnicalIndicators): number {
  let score = 50; // Start with neutral
  let factors = 0;
  
  // RSI scoring
  if (indicators.rsi < 30) {
    score += 20; // Oversold - bullish
  } else if (indicators.rsi > 70) {
    score -= 20; // Overbought - bearish
  } else if (indicators.rsi >= 40 && indicators.rsi <= 60) {
    score += 5; // Healthy range
  }
  factors++;
  
  // Bollinger Bands scoring
  if (indicators.bollingerBands.position === 'below') {
    score += 15; // Below lower band - bullish
  } else if (indicators.bollingerBands.position === 'above') {
    score -= 15; // Above upper band - bearish
  }
  factors++;
  
  // Volume trend scoring
  if (indicators.volumeTrend === 'increasing') {
    score += 10;
  } else if (indicators.volumeTrend === 'decreasing') {
    score -= 5;
  }
  factors++;
  
  // MACD scoring
  if (indicators.macd) {
    if (indicators.macd.trend === 'bullish') {
      score += 15;
    } else if (indicators.macd.trend === 'bearish') {
      score -= 15;
    }
    factors++;
  }
  
  // Stochastic scoring
  if (indicators.stochastic) {
    if (indicators.stochastic.signal === 'oversold') {
      score += 10;
    } else if (indicators.stochastic.signal === 'overbought') {
      score -= 10;
    }
    factors++;
  }
  
  // Support/Resistance scoring
  if (indicators.supportResistance) {
    if (indicators.supportResistance.currentLevel === 'support') {
      score += 12;
    } else if (indicators.supportResistance.currentLevel === 'resistance') {
      score -= 12;
    }
    factors++;
  }
  
  // Normalize score to 0-100 range
  return Math.max(0, Math.min(100, score));
}

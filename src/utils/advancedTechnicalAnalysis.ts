
import { HistoricalPrice } from '../types/crypto';

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
  trend: 'bullish' | 'bearish' | 'neutral';
}

export interface StochasticResult {
  k: number;
  d: number;
  signal: 'overbought' | 'oversold' | 'neutral';
}

export interface FibonacciLevels {
  high: number;
  low: number;
  levels: {
    level: number;
    price: number;
    label: string;
  }[];
}

export interface SupportResistance {
  support: number[];
  resistance: number[];
  currentLevel: 'support' | 'resistance' | 'between';
}

// Calculate MACD (Moving Average Convergence Divergence)
export function calculateMACD(
  prices: number[], 
  fastPeriod: number = 12, 
  slowPeriod: number = 26, 
  signalPeriod: number = 9
): MACDResult {
  if (prices.length < slowPeriod + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0, trend: 'neutral' };
  }

  // Calculate EMAs
  const fastEMA = calculateEMA(prices, fastPeriod);
  const slowEMA = calculateEMA(prices, slowPeriod);
  
  // Calculate MACD line
  const macdLine: number[] = [];
  for (let i = slowPeriod - 1; i < prices.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }
  
  // Calculate Signal line (EMA of MACD)
  const signalLine = calculateEMA(macdLine, signalPeriod);
  
  const currentMacd = macdLine[macdLine.length - 1];
  const currentSignal = signalLine[signalLine.length - 1];
  const histogram = currentMacd - currentSignal;
  
  // Determine trend
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (currentMacd > currentSignal && histogram > 0) {
    trend = 'bullish';
  } else if (currentMacd < currentSignal && histogram < 0) {
    trend = 'bearish';
  }
  
  return {
    macd: currentMacd,
    signal: currentSignal,
    histogram,
    trend
  };
}

// Calculate Stochastic Oscillator
export function calculateStochastic(
  highs: number[], 
  lows: number[], 
  closes: number[], 
  kPeriod: number = 14, 
  dPeriod: number = 3
): StochasticResult {
  if (highs.length < kPeriod || lows.length < kPeriod || closes.length < kPeriod) {
    return { k: 50, d: 50, signal: 'neutral' };
  }

  const kValues: number[] = [];
  
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const highestHigh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const lowestLow = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    const currentClose = closes[i];
    
    const k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    kValues.push(k);
  }
  
  // Calculate %D (SMA of %K)
  const dValues: number[] = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    const sum = kValues.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0);
    dValues.push(sum / dPeriod);
  }
  
  const currentK = kValues[kValues.length - 1];
  const currentD = dValues[dValues.length - 1];
  
  let signal: 'overbought' | 'oversold' | 'neutral' = 'neutral';
  if (currentK > 80 && currentD > 80) {
    signal = 'overbought';
  } else if (currentK < 20 && currentD < 20) {
    signal = 'oversold';
  }
  
  return { k: currentK, d: currentD, signal };
}

// Calculate Fibonacci Retracement Levels
export function calculateFibonacci(prices: number[], period: number = 30): FibonacciLevels {
  if (prices.length < period) {
    const currentPrice = prices[prices.length - 1] || 0;
    return {
      high: currentPrice,
      low: currentPrice,
      levels: []
    };
  }

  const recentPrices = prices.slice(-period);
  const high = Math.max(...recentPrices);
  const low = Math.min(...recentPrices);
  const range = high - low;
  
  const fibRatios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const levels = fibRatios.map(ratio => ({
    level: ratio,
    price: high - (range * ratio),
    label: `${(ratio * 100).toFixed(1)}%`
  }));
  
  return { high, low, levels };
}

// Calculate Support and Resistance Levels
export function calculateSupportResistance(prices: number[], period: number = 20): SupportResistance {
  if (prices.length < period * 2) {
    return {
      support: [],
      resistance: [],
      currentLevel: 'between'
    };
  }

  const currentPrice = prices[prices.length - 1];
  const support: number[] = [];
  const resistance: number[] = [];
  
  // Find local minima (support) and maxima (resistance)
  for (let i = period; i < prices.length - period; i++) {
    const leftPrices = prices.slice(i - period, i);
    const rightPrices = prices.slice(i + 1, i + period + 1);
    const currentPricePoint = prices[i];
    
    // Check if current point is a local minimum (support)
    const isSupport = leftPrices.every(p => p >= currentPricePoint) && 
                     rightPrices.every(p => p >= currentPricePoint);
                     
    // Check if current point is a local maximum (resistance)
    const isResistance = leftPrices.every(p => p <= currentPricePoint) && 
                        rightPrices.every(p => p <= currentPricePoint);
    
    if (isSupport) support.push(currentPricePoint);
    if (isResistance) resistance.push(currentPricePoint);
  }
  
  // Determine current level
  let currentLevel: 'support' | 'resistance' | 'between' = 'between';
  
  const nearestSupport = support.filter(s => s <= currentPrice).sort((a, b) => b - a)[0];
  const nearestResistance = resistance.filter(r => r >= currentPrice).sort((a, b) => a - b)[0];
  
  if (nearestSupport && Math.abs(currentPrice - nearestSupport) / currentPrice < 0.02) {
    currentLevel = 'support';
  } else if (nearestResistance && Math.abs(currentPrice - nearestResistance) / currentPrice < 0.02) {
    currentLevel = 'resistance';
  }
  
  return {
    support: support.slice(-5), // Keep last 5 support levels
    resistance: resistance.slice(-5), // Keep last 5 resistance levels
    currentLevel
  };
}

// Helper function to calculate EMA
function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);
  
  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period && i < prices.length; i++) {
    sum += prices[i];
  }
  ema.push(sum / Math.min(period, prices.length));
  
  // Calculate subsequent EMAs
  for (let i = period; i < prices.length; i++) {
    const currentEMA = (prices[i] * multiplier) + (ema[ema.length - 1] * (1 - multiplier));
    ema.push(currentEMA);
  }
  
  return ema;
}

// Calculate all advanced indicators
export function calculateAdvancedIndicators(historicalData: HistoricalPrice[]) {
  const prices = historicalData.map(d => d.price);
  const highs = prices; // Using close prices as approximation
  const lows = prices;
  const closes = prices;
  
  return {
    macd: calculateMACD(prices),
    stochastic: calculateStochastic(highs, lows, closes),
    fibonacci: calculateFibonacci(prices),
    supportResistance: calculateSupportResistance(prices)
  };
}


import { 
  CryptoRecommendation, 
  RecommendationType, 
  TechnicalIndicators, 
  CryptoData, 
  FearGreedIndex,
  EnhancedCryptoData 
} from '../types/crypto';
import { calculateTechnicalScore } from './technicalAnalysis';

interface SmartRecommendationParams {
  cryptoData: CryptoData;
  indicators: TechnicalIndicators;
  fearGreedIndex: FearGreedIndex;
  marketCap: number;
  volume24h: number;
}

interface WeightedSignal {
  signal: 'buy' | 'sell' | 'hold';
  weight: number;
  confidence: number;
  reason: string;
}

interface BollingerBandsData {
  lower: number;
  upper: number;
  position: string;
}

interface MacdData {
  macd: number;
  signal: number;
  histogram: number;
  trend: string;
}

interface StochasticData {
  k: number;
  d: number;
  signal: string;
}

interface SupportResistanceData {
  currentLevel: string;
  support: number[];
  resistance: number[];
}

export function generateSmartRecommendation({
  cryptoData,
  indicators,
  fearGreedIndex,
  marketCap,
  volume24h
}: SmartRecommendationParams): CryptoRecommendation {
  const signals: WeightedSignal[] = [];
  const currentPrice = cryptoData.current_price;
  const priceChange24h = cryptoData.price_change_percentage_24h || 0;
  
  console.log(`🧠 Smart analysis for ${cryptoData.symbol}:`, {
    currentPrice,
    priceChange24h,
    indicators,
    fearGreedIndex: fearGreedIndex.value
  });

  // 1. RSI Analysis (Weight: 15%)
  analyzeRSI(indicators.rsi, signals);
  
  // 2. Bollinger Bands Analysis (Weight: 12%)
  analyzeBollingerBands(indicators.bollingerBands, currentPrice, signals);
  
  // 3. MACD Analysis (Weight: 18%)
  if (indicators.macd) {
    analyzeMacd(indicators.macd, signals);
  }
  
  // 4. Stochastic Analysis (Weight: 10%)
  if (indicators.stochastic) {
    analyzeStochastic(indicators.stochastic, signals);
  }
  
  // 5. Support/Resistance Analysis (Weight: 15%)
  if (indicators.supportResistance) {
    analyzeSupportResistance(indicators.supportResistance, currentPrice, signals);
  }
  
  // 6. Volume Analysis (Weight: 10%)
  analyzeVolume(indicators.volumeTrend, priceChange24h, signals);
  
  // 7. Market Sentiment Analysis (Weight: 12%)
  analyzeMarketSentiment(fearGreedIndex, signals);
  
  // 8. Price Momentum Analysis (Weight: 8%)
  analyzePriceMomentum(priceChange24h, signals);
  
  // Calculate weighted recommendation
  const recommendation = calculateWeightedRecommendation(signals);
  
  // Calculate risk level and timeframe
  const riskLevel = calculateRiskLevel(indicators, marketCap, volume24h);
  const timeframe = calculateTimeframe(indicators, recommendation.confidence);
  
  // Generate enhanced reasoning
  const reasoning = generateEnhancedReasoning(signals, indicators, fearGreedIndex);
  
  // Calculate suggested amounts with risk management
  const suggestedAmounts = calculateRiskAdjustedAmounts(
    recommendation.recommendation,
    recommendation.confidence,
    currentPrice,
    marketCap,
    riskLevel
  );

  return {
    symbol: cryptoData.symbol.toUpperCase(),
    recommendation: recommendation.recommendation,
    confidence: recommendation.confidence,
    reasoning,
    indicators,
    currentPrice,
    priceChange24h,
    suggestedAmounts,
    riskLevel,
    timeframe
  };
}

function analyzeRSI(rsi: number, signals: WeightedSignal[]): void {
  if (rsi <= 25) {
    signals.push({
      signal: 'buy',
      weight: 15,
      confidence: 90,
      reason: `RSI קיצוני נמוך (${rsi.toFixed(1)}) - oversold חזק`
    });
  } else if (rsi <= 35) {
    signals.push({
      signal: 'buy',
      weight: 15,
      confidence: 75,
      reason: `RSI נמוך (${rsi.toFixed(1)}) - oversold`
    });
  } else if (rsi >= 75) {
    signals.push({
      signal: 'sell',
      weight: 15,
      confidence: 90,
      reason: `RSI קיצוני גבוה (${rsi.toFixed(1)}) - overbought חזק`
    });
  } else if (rsi >= 65) {
    signals.push({
      signal: 'sell',
      weight: 15,
      confidence: 70,
      reason: `RSI גבוה (${rsi.toFixed(1)}) - overbought`
    });
  } else if (rsi >= 45 && rsi <= 55) {
    signals.push({
      signal: 'hold',
      weight: 15,
      confidence: 80,
      reason: `RSI נייטרלי (${rsi.toFixed(1)})`
    });
  }
}

function analyzeBollingerBands(bb: BollingerBandsData, currentPrice: number, signals: WeightedSignal[]): void {
  const priceToBandRatio = (currentPrice - bb.lower) / (bb.upper - bb.lower);
  
  if (bb.position === 'below') {
    signals.push({
      signal: 'buy',
      weight: 12,
      confidence: 85,
      reason: `מחיר מתחת לרצועה התחתונה (${currentPrice.toFixed(2)} < ${bb.lower.toFixed(2)})`
    });
  } else if (bb.position === 'above') {
    signals.push({
      signal: 'sell',
      weight: 12,
      confidence: 85,
      reason: `מחיר מעל הרצועה העליונה (${currentPrice.toFixed(2)} > ${bb.upper.toFixed(2)})`
    });
  } else if (priceToBandRatio < 0.2) {
    signals.push({
      signal: 'buy',
      weight: 12,
      confidence: 70,
      reason: 'מחיר קרוב לרצועה התחתונה'
    });
  } else if (priceToBandRatio > 0.8) {
    signals.push({
      signal: 'sell',
      weight: 12,
      confidence: 70,
      reason: 'מחיר קרוב לרצועה העליונה'
    });
  }
}

function analyzeMacd(macd: MacdData, signals: WeightedSignal[]): void {
  if (macd.trend === 'bullish' && macd.histogram > 0) {
    const confidence = Math.min(95, 70 + Math.abs(macd.histogram) * 10);
    signals.push({
      signal: 'buy',
      weight: 18,
      confidence,
      reason: `MACD חיובי - מגמה עולה (${macd.macd.toFixed(4)} > ${macd.signal.toFixed(4)})`
    });
  } else if (macd.trend === 'bearish' && macd.histogram < 0) {
    const confidence = Math.min(95, 70 + Math.abs(macd.histogram) * 10);
    signals.push({
      signal: 'sell',
      weight: 18,
      confidence,
      reason: `MACD שלילי - מגמה יורדת (${macd.macd.toFixed(4)} < ${macd.signal.toFixed(4)})`
    });
  }
}

function analyzeStochastic(stoch: StochasticData, signals: WeightedSignal[]): void {
  if (stoch.signal === 'oversold' && stoch.k < 25) {
    signals.push({
      signal: 'buy',
      weight: 10,
      confidence: 75,
      reason: `Stochastic oversold (%K: ${stoch.k.toFixed(1)}, %D: ${stoch.d.toFixed(1)})`
    });
  } else if (stoch.signal === 'overbought' && stoch.k > 75) {
    signals.push({
      signal: 'sell',
      weight: 10,
      confidence: 75,
      reason: `Stochastic overbought (%K: ${stoch.k.toFixed(1)}, %D: ${stoch.d.toFixed(1)})`
    });
  }
}

function analyzeSupportResistance(sr: SupportResistanceData, currentPrice: number, signals: WeightedSignal[]): void {
  if (sr.currentLevel === 'support') {
    signals.push({
      signal: 'buy',
      weight: 15,
      confidence: 80,
      reason: 'מחיר על רמת תמיכה חזקה'
    });
  } else if (sr.currentLevel === 'resistance') {
    signals.push({
      signal: 'sell',
      weight: 15,
      confidence: 75,
      reason: 'מחיר על רמת התנגדות חזקה'
    });
  }
  
  // Check proximity to support/resistance levels
  const nearestSupport = sr.support[sr.support.length - 1];
  const nearestResistance = sr.resistance[0];
  
  if (nearestSupport && (currentPrice - nearestSupport) / currentPrice < 0.03) {
    signals.push({
      signal: 'buy',
      weight: 8,
      confidence: 70,
      reason: `קרוב לתמיכה ($${nearestSupport.toFixed(2)})`
    });
  }
  
  if (nearestResistance && (nearestResistance - currentPrice) / currentPrice < 0.03) {
    signals.push({
      signal: 'sell',
      weight: 8,
      confidence: 65,
      reason: `קרוב להתנגדות ($${nearestResistance.toFixed(2)})`
    });
  }
}

function analyzeVolume(volumeTrend: string, priceChange: number, signals: WeightedSignal[]): void {
  if (volumeTrend === 'increasing' && priceChange > 0) {
    signals.push({
      signal: 'buy',
      weight: 10,
      confidence: 75,
      reason: 'נפח עולה עם מחירים עולים - אישור מגמה'
    });
  } else if (volumeTrend === 'increasing' && priceChange < -2) {
    signals.push({
      signal: 'sell',
      weight: 10,
      confidence: 70,
      reason: 'נפח עולה עם מחירים יורדים - לחץ מכירות'
    });
  } else if (volumeTrend === 'decreasing' && Math.abs(priceChange) > 3) {
    signals.push({
      signal: 'hold',
      weight: 10,
      confidence: 60,
      reason: 'נפח נמוך - מגמה לא מאושרת'
    });
  }
}

function analyzeMarketSentiment(fearGreed: FearGreedIndex, signals: WeightedSignal[]): void {
  const fgValue = fearGreed.value;
  
  if (fgValue <= 20) {
    signals.push({
      signal: 'buy',
      weight: 12,
      confidence: 85,
      reason: `פחד קיצוני בשוק (${fgValue}) - הזדמנות קנייה`
    });
  } else if (fgValue <= 35) {
    signals.push({
      signal: 'buy',
      weight: 12,
      confidence: 70,
      reason: `פחד בשוק (${fgValue}) - שקול קנייה`
    });
  } else if (fgValue >= 80) {
    signals.push({
      signal: 'sell',
      weight: 12,
      confidence: 80,
      reason: `חמדנות קיצונית (${fgValue}) - שקול מכירה`
    });
  } else if (fgValue >= 70) {
    signals.push({
      signal: 'sell',
      weight: 12,
      confidence: 65,
      reason: `חמדנות בשוק (${fgValue}) - זהירות`
    });
  }
}

function analyzePriceMomentum(priceChange: number, signals: WeightedSignal[]): void {
  if (priceChange > 8) {
    signals.push({
      signal: 'sell',
      weight: 8,
      confidence: 70,
      reason: `עלייה חדה (+${priceChange.toFixed(1)}%) - שקול מימוש רווחים`
    });
  } else if (priceChange < -8) {
    signals.push({
      signal: 'buy',
      weight: 8,
      confidence: 70,
      reason: `ירידה חדה (${priceChange.toFixed(1)}%) - הזדמנות קנייה`
    });
  } else if (priceChange > 3 && priceChange <= 8) {
    signals.push({
      signal: 'buy',
      weight: 8,
      confidence: 60,
      reason: `מומנטום חיובי (+${priceChange.toFixed(1)}%)`
    });
  }
}

function calculateWeightedRecommendation(signals: WeightedSignal[]): { recommendation: RecommendationType; confidence: number } {
  if (signals.length === 0) {
    return { recommendation: 'hold', confidence: 45 };
  }

  let buyScore = 0;
  let sellScore = 0;
  let holdScore = 0;
  let totalWeight = 0;

  signals.forEach(signal => {
    // Score of each signal in "weight points" (0..weight)
    const weighted = signal.weight * (signal.confidence / 100);

    switch (signal.signal) {
      case 'buy':
        buyScore += weighted;
        break;
      case 'sell':
        sellScore += weighted;
        break;
      case 'hold':
        holdScore += weighted;
        break;
    }

    totalWeight += signal.weight;
  });

  const maxScore = Math.max(buyScore, sellScore, holdScore);
  const secondScore = [buyScore, sellScore, holdScore]
    .sort((a, b) => b - a)[1] || 0;

  let recommendation: RecommendationType;
  if (maxScore === buyScore) recommendation = 'buy';
  else if (maxScore === sellScore) recommendation = 'sell';
  else recommendation = 'hold';

  // Share of the total weight that supports the winning side (0..1)
  const dominance = totalWeight > 0 ? maxScore / totalWeight : 0;
  // How clearly it beats the opposing side (0..1)
  const margin = maxScore > 0 ? (maxScore - secondScore) / maxScore : 0;
  // How much of the full indicator set actually produced a signal (0..1)
  const coverage = Math.min(1, totalWeight / 88);

  // Real confidence: 50 baseline + evidence, scaled by coverage
  const raw = 50 + (dominance * 45 + margin * 25) * coverage - (1 - coverage) * 10;

  const cap = recommendation === 'hold' ? 85 : 97;
  const confidence = Math.round(Math.min(cap, Math.max(20, raw)) * 10) / 10;

  return { recommendation, confidence };
}


function calculateRiskLevel(indicators: TechnicalIndicators, marketCap: number, volume: number): 'low' | 'medium' | 'high' {
  let riskScore = 0;
  
  // Market cap risk
  if (marketCap < 100000000) riskScore += 3; // Under 100M - high risk
  else if (marketCap < 1000000000) riskScore += 2; // Under 1B - medium risk
  else riskScore += 1; // Over 1B - lower risk
  
  // Volume risk
  const volumeToMarketCapRatio = volume / marketCap;
  if (volumeToMarketCapRatio < 0.01) riskScore += 2; // Low volume
  else if (volumeToMarketCapRatio > 0.5) riskScore += 1; // Very high volume
  
  // Technical volatility
  if (indicators.rsi < 25 || indicators.rsi > 75) riskScore += 1;
  if (indicators.bollingerBands.position !== 'between') riskScore += 1;
  
  if (riskScore >= 5) return 'high';
  if (riskScore >= 3) return 'medium';
  return 'low';
}

function calculateTimeframe(indicators: TechnicalIndicators, confidence: number): 'short' | 'medium' | 'long' {
  // High confidence + strong signals = short term opportunities
  if (confidence > 85 && (indicators.rsi < 30 || indicators.rsi > 70)) {
    return 'short';
  }
  
  // MACD and trend-based signals = medium term
  if (indicators.macd && indicators.macd.trend !== 'neutral') {
    return 'medium';
  }
  
  // Support/resistance and fundamental levels = long term
  return 'long';
}

function generateEnhancedReasoning(signals: WeightedSignal[], indicators: TechnicalIndicators, fearGreed: FearGreedIndex): string {
  const topSignals = signals
    .sort((a, b) => (b.weight * b.confidence) - (a.weight * a.confidence))
    .slice(0, 3);
  
  let reasoning = '🎯 ניתוח מתקדם: ';
  reasoning += topSignals.map(s => s.reason).join(' | ');
  
  // Add technical score
  const techScore = calculateTechnicalScore(indicators);
  reasoning += ` | ציון טכני: ${techScore.toFixed(0)}/100`;
  
  return reasoning;
}

function calculateRiskAdjustedAmounts(
  recommendation: RecommendationType,
  confidence: number,
  currentPrice: number,
  marketCap: number,
  riskLevel: 'low' | 'medium' | 'high'
): { usd: number; crypto: number } {
  const baseAmount = 1000;
  
  // Risk adjustment
  const riskMultiplier = {
    'low': 1.0,
    'medium': 0.7,
    'high': 0.4
  }[riskLevel];
  
  // Confidence adjustment
  const confidenceMultiplier = confidence / 100;
  
  // Market cap adjustment
  let marketCapMultiplier = 1.0;
  if (marketCap < 100000000) marketCapMultiplier = 0.3;
  else if (marketCap < 1000000000) marketCapMultiplier = 0.6;
  else if (marketCap < 10000000000) marketCapMultiplier = 0.8;
  
  const finalAmount = Math.round(
    baseAmount * riskMultiplier * confidenceMultiplier * marketCapMultiplier
  );
  
  return {
    usd: Math.max(50, finalAmount),
    crypto: Math.max(0.001, finalAmount / currentPrice)
  };
}

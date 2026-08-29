/**
 * proAdvancedAnalysis — the site's "Advanced Analysis" math, lifted into the
 * 24/7 server engine so Bot Pro trades on exactly the recommendation the
 * Advanced Analysis page / smart-recommendation engine produces.
 *
 * Source of truth (identical pure functions):
 *   - src/utils/technicalAnalysis.ts        (calculateTechnicalIndicators)
 *   - src/utils/advancedTechnicalAnalysis.ts (calculateAdvancedIndicators)
 *   - src/utils/smartRecommendationEngine.ts (generateSmartRecommendation)
 *
 * This module is browser-independent (pure math only), so it runs safely in
 * the Node worker bundle (esbuild follows imports; tsconfig.worker.json pulls
 * the imported files in via the graph).
 *
 * Candle timeframe note: the site's page builds its analysis from 30 DAILY
 * candles. The worker already caches per-symbol candles (H1) that refresh on
 * the CANDLE cadence (not per tick), so this uses those same candles to keep
 * the 4s hot loop free of new network calls. The algorithm and recommendation
 * are IDENTICAL to the site — only the candle timeframe differs. To switch to
 * daily candles later, feed daily closes/volumes into computeProAdvancedAnalysis
 * (it is array-agnostic).
 */
import { Candle } from './tradeEngine';
import { HistoricalPrice, FearGreedIndex, TechnicalIndicators } from '../types/crypto';
import { calculateTechnicalIndicators } from '../utils/technicalAnalysis';
import { calculateAdvancedIndicators } from '../utils/advancedTechnicalAnalysis';
import { generateSmartRecommendation } from '../utils/smartRecommendationEngine';

export interface ProAdvancedSignal {
  name: string;
  weight: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  strength: number;
  value: string;
  reason: string;
}

export interface ProAdvancedPredictions {
  h24: number;
  h24pct: number;
  w: number;
  wpct: number;
  m: number;
  mpct: number;
  confidence: number;
}

export interface ProAdvancedResult {
  action: 'BUY' | 'SELL' | 'HOLD';
  recommendation: 'buy' | 'sell' | 'hold';
  /** 0-100 — used as the routing threshold score (rawConfidence). */
  confidence: number;
  reasoning: string;
  riskLevel: 'low' | 'medium' | 'high';
  timeframe: 'short' | 'medium' | 'long';
  predictions: ProAdvancedPredictions;
  supportLevel?: number;
  resistanceLevel?: number;
  williamsR: number;
  indicators: TechnicalIndicators;
  signals: ProAdvancedSignal[];
  penalties: string[];
}

/** Identical to the local helper in AdvancedAnalysis.tsx. */
function computeWilliamsR(prices: number[], period = 14): number {
  if (prices.length < period) return -50;
  const recent = prices.slice(-period);
  const highest = Math.max(...recent);
  const lowest = Math.min(...recent);
  const close = prices[prices.length - 1];
  if (highest === lowest) return -50;
  return ((highest - close) / (highest - lowest)) * -100;
}

export interface ProAdvancedInput {
  candles: Candle[];
  currentPrice: number;
  priceChange24h: number;
  fearGreedIndex: number;
  marketCap: number;
  volume24h: number;
  /** Used only for diagnostics (the "Smart analysis for X" log). */
  symbol?: string;
}


export function computeProAdvancedAnalysis(input: ProAdvancedInput): ProAdvancedResult {
  const { currentPrice, priceChange24h, fearGreedIndex, marketCap, volume24h } = input;

  const closes = input.candles.map((c) => c.close);
  const volumes = input.candles.map((c) => c.volume);

  // Build HistoricalPrice[] (like the site) and anchor the last close to the
  // live spot price so the analysis uses today's rate, not a stale candle.
  const historical: HistoricalPrice[] = input.candles.map((c, i) => ({
    timestamp: c.timestamp,
    price: c.close,
    volume: c.volume ?? 0,
  }));
  if (historical.length && currentPrice > 0) {
    historical[historical.length - 1].price = currentPrice;
    if (historical[historical.length - 1].volume === 0 && volumes.length) {
      historical[historical.length - 1].volume = volumes[volumes.length - 1] || 0;
    }
  }

  const indicators = calculateTechnicalIndicators(historical, volumes);
  const advanced = calculateAdvancedIndicators(historical);
  const prices = historical.map((h) => h.price);
  const williamsR = computeWilliamsR(prices);

  const fg: FearGreedIndex = {
    value: fearGreedIndex,
    value_classification: 'unknown',
    timestamp: new Date().toISOString(),
  };

  // generateSmartRecommendation only reads current_price / price_change / symbol
  // from cryptoData (marketCap & volume passed as their own args).
  const recommendation = generateSmartRecommendation({
    cryptoData: {
      id: '',
      symbol: input.symbol ?? '?',
      name: '',
      current_price: currentPrice,
      price_change_percentage_24h: priceChange24h,
      total_volume: volume24h,
      market_cap: marketCap,
      last_updated: '',
    },
    indicators,
    fearGreedIndex: fg,
    marketCap: marketCap || 0,
    volume24h,
  });

  // Live-derived projections from the recent price slope (no random data) —
  // identical to AdvancedAnalysis.tsx lines 224-240.
  const recent = prices.slice(-14);
  const slope = recent.length > 1 ? (recent[recent.length - 1] - recent[0]) / recent.length : 0;
  const last = prices[prices.length - 1] || 0;
  const h24 = last + slope * 1;
  const w = last + slope * 7;
  const m = last + slope * 30;
  const trendConfidence = Math.max(30, Math.min(95, 50 + (Math.abs(slope) / (last || 1)) * 1000));
  const predictions: ProAdvancedPredictions = {
    h24,
    h24pct: Number(((h24 / (last || 1) - 1) * 100).toFixed(1)),
    w,
    wpct: Number(((w / (last || 1) - 1) * 100).toFixed(1)),
    m,
    mpct: Number(((m / (last || 1) - 1) * 100).toFixed(1)),
    confidence: Number(trendConfidence.toFixed(0)),
  };

  const sr = advanced?.supportResistance ?? { support: [], resistance: [], currentLevel: 'between' };
  const supportLevel = sr.support.length ? sr.support[sr.support.length - 1] : undefined;
  const resistanceLevel = sr.resistance.length ? sr.resistance[sr.resistance.length - 1] : undefined;

  const action: 'BUY' | 'SELL' | 'HOLD' =
    recommendation.recommendation === 'buy'
      ? 'BUY'
      : recommendation.recommendation === 'sell'
        ? 'SELL'
        : 'HOLD';

  // Feed the same signals/penalties the old pro signal engine produced, for UI.
  const signals: ProAdvancedSignal[] = [
    {
      name: 'Advanced Analysis',
      weight: 50,
      signal: action === 'BUY' ? 'BUY' : action === 'SELL' ? 'SELL' : 'NEUTRAL',
      strength: 0.8,
      value: `${recommendation.recommendation.toUpperCase()} (${recommendation.confidence.toFixed(1)}%)`,
      reason: recommendation.reasoning,
    },
    {
      name: 'RSI',
      weight: 15,
      signal: indicators.rsi < 30 ? 'BUY' : indicators.rsi > 70 ? 'SELL' : 'NEUTRAL',
      strength: Number(Math.min(100, Math.abs(indicators.rsi - 50) * 2).toFixed(2)) / 100,
      value: indicators.rsi.toFixed(2),
      reason: indicators.rsi < 30 ? 'קניית-יתר' : indicators.rsi > 70 ? 'מכירת-יתר' : 'ניטרלי',
    },
    {
      name: 'MACD',
      weight: 18,
      signal: advanced?.macd?.trend === 'bullish' ? 'BUY' : advanced?.macd?.trend === 'bearish' ? 'SELL' : 'NEUTRAL',
      strength: Number(Math.min(100, Math.abs(advanced?.macd?.histogram ?? 0) * 500).toFixed(2)) / 100,
      value: String((advanced?.macd?.macd ?? 0).toFixed(4)),
      reason: advanced?.macd?.trend === 'bullish' ? 'MACD חיובי' : advanced?.macd?.trend === 'bearish' ? 'MACD שלילי' : 'ללא אות',
    },
    {
      name: 'Stochastic',
      weight: 10,
      signal: advanced?.stochastic?.signal === 'oversold' ? 'BUY' : advanced?.stochastic?.signal === 'overbought' ? 'SELL' : 'NEUTRAL',
      strength: Number((advanced?.stochastic?.k ?? 50).toFixed(2)) / 100,
      value: String((advanced?.stochastic?.k ?? 50).toFixed(2)),
      reason: advanced?.stochastic?.signal ?? 'neutral',
    },
    {
      name: 'Williams %R',
      weight: 7,
      signal: williamsR < -80 ? 'BUY' : williamsR > -20 ? 'SELL' : 'NEUTRAL',
      strength: Number((Math.abs(williamsR + 50) * 2).toFixed(2)) / 100,
      value: williamsR.toFixed(2),
      reason: williamsR < -80 ? 'קניית-יתר' : williamsR > -20 ? 'מכירת-יתר' : 'ניטרלי',
    },
  ];

  const penalties: string[] = [];
  if (fearGreedIndex < 25) penalties.push(`סנטימנט שוק: פחד קיצוני (${fearGreedIndex}/100)`);
  else if (fearGreedIndex > 75) penalties.push(`סנטימנט שוק: חמדנות קיצונית (${fearGreedIndex}/100)`);

  return {
    action,
    recommendation: recommendation.recommendation,
    confidence: recommendation.confidence,
    reasoning: recommendation.reasoning,
    riskLevel: recommendation.riskLevel ?? 'medium',
    timeframe: recommendation.timeframe ?? 'medium',
    predictions,
    supportLevel,
    resistanceLevel,
    williamsR,
    indicators,
    signals,
    penalties,
  };
}

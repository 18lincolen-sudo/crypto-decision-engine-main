
export interface CryptoData {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number;
  total_volume: number;
  market_cap: number;
  last_updated: string;
}

export interface HistoricalPrice {
  timestamp: number;
  price: number;
  volume: number;
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  position: 'above' | 'below' | 'between';
}

export interface VolumeProfile {
  poc: number;
  valueAreaHigh: number;
  valueAreaLow: number;
  position: 'above_vah' | 'below_val' | 'in_value_area';
}

export interface MACDIndicator {
  macd: number;
  signal: number;
  histogram: number;
  trend: 'bullish' | 'bearish' | 'neutral';
}

export interface StochasticIndicator {
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

export interface TechnicalIndicators {
  rsi: number;
  ma20: number;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
  bollingerBands: BollingerBands;
  volumeProfile: VolumeProfile;
  macd?: MACDIndicator;
  stochastic?: StochasticIndicator;
  fibonacci?: FibonacciLevels;
  supportResistance?: SupportResistance;
}

export interface FearGreedIndex {
  value: number;
  value_classification: string;
  timestamp: string;
}

export type RecommendationType = 'buy' | 'sell' | 'hold';

export interface CryptoRecommendation {
  symbol: string;
  recommendation: RecommendationType;
  confidence: number;
  reasoning: string;
  indicators: TechnicalIndicators;
  currentPrice: number;
  priceChange24h: number;
  suggestedAmounts?: {
    usd: number;
    crypto: number;
  };
  riskLevel?: 'low' | 'medium' | 'high';
  timeframe?: 'short' | 'medium' | 'long';
}

export interface PortfolioItem {
  symbol: string;
  allocation: number;
  quantity: number;
  investmentAmount: number;
  purchasePrice: number;
  purchaseDate: string;
}

export interface Portfolio {
  id: string;
  name: string;
  items: PortfolioItem[];
  totalValue?: number;
  performance24h?: number;
  totalInvestment: number;
  totalProfit: number;
  createdAt: string;
}

export interface PortfolioAnalysis {
  totalValue: number;
  totalInvestment: number;
  totalProfit: number;
  totalProfitPercentage: number;
  performance24h: number;
  dailyProfit: number;
  recommendations: {
    overall: RecommendationType;
    confidence: number;
    reasoning: string;
  };
  cryptoAnalysis: CryptoRecommendation[];
  holdings: Array<{
    symbol: string;
    currentValue: number;
    allocation: number;
    quantity: number;
    profit: number;
    profitPercentage: number;
  }>;
}

export interface CryptoChartData {
  date: string;
  price: number;
  volume: number;
}

// New interfaces for enhanced data
export interface MarketSentiment {
  social: number; // -100 to 100
  news: number; // -100 to 100
  overall: 'extremely_bearish' | 'bearish' | 'neutral' | 'bullish' | 'extremely_bullish';
}

export interface RiskMetrics {
  volatility: number;
  sharpeRatio: number;
  maxDrawdown: number;
  beta: number;
}

export interface EnhancedCryptoData extends CryptoData {
  sentiment?: MarketSentiment;
  riskMetrics?: RiskMetrics;
  technicalScore: number; // 0-100
  fundamentalScore: number; // 0-100
}

// ═══════════════════════════════════════════════════════
// Trade Engine Types (Spot + Futures Architecture)
// ═══════════════════════════════════════════════════════

export type MarketRegimeType = 'TRENDING' | 'RANGING' | 'TRANSITIONAL';
export type MarketDirectionType = 'BULL' | 'BEAR' | 'NEUTRAL';
export type VolatilityRegimeType = 'LOW' | 'NORMAL' | 'HIGH';
export type TradeType = 'SPOT' | 'FUTURES' | 'HOLD';
export type TradeSide = 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE';

export interface MarketRegimeResult {
  regime: MarketRegimeType;
  direction: MarketDirectionType;
  volatility: VolatilityRegimeType;
  adx: number;
  atr: number;
  atrPercent: number;
  supertrend: {
    value: number;
    direction: 'BULL' | 'BEAR';
  };
}

export interface IndicatorSignalDetail {
  name: string;
  weight: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  strength: number; // 0 to 1
  value: string;
  reason: string;
}

export interface SignalEngineResult {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0 to 100
  signals: IndicatorSignalDetail[];
  rawConfidence: number;
  penalties: string[];
}

export interface TradeRouterResult {
  type: TradeType;
  side: TradeSide;
  reason: string;
}

export interface RiskParametersResult {
  stopLoss: number;
  takeProfit1?: number; // For Futures (50% exit)
  takeProfit2?: number; // For Futures (remainder exit)
  takeProfit?: number; // For Spot
  leverage: number; // 1 for Spot, 1-5 for Futures
  betSizeUsd: number;
  positionPercentOfPortfolio: number;
  riskRewardRatio: number;
  kellyFraction: number;
}

export interface TradeEngineEvaluation {
  symbol: string;
  currentPrice: number;
  priceChange24h: number;
  layer0: MarketRegimeResult;
  layer1: SignalEngineResult;
  layer2: TradeRouterResult;
  layer3?: RiskParametersResult;
  willExecute: boolean;
  statusMessage: string;
}

export interface ActivePosition {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  avgPrice: number;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  trailingStopActive?: boolean;
  trailingStopPrice?: number;
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
  highestPrice?: number;
  lowestPrice?: number;
  tp1Hit: boolean;
  openedAt: string;
  openTimestamp: number;
  entryFee: number;
  reason: string;
  confidence: number;
}


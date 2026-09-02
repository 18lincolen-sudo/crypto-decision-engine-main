
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Eye, Clock, Shield, Target } from 'lucide-react';
import { CryptoRecommendation } from '../types/crypto';

const safeNumber = (value: unknown, fallback = 0): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

interface CryptoCardProps {
  recommendation: CryptoRecommendation;
  isClickable?: boolean;
}

const CryptoCard = ({ recommendation, isClickable = false }: CryptoCardProps) => {
  const {
    symbol,
    recommendation: rec,
    confidence,
    reasoning,
    indicators,
    currentPrice,
    priceChange24h,
    riskLevel,
    timeframe,
    suggestedAmounts
  } = recommendation;
  const safeCurrentPrice = safeNumber(currentPrice);
  const safePriceChange24h = safeNumber(priceChange24h);
  const safeRsi = safeNumber(indicators?.rsi, 50);
  const safeMa20 = safeNumber(indicators?.ma20, safeCurrentPrice);
  const safeMacd = safeNumber(indicators?.macd?.macd);
  const safeStochasticK = safeNumber(indicators?.stochastic?.k, 50);
  const safeSuggestedCrypto = safeNumber(suggestedAmounts?.crypto);

  const getRecommendationColor = (rec: string) => {
    switch (rec) {
      case 'buy': return 'bg-green-500 text-white';
      case 'sell': return 'bg-red-500 text-white';
      default: return 'bg-yellow-500 text-white';
    }
  };

  const getRecommendationText = (rec: string) => {
    switch (rec) {
      case 'buy': return 'קנייה';
      case 'sell': return 'מכירה';
      default: return 'החזקה';
    }
  };

  const getRSIColor = (rsi: number) => {
    if (rsi < 30) return 'text-green-600';
    if (rsi > 70) return 'text-red-600';
    return 'text-yellow-600';
  };

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case 'low': return 'text-green-600';
      case 'medium': return 'text-yellow-600';
      case 'high': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getRiskText = (risk: string) => {
    switch (risk) {
      case 'low': return 'נמוך';
      case 'medium': return 'בינוני';
      case 'high': return 'גבוה';
      default: return 'לא ידוע';
    }
  };

  const getTimeframeText = (timeframe: string) => {
    switch (timeframe) {
      case 'short': return 'קצר';
      case 'medium': return 'בינוני';
      case 'long': return 'ארוך';
      default: return 'בינוני';
    }
  };

  return (
    <Card className={`hover:shadow-lg transition-all ${isClickable ? 'cursor-pointer hover:scale-105' : ''}`}>
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            {symbol}
            {indicators.macd && (
              <div className="flex gap-1">
                {indicators.macd.trend === 'bullish' && <TrendingUp className="w-4 h-4 text-green-500" />}
                {indicators.macd.trend === 'bearish' && <TrendingDown className="w-4 h-4 text-red-500" />}
              </div>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge className={getRecommendationColor(rec)}>
              {getRecommendationText(rec)} ({confidence}%)
            </Badge>
            {isClickable && <Eye className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-2xl font-bold">
            ${safeCurrentPrice.toLocaleString()}
          </span>
          <div className={`flex items-center ${safePriceChange24h >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {safePriceChange24h >= 0 ? <TrendingUp className="w-4 h-4 mr-1" /> : <TrendingDown className="w-4 h-4 mr-1" />}
            <span className="font-medium">
              {safePriceChange24h >= 0 ? '+' : ''}{safePriceChange24h.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Advanced Indicators Grid */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">RSI:</span>
              <span className={`font-medium ${getRSIColor(safeRsi)}`}>
                {safeRsi.toFixed(1)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">MA20:</span>
              <span className="font-medium">
                ${safeMa20.toLocaleString()}
              </span>
            </div>
            {indicators.macd && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">MACD:</span>
                <span className={`font-medium ${
                  indicators.macd.trend === 'bullish' ? 'text-green-600' : 
                  indicators.macd.trend === 'bearish' ? 'text-red-600' : 'text-gray-600'
                }`}>
                  {safeMacd.toFixed(4)}
                </span>
              </div>
            )}
          </div>
          
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">BB:</span>
              <span className="font-medium text-xs">
                {indicators.bollingerBands.position === 'above' ? 'מעל' :
                 indicators.bollingerBands.position === 'below' ? 'מתחת' : 'ביניים'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">נפח:</span>
              <span className="font-medium text-xs">
                {indicators.volumeTrend === 'increasing' ? 'עולה' : 
                 indicators.volumeTrend === 'decreasing' ? 'יורד' : 'יציב'}
              </span>
            </div>
            {indicators.stochastic && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stoch:</span>
                <span className={`font-medium text-xs ${
                  indicators.stochastic.signal === 'oversold' ? 'text-green-600' :
                  indicators.stochastic.signal === 'overbought' ? 'text-red-600' : 'text-gray-600'
                }`}>
                  {safeStochasticK.toFixed(0)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Risk and Timeframe */}
        <div className="flex justify-between items-center text-sm">
          <div className="flex items-center gap-1">
            <Shield className="w-3 h-3" />
            <span className="text-muted-foreground">סיכון:</span>
            <span className={`font-medium ${getRiskColor(riskLevel || 'medium')}`}>
              {getRiskText(riskLevel || 'medium')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span className="text-muted-foreground">זמן:</span>
            <span className="font-medium">
              {getTimeframeText(timeframe || 'medium')}
            </span>
          </div>
        </div>

        {/* Suggested Amount */}
        {suggestedAmounts && rec !== 'hold' && (
          <div className="bg-muted rounded-lg p-2">
            <div className="flex items-center gap-1 mb-1">
              <Target className="w-3 h-3" />
              <span className="text-xs font-medium">סכום מומלץ:</span>
            </div>
            <div className="text-sm">
              <span className="font-bold">${suggestedAmounts.usd}</span>
              <span className="text-muted-foreground ml-2">
                ({safeSuggestedCrypto.toFixed(6)} {symbol})
              </span>
            </div>
          </div>
        )}

        <div className="pt-2 border-t">
          <p className="text-sm text-muted-foreground line-clamp-2">{reasoning}</p>
          {isClickable && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center">
              <Eye className="w-3 h-3 mr-1" />
              לחץ לפירוט מלא
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default CryptoCard;

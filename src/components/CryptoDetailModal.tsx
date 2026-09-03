
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { TrendingUp, TrendingDown, Clock, AlertTriangle } from 'lucide-react';
import { CryptoRecommendation } from '@cde/engine';

const safeNumber = (value: unknown, fallback = 0): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

interface CryptoDetailModalProps {
  crypto: CryptoRecommendation | null;
  isOpen: boolean;
  onClose: () => void;
}

const CryptoDetailModal = ({ crypto, isOpen, onClose }: CryptoDetailModalProps) => {
  if (!crypto) return null;

  const safeCurrentPrice = safeNumber(crypto.currentPrice);
  const safePriceChange24h = safeNumber(crypto.priceChange24h);
  const safeRsi = safeNumber(crypto.indicators?.rsi, 50);
  const safeMa20 = safeNumber(crypto.indicators?.ma20, safeCurrentPrice);

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

  const getRSISignal = (rsi: number) => {
    if (rsi < 30) return { text: 'אזור קנייה (Oversold)', color: 'text-green-600', urgent: true };
    if (rsi < 40) return { text: 'נוטה לקנייה', color: 'text-green-500', urgent: false };
    if (rsi > 70) return { text: 'אזור מכירה (Overbought)', color: 'text-red-600', urgent: true };
    if (rsi > 60) return { text: 'נוטה למכירה', color: 'text-red-500', urgent: false };
    return { text: 'אזור נייטרלי', color: 'text-yellow-600', urgent: false };
  };

  const getPriceVsMA = (price: number, ma: number) => {
    const diff = ((price - ma) / ma) * 100;
    if (Math.abs(diff) < 2) return { text: 'קרוב לממוצע', color: 'text-gray-600', signal: 'neutral' };
    return diff > 0 
      ? { text: `${diff.toFixed(1)}% מעל הממוצע`, color: diff > 10 ? 'text-red-600' : 'text-green-600', signal: diff > 10 ? 'sell' : 'bullish' }
      : { text: `${Math.abs(diff).toFixed(1)}% מתחת לממוצע`, color: 'text-green-600', signal: 'buy' };
  };

  const getVolumeSignal = (trend: string) => {
    switch (trend) {
      case 'increasing': return { text: 'נפח עולה - חיזוק לאות', color: 'text-green-600', icon: '📈' };
      case 'decreasing': return { text: 'נפח יורד - אות חלש', color: 'text-red-600', icon: '📉' };
      default: return { text: 'נפח יציב', color: 'text-yellow-600', icon: '➡️' };
    }
  };

  const rsiSignal = getRSISignal(safeRsi);
  const priceVsMA = getPriceVsMA(safeCurrentPrice, safeMa20);
  const volumeSignal = getVolumeSignal(crypto.indicators.volumeTrend);

  const getCurrentTimeRecommendation = () => {
    const hour = new Date().getHours();
    if (crypto.recommendation === 'buy' && hour >= 9 && hour <= 11) {
      return { text: 'זמן מומלץ לקנייה (בוקר)', color: 'text-green-600' };
    } else if (crypto.recommendation === 'sell' && hour >= 14 && hour <= 16) {
      return { text: 'זמן מומלץ למכירה (אחה"צ)', color: 'text-red-600' };
    } else if (hour >= 22 || hour <= 6) {
      return { text: 'שעות לילה - נפח נמוך', color: 'text-gray-500' };
    }
    return { text: 'זמן רגיל למסחר', color: 'text-gray-600' };
  };

  const timeRecommendation = getCurrentTimeRecommendation();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-center flex items-center justify-center gap-2">
            ניתוח מפורט - {crypto.symbol}
            {rsiSignal.urgent && <AlertTriangle className="w-5 h-5 text-orange-500" />}
          </DialogTitle>
          <DialogDescription className="sr-only">
            ניתוח טכני ואינדיקטורים מפורטים עבור {crypto.symbol}
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Current Price & Change */}
          <Card>
            <CardContent className="p-4">
              <div className="text-center">
                <div className="text-3xl font-bold mb-2">
                  ${safeCurrentPrice.toLocaleString()}
                </div>
                <div className={`flex items-center justify-center ${
                  safePriceChange24h >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {safePriceChange24h >= 0 ? 
                    <TrendingUp className="w-5 h-5 mr-1" /> : 
                    <TrendingDown className="w-5 h-5 mr-1" />
                  }
                  <span className="font-medium text-lg">
                    {safePriceChange24h >= 0 ? '+' : ''}{safePriceChange24h.toFixed(2)}%
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Main Recommendation */}
          <Card>
            <CardContent className="p-4">
              <div className="text-center mb-4">
                <Badge className={`text-lg py-2 px-4 mb-3 ${getRecommendationColor(crypto.recommendation)}`}>
                  {getRecommendationText(crypto.recommendation)} ({crypto.confidence}%)
                </Badge>
                <Progress 
                  value={crypto.confidence} 
                  className="h-3 mb-3"
                />
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {crypto.reasoning}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Technical Analysis */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">ניתוח טכני מתקדם</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* RSI Analysis */}
              <div className="p-3 border rounded-lg">
                <div className="flex justify-between items-start mb-2">
                  <span className="font-medium">RSI (14 ימים):</span>
                  <div className="text-right">
                    <div className="text-xl font-bold">{safeRsi.toFixed(1)}</div>
                    <div className={`text-sm ${rsiSignal.color} flex items-center gap-1`}>
                      {rsiSignal.urgent && <AlertTriangle className="w-3 h-3" />}
                      {rsiSignal.text}
                    </div>
                  </div>
                </div>
                <Progress value={safeRsi} className="h-2" />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>Oversold (30)</span>
                  <span>Neutral (50)</span>
                  <span>Overbought (70)</span>
                </div>
              </div>

              {/* Moving Average */}
              <div className="p-3 border rounded-lg">
                <div className="flex justify-between items-center">
                  <span className="font-medium">ממוצע נע (20 ימים):</span>
                  <div className="text-right">
                    <div className="text-lg font-bold">
                      ${safeMa20.toLocaleString()}
                    </div>
                    <div className={`text-sm ${priceVsMA.color}`}>
                      {priceVsMA.text}
                    </div>
                  </div>
                </div>
              </div>

              {/* Volume Analysis */}
              <div className="p-3 border rounded-lg">
                <div className="flex justify-between items-center">
                  <span className="font-medium">ניתוח נפח מסחר:</span>
                  <div className="text-right">
                    <div className={`font-medium ${volumeSignal.color} flex items-center gap-1`}>
                      <span>{volumeSignal.icon}</span>
                      {volumeSignal.text}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Time-based Trading */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="w-5 h-5" />
                המלצות לפי זמן
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between items-center">
                <span>זמן נוכחי:</span>
                <span className={timeRecommendation.color}>
                  {timeRecommendation.text}
                </span>
              </div>
              
              <div className="text-sm space-y-2">
                <div className="p-2 bg-muted rounded">
                  <strong>שעות מומלצות למסחר:</strong>
                  <br />
                  • קנייה: 09:00-11:00 (נפח גבוה, תנועתיות)
                  <br />
                  • מכירה: 14:00-16:00 (פעילות מרבית)
                  <br />
                  • הימנע: 22:00-06:00 (נפח נמוך)
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Trading Action Plan */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">תוכנית פעולה</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2 text-sm">
                {crypto.recommendation === 'buy' && (
                  <div className="space-y-1">
                    <div className="text-green-600 font-medium">📈 אסטרטגיית קנייה:</div>
                    <div>• רכישה הדרגתית ב-3-4 שלבים</div>
                    <div>• הפסקת הפסד: ${(safeCurrentPrice * 0.92).toFixed(2)}</div>
                    <div>• יעד ראשון: ${(safeCurrentPrice * 1.08).toFixed(2)}</div>
                    <div>• יעד שני: ${(safeCurrentPrice * 1.15).toFixed(2)}</div>
                  </div>
                )}
                {crypto.recommendation === 'sell' && (
                  <div className="space-y-1">
                    <div className="text-red-600 font-medium">📉 אסטרטגיית מכירה:</div>
                    <div>• מכירה הדרגתית של 25%-50%</div>
                    <div>• שמירה על פוזיציה חלקית</div>
                    <div>• יעד מכירה: ${(safeCurrentPrice * 0.95).toFixed(2)}</div>
                  </div>
                )}
                {crypto.recommendation === 'hold' && (
                  <div className="space-y-1">
                    <div className="text-yellow-600 font-medium">⚖️ אסטרטגיית החזקה:</div>
                    <div>• שמירה על פוזיציה נוכחית</div>
                    <div>• מעקב אחר RSI {'<'} 30 או {'>'} 70</div>
                    <div>• הכנה לפעולה בשינוי מגמה</div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CryptoDetailModal;

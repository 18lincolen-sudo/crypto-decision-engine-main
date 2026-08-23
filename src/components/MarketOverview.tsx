
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Activity, AlertTriangle, Target } from 'lucide-react';
import { useCryptoData } from '../hooks/useCryptoData';

const MarketOverview = () => {
  const { recommendations, fearGreedData, isLoading } = useCryptoData();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-6">
          <div className="text-center">
            <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-2 animate-pulse" />
            <p className="text-muted-foreground">טוען נתוני שוק...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const buyRecommendations = recommendations.filter(r => r.recommendation === 'buy');
  const sellRecommendations = recommendations.filter(r => r.recommendation === 'sell');
  const holdRecommendations = recommendations.filter(r => r.recommendation === 'hold');

  const averageConfidence = recommendations.length > 0 
    ? recommendations.reduce((sum, r) => sum + r.confidence, 0) / recommendations.length 
    : 0;

  const highRiskAssets = recommendations.filter(r => r.riskLevel === 'high').length;
  const strongBuySignals = buyRecommendations.filter(r => r.confidence > 80).length;
  const strongSellSignals = sellRecommendations.filter(r => r.confidence > 80).length;

  const getFearGreedColor = (value: number) => {
    if (value <= 25) return 'text-red-600 bg-red-50';
    if (value <= 45) return 'text-orange-600 bg-orange-50';
    if (value <= 55) return 'text-yellow-600 bg-yellow-50';
    if (value <= 75) return 'text-green-600 bg-green-50';
    return 'text-red-600 bg-red-50';
  };

  const getFearGreedText = (classification: string) => {
    const textMap: Record<string, string> = {
      'Extreme Fear': 'פחד קיצוני',
      'Fear': 'פחד',
      'Neutral': 'נייטרלי',
      'Greed': 'חמדנות',
      'Extreme Greed': 'חמדנות קיצונית'
    };
    return textMap[classification] || classification;
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {/* Market Sentiment */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">רגש השוק</CardTitle>
        </CardHeader>
        <CardContent>
          {fearGreedData ? (
            <div className="space-y-2">
              <div className="text-2xl font-bold">{fearGreedData.value}</div>
              <Badge className={`text-xs ${getFearGreedColor(fearGreedData.value)}`}>
                {getFearGreedText(fearGreedData.value_classification)}
              </Badge>
              <p className="text-xs text-muted-foreground">
                {fearGreedData.value <= 35 ? '🎯 הזדמנות קנייה' : 
                 fearGreedData.value >= 70 ? '⚠️ זהירות - חמדנות' : '⚖️ מצב מאוזן'}
              </p>
            </div>
          ) : (
            <div className="text-muted-foreground">טוען...</div>
          )}
        </CardContent>
      </Card>

      {/* Recommendations Summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">פילוח המלצות</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-1">
                <TrendingUp className="w-3 h-3 text-green-600" />
                <span className="text-xs">קנייה</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="font-bold text-green-600">{buyRecommendations.length}</span>
                {strongBuySignals > 0 && (
                  <Badge variant="outline" className="text-xs bg-green-50 text-green-700">
                    {strongBuySignals} חזק
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-1">
                <TrendingDown className="w-3 h-3 text-red-600" />
                <span className="text-xs">מכירה</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="font-bold text-red-600">{sellRecommendations.length}</span>
                {strongSellSignals > 0 && (
                  <Badge variant="outline" className="text-xs bg-red-50 text-red-700">
                    {strongSellSignals} חזק
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-1">
                <Target className="w-3 h-3 text-yellow-600" />
                <span className="text-xs">החזקה</span>
              </div>
              <span className="font-bold text-yellow-600">{holdRecommendations.length}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Average Confidence */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">רמת ביטחון</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-2xl font-bold">{averageConfidence.toFixed(0)}%</div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div 
                className={`h-2 rounded-full transition-all ${
                  averageConfidence >= 70 ? 'bg-green-500' : 
                  averageConfidence >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                }`}
                style={{ width: `${averageConfidence}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {averageConfidence >= 70 ? '🎯 ביטחון גבוה' : 
               averageConfidence >= 50 ? '⚖️ ביטחון בינוני' : '⚠️ ביטחון נמוך'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Risk Alert */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">התרעות סיכון</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {highRiskAssets > 0 ? (
              <>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                  <span className="text-2xl font-bold text-red-600">{highRiskAssets}</span>
                </div>
                <p className="text-xs text-red-600">נכסים בסיכון גבוה</p>
                <p className="text-xs text-muted-foreground">
                  שקול השקעה מדודה
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Target className="w-4 h-4 text-green-500" />
                  <span className="text-2xl font-bold text-green-600">✓</span>
                </div>
                <p className="text-xs text-green-600">רמת סיכון מאוזנת</p>
                <p className="text-xs text-muted-foreground">
                  פרופיל השקעה בריא
                </p>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default MarketOverview;

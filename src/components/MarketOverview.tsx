import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Activity, AlertTriangle, Target } from 'lucide-react';
import { useCryptoData } from '../hooks/useCryptoData';
import { CryptoRecommendation, FearGreedIndex } from '@cde/engine';

interface MarketOverviewProps {
  /** Recommendations to summarize. Omit to use the shared useCryptoData set.
   *  Pass a filtered set (e.g. portfolio-relevant only) to keep this panel in
   *  agreement with the list rendered under it — a summary that counts a
   *  different population than the list below it is worse than no summary. */
  recommendations?: CryptoRecommendation[];
  fearGreedData?: FearGreedIndex | null;
  isLoading?: boolean;
  /** Hide the sentiment card when the page already renders FearGreedIndicator. */
  showSentiment?: boolean;
}

const MarketOverview = ({
  recommendations: recommendationsProp,
  fearGreedData: fearGreedProp,
  isLoading: isLoadingProp,
  showSentiment = true
}: MarketOverviewProps = {}) => {
  // The hook is react-query backed and keyed identically wherever it is used,
  // so calling it here does not trigger a second fetch — it reads the same
  // cache entry the page already populated.
  const hookData = useCryptoData();

  const recommendations = recommendationsProp ?? hookData.recommendations ?? [];
  const fearGreedData = fearGreedProp !== undefined ? fearGreedProp : hookData.fearGreedData;
  const isLoading = isLoadingProp !== undefined ? isLoadingProp : hookData.isLoading;

  if (isLoading && recommendations.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-6">
          <div className="text-center">
            <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-2 animate-pulse" />
            <p className="text-muted-foreground font-mono">טוען נתוני שוק...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const buyRecommendations = recommendations.filter(r => r.recommendation === 'buy');
  const sellRecommendations = recommendations.filter(r => r.recommendation === 'sell');
  const holdRecommendations = recommendations.filter(r => r.recommendation === 'hold');

  const averageConfidence = recommendations.length > 0
    ? recommendations.reduce((sum, r) => sum + (r.confidence || 0), 0) / recommendations.length
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

  const cardCount = showSentiment ? 4 : 3;

  return (
    <div
      className={`grid grid-cols-1 md:grid-cols-2 gap-4 mb-6 ${
        cardCount === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'
      }`}
    >
      {showSentiment && (
        <Card className="bg-background border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium font-mono">רגש השוק</CardTitle>
          </CardHeader>
          <CardContent>
            {fearGreedData ? (
              <div className="space-y-2">
                <div className="text-2xl font-bold font-mono">{fearGreedData.value}</div>
                <Badge className={`text-xs ${getFearGreedColor(fearGreedData.value)}`}>
                  {getFearGreedText(fearGreedData.value_classification)}
                </Badge>
                <p className="text-xs text-muted-foreground font-mono">
                  {fearGreedData.value <= 35
                    ? '🎯 הזדמנות קנייה'
                    : fearGreedData.value >= 70
                    ? '⚠️ זהירות - חמדנות'
                    : '⚖️ מצב מאוזן'}
                </p>
              </div>
            ) : (
              <div className="text-muted-foreground font-mono">טוען...</div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="bg-background border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium font-mono">פילוח המלצות</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-1">
                <TrendingUp className="w-3 h-3 text-green-600" />
                <span className="text-xs font-mono">קנייה</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="font-bold text-green-600 font-mono">{buyRecommendations.length}</span>
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
                <span className="text-xs font-mono">מכירה</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="font-bold text-red-600 font-mono">{sellRecommendations.length}</span>
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
                <span className="text-xs font-mono">החזקה</span>
              </div>
              <span className="font-bold text-yellow-600 font-mono">{holdRecommendations.length}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-background border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium font-mono">רמת ביטחון</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-2xl font-bold font-mono">{averageConfidence.toFixed(0)}%</div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${
                  averageConfidence >= 70
                    ? 'bg-green-500'
                    : averageConfidence >= 50
                    ? 'bg-yellow-500'
                    : 'bg-red-500'
                }`}
                style={{ width: `${Math.max(0, Math.min(100, averageConfidence))}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground font-mono">
              {averageConfidence >= 70
                ? '🎯 ביטחון גבוה'
                : averageConfidence >= 50
                ? '⚖️ ביטחון בינוני'
                : '⚠️ ביטחון נמוך'}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-background border-primary/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium font-mono">התרעות סיכון</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {highRiskAssets > 0 ? (
              <>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                  <span className="text-2xl font-bold text-red-600 font-mono">{highRiskAssets}</span>
                </div>
                <p className="text-xs text-red-600 font-mono">נכסים בסיכון גבוה</p>
                <p className="text-xs text-muted-foreground font-mono">שקול השקעה מדודה</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Target className="w-4 h-4 text-green-500" />
                  <span className="text-2xl font-bold text-green-600 font-mono">✓</span>
                </div>
                <p className="text-xs text-green-600 font-mono">רמת סיכון מאוזנת</p>
                <p className="text-xs text-muted-foreground font-mono">פרופיל השקעה בריא</p>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default MarketOverview;

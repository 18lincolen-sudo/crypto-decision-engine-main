
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react';
import { FearGreedIndex } from '@cde/engine';
import Gauge, { GaugeZone } from '@/components/Gauge';

// Same red→green scale a race-car tachometer uses for "danger zone" vs safe
// cruising, mapped onto the index: fear (low value) reads as caution on the
// investor's actual position — the historical buy signal — so the zone
// coloring intentionally does not follow "red = bad".
const FEAR_GREED_ZONES: GaugeZone[] = [
  { upTo: 25, color: '#dc2626' },  // Extreme Fear
  { upTo: 50, color: '#f97316' },  // Fear
  { upTo: 75, color: '#eab308' },  // Neutral / Greed
  { upTo: 100, color: '#16a34a' }  // Extreme Greed
];

interface FearGreedIndicatorProps {
  fearGreedData: FearGreedIndex;
}

const FearGreedIndicator = ({ fearGreedData }: FearGreedIndicatorProps) => {
  const getBackgroundColor = (value: number) => {
    if (value < 25) return 'bg-red-50 border-red-200';
    if (value < 50) return 'bg-orange-50 border-orange-200';
    if (value < 75) return 'bg-yellow-50 border-yellow-200';
    return 'bg-green-50 border-green-200';
  };

  const getDescription = (classification: string) => {
    const translations: { [key: string]: string } = {
      'Extreme Fear': 'פחד קיצוני',
      'Fear': 'פחד',
      'Neutral': 'נייטרלי',
      'Greed': 'חמדנות',
      'Extreme Greed': 'חמדנות קיצונית'
    };
    return translations[classification] || classification;
  };

  const getRecommendation = (value: number) => {
    if (value < 25) {
      return {
        text: 'זמן מעולה לקנייה',
        icon: <TrendingUp className="w-4 h-4" />,
        color: 'text-green-600',
        badge: 'הזדמנות',
        advice: 'פחד קיצוני בשוק בדרך כלל מסמן הזדמנות קנייה טובה'
      };
    }
    if (value < 50) {
      return {
        text: 'זמן טוב לקנייה זהירה',
        icon: <TrendingUp className="w-4 h-4" />,
        color: 'text-green-500',
        badge: 'קנייה',
        advice: 'רמת פחד גבוהה - שקול רכישות הדרגתיות'
      };
    }
    if (value < 75) {
      return {
        text: 'זהירות - שוק נייטרלי',
        icon: <AlertTriangle className="w-4 h-4" />,
        color: 'text-yellow-600',
        badge: 'זהירות',
        advice: 'המתן לאותות ברורים יותר'
      };
    }
    return {
      text: 'שקול מכירות',
      icon: <TrendingDown className="w-4 h-4" />,
      color: 'text-red-600',
      badge: 'מכירה',
      advice: 'חמדנות גבוהה - זמן טוב לקחת רווחים'
    };
  };

  const recommendation = getRecommendation(fearGreedData.value);

  return (
    <Card className={`${getBackgroundColor(fearGreedData.value)} border-2`}>
      <CardHeader className="text-center pb-3">
        <CardTitle className="flex items-center justify-center gap-2">
          מדד פחד וחמדנות
          <Badge variant="outline" className={recommendation.color}>
            {recommendation.badge}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-[260px] mx-auto">
          <Gauge
            value={fearGreedData.value}
            zones={FEAR_GREED_ZONES}
            caption={getDescription(fearGreedData.value_classification).toUpperCase()}
          />
        </div>

        {/* Market Recommendation */}
        <div className="p-3 bg-background rounded-lg border">
          <div className={`flex items-center gap-2 font-medium mb-2 ${recommendation.color}`}>
            {recommendation.icon}
            {recommendation.text}
          </div>
          <p className="text-sm text-muted-foreground">
            {recommendation.advice}
          </p>
        </div>

        {/* Extreme Fear Special Alert */}
        {fearGreedData.value < 25 && (
          <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
            <div className="text-green-700 font-medium flex items-center gap-2 mb-1">
              🎯 הזדמנות זהב
            </div>
            <p className="text-sm text-green-600">
              פחד קיצוני היסטורית מסמן תחתית שוק. זמן מצוין לאיזון תיק ורכישה הדרגתית.
            </p>
          </div>
        )}

        {/* Extreme Greed Warning */}
        {fearGreedData.value > 80 && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
            <div className="text-red-700 font-medium flex items-center gap-2 mb-1">
              ⚠️ אזהרת חמדנות
            </div>
            <p className="text-sm text-red-600">
              חמדנות קיצונית עלולה להוביל לתיקון. שקול לקחת רווחים חלקיים.
            </p>
          </div>
        )}

        <div className="text-center text-xs text-muted-foreground pt-2 border-t">
          עדכון אחרון: {new Date(parseInt(fearGreedData.timestamp) * 1000).toLocaleString('he-IL')}
        </div>
      </CardContent>
    </Card>
  );
};

export default FearGreedIndicator;

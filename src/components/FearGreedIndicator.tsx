
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react';
import { FearGreedIndex } from '@cde/engine';

interface FearGreedIndicatorProps {
  fearGreedData: FearGreedIndex;
}

const FearGreedIndicator = ({ fearGreedData }: FearGreedIndicatorProps) => {
  const getColorClass = (value: number) => {
    if (value < 25) return 'text-red-600';
    if (value < 50) return 'text-orange-500';
    if (value < 75) return 'text-yellow-500';
    return 'text-green-600';
  };

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
        <div className="text-center">
          <div className={`text-5xl font-bold mb-2 ${getColorClass(fearGreedData.value)}`}>
            {fearGreedData.value}
          </div>
          <div className="text-lg font-medium mb-2">
            {getDescription(fearGreedData.value_classification)}
          </div>
        </div>
        
        <div className="space-y-2">
          <Progress 
            value={fearGreedData.value} 
            className="h-3"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>פחד קיצוני (0)</span>
            <span>נייטרלי (50)</span>
            <span>חמדנות קיצונית (100)</span>
          </div>
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

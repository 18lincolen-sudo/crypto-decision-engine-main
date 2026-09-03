
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Wallet, DollarSign } from 'lucide-react';
import { PortfolioAnalysis } from '@cde/engine';

interface PortfolioOverviewProps {
  analysis: PortfolioAnalysis | null;
}

const PortfolioOverview = ({ analysis }: PortfolioOverviewProps) => {
  if (!analysis) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-6">
          <div className="text-center">
            <Wallet className="w-12 h-12 text-muted-foreground mx-auto mb-2" />
            <p className="text-muted-foreground">בחר מטבעות לתיק כדי לראות ניתוח</p>
          </div>
        </CardContent>
      </Card>
    );
  }

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

  return (
    <div className="space-y-6">
      {/* Main Portfolio Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="w-5 h-5" />
            סקירת התיק
          </CardTitle>
        </CardHeader>
        
        <CardContent className="space-y-6">
          {/* Portfolio Values */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center p-3 bg-muted rounded-lg">
              <div className="text-sm text-muted-foreground">ערך נוכחי</div>
              <div className="text-xl font-bold text-blue-600">
                ${analysis.totalValue.toLocaleString()}
              </div>
            </div>
            
            <div className="text-center p-3 bg-muted rounded-lg">
              <div className="text-sm text-muted-foreground">השקעה כוללת</div>
              <div className="text-xl font-bold">
                ${analysis.totalInvestment.toLocaleString()}
              </div>
            </div>
            
            <div className="text-center p-3 bg-muted rounded-lg">
              <div className="text-sm text-muted-foreground">רווח כולל</div>
              <div className={`text-xl font-bold ${
                analysis.totalProfit >= 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                {analysis.totalProfit >= 0 ? '+' : ''}${analysis.totalProfit.toFixed(2)}
              </div>
            </div>
            
            <div className="text-center p-3 bg-muted rounded-lg">
              <div className="text-sm text-muted-foreground">אחוז רווח</div>
              <div className={`text-xl font-bold flex items-center justify-center ${
                analysis.totalProfitPercentage >= 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                {analysis.totalProfitPercentage >= 0 ? 
                  <TrendingUp className="w-4 h-4 mr-1" /> : 
                  <TrendingDown className="w-4 h-4 mr-1" />
                }
                {analysis.totalProfitPercentage >= 0 ? '+' : ''}{analysis.totalProfitPercentage.toFixed(2)}%
              </div>
            </div>
          </div>

          {/* Daily Performance */}
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center p-3 border rounded-lg">
              <div className="text-sm text-muted-foreground">ביצועים 24 שעות</div>
              <div className={`text-lg font-bold flex items-center justify-center ${
                analysis.performance24h >= 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                {analysis.performance24h >= 0 ? 
                  <TrendingUp className="w-4 h-4 mr-1" /> : 
                  <TrendingDown className="w-4 h-4 mr-1" />
                }
                {analysis.performance24h >= 0 ? '+' : ''}{analysis.performance24h.toFixed(2)}%
              </div>
            </div>
            
            <div className="text-center p-3 border rounded-lg">
              <div className="text-sm text-muted-foreground">רווח יומי</div>
              <div className={`text-lg font-bold flex items-center justify-center ${
                analysis.dailyProfit >= 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                <DollarSign className="w-4 h-4 mr-1" />
                {analysis.dailyProfit >= 0 ? '+' : ''}${analysis.dailyProfit.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Overall Recommendation */}
          <div className="text-center p-4 bg-muted rounded-lg">
            <Badge className={`mb-2 ${getRecommendationColor(analysis.recommendations.overall)}`}>
              {getRecommendationText(analysis.recommendations.overall)} ({analysis.recommendations.confidence}%)
            </Badge>
            <p className="text-sm text-muted-foreground">
              {analysis.recommendations.reasoning}
            </p>
          </div>

          {/* Recommendations Breakdown */}
          <div>
            <div className="text-sm font-medium mb-2">פיצול המלצות:</div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="text-center p-2 bg-green-100 rounded">
                <div className="font-medium text-green-800">קנייה</div>
                <div className="text-green-600">
                  {analysis.cryptoAnalysis.filter(c => c.recommendation === 'buy').length}
                </div>
              </div>
              <div className="text-center p-2 bg-yellow-100 rounded">
                <div className="font-medium text-yellow-800">החזקה</div>
                <div className="text-yellow-600">
                  {analysis.cryptoAnalysis.filter(c => c.recommendation === 'hold').length}
                </div>
              </div>
              <div className="text-center p-2 bg-red-100 rounded">
                <div className="font-medium text-red-800">מכירה</div>
                <div className="text-red-600">
                  {analysis.cryptoAnalysis.filter(c => c.recommendation === 'sell').length}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default PortfolioOverview;

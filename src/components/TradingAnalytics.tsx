
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  TrendingUp, 
  TrendingDown, 
  Target, 
  Shield, 
  Activity,
  BarChart3
} from 'lucide-react';
import { TradingMetrics } from '../services/advancedTradingService';

interface TradingAnalyticsProps {
  metrics: TradingMetrics;
  portfolioSummary: any;
}

const TradingAnalytics: React.FC<TradingAnalyticsProps> = ({ metrics, portfolioSummary }) => {
  const winRateColor = metrics.winRate >= 60 ? 'text-green-500' : 
                      metrics.winRate >= 40 ? 'text-yellow-500' : 'text-red-500';
  
  const pnlColor = metrics.totalPnL >= 0 ? 'text-green-500' : 'text-red-500';

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* Portfolio Summary */}
      <Card className="border-green-200 bg-green-50/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-mono flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-green-600" />
            סיכום תיק
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">יתרה כוללת:</span>
            <span className="font-bold font-mono">${portfolioSummary?.totalBalance?.toFixed(2) || '0.00'}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">יתרה זמינה:</span>
            <span className="font-mono">${portfolioSummary?.availableBalance?.toFixed(2) || '0.00'}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">פוזיציות פתוחות:</span>
            <Badge variant="outline" className="font-mono">
              {portfolioSummary?.openPositions || 0}
            </Badge>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">PnL לא מימוש:</span>
            <span className={`font-mono ${portfolioSummary?.totalUnrealizedPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              ${portfolioSummary?.totalUnrealizedPnL?.toFixed(2) || '0.00'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Trading Performance */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-mono flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-600" />
            ביצועי מסחר
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">סה"כ עסקאות:</span>
            <span className="font-bold font-mono">{metrics.totalTrades}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">שיעור ניצחון:</span>
            <span className={`font-bold font-mono ${winRateColor}`}>
              {metrics.winRate.toFixed(1)}%
            </span>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="font-mono text-muted-foreground">זוכות</span>
              <span className="font-mono text-muted-foreground">מפסידות</span>
            </div>
            <div className="flex gap-1">
              <div className="flex-1 bg-green-200 h-2 rounded-l" 
                   style={{width: `${metrics.winRate}%`}}></div>
              <div className="flex-1 bg-red-200 h-2 rounded-r" 
                   style={{width: `${100 - metrics.winRate}%`}}></div>
            </div>
            <div className="flex justify-between text-sm font-mono">
              <span className="text-green-600">{metrics.winningTrades}</span>
              <span className="text-red-600">{metrics.losingTrades}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Risk Metrics */}
      <Card className="border-purple-200 bg-purple-50/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-mono flex items-center gap-2">
            <Shield className="w-5 h-5 text-purple-600" />
            מדדי סיכון
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">PnL כולל:</span>
            <span className={`font-bold font-mono ${pnlColor}`}>
              ${metrics.totalPnL.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">רווח ממוצע:</span>
            <span className="font-mono text-green-600">
              ${metrics.avgWin.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">הפסד ממוצע:</span>
            <span className="font-mono text-red-600">
              ${metrics.avgLoss.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-mono text-muted-foreground">ירידה מקסימלית:</span>
            <span className="font-mono text-red-600">
              {metrics.maxDrawdown.toFixed(2)}%
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default TradingAnalytics;

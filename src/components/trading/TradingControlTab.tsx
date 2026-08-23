
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Activity, Play, Square } from 'lucide-react';
import { TradingMetrics } from '../../services/advancedTradingService';

interface TradingControlTabProps {
  isConfigured: boolean;
  isTrading: boolean;
  recommendations: any[];
  metrics: TradingMetrics;
  alerts: any[];
  onStartTrading: () => void;
  onStopTrading: () => void;
}

const TradingControlTab: React.FC<TradingControlTabProps> = ({
  isConfigured,
  isTrading,
  recommendations,
  metrics,
  alerts,
  onStartTrading,
  onStopTrading
}) => {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-mono text-lg sm:text-xl">
          <Activity className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
          <span className="truncate">בקרת בוט מתקדמת</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 sm:space-y-6 pt-0">
        <div className="text-center">
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center">
            <Button
              onClick={onStartTrading}
              disabled={!isConfigured || isTrading}
              className="font-mono text-sm sm:text-base w-full sm:w-auto"
              size="lg"
            >
              <Play className="w-4 h-4 mr-2 flex-shrink-0" />
              התחל מסחר חכם
            </Button>
            
            <Button
              onClick={onStopTrading}
              disabled={!isTrading}
              variant="destructive"
              className="font-mono text-sm sm:text-base w-full sm:w-auto"
              size="lg"
            >
              <Square className="w-4 h-4 mr-2 flex-shrink-0" />
              עצור מסחר
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:gap-4">
          <Card>
            <CardContent className="p-3 sm:p-4 text-center">
              <div className="text-lg sm:text-2xl font-bold text-green-600 font-mono truncate">
                {recommendations?.filter(r => r.recommendation === 'buy').length || 0}
              </div>
              <div className="text-xs sm:text-sm text-muted-foreground font-mono leading-tight">
                המלצות קנייה
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-3 sm:p-4 text-center">
              <div className="text-lg sm:text-2xl font-bold text-red-600 font-mono truncate">
                {recommendations?.filter(r => r.recommendation === 'sell').length || 0}
              </div>
              <div className="text-xs sm:text-sm text-muted-foreground font-mono leading-tight">
                המלצות מכירה
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-3 sm:p-4 text-center">
              <div className="text-lg sm:text-2xl font-bold text-blue-600 font-mono truncate">
                {metrics.winRate.toFixed(1)}%
              </div>
              <div className="text-xs sm:text-sm text-muted-foreground font-mono leading-tight">
                שיעור הצלחה
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-3 sm:p-4 text-center">
              <div className="text-lg sm:text-2xl font-bold text-purple-600 font-mono truncate">
                {alerts.length}
              </div>
              <div className="text-xs sm:text-sm text-muted-foreground font-mono leading-tight">
                התראות פעילות
              </div>
            </CardContent>
          </Card>
        </div>
      </CardContent>
    </Card>
  );
};

export default TradingControlTab;

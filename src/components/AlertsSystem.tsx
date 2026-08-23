
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bell, TrendingUp, TrendingDown, AlertTriangle, Target, Clock } from 'lucide-react';
import { useCryptoData } from '../hooks/useCryptoData';

interface Alert {
  id: string;
  type: 'opportunity' | 'warning' | 'info';
  priority: 'high' | 'medium' | 'low';
  symbol: string;
  message: string;
  confidence: number;
  timestamp: Date;
}

const AlertsSystem = () => {
  const { recommendations, fearGreedData } = useCryptoData();

  // Generate alerts based on recommendations
  const generateAlerts = (): Alert[] => {
    const alerts: Alert[] = [];

    recommendations.forEach(rec => {
      // High confidence buy opportunities
      if (rec.recommendation === 'buy' && rec.confidence > 85) {
        alerts.push({
          id: `buy-${rec.symbol}`,
          type: 'opportunity',
          priority: 'high',
          symbol: rec.symbol,
          message: `הזדמנות קנייה מצוינת - ביטחון ${rec.confidence}%`,
          confidence: rec.confidence,
          timestamp: new Date()
        });
      }

      // High confidence sell signals
      if (rec.recommendation === 'sell' && rec.confidence > 80) {
        alerts.push({
          id: `sell-${rec.symbol}`,
          type: 'warning',
          priority: 'high',
          symbol: rec.symbol,
          message: `שקול מכירה - ביטחון ${rec.confidence}%`,
          confidence: rec.confidence,
          timestamp: new Date()
        });
      }

      // RSI extreme levels
      if (rec.indicators.rsi < 25) {
        alerts.push({
          id: `rsi-low-${rec.symbol}`,
          type: 'opportunity',
          priority: 'medium',
          symbol: rec.symbol,
          message: `RSI קיצוני נמוך (${rec.indicators.rsi.toFixed(1)}) - oversold`,
          confidence: 75,
          timestamp: new Date()
        });
      }

      if (rec.indicators.rsi > 75) {
        alerts.push({
          id: `rsi-high-${rec.symbol}`,
          type: 'warning',
          priority: 'medium',
          symbol: rec.symbol,
          message: `RSI קיצוני גבוה (${rec.indicators.rsi.toFixed(1)}) - overbought`,
          confidence: 70,
          timestamp: new Date()
        });
      }

      // MACD signals
      if (rec.indicators.macd?.trend === 'bullish' && rec.indicators.macd.histogram > 0.01) {
        alerts.push({
          id: `macd-bull-${rec.symbol}`,
          type: 'opportunity',
          priority: 'medium',
          symbol: rec.symbol,
          message: 'MACD חיובי - מגמה עולה חזקה',
          confidence: 70,
          timestamp: new Date()
        });
      }

      // High risk warnings
      if (rec.riskLevel === 'high') {
        alerts.push({
          id: `risk-${rec.symbol}`,
          type: 'warning',
          priority: 'medium',
          symbol: rec.symbol,
          message: 'נכס בסיכון גבוה - השקע בזהירות',
          confidence: 60,
          timestamp: new Date()
        });
      }
    });

    // Market sentiment alerts
    if (fearGreedData) {
      if (fearGreedData.value <= 20) {
        alerts.push({
          id: 'market-fear',
          type: 'opportunity',
          priority: 'high',
          symbol: 'MARKET',
          message: `פחד קיצוני בשוק (${fearGreedData.value}) - הזדמנות היסטורית`,
          confidence: 85,
          timestamp: new Date()
        });
      } else if (fearGreedData.value >= 80) {
        alerts.push({
          id: 'market-greed',
          type: 'warning',
          priority: 'high',
          symbol: 'MARKET',
          message: `חמדנות קיצונית (${fearGreedData.value}) - זהירות מפניה`,
          confidence: 80,
          timestamp: new Date()
        });
      }
    }

    // Sort by priority and confidence
    return alerts.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[b.priority] - priorityOrder[a.priority];
      }
      return b.confidence - a.confidence;
    }).slice(0, 8); // Show top 8 alerts
  };

  const alerts = generateAlerts();

  const getAlertIcon = (type: string) => {
    switch (type) {
      case 'opportunity': return <TrendingUp className="w-4 h-4 text-green-600" />;
      case 'warning': return <AlertTriangle className="w-4 h-4 text-red-600" />;
      default: return <Target className="w-4 h-4 text-blue-600" />;
    }
  };

  const getAlertColor = (type: string) => {
    switch (type) {
      case 'opportunity': return 'border-l-green-500 bg-green-50';
      case 'warning': return 'border-l-red-500 bg-red-50';
      default: return 'border-l-blue-500 bg-blue-50';
    }
  };

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'high': return <Badge className="bg-red-500 text-white text-xs">גבוה</Badge>;
      case 'medium': return <Badge className="bg-yellow-500 text-white text-xs">בינוני</Badge>;
      default: return <Badge className="bg-gray-500 text-white text-xs">נמוך</Badge>;
    }
  };

  if (alerts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="w-5 h-5" />
            התרעות חכמות
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <Target className="w-12 h-12 text-muted-foreground mx-auto mb-2" />
            <p className="text-muted-foreground">אין התרעות פעילות כרגע</p>
            <p className="text-sm text-muted-foreground mt-1">המערכת מנטרת את השוק 24/7</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="w-5 h-5" />
          התרעות חכמות
          <Badge className="bg-blue-500 text-white">{alerts.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {alerts.map(alert => (
            <div 
              key={alert.id}
              className={`p-3 rounded-lg border-l-4 ${getAlertColor(alert.type)}`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  {getAlertIcon(alert.type)}
                  <span className="font-semibold text-sm">{alert.symbol}</span>
                  {getPriorityBadge(alert.priority)}
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  עכשיו
                </div>
              </div>
              
              <p className="text-sm mb-2">{alert.message}</p>
              
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  ביטחון: {alert.confidence}%
                </div>
                <div className="w-16 bg-gray-200 rounded-full h-1">
                  <div 
                    className={`h-1 rounded-full ${
                      alert.confidence >= 80 ? 'bg-green-500' : 
                      alert.confidence >= 58 ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${alert.confidence}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

export default AlertsSystem;


import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Bell, 
  CheckCircle, 
  AlertTriangle, 
  XCircle, 
  Info,
  Trash2
} from 'lucide-react';
import { Alert } from '../services/advancedTradingService';

interface TradingAlertsProps {
  alerts: Alert[];
  onClearAlerts: () => void;
}

const TradingAlerts: React.FC<TradingAlertsProps> = ({ alerts, onClearAlerts }) => {
  const getAlertIcon = (type: Alert['type']) => {
    switch (type) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
      case 'error':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'info':
        return <Info className="w-4 h-4 text-blue-500" />;
      default:
        return <Bell className="w-4 h-4" />;
    }
  };

  const getAlertBadgeVariant = (type: Alert['type']) => {
    switch (type) {
      case 'success':
        return 'default' as const;
      case 'warning':
        return 'secondary' as const;
      case 'error':
        return 'destructive' as const;
      case 'info':
        return 'outline' as const;
      default:
        return 'outline' as const;
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg font-mono flex items-center gap-2">
            <Bell className="w-5 h-5" />
            התראות בזמן אמת
            {alerts.length > 0 && (
              <Badge variant="outline" className="font-mono">
                {alerts.length}
              </Badge>
            )}
          </CardTitle>
          {alerts.length > 0 && (
            <Button 
              onClick={onClearAlerts}
              variant="outline" 
              size="sm"
              className="font-mono"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              נקה הכל
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-80">
          {alerts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground font-mono">
              אין התראות חדשות
            </div>
          ) : (
            <div className="space-y-3">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3 rounded-lg border ${
                    alert.type === 'success' ? 'border-green-200 bg-green-50' :
                    alert.type === 'warning' ? 'border-yellow-200 bg-yellow-50' :
                    alert.type === 'error' ? 'border-red-200 bg-red-50' :
                    'border-blue-200 bg-blue-50'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {getAlertIcon(alert.type)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge 
                          variant={getAlertBadgeVariant(alert.type)}
                          className="text-xs font-mono"
                        >
                          {alert.type.toUpperCase()}
                        </Badge>
                        {alert.symbol && (
                          <Badge variant="outline" className="text-xs font-mono">
                            {alert.symbol}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground font-mono ml-auto">
                          {alert.timestamp.toLocaleTimeString('he-IL')}
                        </span>
                      </div>
                      <p className="text-sm font-mono text-gray-700 break-words">
                        {alert.message}
                      </p>
                      {alert.price && (
                        <p className="text-xs text-muted-foreground font-mono mt-1">
                          מחיר: ${alert.price.toFixed(2)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
};

export default TradingAlerts;

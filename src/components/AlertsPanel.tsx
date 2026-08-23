
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Bell, X, Volume2, VolumeX, Trash2, AlertTriangle, TrendingUp, BarChart3, Newspaper } from 'lucide-react';
import { useAlerts, Alert } from '@/hooks/useAlerts';

interface AlertsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const AlertsPanel = ({ isOpen, onClose }: AlertsPanelProps) => {
  const { alerts, clearAlert, clearAllAlerts, soundEnabled, setSoundEnabled } = useAlerts();

  const getAlertIcon = (type: Alert['type']) => {
    switch (type) {
      case 'price': return <TrendingUp className="w-4 h-4" />;
      case 'volume': return <BarChart3 className="w-4 h-4" />;
      case 'news': return <Newspaper className="w-4 h-4" />;
      case 'technical': return <AlertTriangle className="w-4 h-4" />;
      default: return <Bell className="w-4 h-4" />;
    }
  };

  const getPriorityColor = (priority: Alert['priority']) => {
    switch (priority) {
      case 'high': return 'text-red-400 bg-red-500/20 border-red-500/30';
      case 'medium': return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30';
      case 'low': return 'text-green-400 bg-green-500/20 border-green-500/30';
      default: return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30';
    }
  };

  const getPriorityText = (priority: Alert['priority']) => {
    switch (priority) {
      case 'high': return 'גבוה';
      case 'medium': return 'בינוני';
      case 'low': return 'נמוך';
      default: return 'בינוני';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed top-20 right-4 z-50 animate-slide-in-right">
      <Card className="w-96 h-[600px] bg-background/95 backdrop-blur-xl border border-primary/30 shadow-2xl">
        <CardHeader className="p-4 border-b border-primary/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-yellow-400" />
              <CardTitle className="text-yellow-400">התראות בזמן אמת</CardTitle>
              <Badge variant="outline" className="text-xs text-yellow-300 border-primary/30">
                {alerts.length}
              </Badge>
            </div>
            
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSoundEnabled(!soundEnabled)}
                className="w-8 h-8 p-0 text-yellow-300 hover:text-yellow-200 hover:bg-primary/20"
              >
                {soundEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAllAlerts}
                disabled={alerts.length === 0}
                className="w-8 h-8 p-0 text-yellow-300 hover:text-yellow-200 hover:bg-primary/20"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="w-8 h-8 p-0 text-yellow-300 hover:text-yellow-200 hover:bg-primary/20"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <ScrollArea className="h-[520px] p-4">
            {alerts.length === 0 ? (
              <div className="text-center py-12">
                <Bell className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                <p className="text-muted-foreground">אין התראות כרגע</p>
                <p className="text-sm text-muted-foreground/70 mt-2">
                  ההתראות יופיעו כאן כשיזוהו אותות חשובים
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {alerts.map((alert) => (
                  <Card
                    key={alert.id}
                    className={`p-3 bg-background/30 border transition-all duration-300 hover:bg-background/50 ${getPriorityColor(alert.priority)}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 flex-1">
                        <div className="mt-1">
                          {getAlertIcon(alert.type)}
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge 
                              variant="outline" 
                              className={`text-xs px-2 py-0 ${getPriorityColor(alert.priority)}`}
                            >
                              {alert.symbol}
                            </Badge>
                            <Badge 
                              variant="outline" 
                              className="text-xs px-2 py-0 text-yellow-300 border-primary/30"
                            >
                              {getPriorityText(alert.priority)}
                            </Badge>
                          </div>
                          
                          <p className="text-sm text-foreground leading-relaxed">
                            {alert.message}
                          </p>
                          
                          <p className="text-xs text-muted-foreground mt-2">
                            {alert.timestamp.toLocaleString('he-IL')}
                          </p>
                        </div>
                      </div>
                      
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => clearAlert(alert.id)}
                        className="w-6 h-6 p-0 text-muted-foreground hover:text-foreground opacity-60 hover:opacity-100"
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
};

export default AlertsPanel;

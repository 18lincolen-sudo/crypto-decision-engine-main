
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Bell, AlertTriangle, TrendingUp, TrendingDown, Target, Settings, Zap } from 'lucide-react';
import Navigation from '../components/Navigation';
import { useCryptoData } from '../hooks/useCryptoData';
import { MatrixBackground } from '../components/MatrixBackground';

interface Alert {
  id: string;
  symbol: string;
  type: 'price' | 'volume' | 'rsi' | 'support' | 'resistance';
  condition: string;
  value: number;
  currentValue: number;
  isTriggered: boolean;
  timestamp: string;
  priority: 'low' | 'medium' | 'high';
}

const Alerts = () => {
  const { cryptoData, fearGreedData } = useCryptoData();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => localStorage.getItem('alerts-notifications') === '1'
  );
  const [soundEnabled, setSoundEnabled] = useState(
    () => localStorage.getItem('alerts-sound') !== '0'
  );

  useEffect(() => {
    localStorage.setItem('alerts-notifications', notificationsEnabled ? '1' : '0');
  }, [notificationsEnabled]);

  useEffect(() => {
    localStorage.setItem('alerts-sound', soundEnabled ? '1' : '0');
  }, [soundEnabled]);

  useEffect(() => {
    // Build live alerts from real market data (no mock data)
    const liveAlerts: Alert[] = [];

    (cryptoData || []).forEach((crypto) => {
      const symbol = crypto.symbol.toUpperCase();
      const change = crypto.price_change_percentage_24h || 0;
      const absChange = Math.abs(change);

      if (absChange >= 3) {
        const isUp = change > 0;
        liveAlerts.push({
          id: `price-${symbol}`,
          symbol,
          type: 'price',
          condition: isUp ? 'עלה מעל' : 'ירד מתחת',
          value: crypto.current_price,
          currentValue: crypto.current_price,
          isTriggered: true,
          timestamp: new Date().toISOString(),
          priority: absChange >= 8 ? 'high' : absChange >= 5 ? 'medium' : 'low'
        });
      }

      if (crypto.total_volume >= 1_000_000_000) {
        liveAlerts.push({
          id: `volume-${symbol}`,
          symbol,
          type: 'volume',
          condition: 'נפח מסחר גבוה',
          value: crypto.total_volume,
          currentValue: crypto.total_volume,
          isTriggered: true,
          timestamp: new Date().toISOString(),
          priority: crypto.total_volume >= 5_000_000_000 ? 'high' : 'medium'
        });
      }
    });

    // Market-wide alert from the live Fear & Greed index
    if (fearGreedData) {
      const fg = fearGreedData.value;
      if (fg <= 25) {
        liveAlerts.push({
          id: 'fg-fear',
          symbol: 'שוק',
          type: 'support',
          condition: 'פחד קיצוני בשוק',
          value: fg,
          currentValue: fg,
          isTriggered: false,
          timestamp: new Date().toISOString(),
          priority: 'high'
        });
      } else if (fg >= 75) {
        liveAlerts.push({
          id: 'fg-greed',
          symbol: 'שוק',
          type: 'resistance',
          condition: 'חמדנות קיצונית בשוק',
          value: fg,
          currentValue: fg,
          isTriggered: false,
          timestamp: new Date().toISOString(),
          priority: 'high'
        });
      }
    }

    setAlerts(liveAlerts);
  }, [cryptoData, fearGreedData]);

  const getAlertIcon = (type: string) => {
    switch (type) {
      case 'price': return <TrendingUp className="w-4 h-4" />;
      case 'volume': return <Zap className="w-4 h-4" />;
      case 'rsi': return <Target className="w-4 h-4" />;
      default: return <AlertTriangle className="w-4 h-4" />;
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'border-red-500 bg-red-950/20';
      case 'medium': return 'border-yellow-500 bg-yellow-950/20';
      default: return 'border-green-500 bg-green-950/20';
    }
  };

  const triggeredAlerts = alerts.filter(a => a.isTriggered);
  const activeAlerts = alerts.filter(a => !a.isTriggered);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      
      <div className="max-w-7xl mx-auto p-4">
        {/* Matrix Background Effect */}
        <MatrixBackground count={20} chars={['1', '0']} />

        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold mb-4 text-primary flex items-center justify-center gap-3">
            <Bell className="w-10 h-10" />
            מערכת התראות חכמה
          </h1>
          <p className="text-xl text-muted-foreground">
            התראות בזמן אמת • ניטור אוטומטי • הודעות מיידיות
          </p>
        </div>

        {/* Settings Panel */}
        <Card className="mb-8 border-primary/30 bg-card/50 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-primary">
              <Settings className="w-5 h-5" />
              הגדרות התראות
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="flex items-center justify-between p-4 border border-primary/20 rounded-lg">
                <div>
                  <div className="font-medium text-primary">התראות דחיפה</div>
                  <div className="text-sm text-muted-foreground">הודעות למכשיר</div>
                </div>
                <Switch 
                  checked={notificationsEnabled} 
                  onCheckedChange={setNotificationsEnabled}
                />
              </div>
              <div className="flex items-center justify-between p-4 border border-primary/20 rounded-lg">
                <div>
                  <div className="font-medium text-primary">צלילי התראה</div>
                  <div className="text-sm text-muted-foreground">אזעקה קולית</div>
                </div>
                <Switch 
                  checked={soundEnabled} 
                  onCheckedChange={setSoundEnabled}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Active Alerts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <h2 className="text-2xl font-semibold mb-4 text-primary flex items-center gap-2">
              <Target className="w-6 h-6" />
              התראות פעילות ({activeAlerts.length})
            </h2>
            <div className="space-y-4">
              {activeAlerts.map((alert) => (
                <Card key={alert.id} className={`border-2 ${getPriorityColor(alert.priority)} backdrop-blur`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {getAlertIcon(alert.type)}
                        <span className="font-bold text-primary">{alert.symbol}</span>
                        <Badge variant="outline" className="border-primary text-primary">
                          {alert.type.toUpperCase()}
                        </Badge>
                      </div>
                      <Badge className={`${alert.priority === 'high' ? 'bg-red-500' : alert.priority === 'medium' ? 'bg-yellow-500' : 'bg-green-500'}`}>
                        {alert.priority === 'high' ? 'גבוה' : alert.priority === 'medium' ? 'בינוני' : 'נמוך'}
                      </Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      <div>{alert.condition} {alert.value.toLocaleString()}</div>
                      <div>ערך נוכחי: {alert.currentValue.toLocaleString()}</div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></div>
                        <span>ממתין להפעלה</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* Triggered Alerts */}
          <div>
            <h2 className="text-2xl font-semibold mb-4 text-primary flex items-center gap-2">
              <AlertTriangle className="w-6 h-6" />
              התראות שהופעלו ({triggeredAlerts.length})
            </h2>
            <div className="space-y-4">
              {triggeredAlerts.map((alert) => (
                <Card key={alert.id} className="border-2 border-green-500 bg-green-950/20 backdrop-blur">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {getAlertIcon(alert.type)}
                        <span className="font-bold text-primary">{alert.symbol}</span>
                        <Badge variant="outline" className="border-green-500 text-green-400">
                          הופעל
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(alert.timestamp).toLocaleString('he-IL')}
                      </div>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      <div>{alert.condition} {alert.value.toLocaleString()}</div>
                      <div>ערך שהופעל: {alert.currentValue.toLocaleString()}</div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                        <span className="text-green-400">התראה הופעלה בהצלחה</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>

        {/* Statistics */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="border-primary/30 bg-card/50 backdrop-blur">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary">{alerts.length}</div>
              <div className="text-sm text-muted-foreground">סה"כ התראות</div>
            </CardContent>
          </Card>
          <Card className="border-primary/30 bg-card/50 backdrop-blur">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-green-400">{triggeredAlerts.length}</div>
              <div className="text-sm text-muted-foreground">הופעלו היום</div>
            </CardContent>
          </Card>
          <Card className="border-primary/30 bg-card/50 backdrop-blur">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-yellow-400">{activeAlerts.length}</div>
              <div className="text-sm text-muted-foreground">ממתינות</div>
            </CardContent>
          </Card>
          <Card className="border-primary/30 bg-card/50 backdrop-blur">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary">{fearGreedData ? fearGreedData.value : '--'}</div>
              <div className="text-sm text-muted-foreground">מדד פחד וחמדנות</div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Alerts;

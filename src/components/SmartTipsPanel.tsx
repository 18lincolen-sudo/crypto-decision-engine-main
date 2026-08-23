
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  TrendingUp, 
  TrendingDown, 
  AlertTriangle, 
  Clock, 
  Zap,
  Target,
  Shield,
  Brain
} from 'lucide-react';
import { useCryptoData } from '../hooks/useCryptoData';

interface MarketCondition {
  type: 'bullish' | 'bearish' | 'volatile' | 'stable';
  intensity: 'low' | 'medium' | 'high';
  volume: 'low' | 'normal' | 'high';
}

interface SmartTip {
  id: string;
  title: string;
  content: string;
  type: 'timing' | 'risk' | 'opportunity' | 'warning';
  priority: 'high' | 'medium' | 'low';
  icon: any;
  color: string;
  timestamp: Date;
}

const SmartTipsPanel = () => {
  const { cryptoData, fearGreedData } = useCryptoData();
  const [marketCondition, setMarketCondition] = useState<MarketCondition>({
    type: 'stable',
    intensity: 'medium',
    volume: 'normal'
  });
  const [tips, setTips] = useState<SmartTip[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
      analyzeRealMarketConditions();
    }, 30000);

    analyzeRealMarketConditions();
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    generateRealTimeTips();
  }, [marketCondition, currentTime, cryptoData, fearGreedData]);

  const analyzeRealMarketConditions = () => {
    if (!cryptoData || cryptoData.length === 0) {
      return;
    }

    const hour = new Date().getHours();
    const dayOfWeek = new Date().getDay();
    
    // Real market analysis based on actual crypto data
    let newCondition: MarketCondition = {
      type: 'stable',
      intensity: 'medium',
      volume: 'normal'
    };

    // Calculate market volatility from real data
    const volatility = cryptoData.reduce((sum, crypto) => 
      sum + Math.abs(crypto.price_change_percentage_24h || 0), 0) / cryptoData.length;

    // Determine market type based on real price changes
    const avgChange = cryptoData.reduce((sum, crypto) => 
      sum + (crypto.price_change_percentage_24h || 0), 0) / cryptoData.length;

    if (volatility > 5) {
      newCondition.type = 'volatile';
      newCondition.intensity = 'high';
    } else if (avgChange > 2) {
      newCondition.type = 'bullish';
    } else if (avgChange < -2) {
      newCondition.type = 'bearish';
    }

    // Volume analysis based on trading hours
    if (hour >= 9 && hour <= 16) {
      newCondition.volume = 'high';
    } else if (hour >= 22 || hour <= 6) {
      newCondition.volume = 'low';
    }

    // Weekend analysis
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      newCondition.volume = 'low';
      newCondition.intensity = 'low';
    }

    setMarketCondition(newCondition);
  };

  const generateRealTimeTips = () => {
    if (!cryptoData || cryptoData.length === 0) {
      return;
    }

    const hour = currentTime.getHours();
    const dayOfWeek = currentTime.getDay();
    const newTips: SmartTip[] = [];

    // Real market-based tips
    const btcData = cryptoData.find(c => c.symbol === 'BTC' || c.symbol === 'btc');
    const ethData = cryptoData.find(c => c.symbol === 'ETH' || c.symbol === 'eth');

    // BTC specific analysis
    if (btcData) {
      if (btcData.price_change_percentage_24h > 5) {
        newTips.push({
          id: 'btc-surge',
          title: '🚀 ביטקוין עולה חזק',
          content: `ביטקוין עלה ${btcData.price_change_percentage_24h.toFixed(2)}% ב-24 השעות האחרונות`,
          type: 'opportunity',
          priority: 'high',
          icon: TrendingUp,
          color: 'border-primary/40 bg-primary/20',
          timestamp: new Date()
        });
      } else if (btcData.price_change_percentage_24h < -5) {
        newTips.push({
          id: 'btc-drop',
          title: '📉 ביטקוין יורד',
          content: `ביטקוין ירד ${Math.abs(btcData.price_change_percentage_24h).toFixed(2)}% - שקול הזדמנות קנייה`,
          type: 'warning',
          priority: 'high',
          icon: TrendingDown,
          color: 'border-red-500/40 bg-red-500/20',
          timestamp: new Date()
        });
      }
    }

    // Fear & Greed based tips
    if (fearGreedData) {
      if (fearGreedData.value <= 25) {
        newTips.push({
          id: 'extreme-fear',
          title: '😨 פחד קיצוני בשוק',
          content: `מדד פחד וחמדנות: ${fearGreedData.value} - זמן טוב לקנייה`,
          type: 'opportunity',
          priority: 'high',
          icon: Target,
          color: 'border-primary/40 bg-primary/20',
          timestamp: new Date()
        });
      } else if (fearGreedData.value >= 75) {
        newTips.push({
          id: 'extreme-greed',
          title: '🔥 חמדנות קיצונית',
          content: `מדד פחד וחמדנות: ${fearGreedData.value} - שקול מכירה חלקית`,
          type: 'warning',
          priority: 'high',
          icon: AlertTriangle,
          color: 'border-orange-500/40 bg-orange-500/20',
          timestamp: new Date()
        });
      }
    }

    // Time-based tips
    if (hour >= 9 && hour <= 11) {
      newTips.push({
        id: 'morning-active',
        title: '🌅 שעות פעילות מרבית',
        content: 'זמן מומלץ למסחר! נפח גבוה בשעות 09:00-11:00',
        type: 'timing',
        priority: 'medium',
        icon: Zap,
        color: 'border-primary/40 bg-primary/20',
        timestamp: new Date()
      });
    }

    if (hour >= 22 || hour <= 6) {
      newTips.push({
        id: 'low-volume',
        title: '😴 שעות נפח נמוך',
        content: 'הימנע ממסחר בשעות 22:00-06:00',
        type: 'warning',
        priority: 'medium',
        icon: AlertTriangle,
        color: 'border-orange-500/40 bg-orange-500/20',
        timestamp: new Date()
      });
    }

    // Market volatility tips
    if (marketCondition.type === 'volatile') {
      newTips.push({
        id: 'volatile-market',
        title: '⚡ שוק תנודתי',
        content: 'תנודתיות גבוהה! השתמש בסטופ לוס צמודים',
        type: 'risk',
        priority: 'high',
        icon: Shield,
        color: 'border-orange-500/40 bg-orange-500/20',
        timestamp: new Date()
      });
    }

    // Weekend tips
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      newTips.push({
        id: 'weekend-planning',
        title: '📅 סוף שבוע - זמן תכנון',
        content: 'זמן טוב לניתוח ותכנון אסטרטגיה',
        type: 'timing',
        priority: 'low',
        icon: Brain,
        color: 'border-primary/30 bg-primary/10',
        timestamp: new Date()
      });
    }

    setTips(newTips.slice(0, 3));
  };

  const getPriorityBadge = (priority: string) => {
    const colors = {
      high: 'bg-red-500 text-white',
      medium: 'bg-yellow-500 text-black',
      low: 'bg-primary text-primary-foreground'
    };
    
    return colors[priority as keyof typeof colors] || colors.medium;
  };

  if (!cryptoData || cryptoData.length === 0) {
    return (
      <Card className="bg-background border-primary/30">
        <CardContent className="flex items-center justify-center p-6">
          <div className="text-center">
            <Brain className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-muted-foreground font-mono">טוען נתוני שוק...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-background border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-primary font-mono">
          <Brain className="w-5 h-5" />
          טיפים חכמים - {currentTime.toLocaleTimeString('he-IL')}
        </CardTitle>
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="outline" className="text-xs font-mono bg-background border-primary/30">
            שוק: {marketCondition.type === 'bullish' ? 'עולה' : 
                  marketCondition.type === 'bearish' ? 'יורד' : 
                  marketCondition.type === 'volatile' ? 'תנודתי' : 'יציב'}
          </Badge>
          <Badge variant="outline" className="text-xs font-mono bg-background border-primary/30">
            נפח: {marketCondition.volume === 'high' ? 'גבוה' : 
                  marketCondition.volume === 'low' ? 'נמוך' : 'רגיל'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {tips.length > 0 ? (
          tips.map((tip) => (
            <div
              key={tip.id}
              className={`p-4 rounded-lg border ${tip.color}`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <tip.icon className="w-4 h-4 text-primary" />
                  <h4 className="font-semibold text-sm font-mono text-primary">{tip.title}</h4>
                </div>
                <Badge className={getPriorityBadge(tip.priority)}>
                  {tip.priority === 'high' ? 'גבוה' : 
                   tip.priority === 'medium' ? 'בינוני' : 'נמוך'}
                </Badge>
              </div>
              <p className="text-sm text-foreground leading-relaxed font-mono">
                {tip.content}
              </p>
              <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground font-mono">
                <Clock className="w-3 h-3" />
                {tip.timestamp.toLocaleTimeString('he-IL')}
              </div>
            </div>
          ))
        ) : (
          <div className="text-center p-4">
            <p className="text-muted-foreground font-mono">אין טיפים זמינים כרגע</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default SmartTipsPanel;

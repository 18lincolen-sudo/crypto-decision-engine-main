
import { useState, useEffect, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart3, TrendingUp, Brain, Target, Zap, Activity, Eye, AlertTriangle, Loader2 } from 'lucide-react';
import Navigation from '../components/Navigation';
import { MatrixBackground } from '../components/MatrixBackground';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar } from 'recharts';
import { coinGeckoApi } from '../services/coinGeckoApi';
import { bybitApi } from '../services/bybitApi';
import { useCryptoData } from '../hooks/useCryptoData';
import { HistoricalPrice } from '@cde/engine';
import { calculateTechnicalIndicators } from '@cde/engine/analysis';
import { calculateAdvancedIndicators } from '@cde/engine/analysis';

interface TechnicalIndicator {
  name: string;
  value: number;
  signal: 'buy' | 'sell' | 'neutral';
  strength: number;
}

interface SentimentData {
  source: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  score: number;
  volume: number;
}

interface PatternItem {
  time: string;
  pattern: string;
  confidence: number;
  price: number;
}

interface Predictions {
  h24: number;
  h24pct: number;
  w: number;
  wpct: number;
  m: number;
  mpct: number;
  confidence: number;
}

function computeWilliamsR(prices: number[], period: number = 14): number {
  if (prices.length < period) return -50;
  const recent = prices.slice(-period);
  const highest = Math.max(...recent);
  const lowest = Math.min(...recent);
  const close = prices[prices.length - 1];
  if (highest === lowest) return -50;
  return ((highest - close) / (highest - lowest)) * -100;
}

const AdvancedAnalysis = () => {
  const { cryptoData, fearGreedData } = useCryptoData();
  const [activeTab, setActiveTab] = useState('technical');
  const [selectedCrypto, setSelectedCrypto] = useState('BTC');
  const [technicalIndicators, setTechnicalIndicators] = useState<TechnicalIndicator[]>([]);
  const [sentimentData, setSentimentData] = useState<SentimentData[]>([]);
  const [patternAnalysis, setPatternAnalysis] = useState<PatternItem[]>([]);
  const [predictions, setPredictions] = useState<Predictions | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get available cryptocurrencies from the live data
  const availableCryptos = useMemo(() => cryptoData?.map(crypto => ({
    symbol: crypto.symbol.toUpperCase(),
    name: crypto.name,
    price: crypto.current_price
  })) || [], [cryptoData]);

  // Keep live data in refs so the analysis only reloads when the user picks a
  // different coin (or data first becomes available) — NOT on every price tick.
  // Depending on the full cryptoData/fearGreedData objects made the effect
  // re-run every 60s, briefly hiding results (loader) and, on a failed refetch,
  // replacing them with an error — i.e. results "disappearing".
  const cryptoDataRef = useRef(cryptoData);
  const fearGreedRef = useRef(fearGreedData);
  cryptoDataRef.current = cryptoData;
  fearGreedRef.current = fearGreedData;
  const dataReady = (cryptoData?.length ?? 0) > 0;

  // Keep the selected crypto valid as the live list changes
  useEffect(() => {
    if (availableCryptos.length && !availableCryptos.find(c => c.symbol === selectedCrypto)) {
      setSelectedCrypto(availableCryptos[0].symbol);
    }
  }, [availableCryptos, selectedCrypto]);

  useEffect(() => {
    let cancelled = false;

    const loadLiveAnalysis = async () => {
      setIsLoading(true);
      setError(null);
      // Read live values from refs so a price tick doesn't re-trigger this effect
      const cd = cryptoDataRef.current;
      const fgIndex = fearGreedRef.current;
      try {
        // Prefer real-time Bybit kline (the same source the rest of the app
        // uses) so the analysis is never built on stale daily CoinGecko candles
        // that lag up to 24h. Fall back to CoinGecko only if Bybit kline is
        // unavailable for the selected symbol.
        const bybitSymbol = bybitApi.getBybitSymbol(selectedCrypto);
        let historical: HistoricalPrice[] = [];
        let volumes: number[] = [];
        const kline = await bybitApi.getKlineData(bybitSymbol, 'D', 30);
        if (kline && kline.length) {
          historical = kline.map(k => ({
            timestamp: parseInt(k.openTime, 10),
            price: parseFloat(k.close),
            volume: parseFloat(k.volume)
          }));
          volumes = historical.map(h => h.volume);
        } else {
          const coinId = coinGeckoApi.getCoinId(selectedCrypto);
          const [hg, vg] = await Promise.all([
            coinGeckoApi.getHistoricalPrices(coinId, 30),
            coinGeckoApi.getVolumeData(coinId, 30)
          ]);
          historical = hg;
          volumes = vg;
        }
        if (cancelled) return;
        if (!historical.length) {
          setError('אין נתונים חיים עבור המטבע שנבחר. נסה שוב מאוחר יותר.');
          return;
        }

        // Anchor the latest point to the live spot price so the analysis uses
        // today's rate instead of the last daily candle (which can lag ~24h).
        const livePrice = cd?.find(c => c.symbol.toUpperCase() === selectedCrypto)?.current_price || 0;
        if (livePrice && historical.length) historical[historical.length - 1].price = livePrice;

        const prices = historical.map(h => h.price);
        const indicators = calculateTechnicalIndicators(historical, volumes);
        const advanced = calculateAdvancedIndicators(historical);

        const williamsR = computeWilliamsR(prices);

        const ti: TechnicalIndicator[] = [
          {
            name: 'RSI',
            value: Number(indicators.rsi.toFixed(2)),
            signal: indicators.rsi < 30 ? 'buy' : indicators.rsi > 70 ? 'sell' : 'neutral',
            strength: Number(Math.min(100, Math.abs(indicators.rsi - 50) * 2).toFixed(2))
          },
          {
            name: 'MACD',
            value: Number(advanced.macd.macd.toFixed(4)),
            signal: advanced.macd.trend === 'bullish' ? 'buy' : advanced.macd.trend === 'bearish' ? 'sell' : 'neutral',
            strength: Number(Math.min(100, Math.abs(advanced.macd.histogram) * 500).toFixed(2))
          },
          {
            name: 'Bollinger Bands',
            value: Number(indicators.bollingerBands.middle.toFixed(2)),
            signal: indicators.bollingerBands.position === 'below' ? 'buy' : indicators.bollingerBands.position === 'above' ? 'sell' : 'neutral',
            strength: 60
          },
          {
            name: 'Moving Average',
            value: Number(indicators.ma20.toFixed(2)),
            signal: prices[prices.length - 1] > indicators.ma20 ? 'buy' : 'sell',
            strength: 70
          },
          {
            name: 'Stochastic',
            value: Number(advanced.stochastic.k.toFixed(2)),
            signal: advanced.stochastic.signal === 'oversold' ? 'buy' : advanced.stochastic.signal === 'overbought' ? 'sell' : 'neutral',
            strength: Number(advanced.stochastic.k.toFixed(2))
          },
          {
            name: 'Williams %R',
            value: Number(williamsR.toFixed(2)),
            signal: williamsR < -80 ? 'buy' : williamsR > -20 ? 'sell' : 'neutral',
            strength: Number((Math.abs(williamsR + 50) * 2).toFixed(2))
          }
        ];
        setTechnicalIndicators(ti);

        const change = cd?.find(c => c.symbol.toUpperCase() === selectedCrypto)?.price_change_percentage_24h || 0;
        const fg = fgIndex?.value ?? 50;
        const liveSentiment: SentimentData[] = [
          {
            source: 'Fear & Greed',
            sentiment: fg >= 55 ? 'positive' : fg <= 45 ? 'negative' : 'neutral',
            score: Number(((fg - 50) / 50).toFixed(2)),
            volume: 0
          },
          {
            source: 'מחיר 24h',
            sentiment: change >= 0 ? 'positive' : 'negative',
            score: Number(Math.max(-1, Math.min(1, change / 10)).toFixed(2)),
            volume: 0
          },
          {
            source: 'נפח מסחר',
            sentiment: 'neutral',
            score: 0,
            volume: Math.floor(volumes.reduce((a, b) => a + b, 0))
          }
        ];
        setSentimentData(liveSentiment);

        const sr = advanced.supportResistance;
        const fib = advanced.fibonacci;
        const patterns: PatternItem[] = [];
        if (sr.support.length) {
          patterns.push({ time: 'תמיכה', pattern: 'Support Zone', confidence: 80, price: sr.support[sr.support.length - 1] });
        }
        if (sr.resistance.length) {
          patterns.push({ time: 'התנגדות', pattern: 'Resistance Zone', confidence: 80, price: sr.resistance[sr.resistance.length - 1] });
        }
        if (fib.levels.length > 4) {
          patterns.push({ time: 'Fib 0.618', pattern: 'Fibonacci', confidence: 70, price: fib.levels[4].price });
        }
        setPatternAnalysis(patterns);

        // Live-derived projections from the recent price slope (no random data)
        const recent = prices.slice(-14);
        const slope = recent.length > 1 ? (recent[recent.length - 1] - recent[0]) / recent.length : 0;
        const last = prices[prices.length - 1] || 0;
        const h24 = last + slope * 1;
        const w = last + slope * 7;
        const m = last + slope * 30;
        const trendConfidence = Math.max(30, Math.min(95, 50 + (Math.abs(slope) / (last || 1)) * 1000));
        setPredictions({
          h24,
          h24pct: Number(((h24 / (last || 1) - 1) * 100).toFixed(1)),
          w,
          wpct: Number(((w / (last || 1) - 1) * 100).toFixed(1)),
          m,
          mpct: Number(((m / (last || 1) - 1) * 100).toFixed(1)),
          confidence: Number(trendConfidence.toFixed(0))
        });
      } catch (err) {
        console.error('Error loading live analysis:', err);
        if (!cancelled) setError('שגיאה בטעינת נתונים חיים מה-API. נסה שוב מאוחר יותר.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadLiveAnalysis();
    return () => { cancelled = true; };
  }, [selectedCrypto, dataReady]);

  const radarData = technicalIndicators.map(indicator => ({
    subject: indicator.name,
    strength: indicator.strength,
    signal: indicator.signal === 'buy' ? 100 : indicator.signal === 'sell' ? 0 : 50
  }));

  const getSignalColor = (signal: string) => {
    switch (signal) {
      case 'buy': return 'text-green-400 bg-green-950/30 border-green-500';
      case 'sell': return 'text-red-400 bg-red-950/30 border-red-500';
      default: return 'text-yellow-400 bg-yellow-950/30 border-yellow-500';
    }
  };

  const getSentimentColor = (sentiment: string) => {
    switch (sentiment) {
      case 'positive': return 'text-green-400';
      case 'negative': return 'text-red-400';
      default: return 'text-yellow-400';
    }
  };

  const currentCrypto = availableCryptos.find(c => c.symbol === selectedCrypto);
  const basePrice = currentCrypto?.price || 0;
  const supportLevel = patternAnalysis.find(p => p.pattern === 'Support Zone')?.price;
  const resistanceLevel = patternAnalysis.find(p => p.pattern === 'Resistance Zone')?.price;
  const liveVolume = sentimentData.find(s => s.source === 'נפח מסחר')?.volume || 0;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <div className="max-w-7xl mx-auto p-4">
        {/* Matrix Background Effect */}
                <MatrixBackground count={25} chars={['📈', '📊', '🧠', '⚡', '🎯', '💡']} />

        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold mb-4 text-primary flex items-center justify-center gap-3">
            <Brain className="w-10 h-10" />
            ניתוח מתקדם AI
          </h1>
          <p className="text-xl text-muted-foreground">
            ניתוח טכני עמוק • זיהוי דפוסים • ניתוח רגשות • חיזוי מגמות
          </p>
        </div>

        {/* Enhanced Crypto Selector */}
        <div className="mb-8 flex justify-center">
          <div className="w-full max-w-md">
            <Select value={selectedCrypto} onValueChange={setSelectedCrypto}>
              <SelectTrigger className="w-full border-primary/30 bg-card/50 backdrop-blur text-primary">
                <SelectValue placeholder="בחר מטבע קריפטו" />
              </SelectTrigger>
              <SelectContent className="bg-card/95 backdrop-blur border-primary/30">
                {availableCryptos.map((crypto) => (
                  <SelectItem key={crypto.symbol} value={crypto.symbol} className="text-primary">
                    <div className="flex items-center justify-between w-full">
                      <span className="font-bold">{crypto.symbol}</span>
                      <span className="text-sm text-muted-foreground ml-2">
                        ${crypto.price.toLocaleString()}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center h-40">
            <div className="text-center">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
              <p>טוען ניתוח חי...</p>
            </div>
          </div>
        )}

        {error && !isLoading && (
          <div className="flex items-center justify-center h-40">
            <div className="text-center text-red-400">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
              <p>{error}</p>
            </div>
          </div>
        )}

        {!isLoading && !error && (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">
          <TabsList className="grid w-full grid-cols-4 bg-card/50 border border-primary/30">
            <TabsTrigger value="technical" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
              <BarChart3 className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">ניתוח טכני</span>
              <span className="sm:hidden">טכני</span>
            </TabsTrigger>
            <TabsTrigger value="sentiment" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
              <Brain className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">ניתוח רגשות</span>
              <span className="sm:hidden">רגשות</span>
            </TabsTrigger>
            <TabsTrigger value="patterns" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
              <Eye className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">זיהוי דפוסים</span>
              <span className="sm:hidden">דפוסים</span>
            </TabsTrigger>
            <TabsTrigger value="predictions" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
              <Target className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">חיזויים</span>
              <span className="sm:hidden">חיזוי</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="technical" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Technical Indicators */}
              <Card className="border-primary/30 bg-card/50 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-primary flex items-center gap-2">
                    <Activity className="w-5 h-5" />
                    אינדיקטורים טכניים
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {technicalIndicators.map((indicator, index) => (
                      <div key={index} className="flex items-center justify-between p-3 border border-primary/20 rounded-lg">
                        <div>
                          <div className="font-medium text-primary">{indicator.name}</div>
                          <div className="text-sm text-muted-foreground">
                            ערך: {typeof indicator.value === 'number' ? indicator.value.toFixed(2) : indicator.value}
                          </div>
                        </div>
                        <div className="text-right">
                          <Badge className={`mb-2 ${getSignalColor(indicator.signal)}`}>
                            {indicator.signal === 'buy' ? 'קנייה' : indicator.signal === 'sell' ? 'מכירה' : 'נייטרלי'}
                          </Badge>
                          <div className="text-sm">
                            <div className="w-16 bg-gray-700 rounded-full h-2 mb-1">
                              <div
                                className="bg-primary h-2 rounded-full transition-all"
                                style={{ width: `${indicator.strength}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground">{indicator.strength.toFixed(2)}%</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Radar Chart */}
              <Card className="border-primary/30 bg-card/50 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-primary">מפת אינדיקטורים</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height={256}>
                      <RadarChart data={radarData}>
                        <PolarGrid stroke="rgba(34, 197, 94, 0.3)" />
                        <PolarAngleAxis tick={{ fill: 'rgba(34, 197, 94, 0.7)', fontSize: 12 }} />
                        <PolarRadiusAxis tick={{ fill: 'rgba(34, 197, 94, 0.7)', fontSize: 10 }} />
                        <Radar name="Strength" dataKey="strength" stroke="#22c55e" fill="#22c55e" fillOpacity={0.2} />
                      </RadarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="sentiment" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Sentiment Analysis */}
              <Card className="border-primary/30 bg-card/50 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-primary flex items-center gap-2">
                    <Brain className="w-5 h-5" />
                    ניתוח רגשות בזמן אמת
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {sentimentData.map((data, index) => (
                      <div key={index} className="flex items-center justify-between p-3 border border-primary/20 rounded-lg">
                        <div>
                          <div className="font-medium text-primary">{data.source}</div>
                          <div className="text-sm text-muted-foreground">
                            {data.volume > 0 ? `${(data.volume / 1000000).toFixed(0)}M נפח` : 'מדד חי'}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`font-bold ${getSentimentColor(data.sentiment)}`}>
                            {data.sentiment === 'positive' ? 'חיובי' : data.sentiment === 'negative' ? 'שלילי' : 'נייטרלי'}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            ציון: {data.score.toFixed(2)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Sentiment Chart */}
              <Card className="border-primary/30 bg-card/50 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-primary">התפלגות רגשות</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-64" key={activeTab}>
                    <ResponsiveContainer width="100%" height={256}>
                      <BarChart data={sentimentData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(34, 197, 94, 0.2)" />
                        <XAxis dataKey="source" stroke="rgba(34, 197, 94, 0.7)" />
                        <YAxis stroke="rgba(34, 197, 94, 0.7)" />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'rgba(8, 47, 73, 0.9)',
                            border: '1px solid rgba(34, 197, 94, 0.3)',
                            borderRadius: '8px'
                          }}
                        />
                        <Bar dataKey="score" fill="#22c55e" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="patterns" className="space-y-6">
            <Card className="border-primary/30 bg-card/50 backdrop-blur">
              <CardHeader>
                <CardTitle className="text-primary flex items-center gap-2">
                  <Eye className="w-5 h-5" />
                  דפוסים שזוהו מהנתונים החיים
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {patternAnalysis.length === 0 && (
                    <div className="col-span-full text-center text-muted-foreground p-6">
                      אין דפוסים זמינים כרגע — הנתונים החיים לא זיהו רמות תמיכה/התנגדות מובהקות
                    </div>
                  )}
                  {patternAnalysis.map((pattern, index) => (
                    <div key={index} className="p-4 border border-primary/20 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium text-primary">{pattern.pattern}</div>
                        <Badge className="bg-primary/20 text-primary border-primary">
                          {pattern.confidence.toFixed(2)}% ביטחון
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        <div>זמן: {pattern.time}</div>
                        <div>מחיר: ${pattern.price.toLocaleString()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="predictions" className="space-y-6">
            {predictions && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Card className="border-green-500/30 bg-green-950/20 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-green-400 flex items-center gap-2">
                    <TrendingUp className="w-5 h-5" />
                    חיזוי 24 שעות
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-green-400">
                      ${predictions.h24.toFixed(2).toLocaleString()}
                    </div>
                    <div className="text-sm text-green-300">
                      {predictions.h24pct >= 0 ? '+' : ''}{predictions.h24pct}% שינוי צפוי
                    </div>
                    <div className="mt-4">
                      <div className="text-xs text-muted-foreground mb-1">רמת ביטחון</div>
                      <div className="w-full bg-gray-700 rounded-full h-2">
                        <div
                          className="bg-green-500 h-2 rounded-full transition-all"
                          style={{ width: `${predictions.confidence}%` }}
                        />
                      </div>
                      <div className="text-xs text-green-400 mt-1">
                        {predictions.confidence}%
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-yellow-500/30 bg-yellow-950/20 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-yellow-400 flex items-center gap-2">
                    <Target className="w-5 h-5" />
                    חיזוי שבועי
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-yellow-400">
                      ${predictions.w.toFixed(2).toLocaleString()}
                    </div>
                    <div className="text-sm text-yellow-300">
                      {predictions.wpct >= 0 ? '+' : ''}{predictions.wpct}% שינוי צפוי
                    </div>
                    <div className="mt-4">
                      <div className="text-xs text-muted-foreground mb-1">רמת ביטחון</div>
                      <div className="w-full bg-gray-700 rounded-full h-2">
                        <div
                          className="bg-yellow-500 h-2 rounded-full transition-all"
                          style={{ width: `${Math.max(20, predictions.confidence - 10)}%` }}
                        />
                      </div>
                      <div className="text-xs text-yellow-400 mt-1">
                        {Math.max(20, predictions.confidence - 10)}%
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-blue-500/30 bg-blue-950/20 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-blue-400 flex items-center gap-2">
                    <Zap className="w-5 h-5" />
                    חיזוי חודשי
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-blue-400">
                      ${predictions.m.toFixed(2).toLocaleString()}
                    </div>
                    <div className="text-sm text-blue-300">
                      {predictions.mpct >= 0 ? '+' : ''}{predictions.mpct}% שינוי צפוי
                    </div>
                    <div className="mt-4">
                      <div className="text-xs text-muted-foreground mb-1">רמת ביטחון</div>
                      <div className="w-full bg-gray-700 rounded-full h-2">
                        <div
                          className="bg-blue-500 h-2 rounded-full transition-all"
                          style={{ width: `${Math.max(15, predictions.confidence - 20)}%` }}
                        />
                      </div>
                      <div className="text-xs text-blue-400 mt-1">
                        {Math.max(15, predictions.confidence - 20)}%
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
            )}

            <Card className="border-primary/30 bg-card/50 backdrop-blur">
              <CardHeader>
                <CardTitle className="text-primary flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" />
                  התרעות וסיכונים עבור {selectedCrypto}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {resistanceLevel ? (
                    <div className="p-3 border border-red-500/30 bg-red-950/20 rounded-lg">
                      <div className="text-red-400 font-medium">
                        ⚠️ התנגדות חזקה ב-${resistanceLevel.toFixed(2).toLocaleString()}
                      </div>
                      <div className="text-sm text-muted-foreground">ייתכן קושי בפריצה מעל לרמה זו</div>
                    </div>
                  ) : (
                    <div className="p-3 border border-red-500/30 bg-red-950/20 rounded-lg">
                      <div className="text-red-400 font-medium">⚠️ אין רמת התנגדות מובהקת זמינה מהנתונים החיים</div>
                    </div>
                  )}
                  {supportLevel ? (
                    <div className="p-3 border border-green-500/30 bg-green-950/20 rounded-lg">
                      <div className="text-green-400 font-medium">
                        🎯 תמיכה חזקה ב-${supportLevel.toFixed(2).toLocaleString()}
                      </div>
                      <div className="text-sm text-muted-foreground">רמת קנייה אטרקטיבית במקרה של ירידה</div>
                    </div>
                  ) : (
                    <div className="p-3 border border-green-500/30 bg-green-950/20 rounded-lg">
                      <div className="text-green-400 font-medium">🎯 אין רמת תמיכה מובהקת זמינה מהנתונים החיים</div>
                    </div>
                  )}
                  <div className="p-3 border border-yellow-500/30 bg-yellow-950/20 rounded-lg">
                    <div className="text-yellow-400 font-medium">📊 נפח מסחר {selectedCrypto}</div>
                    <div className="text-sm text-muted-foreground">נפח מסחר יומי (30 ימים): ${(liveVolume / 30).toFixed(0).toLocaleString()}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
        )}
      </div>
    </div>
  );
};

export default AdvancedAnalysis;

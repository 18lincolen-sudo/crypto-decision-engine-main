import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Bot, Play, Pause, Square, Zap, Settings, ArrowDownCircle, ArrowUpCircle, RefreshCw, ChevronDown, FileText, Target, Shield } from 'lucide-react';
import Navigation from '../components/Navigation';
import PortfolioPulseCard from '../components/trading/PortfolioPulseCard';
import PortfolioRiskMeter from '../components/trading/PortfolioRiskMeter';
import LivePositionChart from '../components/trading/LivePositionChart';
import { useSimulationBotContext } from '../contexts/SimulationBotContext';
import { useCryptoData } from '../hooks/useCryptoData';
import type { SimBotConfig } from '../hooks/useSimulationBot';

const SimulationBot = () => {
  const {
    cash,
    positions,
    positionsValue,
    equity,
    trades,
    history,
    pending,
    totalFees,
    totalSlippageCost,
    winRate,
    totalTrades,
    closedTrades,
    lastEvaluation,
    evaluations,
    minConfidence,
    hasSavedSession,
    nextTickAt,
    totalLeveragedExposureUsd,
    dailyDrawdownPercent,
    weeklyDrawdownPercent,
    candleCount,
    config: botConfig,
    setConfig: setBotConfig,
    status,
    isRunning,
    start: startSimulation,
    pause: pauseSimulation,
    resetAll: resetSimulation
  } = useSimulationBotContext();

  const { cryptoData, isLoading } = useCryptoData();

  const [openLogs, setOpenLogs] = useState<string[]>([]);
  const [countdown, setCountdown] = useState(0);

  // Countdown timer to next tick (4s tick interval)
  useEffect(() => {
    if (!isRunning) {
      setCountdown(0);
      return;
    }
    const updateCountdown = () => {
      if (!nextTickAt) {
        setCountdown(4);
        return;
      }
      const remaining = Math.max(0, nextTickAt - Date.now());
      setCountdown(remaining > 0 ? Math.min(4, Math.ceil(remaining / 1000)) : 1);
    };
    updateCountdown();
    const id = setInterval(updateCountdown, 250);
    return () => clearInterval(id);
  }, [isRunning, nextTickAt]);

  const lastTrade = trades[0];
  const openFuturesCount = positions.filter(p => p.type === 'FUTURES').length;
  const firstRegime = evaluations[0]?.regime;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <div className="max-w-7xl mx-auto p-3 sm:p-4 space-y-6">
        {/* Header */}
        <div className="text-center pt-2">
          <h1 className="text-3xl sm:text-4xl font-bold mb-2 text-primary flex items-center justify-center gap-3 font-mono">
            <Bot className="w-9 h-9" />
            בוט סימולציה AI — Spot + Futures
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground font-mono">
            זיהוי משטר שוק (ADX/Supertrend/ATR) • ניתוב Spot/Futures ממונף • ניהול סיכונים Kelly &amp; Trailing Stop
          </p>
        </div>

        {/* Live data status */}
        <Card className="border-primary/30 bg-card/50 backdrop-blur">
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-mono">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
              <span className="text-muted-foreground">
                {isLoading
                  ? 'טוען נתוני שוק...'
                  : `${cryptoData?.length || 0} נכסים חיים • ${candleCount || 0} נרות חיים • ${evaluations?.length || 0} הערכות במנוע`}
              </span>
            </div>
            <div className="text-sm font-mono text-muted-foreground">
              סף Spot: <span className="text-cyan-400 font-bold">{botConfig.riskLevel === 'high' ? 50 : botConfig.riskLevel === 'low' ? 64 : 60}%</span> | סף Futures: <span className="text-purple-400 font-bold">{botConfig.riskLevel === 'high' ? 56 : botConfig.riskLevel === 'low' ? 72 : 68}%</span>
              {lastEvaluation && <span className="ml-3">בדיקה: {lastEvaluation}</span>}
              {isRunning && countdown > 0 && (
                <span className="ml-3 text-primary font-bold">
                  טיקט הבא: {countdown}s
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Portfolio Risk Meter (Layer 3 & 4 monitoring) */}
        <PortfolioRiskMeter
          portfolioValue={equity}
          totalInvestedUsd={positionsValue}
          totalLeveragedExposureUsd={totalLeveragedExposureUsd}
          openPositionsCount={positions.length}
          maxPositions={botConfig.maxPositions}
          openFuturesCount={openFuturesCount}
          maxFutures={2}
          dailyDrawdownPercent={dailyDrawdownPercent}
          weeklyDrawdownPercent={weeklyDrawdownPercent}
          marketRegime={firstRegime}
        />

        {/* Action cards: recommendations + settings */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Recommendations dialog */}
          <Dialog>
            <DialogTrigger asChild>
              <Card className="border-primary/30 bg-card/50 backdrop-blur cursor-pointer hover:border-primary transition-colors">
                <CardContent className="p-5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Zap className="w-6 h-6 text-primary" />
                    <div className="text-right">
                      <div className="text-primary font-bold font-mono">הערכות מנוע ההחלטות (TradeEngine)</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {evaluations?.length || 0} הערכות שוק • לחץ לפירוט מלא
                      </div>
                    </div>
                  </div>
                  <ChevronDown className="w-5 h-5 text-muted-foreground" />
                </CardContent>
              </Card>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-primary font-mono">
                  <Zap className="w-5 h-5" />
                  מנוע ההחלטות בזמן אמת ({evaluations?.length || 0})
                </DialogTitle>
                <DialogDescription className="sr-only">
                  רשימת הערכות מנוע ההחלטות בזמן אמת לכל מטבע
                </DialogDescription>
              </DialogHeader>
              {!evaluations?.length ? (
                <div className="text-muted-foreground text-sm text-center py-4 font-mono">
                  {isLoading ? 'מחשב ניתוח רב-שכבתי...' : 'אין נתוני מטבעות זמינים'}
                </div>
              ) : (
                <div className="space-y-3 font-mono">
                  {evaluations.map((rec) => {
                    const isFutures = rec.tradeType === 'FUTURES';
                    const isSpot = rec.tradeType === 'SPOT';
                    const open = openLogs.includes(rec.symbol);

                    return (
                      <div key={rec.symbol} className="p-3.5 border border-primary/20 rounded-lg bg-card/30">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <Badge className="font-mono">{rec.symbol}</Badge>
                            <Badge
                              variant="outline"
                              className={
                                isFutures
                                  ? 'text-purple-400 border-purple-500/50 bg-purple-500/10'
                                  : isSpot
                                  ? 'text-cyan-400 border-cyan-500/50 bg-cyan-500/10'
                                  : 'text-muted-foreground'
                              }
                            >
                              {isFutures ? `FUTURES ${rec.leverage}x ${rec.tradeSide}` : isSpot ? `SPOT ${rec.tradeSide}` : 'HOLD'}
                            </Badge>
                            <span className="text-sm font-bold text-primary">
                              ביטחון {rec.confidence.toFixed(1)}%
                            </span>
                            {rec.regime && (
                              <span className="text-xs text-muted-foreground hidden sm:inline">
                                ({rec.regime.regime}, ADX {rec.regime.adx})
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            ${rec.price.toFixed(4)}{' '}
                            <span className={rec.priceChange24h >= 0 ? 'text-green-400' : 'text-red-400'}>
                              ({rec.priceChange24h >= 0 ? '+' : ''}{rec.priceChange24h.toFixed(2)}%)
                            </span>
                          </div>
                          <Badge variant={rec.willExecute ? 'default' : 'secondary'} className="text-xs">
                            {rec.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground mt-2">{rec.reasoning}</div>

                        <button
                          type="button"
                          onClick={() =>
                            setOpenLogs((prev) =>
                              prev.includes(rec.symbol) ? prev.filter((s) => s !== rec.symbol) : [...prev, rec.symbol]
                            )
                          }
                          className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <FileText className="w-3 h-3" />
                          פירוט 6 שכבות החלטה ({rec.factors.length})
                          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                        </button>

                        {open && (
                          <div className="mt-2 border-t border-primary/20 pt-2 space-y-1.5 bg-background/40 p-2.5 rounded">
                            {rec.factors.map((f, i) => (
                              <div
                                key={i}
                                className="flex items-start justify-between gap-2 text-xs py-1 border-b border-primary/10 last:border-0"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                      f.impact === 'positive'
                                        ? 'bg-green-400'
                                        : f.impact === 'negative'
                                        ? 'bg-red-400'
                                        : 'bg-muted-foreground'
                                    }`}
                                  />
                                  <span className="font-semibold">{f.label}</span>
                                  <span className="text-muted-foreground">{f.value}</span>
                                </div>
                                <span className="text-muted-foreground text-left max-w-[50%]">{f.note}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </DialogContent>
          </Dialog>

          {/* Settings dialog */}
          <Dialog>
            <DialogTrigger asChild>
              <Card className="border-primary/30 bg-card/50 backdrop-blur cursor-pointer hover:border-primary transition-colors">
                <CardContent className="p-5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Settings className="w-6 h-6 text-primary" />
                    <div className="text-right">
                      <div className="text-primary font-bold font-mono">הגדרות בוט &amp; פרמטרים</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        סיכון {botConfig.riskLevel} • מקס' 5 פוזיציות (עד 2 Futures) • Kelly Sizing
                      </div>
                    </div>
                  </div>
                  <ChevronDown className="w-5 h-5 text-muted-foreground" />
                </CardContent>
              </Card>
            </DialogTrigger>
            <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto font-mono">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-primary">
                  <Settings className="w-5 h-5" />
                  הגדרות בוט ומסחר
                </DialogTitle>
                <DialogDescription className="sr-only">
                  הגדרות פרופיל סיכון, הון התחלתי, עמלות והחלקה
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-muted-foreground mb-2 block">פרופיל סיכון</label>
                  <Select
                    value={botConfig.riskLevel}
                    onValueChange={(value) => setBotConfig({ ...botConfig, riskLevel: value as SimBotConfig['riskLevel'] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">נמוך (שמרני)</SelectItem>
                      <SelectItem value="medium">בינוני (מאוזן)</SelectItem>
                      <SelectItem value="high">גבוה (אגרסיבי)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-2 block">הון התחלתי ($)</label>
                  <Input
                    type="number"
                    value={botConfig.initialAmount}
                    onChange={(e) => setBotConfig({ ...botConfig, initialAmount: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-2 block">עמלת Spot Bybit (%)</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={botConfig.feePercent}
                    onChange={(e) => setBotConfig({ ...botConfig, feePercent: Math.max(0, Number(e.target.value)) })}
                  />
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-2 block">החלקה בסיסית / Slippage (%)</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={botConfig.slippagePercent}
                    onChange={(e) => setBotConfig({ ...botConfig, slippagePercent: Math.max(0, Number(e.target.value)) })}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                * חישובי TP/SL מחושבים דינמית לפי מדד ATR(14) בזמן אמת. גודל הפוזיציה נגזר מנוסחת Kelly Criterion מוגבלת (עד 10% לכל היותר).
              </p>
            </DialogContent>
          </Dialog>
        </div>

        {/* Bot Control Panel */}
        <Card className="border-primary/30 bg-card/50 backdrop-blur">
          <CardContent className="p-5 font-mono">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div
                  className={`w-3.5 h-3.5 rounded-full ${
                    status === 'running' ? 'bg-green-500 animate-pulse' : status === 'paused' ? 'bg-yellow-500' : 'bg-gray-500'
                  }`}
                />
                <span className="font-medium text-sm sm:text-base text-primary">
                  {status === 'running'
                    ? 'בוט פעיל — סורק משטר שוק ומבצע עסקאות Spot/Futures'
                    : status === 'paused'
                    ? 'בוט מושהה — נתונים שמורים'
                    : 'בוט מושבת'}
                </span>
              </div>
              <div className="flex gap-2 flex-wrap justify-center">
                <Button onClick={startSimulation} disabled={isRunning} className="bg-green-600 hover:bg-green-700">
                  <Play className="w-4 h-4 mr-2" />
                  {status === 'paused' || hasSavedSession ? 'המשך' : 'התחל'}
                </Button>
                <Button onClick={pauseSimulation} disabled={!isRunning} variant="outline">
                  <Pause className="w-4 h-4 mr-2" />
                  השהה
                </Button>
                <Button onClick={resetSimulation} variant="destructive">
                  <Square className="w-4 h-4 mr-2" />
                  איפוס
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Portfolio pulse card */}
        <PortfolioPulseCard
          equity={equity}
          invested={botConfig.initialAmount}
          cash={cash}
          positionsValue={positionsValue}
          history={history}
          trades={trades}
          statusLabel={status === 'running' ? 'בוט פעיל' : status === 'paused' ? 'מושהה' : 'מושבת'}
          statusTone={status}
          metrics={[
            {
              label: 'עסקאות',
              value: `${totalTrades}`,
              hint: `${closedTrades} נסגרו • הצלחה ${winRate.toFixed(1)}%`,
            },
            {
              label: 'פוזיציות פתוחות',
              value: `${positions.length}/5`,
              hint: `${openFuturesCount} פיוצ'רס • ${positions.length - openFuturesCount} ספוט`,
            },
            {
              label: 'עלויות מסחר',
              value: `-$${(totalFees + totalSlippageCost).toFixed(2)}`,
              tone: 'negative',
              hint: `עמלות $${totalFees.toFixed(2)} • החלקה $${totalSlippageCost.toFixed(2)}`,
            },
            {
              label: 'פעולה אחרונה',
              value: lastTrade ? `${lastTrade.side.toUpperCase()} ${lastTrade.symbol}` : '—',
              hint: lastTrade?.timestamp || 'אין פעולות',
            },
            {
              label: 'פקודות בהמתנה',
              value: `${pending.length}`,
              hint: pending.length ? pending.map((o) => `${o.symbol} ${o.side}`).join(' • ') : 'תור פנוי',
            },
            {
              label: 'טיקט הבא',
              value: isRunning ? `${countdown}s` : '—',
              hint: 'דופק 4 שניות',
            },
          ]}
        />

        {/* Positions & Trades Tabs */}
        <Card className="border-primary/30 bg-card/50 backdrop-blur">
          <CardContent className="p-4">
            <Tabs defaultValue="positions">
              <TabsList className="grid grid-cols-2 w-full mb-4">
                <TabsTrigger value="positions" className="font-mono text-xs sm:text-sm">
                  פוזיציות פתוחות ({positions.length})
                </TabsTrigger>
                <TabsTrigger value="trades" className="font-mono text-xs sm:text-sm">
                  יומן עסקאות ({trades.length})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="positions">
                {positions.length === 0 ? (
                  <div className="text-muted-foreground text-sm text-center py-8 font-mono">
                    {isRunning ? 'ממתין לאיתותי מסחר מתאימים לפי משטר השוק...' : 'הפעל את הבוט כדי להתחיל'}
                  </div>
                ) : (
                  <div className="space-y-4 max-h-[32rem] overflow-y-auto">
                    {positions.map((pos) => {
                      const isFutures = pos.type === 'FUTURES';
                      const isLong = pos.side === 'LONG' || pos.side === 'BUY';
                      const liveAsset = cryptoData?.find(
                        (c) => c.symbol.toUpperCase() === pos.symbol.toUpperCase()
                      );
                      const livePrice = liveAsset?.current_price ?? pos.currentPrice ?? pos.entryPrice;
                      const priceDiff = isLong
                        ? livePrice - pos.entryPrice
                        : pos.entryPrice - livePrice;
                      const pnl = priceDiff * pos.quantity * (pos.leverage || 1);

                      return (
                        <div key={pos.id} className="space-y-2">
                          <LivePositionChart
                            symbol={pos.symbol}
                            type={pos.type}
                            side={pos.side}
                            entryPrice={pos.entryPrice}
                            currentPrice={livePrice}
                            quantity={pos.quantity}
                            openedAt={pos.openedAt}
                            openTimestamp={pos.openTimestamp}
                            stopLoss={pos.stopLoss}
                            takeProfit={pos.takeProfit}
                            takeProfit1={pos.takeProfit1}
                            leverage={pos.leverage}
                            unrealizedPnl={pnl}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="trades">
                {trades.length === 0 ? (
                  <div className="text-muted-foreground text-sm text-center py-8 font-mono">אין עסקאות עדיין</div>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto font-mono">
                    {trades.map((trade) => (
                      <div key={trade.id} className="p-2.5 border border-primary/20 rounded bg-card/30">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 text-sm">
                            {trade.side.includes('buy') || trade.side.includes('long') ? (
                              <ArrowUpCircle className="w-4 h-4 text-green-400" />
                            ) : (
                              <ArrowDownCircle className="w-4 h-4 text-red-400" />
                            )}
                            <Badge variant="outline">{trade.symbol}</Badge>
                            <Badge
                              variant="secondary"
                              className={`text-[10px] ${
                                trade.type === 'FUTURES' ? 'text-purple-300' : 'text-cyan-300'
                              }`}
                            >
                              {trade.type} {trade.leverage > 1 ? `${trade.leverage}x` : ''} {trade.side.toUpperCase()}
                            </Badge>
                            <span className="text-muted-foreground text-xs">{trade.timestamp}</span>
                          </div>
                          <div className="text-sm">
                            <span className="text-primary">${trade.price.toFixed(4)}</span>
                            <span className="text-muted-foreground"> • ${trade.usdValue.toFixed(2)}</span>
                            {trade.pnl !== undefined && (
                              <span className={`ml-2 font-bold ${trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} ({trade.pnlPercent?.toFixed(2)}%)
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">{trade.reason}</div>
                        <div className="text-[11px] text-muted-foreground mt-1 font-mono">
                          מחיר איתות ${trade.requestedPrice.toFixed(4)} • החלקה {trade.slippagePercent.toFixed(3)}% • עמלה ${trade.fee.toFixed(2)} • השהיה {(trade.delayMs / 1000).toFixed(1)}s
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default SimulationBot;

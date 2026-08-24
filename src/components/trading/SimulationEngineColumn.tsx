import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Play, Pause, Square, Zap, Settings, ArrowDownCircle, ArrowUpCircle, ChevronDown, FileText } from 'lucide-react';
import PortfolioPulseCard from './PortfolioPulseCard';
import LivePositionChart from './LivePositionChart';
import type { CryptoData } from '@/types/crypto';
import type { SimBotConfig } from '@/hooks/useSimulationBot';

export interface EngineColumnProps {
  title: string;
  subtitle: string;
  accentClass: string; // e.g. 'text-primary' or 'text-cyan-400' — column header + accent color
  cryptoData?: CryptoData[];
  cash: number;
  positions: any[];
  positionsValue: number;
  equity: number;
  trades: any[];
  history: any[];
  pending: any[];
  totalFees: number;
  totalSlippageCost: number;
  winRate: number;
  totalTrades: number;
  closedTrades: number;
  evaluations: any[];
  hasSavedSession: boolean;
  nextTickAt: number;
  config: SimBotConfig;
  setConfig: (c: SimBotConfig) => void;
  status: 'running' | 'paused' | 'idle';
  isRunning: boolean;
  start: () => void;
  pause: () => void;
  resetAll: () => void;
}

// One self-contained engine column: control panel, capital/settings, live
// decision feed, pulse card, positions and trade log. Rendered twice side by
// side (new intraday engine vs. the original alg.md confidence-score engine)
// so both can be configured and watched independently for comparison.
export default function SimulationEngineColumn({
  title, subtitle, accentClass, cryptoData,
  cash, positions, positionsValue, equity, trades, history, pending,
  totalFees, totalSlippageCost, winRate, totalTrades, closedTrades,
  evaluations, hasSavedSession, nextTickAt, config: botConfig, setConfig: setBotConfig,
  status, isRunning, start, pause, resetAll
}: EngineColumnProps) {
  const [openLogs, setOpenLogs] = useState<string[]>([]);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!isRunning) {
      setCountdown(0);
      return;
    }
    const updateCountdown = () => {
      if (!nextTickAt) {
        setCountdown(5);
        return;
      }
      const remaining = Math.max(0, nextTickAt - Date.now());
      setCountdown(remaining > 0 ? Math.min(5, Math.ceil(remaining / 1000)) : 1);
    };
    updateCountdown();
    const id = setInterval(updateCountdown, 200);
    return () => clearInterval(id);
  }, [isRunning, nextTickAt]);

  const lastTrade = trades[0];
  const openFuturesCount = positions.filter((p) => p.type === 'FUTURES').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className={`text-lg font-bold font-mono ${accentClass}`}>{title}</h2>
          <p className="text-xs text-muted-foreground font-mono">{subtitle}</p>
        </div>
        <div
          className={`w-3 h-3 rounded-full ${
            status === 'running' ? 'bg-green-500 animate-pulse' : status === 'paused' ? 'bg-yellow-500' : 'bg-gray-500'
          }`}
          title={status === 'running' ? 'פעיל' : status === 'paused' ? 'מושהה' : 'מושבת'}
        />
      </div>

      {/* Evaluations + Settings */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Dialog>
          <DialogTrigger asChild>
            <Card className="border-border/40 bg-card/50 backdrop-blur cursor-pointer hover:border-primary/50 transition-colors">
              <CardContent className="p-3.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Zap className={`w-5 h-5 shrink-0 ${accentClass}`} />
                  <div className="text-right min-w-0">
                    <div className="text-sm font-bold font-mono truncate">הערכות מנוע</div>
                    <div className="text-xs text-muted-foreground font-mono">{evaluations?.length || 0} נכסים</div>
                  </div>
                </div>
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          </DialogTrigger>
          <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className={`flex items-center gap-2 font-mono ${accentClass}`}>
                <Zap className="w-5 h-5" />
                {title} — הערכות בזמן אמת ({evaluations?.length || 0})
              </DialogTitle>
              <DialogDescription className="sr-only">רשימת הערכות מנוע ההחלטות לכל מטבע</DialogDescription>
            </DialogHeader>
            {!evaluations?.length ? (
              <div className="text-muted-foreground text-sm text-center py-4 font-mono">אין נתוני מטבעות זמינים</div>
            ) : (
              <div className="space-y-3 font-mono">
                {evaluations.map((rec) => {
                  const isFutures = rec.tradeType === 'FUTURES';
                  const isSpot = rec.tradeType === 'SPOT';
                  const open = openLogs.includes(rec.symbol);
                  return (
                    <div key={rec.symbol} className="p-3.5 border border-border/40 rounded-lg bg-card/30">
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
                          <span className={`text-sm font-bold ${accentClass}`}>ביטחון {rec.confidence.toFixed(1)}%</span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          ${rec.price.toFixed(4)}{' '}
                          <span className={rec.priceChange24h >= 0 ? 'text-green-400' : 'text-red-400'}>
                            ({rec.priceChange24h >= 0 ? '+' : ''}{rec.priceChange24h.toFixed(2)}%)
                          </span>
                        </div>
                        <Badge variant={rec.willExecute ? 'default' : 'secondary'} className="text-xs">{rec.status}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-2">{rec.reasoning}</div>
                      <button
                        type="button"
                        onClick={() => setOpenLogs((prev) => (prev.includes(rec.symbol) ? prev.filter((s) => s !== rec.symbol) : [...prev, rec.symbol]))}
                        className={`mt-2 flex items-center gap-1 text-xs cursor-pointer hover:underline ${accentClass}`}
                      >
                        <FileText className="w-3 h-3" />
                        פירוט שכבות החלטה ({rec.factors.length})
                        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                      </button>
                      {open && (
                        <div className="mt-2 border-t border-border/30 pt-2 space-y-1.5 bg-background/40 p-2.5 rounded">
                          {rec.factors.map((f: any, i: number) => (
                            <div key={i} className="flex items-start justify-between gap-2 text-xs py-1 border-b border-border/20 last:border-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${f.impact === 'positive' ? 'bg-green-400' : f.impact === 'negative' ? 'bg-red-400' : 'bg-muted-foreground'}`} />
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

        <Dialog>
          <DialogTrigger asChild>
            <Card className="border-border/40 bg-card/50 backdrop-blur cursor-pointer hover:border-primary/50 transition-colors">
              <CardContent className="p-3.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Settings className={`w-5 h-5 shrink-0 ${accentClass}`} />
                  <div className="text-right min-w-0">
                    <div className="text-sm font-bold font-mono truncate">הגדרות והון</div>
                    <div className="text-xs text-muted-foreground font-mono">${botConfig.initialAmount.toLocaleString()}</div>
                  </div>
                </div>
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          </DialogTrigger>
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto font-mono">
            <DialogHeader>
              <DialogTitle className={`flex items-center gap-2 ${accentClass}`}>
                <Settings className="w-5 h-5" />
                {title} — הגדרות
              </DialogTitle>
              <DialogDescription className="sr-only">הגדרות פרופיל סיכון, הון התחלתי, עמלות והחלקה</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-muted-foreground mb-2 block">פרופיל סיכון</label>
                <Select value={botConfig.riskLevel} onValueChange={(value) => setBotConfig({ ...botConfig, riskLevel: value as SimBotConfig['riskLevel'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">נמוך (שמרני)</SelectItem>
                    <SelectItem value="medium">בינוני (מאוזן)</SelectItem>
                    <SelectItem value="high">גבוה (אגרסיבי)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-2 block">הון התחלתי ($) — נפרד לכל מנוע</label>
                <Input type="number" value={botConfig.initialAmount} onChange={(e) => setBotConfig({ ...botConfig, initialAmount: Number(e.target.value) })} />
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-2 block">עמלת Spot Bybit (%)</label>
                <Input type="number" step="0.01" value={botConfig.feePercent} onChange={(e) => setBotConfig({ ...botConfig, feePercent: Math.max(0, Number(e.target.value)) })} />
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-2 block">החלקה בסיסית / Slippage (%)</label>
                <Input type="number" step="0.01" value={botConfig.slippagePercent} onChange={(e) => setBotConfig({ ...botConfig, slippagePercent: Math.max(0, Number(e.target.value)) })} />
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Control Panel */}
      <Card className="border-border/40 bg-card/50 backdrop-blur">
        <CardContent className="p-4 font-mono">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {status === 'running' ? 'פעיל — סורק ומבצע' : status === 'paused' ? 'מושהה' : 'מושבת'}
              {isRunning && countdown > 0 && <span className={`mr-2 font-bold ${accentClass}`}>· טיק בעוד {countdown}s</span>}
            </span>
            <div className="flex gap-2 flex-wrap justify-center">
              <Button onClick={start} disabled={isRunning} size="sm" className="bg-green-600 hover:bg-green-700 cursor-pointer">
                <Play className="w-4 h-4 mr-1" />
                {status === 'paused' || hasSavedSession ? 'המשך' : 'התחל'}
              </Button>
              <Button onClick={pause} disabled={!isRunning} variant="outline" size="sm" className="cursor-pointer">
                <Pause className="w-4 h-4 mr-1" />
                השהה
              </Button>
              <Button onClick={resetAll} variant="destructive" size="sm" className="cursor-pointer">
                <Square className="w-4 h-4 mr-1" />
                איפוס
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <PortfolioPulseCard
        equity={equity}
        invested={botConfig.initialAmount}
        cash={cash}
        positionsValue={positionsValue}
        history={history}
        trades={trades}
        statusLabel={status === 'running' ? 'פעיל' : status === 'paused' ? 'מושהה' : 'מושבת'}
        statusTone={status}
        metrics={[
          { label: 'עסקאות', value: `${totalTrades}`, hint: `${closedTrades} נסגרו · ${winRate.toFixed(1)}%` },
          { label: 'פוזיציות', value: `${positions.length}/${botConfig.maxPositions ?? 7}`, hint: `${openFuturesCount} פיוצ'רס` },
          { label: 'עלויות', value: `-$${(totalFees + totalSlippageCost).toFixed(2)}`, tone: 'negative', hint: `עמלות $${totalFees.toFixed(2)}` },
          { label: 'אחרון', value: lastTrade ? `${lastTrade.side.toUpperCase()} ${lastTrade.symbol}` : '—', hint: lastTrade?.timestamp || 'אין' }
        ]}
      />

      {/* Positions & Trades */}
      <Card className="border-border/40 bg-card/50 backdrop-blur">
        <CardContent className="p-3">
          <Tabs defaultValue="positions">
            <TabsList className="grid grid-cols-2 w-full mb-3">
              <TabsTrigger value="positions" className="font-mono text-xs">פוזיציות ({positions.length})</TabsTrigger>
              <TabsTrigger value="trades" className="font-mono text-xs">עסקאות ({trades.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="positions">
              {positions.length === 0 ? (
                <div className="text-muted-foreground text-xs text-center py-6 font-mono">
                  {isRunning ? 'ממתין לאיתות מתאים...' : 'הפעל כדי להתחיל'}
                </div>
              ) : (
                <div className="space-y-3 max-h-[28rem] overflow-y-auto">
                  {positions.map((pos) => {
                    const isLong = pos.side === 'LONG' || pos.side === 'BUY';
                    const liveAsset = cryptoData?.find((c) => c.symbol.toUpperCase() === pos.symbol.toUpperCase());
                    const livePrice = liveAsset?.current_price ?? pos.currentPrice ?? pos.entryPrice;
                    const priceDiff = isLong ? livePrice - pos.entryPrice : pos.entryPrice - livePrice;
                    const pnl = priceDiff * pos.quantity * (pos.leverage || 1);
                    return (
                      <LivePositionChart
                        key={pos.id}
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
                    );
                  })}
                </div>
              )}
            </TabsContent>

            <TabsContent value="trades">
              {trades.length === 0 ? (
                <div className="text-muted-foreground text-xs text-center py-6 font-mono">אין עסקאות עדיין</div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto font-mono">
                  {trades.map((trade) => (
                    <div key={trade.id} className="p-2 border border-border/30 rounded bg-card/30">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 text-xs">
                          {trade.side.includes('buy') || trade.side.includes('long') ? (
                            <ArrowUpCircle className="w-3.5 h-3.5 text-green-400" />
                          ) : (
                            <ArrowDownCircle className="w-3.5 h-3.5 text-red-400" />
                          )}
                          <Badge variant="outline" className="text-[10px]">{trade.symbol}</Badge>
                          <span className="text-muted-foreground">{trade.timestamp}</span>
                        </div>
                        <div className="text-xs">
                          <span className={accentClass}>${trade.price.toFixed(4)}</span>
                          {trade.pnl !== undefined && (
                            <span className={`mr-2 font-bold ${trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1 truncate">{trade.reason}</div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Play, Pause, Square, Zap, Settings, ArrowDownCircle, ArrowUpCircle, ChevronDown, FileText } from 'lucide-react';
import PortfolioPulseCard from './PortfolioPulseCard';
import ProfitScale from './ProfitScale';
import LivePositionChart from './LivePositionChart';
import type { CryptoData } from '@/types/crypto';
import type { SimBotConfig, SimPosition, SimTrade, SimPoint, PendingOrder, SignalEvaluation, DecisionFactor } from '@/hooks/useSimulationBot';

const safeNumber = (value: unknown, fallback = 0): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

export interface EngineColumnProps {
  title: string;
  subtitle: string;
  accentClass: string; // e.g. 'text-primary' or 'text-cyan-400' — column header + accent color
  cryptoData?: CryptoData[];
  cash: number;
  positions: SimPosition[];
  positionsValue: number;
  equity: number;
  trades: SimTrade[];
  history: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
  winRate: number;
  totalTrades: number;
  closedTrades: number;
  evaluations: SignalEvaluation[];
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
  // null = no schedule known yet; 0 = the tick is overdue (server is still
  // working on it). Anything > 0 is a real number of seconds.
  const [countdown, setCountdown] = useState<number | null>(null);
  const [evalFilter, setEvalFilter] = useState('');
  const [evalSort, setEvalSort] = useState<'default' | 'confidence-desc' | 'confidence-asc'>('confidence-desc');

  useEffect(() => {
    if (!isRunning) {
      setCountdown(null);
      return;
    }
    const updateCountdown = () => {
      if (!nextTickAt) {
        setCountdown(null);
        return;
      }
      const remaining = nextTickAt - Date.now();
      // Two bugs lived on this line. `Math.min(5, …)` capped the display at 5s
      // even when the real wait was 20s, and the `: 1` fallback pinned it to
      // "1s" for as long as the tick was overdue — so the label sat frozen at
      // "טיק בעוד 1s" for ~90% of every cycle and the page looked hung.
      // Overdue is now reported as overdue.
      setCountdown(remaining > 0 ? Math.min(120, Math.ceil(remaining / 1000)) : 0);
    };
    updateCountdown();
    const id = setInterval(updateCountdown, 200);
    return () => clearInterval(id);
  }, [isRunning, nextTickAt]);

  const lastTrade = trades[0];
  const openFuturesCount = positions.filter((p) => p.type === 'FUTURES').length;

  const displayedEvaluations = useMemo(() => {
    const q = evalFilter.trim().toUpperCase();
    const filtered = q ? evaluations.filter((rec) => rec.symbol.toUpperCase().includes(q)) : evaluations;
    if (evalSort === 'default') return filtered;
    const sorted = [...filtered].sort((a, b) =>
      evalSort === 'confidence-desc' ? b.confidence - a.confidence : a.confidence - b.confidence
    );
    return sorted;
  }, [evaluations, evalFilter, evalSort]);

  // Visibility into WHY short-side setups are rare: SHORT only ever routes
  // through FUTURES, which only opens on a TRENDING+BEAR regime — this
  // count makes that market-condition reality checkable at a glance instead
  // of having to take it on faith or page through each symbol's own
  // decision-layer breakdown one at a time.
  // Uses type-safe comparison with MarketRegimeType (TRENDING/RANGING/TRANSITIONAL)
  const regimeCounts = evaluations.reduce(
    (acc, ev) => {
      const r = ev.regime;
      if (!r) { acc.noData++; return acc; }
      if (r.regime === 'TRENDING' && r.direction === 'BULL') acc.bullTrend++;
      else if (r.regime === 'TRENDING' && r.direction === 'BEAR') acc.bearTrend++;
      else if (r.regime === 'RANGING') acc.ranging++;
      else acc.transitional++;
      return acc;
    },
    { bullTrend: 0, bearTrend: 0, ranging: 0, transitional: 0, noData: 0 }
  );

  return (
    <div className="flex flex-col h-full space-y-4">
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
            {!!evaluations?.length && (
              <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono text-muted-foreground border border-border/30 rounded-md px-2.5 py-1.5 bg-card/20">
                <span className="shrink-0">התפלגות משטר שוק כרגע:</span>
                <Badge variant="outline" className="text-green-400 border-green-400/30">↑ עולה {regimeCounts.bullTrend}</Badge>
                <Badge variant="outline" className="text-red-400 border-red-400/30">↓ יורד (SHORT זמין) {regimeCounts.bearTrend}</Badge>
                <Badge variant="outline" className="text-muted-foreground">דשדוש {regimeCounts.ranging}</Badge>
                <Badge variant="outline" className="text-muted-foreground">מעבר {regimeCounts.transitional}</Badge>
                {regimeCounts.bearTrend === 0 && (
                  <span className="text-[10px] w-full">
                    0 מגמות יורדות כרגע — SHORT דורש מגמה יורדת מובהקת (BEAR_TREND); ב-RANGING/דשדוש הבוט יכול רק Spot LONG (MEAN_REVERSION).
                  </span>
                )}
              </div>
            )}
            {!evaluations?.length ? (
              <div className="text-muted-foreground text-sm text-center py-4 font-mono">אין נתוני מטבעות זמינים</div>
            ) : (
              <div className="space-y-3 font-mono">
                <div className="flex items-center gap-2 flex-wrap sticky top-0 bg-background/95 backdrop-blur z-10 pb-2">
                  <Input
                    value={evalFilter}
                    onChange={(e) => setEvalFilter(e.target.value)}
                    placeholder="סינון לפי סימבול..."
                    className="h-8 text-xs font-mono flex-1 min-w-[140px]"
                  />
                  <Select value={evalSort} onValueChange={(v) => setEvalSort(v as typeof evalSort)}>
                    <SelectTrigger className="h-8 text-xs font-mono w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="confidence-desc">ביטחון: גבוה → נמוך</SelectItem>
                      <SelectItem value="confidence-asc">ביטחון: נמוך → גבוה</SelectItem>
                      <SelectItem value="default">סדר סריקה (ברירת מחדל)</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground shrink-0">{displayedEvaluations.length}/{evaluations.length}</span>
                </div>
                {!displayedEvaluations.length && (
                  <div className="text-muted-foreground text-sm text-center py-4">אין תוצאות תואמות לסינון</div>
                )}
                {displayedEvaluations.map((rec) => {
                  const isFutures = rec.tradeType === 'FUTURES';
                  const isSpot = rec.tradeType === 'SPOT';
                  const open = openLogs.includes(rec.symbol);
                  const confidence = safeNumber(rec.confidence);
                  const price = safeNumber(rec.price);
                  const priceChange24h = safeNumber(rec.priceChange24h);
                  const factors = Array.isArray(rec.factors) ? rec.factors : [];
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
                          <span className={`text-sm font-bold ${accentClass}`}>ביטחון {confidence.toFixed(1)}%</span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          ${price.toFixed(4)}{' '}
                          <span className={priceChange24h >= 0 ? 'text-green-400' : 'text-red-400'}>
                            ({priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%)
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
                        פירוט שכבות החלטה ({factors.length})
                        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                      </button>
                      {open && (
                        <div className="mt-2 border-t border-border/30 pt-2 space-y-1.5 bg-background/40 p-2.5 rounded">
                          {/* Layer 0: Market Regime */}
                          {rec.regime && (
                            <div className="mb-2 p-2 border border-border/20 rounded bg-card/30">
                              <div className="text-[10px] font-semibold text-muted-foreground mb-1">שכבה 0 — משטר שוק</div>
                              <div className="flex items-center gap-2 flex-wrap text-[10px]">
                                 <Badge variant="outline" className={`text-[9px] ${rec.regime.regime === 'TRENDING' ? 'text-green-400 border-green-400/30' : rec.regime.regime === 'RANGING' ? 'text-yellow-400 border-yellow-400/30' : 'text-muted-foreground'}`}>
                                  {rec.regime.regime}
                                </Badge>
                                <span className="text-muted-foreground">
                                  כיוון: {rec.regime.direction === 'BULL' ? 'עולה ↑' : rec.regime.direction === 'BEAR' ? 'יורד ↓' : 'ניטרלי'}
                                </span>
                                <span className="text-muted-foreground">
                                  ADX: {rec.regime.adx?.toFixed(1) ?? 'N/A'}
                                </span>
                                <span className="text-muted-foreground">
                                  ATR%: {rec.regime.atrPercent?.toFixed(2) ?? 'N/A'}%
                                </span>
                                <span className="text-muted-foreground">
                                  תנודתיות: {rec.regime.volatility}
                                </span>
                              </div>
                            </div>
                          )}
                          {factors.map((f: DecisionFactor, i: number) => (
                            <div key={i} className="flex items-start justify-between gap-2 text-xs py-1 border-b border-border/20 last:border-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${f.impact === 'positive' ? 'bg-green-400' : f.impact === 'negative' ? 'bg-red-400' : 'bg-muted-foreground'}`} />
                                <span className="font-semibold">{f.label ?? 'N/A'}</span>
                                <span className="text-muted-foreground">{f.value ?? 'N/A'}</span>
                              </div>
                              <span className="text-muted-foreground text-left max-w-[50%]">{f.note ?? ''}</span>
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
              {isRunning && countdown !== null && (
                <span className={`mr-2 font-bold ${accentClass}`}>
                  {countdown > 0 ? `· טיק בעוד ${countdown}s` : '· מעבד טיק…'}
                </span>
              )}
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

      {/* Portfolio Pulse Card — grows to fill available space */}
      <div className="flex-1">
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
      </div>

      {/* Positions & Trades — fixed height section */}
      <Card className="border-border/40 bg-card/50 backdrop-blur">
        <CardContent className="p-3">
          <Tabs defaultValue="positions">
            <TabsList className="grid grid-cols-2 w-full mb-3">
              <TabsTrigger value="positions" className="font-mono text-xs">פוזיציות ({positions.length})</TabsTrigger>
              <TabsTrigger value="trades" className="font-mono text-xs">יומן ביצוע ({trades.length} · נסגרו {closedTrades})</TabsTrigger>
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
                      {(() => {
                        const tradePrice = safeNumber(trade.price);
                        const tradePnl = trade.pnl === undefined ? undefined : safeNumber(trade.pnl);
                        return <>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 text-xs">
                          {trade.side.includes('buy') || trade.side.includes('long') ? (
                            <ArrowUpCircle className="w-3.5 h-3.5 text-green-400" />
                          ) : (
                            <ArrowDownCircle className="w-3.5 h-3.5 text-red-400" />
                          )}
                          <Badge variant="outline" className="text-[10px]">{trade.symbol}</Badge>
                          <Badge className={`text-[10px] ${trade.pnl !== undefined ? 'bg-orange-500/20 text-orange-300 border-orange-500/40' : 'bg-blue-500/20 text-blue-300 border-blue-500/40'}`} variant="outline">
                            {trade.side === 'partial_tp1' ? 'יציאה חלקית' : trade.pnl !== undefined ? 'יציאה' : 'כניסה'}
                          </Badge>
                          <span className="text-muted-foreground">{trade.timestamp}</span>
                        </div>
                        <div className="text-xs">
                          <span className={accentClass}>${tradePrice.toFixed(4)}</span>
                          {tradePnl !== undefined && (
                            <span className={`mr-2 font-bold ${tradePnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {tradePnl >= 0 ? '+' : ''}${tradePnl.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1 truncate">{trade.reason}</div>
                      </>;
                    })()}
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

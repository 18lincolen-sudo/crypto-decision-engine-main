import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Wallet,
  Bot,
  Activity,
  RefreshCw,
  Zap,
  TrendingUp,
  ShieldCheck,
  Play,
  Pause,
  ExternalLink,
  ChevronRight,
  Flame,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { createTradingApiClient } from '@/services/tradingApiClient';
import type { WorkerAccountSummary, WorkerBotState } from '@/services/tradingApiClient';
import { useSimulationBotContextSafe } from '@/contexts/SimulationBotContext';

export const ExecutiveDashboard: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [hasApiConfig, setHasApiConfig] = useState(false);
  const [workerSummary, setWorkerSummary] = useState<WorkerAccountSummary | null>(null);
  const [workerState, setWorkerState] = useState<WorkerBotState | null>(null);
  const [workerHealth, setWorkerHealth] = useState<Record<string, unknown> | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // Simulation Bot State — live from the global provider (runs continuously so
  // the dashboard reflects real-time data). Falls back to the last persisted
  // snapshot in localStorage when the provider is unavailable.
  const sim = useSimulationBotContextSafe();

  const simState = useMemo<{
    cash: number;
    initialAmount: number;
    positionsCount: number;
    totalTrades: number;
    winRate: number;
    totalProfit: number;
    isRunning: boolean;
    activePositions: Array<{
      symbol: string;
      side: string;
      entryPrice: number;
      currentPrice: number;
      pnlPercent: number;
      leverage: number;
      takeProfit?: number;
      stopLoss?: number;
    }>;
  } | null>(() => {
    const derive = (cash: number, positions: any[], trades: any[], initial: number, isRunning: boolean) => {
      let currentVal = cash;
      const activeMapped = positions.map((p: any) => {
        const notional = p.notionalUsd || p.quantity * p.currentPrice || 0;
        const pnl = p.side === 'LONG' || p.side === 'BUY'
          ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100 * (p.leverage || 1)
          : ((p.entryPrice - p.currentPrice) / p.entryPrice) * 100 * (p.leverage || 1);
        currentVal += (p.marginUsd || notional) + (p.marginUsd || notional) * (pnl / 100);
        return {
          symbol: p.symbol,
          side: p.side,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          pnlPercent: pnl,
          leverage: p.leverage || 1,
          takeProfit: p.takeProfit1 || p.takeProfit,
          stopLoss: p.stopLoss
        };
      });
      const winningTrades = trades.filter((t: any) => (t.pnl || 0) > 0).length;
      const winRate = trades.length > 0 ? (winningTrades / trades.length) * 100 : 0;
      const totalProfit = currentVal - initial;
      return { cash, initialAmount: initial, positionsCount: positions.length, totalTrades: trades.length, winRate, totalProfit, isRunning, activePositions: activeMapped };
    };

    if (sim) {
      return derive(sim.cash, sim.positions, sim.trades, sim.config.initialAmount || 10000, sim.isRunning);
    }
    // Fallback: read last snapshot persisted by the simulation bot hook.
    try {
      const raw = localStorage.getItem('simulation-bot-state-v2');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const initial = 10000;
      const status = localStorage.getItem('simulation-bot-status-v2');
      return derive(parsed.cash ?? initial, parsed.positions ?? [], parsed.trades ?? [], initial, status === 'running');
    } catch {
      return null;
    }
  }, [sim]);

  const fetchWorkerData = useCallback(async () => {
    let workerUrl = import.meta.env.VITE_TRADING_API_URL || '';
    // Read the configuration saved by the Real Trading Bot page.
    let workerToken = localStorage.getItem('workerAdminToken') || '';
    try {
      const savedConfig = localStorage.getItem('workerConfig');
if (savedConfig) {
        const config = JSON.parse(savedConfig);
        workerToken = config.adminToken || workerToken;
        workerUrl = config.baseUrl || workerUrl;
      }
    } catch { /* no saved worker config */ }
    const worker = createTradingApiClient(workerUrl, workerToken);

    if (!workerUrl) {
      setHasApiConfig(false);
      setApiError('כתובת ה-Worker (VITE_TRADING_API_URL) לא הוגדרה. הגדר אותה במשתני בנייה של Netlify.');
      return;
    }

    setHasApiConfig(true);
    setLoading(true);
    setApiError(null);

    try {
      console.log('[Worker] Fetching account summary, state and health...');
      const [summary, state, health] = await Promise.all([
        worker.getAccountSummary(),
        worker.getState(),
        worker.getHealth()
      ]);
      console.log('[Worker] summary:', summary, 'state:', state, 'health:', health);

      setWorkerSummary(summary);
      setWorkerState(state);
      setWorkerHealth(health);
      setLastUpdated(new Date().toLocaleTimeString('he-IL'));
    } catch (err: any) {
      const errMsg = err.message || 'שגיאת התחברות ל-Worker';
      console.error('[Worker] fetchWorkerData error:', errMsg);
      setApiError(`שגיאת Worker: ${errMsg}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkerData();

    const interval = setInterval(() => {
      fetchWorkerData();
    }, 15000); // 15s refresh

    return () => clearInterval(interval);
  }, [fetchWorkerData]);

  return (
    <div className="space-y-6 mb-8">
      {/* 1. Real Bybit Live Account Hub */}
      <Card className="border-primary/40 bg-gradient-to-br from-card via-card/95 to-primary/5 shadow-xl shadow-primary/5 relative overflow-hidden">
        <div className="absolute top-0 right-0 left-0 h-1 bg-gradient-to-r from-primary via-emerald-500 to-primary" />
        
        <CardHeader className="pb-3 flex flex-row items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-primary/10 border border-primary/20 text-primary">
              <Wallet className="w-6 h-6" />
            </div>
            <div>
              <CardTitle className="text-xl font-bold flex items-center gap-2 font-mono">
                מרכז פיקוד Bybit Live
                {hasApiConfig && (
                  <Badge variant={workerState?.testnet ? "secondary" : "default"} className="font-mono text-xs">
                    {workerState?.testnet ? "🟡 Testnet" : "🟢 Mainnet Live"}
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground font-mono">
                נתוני ארנק וחשבון Bybit בזמן אמת {lastUpdated && `• עודכן לאחרונה: ${lastUpdated}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                fetchWorkerData();
              }}
              disabled={loading}
              className="font-mono text-xs gap-1.5 h-8"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              רענן נתונים
            </Button>
            <Link to="/real-trading">
              <Button size="sm" className="font-mono text-xs gap-1.5 h-8">
                <Zap className="w-3.5 h-3.5" />
                בוט Bybit Live
              </Button>
            </Link>
          </div>
        </CardHeader>

        <CardContent>
          {hasApiConfig ? (
            <div className="space-y-4">
              {/* Metrics Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* Total Equity */}
                <div className="p-3.5 rounded-xl bg-background/80 border border-border/60">
                  <div className="text-xs text-muted-foreground font-mono mb-1">שווי חשבון כולל (Total Equity)</div>
                  <div className="text-2xl font-bold font-mono text-foreground">
                    ${workerSummary?.totalUsdt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '0.00'}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    סך הון פעיל
                  </div>
                </div>

                {/* Available USDT */}
                <div className="p-3.5 rounded-xl bg-background/80 border border-border/60">
                  <div className="text-xs text-muted-foreground font-mono mb-1">יתרת USDT זמינה (Available)</div>
                  <div className="text-2xl font-bold font-mono text-emerald-400">
                    ${workerSummary?.availableUsdt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '0.00'}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    USDT זמין למסחר
                  </div>
                </div>

                {/* Open Futures */}
                <div className="p-3.5 rounded-xl bg-background/80 border border-border/60">
                  <div className="text-xs text-muted-foreground font-mono mb-1">פוזיציות פתוחות (Open Futures)</div>
                  <div className="text-2xl font-bold font-mono text-primary">
                    {workerSummary?.openFuturesCount ?? 0}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    פוזיציות פעילות
                  </div>
                </div>

                {/* Connection / Health */}
                <div className="p-3.5 rounded-xl bg-background/80 border border-border/60">
                  <div className="text-xs text-muted-foreground font-mono mb-1">סטטוס חיבור (Worker)</div>
                  <div className="text-2xl font-bold font-mono flex items-center gap-1.5">
                    {workerHealth ? (
                      <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-6 h-6 text-red-400" />
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    {workerHealth ? 'מחובר' : 'מנותק'}
                  </div>
                </div>
              </div>

              {/* Positions Breakdown */}
              {workerSummary && workerSummary.positions.length > 0 && (
                <div className="pt-2 border-t border-border/40">
                  <div className="text-xs font-mono text-muted-foreground mb-2">פוזיציות פתוחות בחשבון:</div>
                  <div className="flex flex-wrap gap-2">
                    {workerSummary.positions.map((p) => (
                      <Badge key={p.symbol} variant="outline" className="font-mono text-xs py-1 px-2.5 bg-background/60">
                        <span className="font-bold text-primary mr-1">{p.symbol}:</span>
                        <span>{p.side}</span>
                        {p.leverage > 1 && <span className="ml-1">{p.leverage}x</span>}
                        <span className="text-muted-foreground ml-1.5">({p.size})</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {apiError && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400 font-mono flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  {apiError}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-6 bg-background/40 rounded-xl border border-dashed border-border/80">
              <ShieldCheck className="w-10 h-10 text-primary mx-auto mb-2 opacity-80" />
              <h4 className="text-base font-semibold font-mono mb-1">הגדרת חיבור Bybit API</h4>
              <p className="text-xs text-muted-foreground font-mono max-w-md mx-auto mb-4">
                הגדר את כתובת ה-Worker (VITE_TRADING_API_URL) ואת ה-BOT_ADMIN_TOKEN כדי לצפות ביתרות הארנק, פוזיציות ומצב הבוט בזמן אמת דרך ה-Render Worker.
              </p>
              <Link to="/real-trading">
                <Button size="sm" className="font-mono text-xs gap-1.5">
                  <Zap className="w-3.5 h-3.5" />
                  הגדר Bybit API עכשיו
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Dual Bots Live Status Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Real Trading Bot Summary */}
        <Card className="border-border/60 bg-card hover:border-primary/40 transition-all shadow-md">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Zap className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base font-bold font-mono">בוט Bybit Live Trading</CardTitle>
                <p className="text-xs text-muted-foreground font-mono">מסחר אמיתי עם בקרת סיכונים</p>
              </div>
            </div>
            <Badge variant={workerState?.running ? "default" : "secondary"} className="font-mono text-xs">
              {workerState?.running ? "🟢 פעיל" : "⚪ מופסק"}
            </Badge>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 rounded-lg bg-background/80 border border-border/40">
                <div className="text-[11px] text-muted-foreground font-mono">פוזיציות פתוחות</div>
                <div className="text-lg font-bold font-mono text-primary mt-0.5">
                  {workerSummary?.openFuturesCount ?? 0}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-background/80 border border-border/40">
                <div className="text-[11px] text-muted-foreground font-mono">סריקות</div>
                <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                  {workerState?.scans ?? 0}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-background/80 border border-border/40">
                <div className="text-[11px] text-muted-foreground font-mono">מצב</div>
                <div className="text-lg font-bold font-mono text-foreground mt-0.5">
                  {workerState?.dryRun ? 'Dry' : 'Live'}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border/40">
              <div className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>Trailing Stop & Break-Even פעילים</span>
              </div>
              <Link to="/real-trading">
                <Button variant="ghost" size="sm" className="font-mono text-xs gap-1 h-7 px-2 text-primary hover:text-primary">
                  ניהול בוט Bybit
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Simulation Bot Summary */}
        <Card className="border-border/60 bg-card hover:border-primary/40 transition-all shadow-md">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base font-bold font-mono">בוט סימולציה (Paper Trading)</CardTitle>
                <p className="text-xs text-muted-foreground font-mono">בדיקת אסטרטגיות ללא סיכון הון</p>
              </div>
            </div>
            <Badge variant="outline" className="font-mono text-xs text-blue-400 border-blue-500/30">
              {simState?.isRunning
                ? (simState.positionsCount > 0 ? `🟢 ${simState.positionsCount} פוזיציות פעילות` : "🟢 פועל — ממתין לאותות")
                : simState && simState.positionsCount > 0
                  ? `🟡 מושהה • ${simState.positionsCount} פוזיציות`
                  : "ממתין לאותות"}
            </Badge>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 rounded-lg bg-background/80 border border-border/40">
                <div className="text-[11px] text-muted-foreground font-mono">יתרת סימולציה</div>
                <div className="text-lg font-bold font-mono text-foreground mt-0.5">
                  ${simState?.cash.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '$10,000'}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-background/80 border border-border/40">
                <div className="text-[11px] text-muted-foreground font-mono">סך רווח / הפסד</div>
                <div className={`text-lg font-bold font-mono mt-0.5 ${
                  (simState?.totalProfit || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}>
                  {(simState?.totalProfit || 0) >= 0 ? '+' : ''}
                  ${simState?.totalProfit.toFixed(0) ?? '0'}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-background/80 border border-border/40">
                <div className="text-[11px] text-muted-foreground font-mono">אחוז הצלחה</div>
                <div className="text-lg font-bold font-mono text-primary mt-0.5">
                  {simState?.winRate.toFixed(1) ?? '0'}%
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border/40">
              <div className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-blue-400" />
                <span>מנוע 4-Layer Decision Engine</span>
              </div>
              <Link to="/simulation-bot">
                <Button variant="ghost" size="sm" className="font-mono text-xs gap-1 h-7 px-2 text-primary hover:text-primary">
                  כניסה לסימולציה
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 3. Live Active Positions Radar (if any positions open) */}
      {simState && simState.activePositions.length > 0 && (
        <Card className="border-border/60 bg-card">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Flame className="w-5 h-5 text-amber-400" />
              <CardTitle className="text-base font-bold font-mono">
                פוזיציות פתוחות בזמן אמת ({simState.activePositions.length})
              </CardTitle>
            </div>
            <Link to="/simulation-bot">
              <Button variant="outline" size="sm" className="font-mono text-xs h-7">
                צפה בכל הפוזיציות
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {simState.activePositions.map((p) => (
                <div key={p.symbol} className="p-3 rounded-lg bg-background/80 border border-border/50 font-mono text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm text-foreground">{p.symbol}</span>
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${
                        p.side === 'LONG' || p.side === 'BUY' ? 'text-emerald-400 border-emerald-500/30' : 'text-red-400 border-red-500/30'
                      }`}>
                        {p.side} {p.leverage > 1 ? `${p.leverage}x` : ''}
                      </Badge>
                    </div>
                    <div className={`font-bold ${p.pnlPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.pnlPercent >= 0 ? '+' : ''}{p.pnlPercent.toFixed(2)}%
                    </div>
                  </div>
                  <div className="flex justify-between text-muted-foreground text-[11px]">
                    <span>כניסה: ${p.entryPrice < 1 ? p.entryPrice.toFixed(4) : p.entryPrice.toFixed(2)}</span>
                    <span>נוכחי: ${p.currentPrice < 1 ? p.currentPrice.toFixed(4) : p.currentPrice.toFixed(2)}</span>
                  </div>
                  {(p.takeProfit || p.stopLoss) && (
                    <div className="flex justify-between text-[10px] text-muted-foreground/80 pt-1 border-t border-border/30">
                      <span>TP: ${p.takeProfit ? (p.takeProfit < 1 ? p.takeProfit.toFixed(4) : p.takeProfit.toFixed(2)) : '-'}</span>
                      <span>SL: ${p.stopLoss ? (p.stopLoss < 1 ? p.stopLoss.toFixed(4) : p.stopLoss.toFixed(2)) : '-'}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Bot, AlertTriangle, Server, Play, Square, Wifi, WifiOff } from 'lucide-react';
import Navigation from '../components/Navigation';
import PortfolioPulseCard from '../components/trading/PortfolioPulseCard';
import PortfolioRiskMeter from '../components/trading/PortfolioRiskMeter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  createTradingApiClient,
  type WorkerBotState,
  type WorkerHealth,
  type WorkerAccountSummary,
  type WorkerDecision,
  type WorkerSkippedSymbol
} from '@/services/tradingApiClient';

// ═══════════════════════════════════════════════════════════════════════════
// Live trading is performed ONLY by the server worker (src/workers/tradingWorker.ts or dist/worker.js).
// The browser never holds the Bybit secret and never signs orders.
// Once the worker is connected it is the SINGLE execution owner:
// the frontend only sends control commands and never trades on its own.
// ═══════════════════════════════════════════════════════════════════════════

interface WorkerConfig {
  baseUrl: string;
  adminToken: string;
}

const WORKER_CONFIG_KEY = 'workerConfig';

// Prefer the build-time tunnel URL; otherwise fall back to a saved manual URL.
const ENV_API_URL = (import.meta.env.VITE_TRADING_API_URL as string | undefined) || '';

const RealTradingBot = () => {
  const [config, setConfig] = useState<WorkerConfig>(() => {
    try {
      const raw = localStorage.getItem(WORKER_CONFIG_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return { baseUrl: ENV_API_URL, adminToken: '' };
  });
  const [botState, setBotState] = useState<WorkerBotState | null>(null);
  const [account, setAccount] = useState<WorkerAccountSummary | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(0);

  const clientRef = useRef(createTradingApiClient(config.baseUrl, config.adminToken));
  clientRef.current = createTradingApiClient(config.baseUrl, config.adminToken);

  // Heartbeat: poll the public /health endpoint. Drives the explicit online/offline state.
  // While offline, live order controls are disabled and no live orders can be queued.
  const refresh = useCallback(async () => {
    const client = clientRef.current;
    if (!client.baseUrl || !config.adminToken) {
      setOnline(false);
      setBotState(null);
      setAccount(null);
      return;
    }
    try {
      const health = await client.getHealth();
      if (!health || health.ok !== true) throw new Error('Worker לא מגיב');
      const state = await client.getState();
      setBotState(state);
      setOnline(true);
      setError(null);
      setLastHeartbeat(Date.now());
      try {
        setAccount(await client.getAccountSummary());
      } catch {
        setAccount(null);
      }
    } catch (e) {
      setOnline(false);
      setBotState(null);
      setAccount(null);
      setError(e instanceof Error ? e.message : 'שגיאת חיבור ל-Worker');
    }
  }, [config.adminToken]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const saveConfig = () => {
    if (!config.baseUrl || !config.adminToken) {
      alert('נא להזין כתובת Worker ו-Token');
      return;
    }
    localStorage.setItem(WORKER_CONFIG_KEY, JSON.stringify(config));
    localStorage.setItem('workerAdminToken', config.adminToken);
    void refresh();
  };

  const startBot = async () => {
    if (!online) return;
    setBusy(true);
    try {
      const state = await clientRef.current.start();
      setBotState(state);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בהפעלה');
    } finally {
      setBusy(false);
    }
  };

  const stopBot = async () => {
    if (!online) return;
    setBusy(true);
    try {
      const state = await clientRef.current.stop();
      setBotState(state);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בעצירה');
    } finally {
      setBusy(false);
    }
  };

  const recentOrders = botState?.orders?.slice(0, 12) ?? [];
  const recentDecisions: WorkerDecision[] = (botState?.decisions ?? []).filter(d => d.action && d.action !== 'HOLD').slice(0, 12);
  const skipped: WorkerSkippedSymbol[] = botState?.skippedSymbols ?? [];
  const health: WorkerHealth | undefined = botState?.health;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <div className="max-w-7xl mx-auto p-2 sm:p-4">
        <div className="text-center mb-4 sm:mb-8">
          <h1 className="text-2xl sm:text-4xl font-bold mb-2 sm:mb-4 text-primary font-mono flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
            <Bot className="w-6 h-6 sm:w-10 sm:h-10" />
            <span className="break-words">🚀 בוט מסחר אמיתי - Bybit (Worker)</span>
          </h1>
          <p className="text-sm sm:text-xl text-muted-foreground mb-4 sm:mb-6 font-mono px-2 leading-relaxed">
            ביצוע דרך שרת Worker מקומי מוגן • המפתח הסודי נשאר בשרת בלבד • ללא חתימה בדפדפן
          </p>
        </div>

        <Alert className="mb-4 sm:mb-8 border-yellow-500 bg-yellow-500/10">
          <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0" />
          <AlertDescription className="font-mono text-yellow-700 text-sm leading-relaxed">
            <strong>אזהרה:</strong> מסחר אוטומטי כרוך בסיכונים גבוהים. השרת פועל כברירת מחדל במצב DRY-RUN (ללא ביצוע אמיתי) עד שתשנו זאת בשרת לאחר אימות ב-Testnet. השרת הוא בעל הביצוע היחיד — הדפדפן רק שולט בו.
          </AlertDescription>
        </Alert>

        {/* Connection status / heartbeat */}
        <div className="mb-4 flex items-center gap-2 font-mono text-sm">
          {online ? (
            <span className="flex items-center gap-2 text-green-400">
              <Wifi className="w-4 h-4" /> מחובר ל-Worker (Heartbeat: {lastHeartbeat ? new Date(lastHeartbeat).toLocaleTimeString('he-IL') : '—'})
            </span>
          ) : (
            <span className="flex items-center gap-2 text-red-400">
              <WifiOff className="w-4 h-4" /> ה-Worker אינו זמין — מסחר חי מושבת
            </span>
          )}
        </div>

        {/* Offline / simulation fallback */}
        {!online && (
          <Alert className="mb-4 border-blue-500 bg-blue-500/10">
            <AlertDescription className="font-mono text-blue-300 text-sm leading-relaxed">
              ה-Worker אינו מחובר. <strong>לא ניתן לתזמן פקודות חיות במצב לא מקוון.</strong> הסימולציה המקומית זמינה ופועלת ללא תלות ב-Worker — עברו לכרטיסייה "בוט סימולציה". חברו את ה-Worker (כתובת טאנל HTTPS) כדי להפעיל מסחר חי.
            </AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="connection" className="space-y-4 sm:space-y-6">
          <TabsList className="grid w-full grid-cols-3 sm:grid-cols-5 gap-1 h-auto p-1">
            <TabsTrigger value="connection" className="text-xs sm:text-sm px-1 sm:px-3 py-2 font-mono">חיבור Worker</TabsTrigger>
            <TabsTrigger value="status" className="text-xs sm:text-sm px-1 sm:px-3 py-2 font-mono">סטטוס</TabsTrigger>
            <TabsTrigger value="account" className="text-xs sm:text-sm px-1 sm:px-3 py-2 font-mono">חשבון</TabsTrigger>
            <TabsTrigger value="decisions" className="text-xs sm:text-sm px-1 sm:px-3 py-2 font-mono">החלטות</TabsTrigger>
            <TabsTrigger value="orders" className="text-xs sm:text-sm px-1 sm:px-3 py-2 font-mono">פקודות</TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="space-y-4">
            <div className="border border-primary/30 bg-card/50 backdrop-blur rounded-lg p-5 space-y-3 font-mono">
              <div className="flex items-center gap-2 text-primary font-bold">
                <Server className="w-5 h-5" /> הגדרת חיבור ל-Worker
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">כתובת Worker (HTTPS Tunnel URL)</label>
                <Input
                  placeholder="https://<tunnel>.trycloudflare.com"
                  value={config.baseUrl}
                  onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
                />
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">BOT_ADMIN_TOKEN</label>
                <Input
                  type="password"
                  placeholder="טוקן אדמין מה-Worker"
                  value={config.adminToken}
                  onChange={(e) => setConfig({ ...config, adminToken: e.target.value })}
                />
              </div>
              <Button onClick={saveConfig} className="bg-primary hover:bg-primary/90">שמור והתחבר</Button>
              {error && <div className="text-red-400 text-sm">שגיאה: {error}</div>}
              {online && botState && (
                <div className="text-green-400 text-sm">
                  מחובר ✓ | מצב: {botState.mode} | DRY-RUN: {botState.dryRun ? 'כן' : 'לא'} | סמלים: {botState.symbols}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="status" className="space-y-4">
            <PortfolioRiskMeter
              portfolioValue={account?.totalUsdt || 1000}
              totalInvestedUsd={0}
              totalLeveragedExposureUsd={0}
              openPositionsCount={botState?.openedSymbols?.length ?? 0}
              maxPositions={5}
              openFuturesCount={account?.openFuturesCount ?? 0}
              maxFutures={2}
              dailyDrawdownPercent={0}
              weeklyDrawdownPercent={0}
            />
            <PortfolioPulseCard
              equity={account?.totalUsdt || 1000}
              invested={0}
              cash={account?.availableUsdt || 1000}
              positionsValue={0}
              history={[]}
              statusLabel={botState?.running ? 'פועל' : 'מושבת'}
              statusTone={botState?.running ? 'running' : 'idle'}
              metrics={[
                { label: 'מצב', value: botState ? (botState.running ? 'פועל' : 'מושבת') : '—', hint: botState?.mode ?? '' },
                { label: 'DRY-RUN', value: botState?.dryRun ? 'כן' : 'לא', hint: 'ללא ביצוע אמיתי' },
                { label: 'סריקות', value: `${botState?.scans ?? 0}`, hint: `סמלים: ${botState?.symbols ?? 0}` },
                { label: 'דילוגים', value: `${skipped.length}`, hint: 'סמלים לא נתמכים/נכשלו' },
                { label: 'פקודות', value: `${recentOrders.length}`, hint: botState?.lastScanAt ? `אחרונה: ${botState.lastScanAt}` : 'טרם סריקה' },
                { label: 'בריאות ציבורי', value: `${health?.publicRequests ?? 0}`, hint: `כשלים: ${health?.publicFailures ?? 0}` }
              ]}
            />
            <div className="flex gap-2 flex-wrap">
              <Button onClick={startBot} disabled={!online || busy} className="bg-green-600 hover:bg-green-700">
                <Play className="w-4 h-4 mr-2" /> הפעל בוט
              </Button>
              <Button onClick={stopBot} disabled={!online || busy} variant="destructive">
                <Square className="w-4 h-4 mr-2" /> עצור בוט
              </Button>
            </div>
            {botState?.lastError && (
              <div className="text-red-400 text-sm font-mono">שגיאה אחרונה: {botState.lastError}</div>
            )}
          </TabsContent>

          <TabsContent value="account" className="space-y-4">
            {!online ? (
              <div className="text-muted-foreground text-sm text-center py-8 font-mono">ה-Worker אינו מחובר — אין גישה לחשבון</div>
            ) : account ? (
              <div className="space-y-2 font-mono text-sm">
                <div className="p-3 border border-primary/20 rounded-lg bg-card/30">
                  <div>יתרה זמינה (USDT): <span className="text-primary">{account.availableUsdt}</span></div>
                  <div>סך יתרה (USDT): <span className="text-primary">{account.totalUsdt}</span></div>
                  <div>פוזיציות Futures פתוחות: <span className="text-primary">{account.openFuturesCount}</span></div>
                </div>
                {account.positions.length === 0 ? (
                  <div className="text-muted-foreground text-center py-4">אין פוזיציות פתוחות</div>
                ) : (
                  account.positions.map((p, i) => (
                    <div key={i} className="p-3 border border-primary/20 rounded-lg bg-card/30">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-bold">{p.symbol}</span>
                        <span className="text-cyan-400">{p.side} x{p.leverage}</span>
                        <span className="text-xs text-muted-foreground">כמות {p.size}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">מחיר כניסה: {p.entryPrice}</div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="text-muted-foreground text-sm text-center py-8 font-mono">אין נתוני חשבון (דרושות הרשאות וחיבור)</div>
            )}
          </TabsContent>

          <TabsContent value="decisions" className="space-y-2">
            {recentDecisions.length === 0 ? (
              <div className="text-muted-foreground text-sm text-center py-8 font-mono">אין החלטות פעילות עדיין</div>
            ) : (
              recentDecisions.map((d, i) => (
                <div key={i} className="p-3 border border-primary/20 rounded-lg bg-card/30 font-mono text-sm">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-bold">{d.symbol ?? '?'}</span>
                    <span className="text-cyan-400">{d.action} {d.side ?? ''}</span>
                    <span className="text-primary">ביטחון {Number(d.confidence ?? 0).toFixed(1)}%</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{d.reason ?? ''}</div>
                </div>
              ))
            )}
            {skipped.length > 0 && (
              <div className="mt-4">
                <div className="text-xs text-muted-foreground mb-1 font-mono">סמלים שדולגו (עם סיבה):</div>
                {skipped.map((s, i) => (
                  <div key={i} className="p-2 border border-yellow-500/30 rounded-lg bg-yellow-500/5 font-mono text-xs text-yellow-300">
                    {s.symbol}: {s.reason}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="orders" className="space-y-2">
            {recentOrders.length === 0 ? (
              <div className="text-muted-foreground text-sm text-center py-8 font-mono">אין פקודות עדיין</div>
            ) : (
              recentOrders.map((o, i) => (
                <div key={i} className="p-3 border border-primary/20 rounded-lg bg-card/30 font-mono text-sm">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-bold">{(o.symbol as string) ?? '?'}</span>
                    <span className={(o.dryRun as boolean) ? 'text-yellow-400' : 'text-green-400'}>
                      {(o.side as string)} {(o.category as string) ?? ''}
                    </span>
                    <span className="text-xs text-muted-foreground">{(o.at as string) ?? ''}</span>
                  </div>
                  {o.reason && <div className="text-xs text-muted-foreground mt-1">{o.reason as string}</div>}
                  {o.error && <div className="text-xs text-red-400 mt-1">{o.error as string}</div>}
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default RealTradingBot;

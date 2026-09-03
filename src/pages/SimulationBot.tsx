import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import { Bot, RefreshCw, AlertTriangle, Trash2, ExternalLink, Play, Pause, Square } from 'lucide-react';
import Navigation from '../components/Navigation';
import PortfolioRiskMeter from '../components/trading/PortfolioRiskMeter';
import SimulationEngineColumn from '../components/trading/SimulationEngineColumn';
import { useSimulationBotContext } from '../contexts/SimulationBotContext';
import { useLegacySimulationBotContext } from '../contexts/LegacySimulationBotContext';
import { useProSimulationBotContext } from '../contexts/ProSimulationBotContext';
import { useWorkerAuth } from '../contexts/WorkerAuthContext';
import { useCryptoData } from '../hooks/useCryptoData';
import { SIM_BOT_STORAGE_KEY } from '../hooks/useSimulationBot';
import { LEGACY_SIM_BOT_STORAGE_KEY } from '../hooks/useLegacySimulationBot';
import { PRO_SIM_BOT_STORAGE_KEY } from '../hooks/useProSimulationBot';

// Keys that hold the bots' remembered history (positions/trades/equity).
// Distinct from workerConfig/theme/credentials — those are connection/app
// settings, not simulation state, and are intentionally left untouched.
const SIM_CACHE_KEYS = [
  SIM_BOT_STORAGE_KEY,
  'simulation-bot-state-v1',
  LEGACY_SIM_BOT_STORAGE_KEY,
  PRO_SIM_BOT_STORAGE_KEY,
  'crypto-portfolio'
];

const SimulationBotPage = () => {
  const intraday = useSimulationBotContext();
  const legacy = useLegacySimulationBotContext();
  const pro = useProSimulationBotContext();
  const { cryptoData, isLoading } = useCryptoData();
  const { baseUrl, setBaseUrl, persistBaseUrl, baseUrlSource, setBaseUrlSource } = useWorkerAuth();
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);

  const resetWorkerUrl = () => {
    localStorage.removeItem('workerConfig');
    setBaseUrl('');
    setBaseUrlSource('none');
  };

  const sourceLabel: Record<string, string> = {
    manual: 'הקלדה ידנית',
    localStorage: 'שמור ב-localStorage',
    env: 'משתנה סביבה (Netlify)',
    none: 'לא הוגדר'
  };

  const runGroupAction = async (actions: Array<() => Promise<void>>) => {
    setGroupBusy(true);
    setGroupError(null);
    const results = await Promise.allSettled(actions.map((action) => action()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) {
      setGroupError(failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : 'פעולה נכשלה').join(' | '));
    }
    setGroupBusy(false);
    return failures.length === 0;
  };

  const clearAllCache = async () => {
    if (!window.confirm('לאפס את כל המטמון של הבוטים (מקומי + שרת)? הפעולה תמחק את כל הפוזיציות וההיסטוריה של שלושת המנועים ותרענן את הדף.')) {
      return;
    }
    for (const key of SIM_CACHE_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
    // resetAll() on the intraday engine also calls the server's /api/sim/reset,
    // clearing the persisted server-side snapshot (sim-state.json) that
    // otherwise survives a fresh deploy — that's the "remembers the past even
    // after I uploaded a new dist" symptom.
    if (await runGroupAction([intraday.resetAll, legacy.resetAll, pro.resetAll])) {
      window.location.reload();
    }
  };

  const combinedPositionsCount = intraday.positions.length + legacy.positions.length + pro.positions.length;
  const combinedFuturesCount =
    intraday.positions.filter((p: { type?: string }) => p.type === 'FUTURES').length +
    legacy.positions.filter((p: { type?: string }) => p.type === 'FUTURES').length +
    pro.positions.filter((p: { type?: string }) => p.type === 'FUTURES').length;

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <div className="max-w-[1600px] mx-auto p-3 sm:p-4 space-y-6">
        {/* Header */}
        <div className="text-center pt-2">
          <h1 className="text-3xl sm:text-4xl font-bold mb-2 text-primary flex items-center justify-center gap-3 font-mono">
            <Bot className="w-9 h-9" />
            בוט סימולציה — השוואת שלושה אלגוריתמים
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground font-mono break-words">
            מנוע חדש (רב-שכבתי Multi-Timeframe) · מנוע מקורי (ציון ביטחון משוקלל) · בוט פרו (מימוש מדויק של alg.md) — כל אחד עם הון וסטטיסטיקה נפרדים
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button
              size="sm"
              onClick={() => void runGroupAction([intraday.start, legacy.start, pro.start])}
              disabled={groupBusy || (intraday.isRunning && legacy.isRunning && pro.isRunning)}
              className="bg-green-600 hover:bg-green-700 gap-2"
            >
              <Play className="w-4 h-4" />
              הפעל את כל הבוטים
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runGroupAction([intraday.pause, legacy.pause, pro.pause])}
              disabled={groupBusy || (!intraday.isRunning && !legacy.isRunning && !pro.isRunning)}
              className="gap-2"
            >
              <Pause className="w-4 h-4" />
              השהה את כל הבוטים
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void runGroupAction([intraday.resetAll, legacy.resetAll, pro.resetAll])}
              disabled={groupBusy}
              className="gap-2"
            >
              <Square className="w-4 h-4" />
              אפס את כל הבוטים
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={clearAllCache}
              className="gap-2 text-destructive border-destructive/40 hover:bg-destructive/10"
            >
              <Trash2 className="w-4 h-4" />
              איפוס מטמון (מקומי + שרת)
            </Button>
          </div>

          {(groupError || intraday.controlError || legacy.controlError || pro.controlError) && (
            <Card className="mt-3 border-red-500/40 bg-red-500/10">
              <CardContent className="p-3 text-sm text-red-300 font-mono">
                {groupError || intraday.controlError || legacy.controlError || pro.controlError}
              </CardContent>
            </Card>
          )}

        {/* Worker URL diagnostic — shows exactly which URL the frontend is using
            and where it came from. This is the #1 cause of "CORS blocked" errors
            after a Render URL change: localStorage still holds the old address. */}
        <Card className="border-primary/20 bg-card/50">
          <CardContent className="p-3 flex flex-wrap items-center gap-3 text-xs font-mono">
            <span className="text-muted-foreground">Worker URL:</span>
            <span className="text-primary font-semibold break-all">{baseUrl || 'לא הוגדר'}</span>
            <span className="text-muted-foreground">מקור:</span>
            <span className={`px-2 py-0.5 rounded ${
              baseUrlSource === 'env' ? 'bg-green-500/10 text-green-400' :
              baseUrlSource === 'localStorage' ? 'bg-yellow-500/10 text-yellow-400' :
              baseUrlSource === 'manual' ? 'bg-blue-500/10 text-blue-400' :
              'bg-muted text-muted-foreground'
            }`}>
              {sourceLabel[baseUrlSource] || baseUrlSource}
            </span>
            {baseUrl && (
              <Button
                size="sm"
                variant="ghost"
                onClick={resetWorkerUrl}
                className="h-7 text-xs text-destructive hover:text-destructive"
              >
                איפוס כתובת
              </Button>
            )}
            {baseUrl && (
              <a
                href={`${baseUrl}/health`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline flex items-center gap-1"
              >
                <ExternalLink className="w-3 h-3" />
                בדיקת /health
              </a>
            )}
          </CardContent>
        </Card>

        {/* Cross-device sync status — the shared server state (so a second device
            sees the SAME running bot) needs a Worker URL configured on THIS
            device too; localStorage is per-device and never syncs on its own. */}
        {(intraday.syncStatus === 'local-only' || legacy.syncStatus === 'local-only' || pro.syncStatus === 'local-only') && (
          <Card className="border-yellow-500/40 bg-yellow-500/5">
            <CardContent className="p-4 space-y-2 font-mono">
              <div className="flex items-center gap-2 text-yellow-400 text-sm font-bold">
                <AlertTriangle className="w-4 h-4" />
                {(() => {
                  const offline = [
                    intraday.syncStatus === 'local-only' && 'חדש',
                    legacy.syncStatus === 'local-only' && 'מקורי',
                    pro.syncStatus === 'local-only' && 'פרו'
                  ].filter(Boolean) as string[];
                  return offline.length === 3
                    ? 'שלושת המנועים לא מסונכרנים עם שרת — מציגים סימולציה מקומית בלבד במכשיר הזה'
                    : `מנוע ${offline.join(' ו-')} לא מסונכרן עם שרת — מציג סימולציה מקומית בלבד במכשיר הזה`;
                })()}
              </div>
              <p className="text-xs text-muted-foreground">
                אם הפעלת את הבוט במכשיר אחר, לא תראה כאן את אותה פעילות עד שתחבר את המכשיר הזה לאותה כתובת Worker.
                {intraday.syncError ? ` (${intraday.syncError})` : legacy.syncError ? ` (${legacy.syncError})` : pro.syncError ? ` (${pro.syncError})` : ''}
              </p>
              <div className="flex gap-2 flex-wrap items-center">
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://<worker>.onrender.com או כתובת tunnel"
                  className="flex-1 min-w-[220px] text-xs"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button size="sm" onClick={persistBaseUrl}>
                  שמור כתובת Worker
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Live data status */}
        <Card className="border-primary/30 bg-card/50 backdrop-blur">
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-mono">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
              <span className="text-muted-foreground">
                {isLoading ? 'טוען נתוני שוק...' : `${cryptoData?.length || 0} נכסים חיים · נתונים משותפים לשלושת המנועים`}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Combined risk overview */}
        <PortfolioRiskMeter
          portfolioValue={intraday.equity + legacy.equity + pro.equity}
          totalInvestedUsd={intraday.positionsValue + legacy.positionsValue + pro.positionsValue}
          totalLeveragedExposureUsd={intraday.totalLeveragedExposureUsd + legacy.totalLeveragedExposureUsd + pro.totalLeveragedExposureUsd}
          openPositionsCount={combinedPositionsCount}
          maxPositions={(intraday.config.maxPositions ?? 7) + (legacy.config.maxPositions ?? 7) + (pro.config.maxPositions ?? 7)}
          openFuturesCount={combinedFuturesCount}
          maxFutures={(intraday.config.maxFuturesPositions ?? 2) + (legacy.config.maxFuturesPositions ?? 2) + (pro.config.maxFuturesPositions ?? 2)}
          dailyDrawdownPercent={Math.max(intraday.dailyDrawdownPercent, legacy.dailyDrawdownPercent, pro.dailyDrawdownPercent)}
          weeklyDrawdownPercent={Math.max(intraday.weeklyDrawdownPercent, legacy.weeklyDrawdownPercent, pro.weeklyDrawdownPercent)}
        />

        {/* Three engines — 1 column on mobile, 2 on medium/large, 3 on extra-large screens */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          <SimulationEngineColumn
            title="מנוע חדש · Multi-Timeframe"
            subtitle="Setup + Entry מבניים על 1H/15M/5M"
            accentClass="text-primary"
            cryptoData={cryptoData}
            cash={intraday.cash}
            positions={intraday.positions}
            positionsValue={intraday.positionsValue}
            equity={intraday.equity}
            trades={intraday.trades}
            history={intraday.history}
            pending={intraday.pending}
            totalFees={intraday.totalFees}
            totalSlippageCost={intraday.totalSlippageCost}
            winRate={intraday.winRate}
            totalTrades={intraday.totalTrades}
            closedTrades={intraday.closedTrades}
            evaluations={intraday.evaluations}
            hasSavedSession={intraday.hasSavedSession}
            nextTickAt={intraday.nextTickAt}
            config={intraday.config}
            setConfig={intraday.setConfig}
            status={intraday.status}
            isRunning={intraday.isRunning}
            start={intraday.start}
            pause={intraday.pause}
            resetAll={intraday.resetAll}
          />

          <SimulationEngineColumn
            title="מנוע מקורי · Confidence Score"
            subtitle="ציון משוקלל 7 אינדיקטורים, סף Spot 58 (62 בתנודתיות גבוהה) / Futures 70%"
            accentClass="text-cyan-400"
            cryptoData={cryptoData}
            cash={legacy.cash}
            positions={legacy.positions}
            positionsValue={legacy.positionsValue}
            equity={legacy.equity}
            trades={legacy.trades}
            history={legacy.history}
            pending={legacy.pending}
            totalFees={legacy.totalFees}
            totalSlippageCost={legacy.totalSlippageCost}
            winRate={legacy.winRate}
            totalTrades={legacy.totalTrades}
            closedTrades={legacy.closedTrades}
            evaluations={legacy.evaluations}
            hasSavedSession={legacy.hasSavedSession}
            nextTickAt={legacy.nextTickAt}
            config={legacy.config}
            setConfig={legacy.setConfig}
            status={legacy.status}
            isRunning={legacy.isRunning}
            start={legacy.start}
            pause={legacy.pause}
            resetAll={legacy.resetAll}
          />

          <SimulationEngineColumn
            title="בוט פרו · alg.md"
            subtitle="מימוש מדויק של ASSETS/alg.md — Spot 60% / Futures 72%, Kelly ישיר, קנסות Volume/Ranging"
            accentClass="text-amber-400"
            cryptoData={cryptoData}
            cash={pro.cash}
            positions={pro.positions}
            positionsValue={pro.positionsValue}
            equity={pro.equity}
            trades={pro.trades}
            history={pro.history}
            pending={pro.pending}
            totalFees={pro.totalFees}
            totalSlippageCost={pro.totalSlippageCost}
            winRate={pro.winRate}
            totalTrades={pro.totalTrades}
            closedTrades={pro.closedTrades}
            evaluations={pro.evaluations}
            hasSavedSession={pro.hasSavedSession}
            nextTickAt={pro.nextTickAt}
            config={pro.config}
            setConfig={pro.setConfig}
            status={pro.status}
            isRunning={pro.isRunning}
            start={pro.start}
            pause={pro.pause}
            resetAll={pro.resetAll}
          />
        </div>
      </div>
    </div>
    </div>
  );
};

// The three sim-bot providers now live at the app root (see App.tsx) so every
// page — not just this one — sees live, server-synced bot state.
export default SimulationBotPage;


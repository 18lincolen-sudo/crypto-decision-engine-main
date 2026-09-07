import { useMemo, useState } from 'react';
import { Activity, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import Navigation from '../components/Navigation';
import { useWorkerAuth } from '../contexts/WorkerAuthContext';
import { useSimulationBotContext } from '../contexts/SimulationBotContext';
import { useProSimulationBotContext } from '../contexts/ProSimulationBotContext';
import { usePathSimulationBotContext } from '../contexts/PathSimulationBotContext';
import { useBybitSimulationBotContext } from '../contexts/BybitSimulationBotContext';
import type { SimTrade } from '@cde/engine/execution';

// A live side-by-side comparison of the four simulation bots — closed-trade
// stats and a merged trade log. The bots poll the worker on their own (every
// 5s via their contexts), so there is nothing to "run" here; this page only
// reads what they have already done. All four are simulation only.

type BotKey = 'intraday' | 'pro' | 'path' | 'bybit';

interface TradeRow extends SimTrade {
  bot: string;
  botKey: BotKey;
}

interface BotStats {
  key: BotKey;
  label: string;
  running: boolean;
  equity: number;
  pnlTotalUsd: number;
  pnlTotalPct: number;
  dailyDrawdownPercent: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  avgPnl: number;
  bestTrade: number;
  worstTrade: number;
}

const START_CAPITAL = 10_000;

const fmt = (n: number, digits = 2) =>
  n.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const pnlColor = (pnl: number) =>
  pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-muted-foreground';

function statsFor(key: BotKey, label: string, running: boolean, equity: number, dd: number, trades: TradeRow[]): BotStats {
  const closed = trades.filter((t) => typeof t.pnl === 'number');
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) <= 0);
  const realizedPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const pnls = closed.map((t) => t.pnl ?? 0);
  const pnlTotalUsd = equity - START_CAPITAL;
  return {
    key,
    label,
    running,
    equity,
    pnlTotalUsd,
    pnlTotalPct: (pnlTotalUsd / START_CAPITAL) * 100,
    dailyDrawdownPercent: dd,
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    realizedPnl,
    avgPnl: closed.length ? realizedPnl / closed.length : 0,
    bestTrade: pnls.length ? Math.max(...pnls) : 0,
    worstTrade: pnls.length ? Math.min(...pnls) : 0
  };
}

export default function BacktestResults() {
  const { baseUrl } = useWorkerAuth();
  const intraday = useSimulationBotContext();
  const pro = useProSimulationBotContext();
  const path = usePathSimulationBotContext();
  const bybit = useBybitSimulationBotContext();

  const [selectedBot, setSelectedBot] = useState<'all' | BotKey>('all');
  const [sortBy, setSortBy] = useState<'time' | 'pnl'>('time');

  const bots = useMemo(() => ([
    { key: 'intraday' as const, label: 'מנוע חדש', ctx: intraday },
    { key: 'pro' as const, label: 'פרו', ctx: pro },
    { key: 'path' as const, label: 'נתיב 4H', ctx: path },
    { key: 'bybit' as const, label: 'Bybit', ctx: bybit }
  ]), [intraday, pro, path, bybit]);

  const allTrades: TradeRow[] = useMemo(() =>
    bots.flatMap((b) =>
      (b.ctx.trades ?? [])
        .filter((t) => typeof t.pnl === 'number') // closed trades only
        .map((t) => ({ ...t, bot: b.label, botKey: b.key }))
    ), [bots]);

  const perBotStats: BotStats[] = useMemo(() =>
    bots.map((b) => statsFor(
      b.key, b.label, b.ctx.isRunning, b.ctx.equity, b.ctx.dailyDrawdownPercent,
      allTrades.filter((t) => t.botKey === b.key)
    )), [bots, allTrades]);

  const filtered = selectedBot === 'all'
    ? allTrades
    : allTrades.filter((t) => t.botKey === selectedBot);

  const sorted = [...filtered].sort((a, b) =>
    sortBy === 'time' ? b.at - a.at : (b.pnl ?? 0) - (a.pnl ?? 0)
  );

  const activeStats = selectedBot === 'all'
    ? null
    : perBotStats.find((s) => s.key === selectedBot) ?? null;

  const combined = useMemo(() => {
    const equity = bots.reduce((s, b) => s + (b.ctx.equity || 0), 0);
    const realized = allTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const wins = allTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    return {
      equity,
      pnlUsd: equity - START_CAPITAL * bots.length,
      realized,
      closed: allTrades.length,
      winRate: allTrades.length ? (wins / allTrades.length) * 100 : 0
    };
  }, [bots, allTrades]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Activity className="text-orange-400 w-6 h-6" />
          <h1 className="text-2xl font-bold">השוואת ביצועי הבוטים</h1>
          <span className="text-muted-foreground text-sm">({allTrades.length} עסקאות סגורות)</span>
        </div>

        {!baseUrl && (
          <Card className="bg-yellow-950/40 border-yellow-700 mb-6">
            <CardContent className="flex items-center gap-3 p-4">
              <AlertTriangle className="text-yellow-400 w-5 h-5 flex-shrink-0" />
              <p className="text-yellow-200 text-sm">
                כתובת Worker לא הוגדרה. חבר אותה בדף בוט הסימולציה כדי לראות עסקאות אמיתיות.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Per-bot equity summary */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {perBotStats.map((s) => (
            <Card key={s.key} className="bg-card/60 border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-1">
                  <p className="font-semibold">{s.label}</p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.running ? 'bg-green-900/50 text-green-300' : 'bg-muted text-muted-foreground'}`}>
                    {s.running ? 'פעיל' : 'מושהה'}
                  </span>
                </div>
                <p className={`text-xl font-bold font-mono ${pnlColor(s.pnlTotalUsd)}`}>
                  {s.pnlTotalUsd >= 0 ? '+' : ''}${fmt(s.pnlTotalUsd)}
                  <span className="text-xs ml-1">({s.pnlTotalPct >= 0 ? '+' : ''}{fmt(s.pnlTotalPct, 1)}%)</span>
                </p>
                <div className="text-xs text-muted-foreground mt-1 font-mono">
                  שווי ${fmt(s.equity)} · {s.closedTrades} עסקאות · {s.closedTrades ? `${fmt(s.winRate, 1)}% הצלחה` : 'אין עסקאות'}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  Drawdown יומי {fmt(s.dailyDrawdownPercent, 1)}%
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-4">
          {[
            { key: 'all' as const, label: `הכל (${allTrades.length})` },
            ...perBotStats.map((s) => ({ key: s.key, label: `${s.label} (${s.closedTrades})` }))
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setSelectedBot(key)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                selectedBot === key ? 'bg-orange-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/70'
              }`}
            >
              {label}
            </button>
          ))}
          <div className="flex-1" />
          <div className="flex gap-2">
            <span className="text-muted-foreground text-sm self-center">מיון:</span>
            {[
              { key: 'time' as const, label: 'זמן' },
              { key: 'pnl' as const, label: 'רווח/הפסד' }
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`px-3 py-1.5 rounded text-sm transition-colors ${
                  sortBy === key ? 'bg-slate-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Active-filter stat strip */}
        {activeStats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'עסקאות סגורות', value: `${activeStats.closedTrades}`, color: 'text-foreground' },
              { label: 'אחוז הצלחה', value: `${fmt(activeStats.winRate, 1)}%`, color: activeStats.winRate >= 50 ? 'text-green-400' : 'text-red-400' },
              { label: 'רווח/הפסד ממומש', value: `${activeStats.realizedPnl >= 0 ? '+' : ''}$${fmt(activeStats.realizedPnl)}`, color: pnlColor(activeStats.realizedPnl) },
              { label: 'ממוצע לעסקה', value: `${activeStats.avgPnl >= 0 ? '+' : ''}$${fmt(activeStats.avgPnl)}`, color: pnlColor(activeStats.avgPnl) }
            ].map(({ label, value, color }) => (
              <Card key={label} className="bg-card/60 border-border">
                <CardContent className="p-3">
                  <p className="text-muted-foreground text-xs mb-1">{label}</p>
                  <p className={`text-lg font-bold font-mono ${color}`}>{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Trade log */}
        {allTrades.length === 0 ? (
          <Card className="bg-card/60 border-border">
            <CardContent className="py-16 text-center">
              <Activity className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground">
                {baseUrl
                  ? 'אין עדיין עסקאות סגורות — הפעל את הבוטים בדף בוט הסימולציה והמתן.'
                  : 'הגדר כתובת Worker כדי לראות עסקאות.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="bg-card/60 border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-right">
                    <th className="px-4 py-3 font-medium">זמן</th>
                    <th className="px-4 py-3 font-medium">בוט</th>
                    <th className="px-4 py-3 font-medium">סמל</th>
                    <th className="px-4 py-3 font-medium">סוג</th>
                    <th className="px-4 py-3 font-medium">כיוון</th>
                    <th className="px-4 py-3 font-medium">מחיר</th>
                    <th className="px-4 py-3 font-medium">PnL ($)</th>
                    <th className="px-4 py-3 font-medium">PnL (%)</th>
                    <th className="px-4 py-3 font-medium">סיבה</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.slice(0, 200).map((t, i) => {
                    const pnl = t.pnl ?? 0;
                    const pct = t.pnlPercent ?? 0;
                    const ts = new Date(t.at).toLocaleString('he-IL', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
                    });
                    const isBuy = t.side.includes('buy') || t.side.includes('long');
                    return (
                      <tr key={`${t.botKey}-${t.id}-${i}`} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{ts}</td>
                        <td className="px-4 py-2.5">{t.bot}</td>
                        <td className="px-4 py-2.5 font-mono font-medium">{t.symbol}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs px-2 py-0.5 rounded ${t.type === 'FUTURES' ? 'bg-purple-900/50 text-purple-300' : 'bg-blue-900/50 text-blue-300'}`}>
                            {t.type}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`flex items-center gap-1 ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
                            {isBuy ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {t.side}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-mono">${fmt(t.price, t.price < 1 ? 6 : 2)}</td>
                        <td className={`px-4 py-2.5 font-mono font-medium ${pnlColor(pnl)}`}>{pnl >= 0 ? '+' : ''}${fmt(pnl)}</td>
                        <td className={`px-4 py-2.5 font-mono ${pnlColor(pct)}`}>{pct >= 0 ? '+' : ''}{fmt(pct)}%</td>
                        <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-[220px] truncate" title={t.reason}>{t.reason}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {sorted.length > 200 && (
                <p className="text-center text-muted-foreground text-xs py-3">מוצג 200 מתוך {sorted.length} עסקאות</p>
              )}
            </div>
          </Card>
        )}

        {/* Summary table */}
        {allTrades.length > 0 && (
          <div className="mt-6">
            <h2 className="text-lg font-semibold mb-3">השוואה בין הבוטים</h2>
            <Card className="bg-card/60 border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-right">
                      <th className="px-4 py-3 font-medium">בוט</th>
                      <th className="px-4 py-3 font-medium">רווח/הפסד כולל</th>
                      <th className="px-4 py-3 font-medium">עסקאות</th>
                      <th className="px-4 py-3 font-medium">הצלחות</th>
                      <th className="px-4 py-3 font-medium">הפסדים</th>
                      <th className="px-4 py-3 font-medium">Win Rate</th>
                      <th className="px-4 py-3 font-medium">PnL ממומש</th>
                      <th className="px-4 py-3 font-medium">ממוצע/עסקה</th>
                      <th className="px-4 py-3 font-medium">הכי טוב</th>
                      <th className="px-4 py-3 font-medium">הכי רע</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perBotStats.map((s) => (
                      <tr key={s.key} className="border-b border-border/50">
                        <td className="px-4 py-3 font-medium">{s.label}</td>
                        <td className={`px-4 py-3 font-mono font-medium ${pnlColor(s.pnlTotalUsd)}`}>
                          {s.pnlTotalUsd >= 0 ? '+' : ''}${fmt(s.pnlTotalUsd)} ({s.pnlTotalPct >= 0 ? '+' : ''}{fmt(s.pnlTotalPct, 1)}%)
                        </td>
                        <td className="px-4 py-3">{s.closedTrades}</td>
                        <td className="px-4 py-3 text-green-400">{s.wins}</td>
                        <td className="px-4 py-3 text-red-400">{s.losses}</td>
                        <td className={`px-4 py-3 font-medium ${s.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                          {s.closedTrades ? `${fmt(s.winRate, 1)}%` : '—'}
                        </td>
                        <td className={`px-4 py-3 font-mono ${pnlColor(s.realizedPnl)}`}>
                          {s.closedTrades ? `${s.realizedPnl >= 0 ? '+' : ''}$${fmt(s.realizedPnl)}` : '—'}
                        </td>
                        <td className={`px-4 py-3 font-mono ${pnlColor(s.avgPnl)}`}>
                          {s.closedTrades ? `${s.avgPnl >= 0 ? '+' : ''}$${fmt(s.avgPnl)}` : '—'}
                        </td>
                        <td className="px-4 py-3 font-mono text-green-400">{s.closedTrades ? `+$${fmt(s.bestTrade)}` : '—'}</td>
                        <td className="px-4 py-3 font-mono text-red-400">{s.closedTrades ? `$${fmt(s.worstTrade)}` : '—'}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border font-semibold">
                      <td className="px-4 py-3">סה"כ</td>
                      <td className={`px-4 py-3 font-mono ${pnlColor(combined.pnlUsd)}`}>
                        {combined.pnlUsd >= 0 ? '+' : ''}${fmt(combined.pnlUsd)}
                      </td>
                      <td className="px-4 py-3">{combined.closed}</td>
                      <td className="px-4 py-3" colSpan={2} />
                      <td className={`px-4 py-3 ${combined.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                        {combined.closed ? `${fmt(combined.winRate, 1)}%` : '—'}
                      </td>
                      <td className={`px-4 py-3 font-mono ${pnlColor(combined.realized)}`}>
                        {combined.closed ? `${combined.realized >= 0 ? '+' : ''}$${fmt(combined.realized)}` : '—'}
                      </td>
                      <td className="px-4 py-3" colSpan={3} />
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Play, RefreshCw, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import Navigation from '../components/Navigation';
import { useWorkerAuth } from '../contexts/WorkerAuthContext';

const ADMIN_TOKEN_KEY = 'workerAdminToken';

interface SweepResult {
  engine: 'legacy' | 'pro';
  minStop: number;
  maxStop: number;
  softTrendBase: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
}

interface BacktestState {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: number | null;
  finishedAt: number | null;
  results: SweepResult[];
  error: string | null;
  engine: string | null;
  days: number | null;
}

/** Guard: the SPA host returns index.html for unknown /api paths — return a
 *  clear error instead of crashing on JSON.parse of an HTML document. */
async function parseJsonOrThrow(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`תגובה לא-תקינה מהשרת (${res.status} — ${res.url}). בדוק שכתובת ה-Worker נכונה (הגדרות → כתובת Worker), ושדף זה עומד מול ה-Worker ולא מול אחסון ה-SPA.`);
  }
}

export default function BacktestResults() {
  const { baseUrl: workerBaseUrl, adminToken } = useWorkerAuth();
  const [state, setState] = useState<BacktestState>({
    status: 'idle', startedAt: null, finishedAt: null, results: [], error: null, engine: null, days: null
  });
  const [loading, setLoading] = useState(true);

  const authHeaders: Record<string, string> = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};

  const fetchResults = useCallback(async () => {
    if (!workerBaseUrl) {
      setState(s => ({ ...s, error: 'כתובת Worker לא הוגדרה. הגדר אותה בדף הבוט סימולציה או במשתני בנייה.' }));
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${workerBaseUrl}/api/backtest/results`, { headers: authHeaders });
      if (res.ok) {
        const data = await parseJsonOrThrow(res);
        if (data) {
          setState(s => ({
            ...s,
            ...data,
            error: null,
            status: data.status === 'running' ? 'running' : (data.results?.length ? 'done' : s.status),
          }));
        }
      } else if (res.status === 404) {
        setState(s => ({ ...s, error: 'נסה שוב מאוחר יותר.', status: 'error' }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Failed to fetch backtest results:', e);
      setState(s => ({ ...s, error: msg, status: 'error' }));
    } finally {
      setLoading(false);
    }
  }, [workerBaseUrl, authHeaders]);

  useEffect(() => {
    fetchResults();
    // Poll every 10 seconds if running
    if (state.status === 'running') {
      const interval = setInterval(fetchResults, 10000);
      return () => clearInterval(interval);
    }
  }, [state.status, fetchResults]);

  const handleRun = async () => {
    if (!workerBaseUrl) {
      setState(s => ({ ...s, error: 'כתובת Worker לא הוגדרה. הגדר אותה בדף הבוט סימולציה או במשתני בנייה.' }));
      return;
    }
    try {
      setState(s => ({ ...s, status: 'running', error: null }));
      const res = await fetch(`${workerBaseUrl}/api/backtest/run`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        await fetchResults();
      } else {
        let errMsg = `שגיאה ${res.status}`;
        try {
          const body = await res.json();
          errMsg = body?.error || errMsg;
        } catch { /* not JSON */ }
        setState(s => ({ ...s, status: 'error', error: errMsg }));
        console.error(`Failed to start backtest: ${res.status}`, errMsg);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState(s => ({ ...s, status: 'error', error: msg }));
      console.error('Failed to start backtest:', e);
    }
  };

  const formatDate = (ts: number | null) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('he-IL');
  };

  const getStatusBadge = () => {
    switch (state.status) {
      case 'running':
        return <Badge variant="outline" className="text-blue-400 border-blue-400"><Loader2 className="w-3 h-3 mr-1 animate-spin" /> רץ כרגע</Badge>;
      case 'done':
        return <Badge variant="outline" className="text-green-400 border-green-400"><CheckCircle2 className="w-3 h-3 mr-1" /> הושלם</Badge>;
      case 'error':
        return <Badge variant="outline" className="text-red-400 border-red-400"><AlertCircle className="w-3 h-3 mr-1" /> שגיאה</Badge>;
      default:
        return <Badge variant="outline" className="text-gray-400 border-gray-400"><Clock className="w-3 h-3 mr-1" /> ממתין</Badge>;
    }
  };

  if (loading && state.results.length === 0) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground" dir="rtl">
      <Navigation />
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Backtest Sweep Results</h1>
            <p className="text-sm text-muted-foreground">
              תוצאות סריקת פרמטרים — Stop Loss × Soft Trend Base
            </p>
          </div>
          <div className="flex items-center gap-3">
            {getStatusBadge()}
            <Button
              onClick={handleRun}
              disabled={state.status === 'running' || loading}
              size="sm"
            >
              {state.status === 'running' ? (
                <><Loader2 className="w-4 h-4 ml-2 animate-spin" /> רץ...</>
              ) : (
                <><Play className="w-4 h-4 ml-2" /> הרץ עכשיו</>
              )}
            </Button>
            <Button onClick={fetchResults} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* Status info */}
        {state.status === 'running' && state.startedAt && (
          <Card className="border-blue-500/30 bg-blue-500/5">
            <CardContent className="pt-4">
              <p className="text-sm text-blue-400">
                ריצה התחילה ב-{formatDate(state.startedAt)}. מרענן אוטומטי כל 10 שניות...
              </p>
            </CardContent>
          </Card>
        )}

        {state.status === 'error' && state.error && (
          <Card className="border-red-500/30 bg-red-500/5">
            <CardContent className="pt-4">
              <p className="text-sm text-red-400">שגיאה: {state.error}</p>
            </CardContent>
          </Card>
        )}

        {/* Results table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              תוצאות סוויפ ({state.results.length} שילובים)
              {state.finishedAt && (
                <span className="text-sm font-normal text-muted-foreground mr-2">
                  — עודכן לאחרונה: {formatDate(state.finishedAt)}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {state.results.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                אין תוצאות עדיין. לחץ "הרץ עכשיו" כדי להתחיל.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-right py-2 px-2">Engine</th>
                      <th className="text-right py-2 px-2">Min SL</th>
                      <th className="text-right py-2 px-2">Max SL</th>
                      <th className="text-right py-2 px-2">Soft Base</th>
                      <th className="text-right py-2 px-2">Trades</th>
                      <th className="text-right py-2 px-2">WR%</th>
                      <th className="text-right py-2 px-2">Net $</th>
                      <th className="text-right py-2 px-2">PF</th>
                      <th className="text-right py-2 px-2">Exp $</th>
                      <th className="text-right py-2 px-2">MaxDD%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.results.map((r, i) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="py-2 px-2">
                          <Badge variant={r.engine === 'legacy' ? 'default' : 'secondary'} className="text-xs">
                            {r.engine}
                          </Badge>
                        </td>
                        <td className="py-2 px-2">{r.minStop.toFixed(1)}%</td>
                        <td className="py-2 px-2">{r.maxStop.toFixed(1)}%</td>
                        <td className="py-2 px-2">{r.softTrendBase}</td>
                        <td className="py-2 px-2">{r.totalTrades}</td>
                        <td className="py-2 px-2">{r.winRate.toFixed(1)}%</td>
                        <td className={`py-2 px-2 ${r.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          ${r.netProfit.toFixed(0)}
                        </td>
                        <td className="py-2 px-2 font-medium">{r.profitFactor.toFixed(2)}</td>
                        <td className="py-2 px-2">${r.expectancy.toFixed(1)}</td>
                        <td className="py-2 px-2">{r.maxDrawdown.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

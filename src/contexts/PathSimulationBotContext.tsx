import { createContext, useContext, useState, useCallback, useEffect, useMemo, ReactNode } from 'react';
import {
  getPathSimState,
  getPathTable,
  startPathSim,
  stopPathSim,
  resetPathSim,
  setPathSimConfig,
  PathSimBotStateResponse,
  PathTableStatus
} from '../services/tradingApiClient';
import type { SimBotConfig, SimPosition, SimTrade, SimPoint, PendingOrder } from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';
import { useWorkerAuth } from './WorkerAuthContext';
import type { SimStatus } from './SimulationBotContext';
import { useApiPolling } from '../hooks/useApiPolling';

// Matches server/tradingWorker.ts DEFAULT_PATH_SIM_CONFIG.
//
// Unlike the other three contexts there is NO browser fallback engine here, and
// that is deliberate rather than unfinished. This bot trades from a lookup table
// pooled across the whole universe's 4H history; a browser holds one page-load's
// worth of candles for a handful of symbols, so a local copy could not build the
// table and would silently trade a different, thinner strategy under the same
// name. When the worker is unreachable this context reports it and shows nothing
// — which is the honest state — instead of running a degraded twin.
const DEFAULT_PATH_CONFIG: SimBotConfig = {
  riskLevel: 'medium',
  initialAmount: 10000,
  maxPositions: 5,
  maxFuturesPositions: 0,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 3,
  // A path signal's confidence IS the bucket's lower-bound hit rate, so this
  // floor is a probability: a 2R target clears breakeven around 36%.
  minConfidenceOverride: 33,
  positionPercent: 10
};

export interface PathSimulationBotContextValue {
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
  lastEvaluation: string;
  evaluations: SignalEvaluation[];
  minConfidence: number;
  hasSavedSession: boolean;
  nextTickAt: number;
  totalLeveragedExposureUsd: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  candleCount: number;
  /** Telemetry for the lookup table the bot trades from. Null until first read. */
  table: PathTableStatus | null;
  config: SimBotConfig;
  setConfig: (c: SimBotConfig) => void;
  status: SimStatus;
  isRunning: boolean;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resetAll: () => Promise<void>;
  controlError: string | null;
  syncStatus: 'synced' | 'local-only' | 'connecting';
  syncError: string | null;
}

const PathSimulationBotContext = createContext<PathSimulationBotContextValue | null>(null);

const LAST_KNOWN_RUNNING_KEY = 'path-sim-bot-last-known-running';

const EMPTY_SNAPSHOT = {
  cash: 10000, positions: [], positionsValue: 0, equity: 10000, trades: [], history: [],
  pending: [], totalFees: 0, totalSlippageCost: 0, winRate: 0, totalTrades: 0,
  closedTrades: 0, lastEvaluation: '', evaluations: [], minConfidence: 33,
  hasSavedSession: false, nextTickAt: 0, totalLeveragedExposureUsd: 0,
  dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0, candleCount: 0
};

export function PathSimulationBotProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<SimBotConfig>(DEFAULT_PATH_CONFIG);
  const [status, setStatus] = useState<SimStatus>(() => {
    try {
      return localStorage.getItem(LAST_KNOWN_RUNNING_KEY) === '1' ? 'running' : 'idle';
    } catch {
      return 'idle';
    }
  });
  const [serverSnapshot, setServerSnapshot] = useState<PathSimBotStateResponse['snapshot']>(null);
  const [table, setTable] = useState<PathTableStatus | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const { baseUrl } = useWorkerAuth();

  const isRunning = status === 'running';

  const applyServerState = useCallback((st: PathSimBotStateResponse) => {
    if (st.snapshot) setServerSnapshot(st.snapshot);
    if (typeof st.running === 'boolean') {
      setStatus(st.running ? 'running' : current => current === 'paused' ? 'paused' : 'idle');
      try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, st.running ? '1' : '0'); } catch { /* ignore */ }
    }
    if (st.config) setConfigState(st.config as SimBotConfig);
  }, []);

  const pollingOptions = useMemo(() => ({ baseInterval: 5000, maxInterval: 30000 }), []);
  const { data: pathSimStateData, syncStatus, syncError } = useApiPolling<PathSimBotStateResponse>(
    () => getPathSimState(baseUrl),
    pollingOptions
  );

  useEffect(() => {
    if (pathSimStateData) applyServerState(pathSimStateData);
  }, [pathSimStateData, applyServerState]);

  useEffect(() => {
    if (syncStatus === 'local-only') setServerSnapshot(null);
  }, [syncStatus]);

  // The table changes only when the worker rebuilds it (every 30 minutes), so
  // it is polled far more slowly than the snapshot.
  useEffect(() => {
    if (!baseUrl) return;
    let cancelled = false;
    const read = () => {
      getPathTable(baseUrl)
        .then((t) => { if (!cancelled) setTable(t); })
        .catch(() => { /* table telemetry is informational; never block on it */ });
    };
    read();
    const interval = setInterval(read, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [baseUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const serverState = await getPathSimState(baseUrl);
        if (!cancelled) applyServerState(serverState);
      } catch {
        /* keep local state if the worker is unreachable */
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, applyServerState]);

  const start = useCallback(async () => {
    setControlError(null);
    setStatus('running');
    try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, '1'); } catch { /* ignore */ }
    if (!baseUrl) {
      setControlError('הבוט הזה רץ בשרת בלבד — הגדר כתובת Worker');
      return;
    }
    try {
      applyServerState(await startPathSim(baseUrl));
    } catch (error) {
      setServerSnapshot(null);
      setControlError(error instanceof Error ? error.message : 'שגיאה בהפעלת הבוט');
    }
  }, [baseUrl, applyServerState]);

  const pause = useCallback(async () => {
    setControlError(null);
    setStatus('paused');
    try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, '0'); } catch { /* ignore */ }
    if (!baseUrl) return;
    try {
      const state = await stopPathSim(baseUrl);
      if (state.snapshot) setServerSnapshot(state.snapshot);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'שגיאה בהשהיית הבוט');
    }
  }, [baseUrl]);

  const resetAll = useCallback(async () => {
    setControlError(null);
    setStatus('idle');
    try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, '0'); } catch { /* ignore */ }
    setServerSnapshot(null);
    if (!baseUrl) return;
    try {
      await resetPathSim(baseUrl);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'שגיאה באיפוס הבוט');
    }
  }, [baseUrl]);

  const setConfig = useCallback((c: SimBotConfig) => {
    setControlError(null);
    setConfigState(c);
    if (baseUrl) {
      setPathSimConfig(c, baseUrl).catch((error) => {
        setControlError(error instanceof Error ? error.message : 'שגיאה בשמירת ההגדרות');
      });
    }
  }, [baseUrl]);

  const source = (serverSnapshot ?? EMPTY_SNAPSHOT) as typeof EMPTY_SNAPSHOT;

  const value: PathSimulationBotContextValue = {
    cash: source.cash ?? 10000,
    positions: (source.positions ?? []) as SimPosition[],
    positionsValue: source.positionsValue ?? 0,
    equity: source.equity ?? 10000,
    trades: (source.trades ?? []) as SimTrade[],
    history: (source.history ?? []) as SimPoint[],
    pending: (source.pending ?? []) as PendingOrder[],
    totalFees: source.totalFees ?? 0,
    totalSlippageCost: source.totalSlippageCost ?? 0,
    winRate: source.winRate ?? 0,
    totalTrades: source.totalTrades ?? 0,
    closedTrades: source.closedTrades ?? 0,
    lastEvaluation: source.lastEvaluation ?? '',
    evaluations: (source.evaluations ?? []) as SignalEvaluation[],
    minConfidence: source.minConfidence ?? 33,
    hasSavedSession: source.hasSavedSession ?? false,
    nextTickAt: source.nextTickAt ?? 0,
    totalLeveragedExposureUsd: source.totalLeveragedExposureUsd ?? 0,
    dailyDrawdownPercent: source.dailyDrawdownPercent ?? 0,
    weeklyDrawdownPercent: source.weeklyDrawdownPercent ?? 0,
    candleCount: source.candleCount ?? 0,
    table,
    config,
    setConfig,
    status,
    isRunning,
    start,
    pause,
    resetAll,
    controlError,
    syncStatus,
    syncError
  };

  return <PathSimulationBotContext.Provider value={value}>{children}</PathSimulationBotContext.Provider>;
}

export function usePathSimulationBotContext(): PathSimulationBotContextValue {
  const ctx = useContext(PathSimulationBotContext);
  if (!ctx) throw new Error('usePathSimulationBotContext must be used within a PathSimulationBotProvider');
  return ctx;
}

export function usePathSimulationBotContextSafe(): PathSimulationBotContextValue | null {
  return useContext(PathSimulationBotContext);
}

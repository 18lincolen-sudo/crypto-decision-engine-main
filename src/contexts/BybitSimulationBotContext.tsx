import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo, ReactNode } from 'react';
import {
  getBybitSimState,
  startBybitSim,
  stopBybitSim,
  resetBybitSim,
  setBybitSimConfig,
  BybitSimBotStateResponse
} from '../services/tradingApiClient';
import type { SimBotConfig, SimPosition, SimTrade, SimPoint, PendingOrder } from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';
import { useWorkerAuth } from './WorkerAuthContext';
import type { SimStatus } from './SimulationBotContext';
import { useApiPolling } from '../hooks/useApiPolling';
import { simBotDefaults } from '@cde/engine/execution';
import { SIM_MIN_CONFIDENCE } from '@cde/engine/execution';
import { useServerSimDefaults } from '../hooks/useServerSimDefaults';

// Like the Path bot, this one has NO browser fallback engine — TrendBreakout
// needs H1/M15/M5 history across the whole universe that a single page load
// cannot hold, so a local twin would silently trade a thinner strategy under
// the same name. When the worker is unreachable this context reports it and
// shows nothing (the honest state) rather than a degraded copy.
//
// SIMULATION ONLY. This bot is never a real-money bot until a separate decision.
const DEFAULT_BYBIT_CONFIG: SimBotConfig = simBotDefaults('bybit');

export interface BybitSimulationBotContextValue {
  cash: number;
  positions: SimPosition[];
  positionsValue: number;
  equity: number;
  trades: SimTrade[];
  history: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
  totalFunding: number;
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
  /** Capital the current run opened with. Authoritative from the server
   *  snapshot; falls back to the local config's initialAmount before the
   *  first sync. */
  initialAmount: number;
  /** False when the numbers above are the EMPTY_SNAPSHOT placeholder rather
    * than a real server reading (no Worker URL, or the worker unreachable). */
  hasServerData: boolean;
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

const BybitSimulationBotContext = createContext<BybitSimulationBotContextValue | null>(null);

/** The Bybit bot's only localStorage key. Exported so SimulationBot.tsx's Clear
 *  Cache list imports it rather than holding a second copy of the string. */
export const BYBIT_SIM_BOT_LAST_KNOWN_RUNNING_KEY = 'bybit-sim-bot-last-known-running';
const LAST_KNOWN_RUNNING_KEY = BYBIT_SIM_BOT_LAST_KNOWN_RUNNING_KEY;

const EMPTY_SNAPSHOT = {
  cash: 10000, positions: [], positionsValue: 0, equity: 10000, trades: [], history: [],
  pending: [], totalFees: 0, totalSlippageCost: 0, totalFunding: 0, winRate: 0, totalTrades: 0,
  closedTrades: 0, lastEvaluation: '', evaluations: [], minConfidence: SIM_MIN_CONFIDENCE.bybit,
  hasSavedSession: false, nextTickAt: 0, totalLeveragedExposureUsd: 0,
  dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0, candleCount: 0, initialAmount: 10000
};

export function BybitSimulationBotProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<SimBotConfig>(DEFAULT_BYBIT_CONFIG);
  const [status, setStatus] = useState<SimStatus>(() => {
    try {
      return localStorage.getItem(LAST_KNOWN_RUNNING_KEY) === '1' ? 'running' : 'idle';
    } catch {
      return 'idle';
    }
  });
  const [serverSnapshot, setServerSnapshot] = useState<BybitSimBotStateResponse['snapshot']>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const configFromServer = useRef(false);
  const { baseUrl } = useWorkerAuth();

  const isRunning = status === 'running';

  const applyServerState = useCallback((st: BybitSimBotStateResponse) => {
    if (st.snapshot) setServerSnapshot(st.snapshot);
    if (typeof st.running === 'boolean') {
      setStatus(st.running ? 'running' : current => current === 'paused' ? 'paused' : 'idle');
      try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, st.running ? '1' : '0'); } catch { /* ignore */ }
    }
    if (st.config) {
      configFromServer.current = true;
      setConfigState(st.config as SimBotConfig);
    }
  }, []);

  const pollingOptions = useMemo(() => ({ baseInterval: 5000, maxInterval: 30000 }), []);
  useServerSimDefaults('bybit', baseUrl, setConfigState, configFromServer.current);

  const { data: bybitSimStateData, syncStatus, syncError } = useApiPolling<BybitSimBotStateResponse>(
    () => getBybitSimState(baseUrl),
    pollingOptions
  );

  useEffect(() => {
    if (bybitSimStateData) applyServerState(bybitSimStateData);
  }, [bybitSimStateData, applyServerState]);

  useEffect(() => {
    if (syncStatus === 'local-only') setServerSnapshot(null);
  }, [syncStatus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const serverState = await getBybitSimState(baseUrl);
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
      applyServerState(await startBybitSim(baseUrl));
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
      const state = await stopBybitSim(baseUrl);
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
      await resetBybitSim(baseUrl);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'שגיאה באיפוס הבוט');
    }
  }, [baseUrl]);

  const setConfig = useCallback((c: SimBotConfig) => {
    setControlError(null);
    setConfigState(c);
    if (baseUrl) {
      setBybitSimConfig(c, baseUrl).catch((error) => {
        setControlError(error instanceof Error ? error.message : 'שגיאה בשמירת ההגדרות');
      });
    }
  }, [baseUrl]);

  const source = (serverSnapshot ?? EMPTY_SNAPSHOT) as typeof EMPTY_SNAPSHOT;

  const value: BybitSimulationBotContextValue = {
    cash: source.cash ?? 10000,
    positions: (source.positions ?? []) as SimPosition[],
    positionsValue: source.positionsValue ?? 0,
    equity: source.equity ?? 10000,
    trades: (source.trades ?? []) as SimTrade[],
    history: (source.history ?? []) as SimPoint[],
    pending: (source.pending ?? []) as PendingOrder[],
    totalFees: source.totalFees ?? 0,
    totalSlippageCost: source.totalSlippageCost ?? 0,
    totalFunding: source.totalFunding ?? 0,
    winRate: source.winRate ?? 0,
    totalTrades: source.totalTrades ?? 0,
    closedTrades: source.closedTrades ?? 0,
    lastEvaluation: source.lastEvaluation ?? '',
    evaluations: (source.evaluations ?? []) as SignalEvaluation[],
    minConfidence: source.minConfidence ?? SIM_MIN_CONFIDENCE.bybit,
    hasSavedSession: source.hasSavedSession ?? false,
    nextTickAt: source.nextTickAt ?? 0,
    totalLeveragedExposureUsd: source.totalLeveragedExposureUsd ?? 0,
    dailyDrawdownPercent: source.dailyDrawdownPercent ?? 0,
    weeklyDrawdownPercent: source.weeklyDrawdownPercent ?? 0,
    candleCount: source.candleCount ?? 0,
    initialAmount: source.initialAmount,
    hasServerData: serverSnapshot !== null,
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

  return <BybitSimulationBotContext.Provider value={value}>{children}</BybitSimulationBotContext.Provider>;
}

export function useBybitSimulationBotContext(): BybitSimulationBotContextValue {
  const ctx = useContext(BybitSimulationBotContext);
  if (!ctx) throw new Error('useBybitSimulationBotContext must be used within a BybitSimulationBotProvider');
  return ctx;
}

export function useBybitSimulationBotContextSafe(): BybitSimulationBotContextValue | null {
  return useContext(BybitSimulationBotContext);
}

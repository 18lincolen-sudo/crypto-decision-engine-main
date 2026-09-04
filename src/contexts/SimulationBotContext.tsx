import { createContext, useContext, useState, useRef, useCallback, useEffect, ReactNode } from 'react';
import {
  getSimState,
  startSim,
  stopSim,
  resetSim,
  setSimConfig,
  SimBotStateResponse
} from '../services/tradingApiClient';
import type { SimBotSnapshot } from '../services/tradingApiClient';
import { useSimulationBot, SimBotConfig, SimPosition, SimTrade, SimPoint, PendingOrder } from '../hooks/useSimulationBot';
import type { SignalEvaluation } from '@cde/engine';
import { useCryptoData } from '../hooks/useCryptoData';
import { useFearGreedIndex } from '../hooks/useFearGreedIndex';
import { useWorkerAuth } from './WorkerAuthContext';
import { useApiPolling } from '../hooks/useApiPolling';
import { simBotDefaults, SIM_MIN_CONFIDENCE } from '@cde/engine/execution';
import { useServerSimDefaults } from '../hooks/useServerSimDefaults';

// Matches server/simEngine.ts DEFAULT_SIM_CONFIG — this engine is server-driven
// (the poll effect below overwrites this with the server's real config on sync),
// so this is only the pre-sync placeholder shown for a moment on first load.
// The static base, shared with server/tradingWorker.ts so the two runtimes
// cannot drift. What is NOT shared: the operator's deploy-time environment
// (BOT_MIN_CONFIDENCE, BOT_POSITION_PERCENT, BOT_MAX_OPEN_POSITIONS,
// BOT_RISK_LEVEL). useServerSimDefaults() below reads those from the worker at
// boot; this is what is shown until that lands, or if it never does.
const DEFAULT_CONFIG: SimBotConfig = simBotDefaults('intraday');

export type SimStatus = 'running' | 'paused' | 'idle';

export interface SimulationBotContextValue {
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
  config: SimBotConfig;
  setConfig: (c: SimBotConfig) => void;
  status: SimStatus;
  isRunning: boolean;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resetAll: () => Promise<void>;
  controlError: string | null;
  /** Whether this device is showing the shared server-synced bot state, or an
   *  unstarted local-only fallback because the Worker URL isn't reachable
   *  from THIS device (localStorage config is per-device, not synced). */
  syncStatus: 'synced' | 'local-only' | 'connecting';
  syncError: string | null;
}

const SimulationBotContext = createContext<SimulationBotContextValue | null>(null);

// The server is the actual execution authority for this engine — a reload or
// network blip on the client never pauses real trading, it only affects what
// this device can currently SEE. But starting from a hardcoded 'idle' on every
// mount meant a reload that happens to land while offline briefly showed
// "idle"/enabled Start button even though the server was still running fine,
// which reads as "the bot stopped" even though it never did. Seed from the
// last known value so a reload-while-offline keeps showing the truth until
// the next successful poll corrects it (see applyServerState below).
const LAST_KNOWN_RUNNING_KEY = 'sim-bot-last-known-running';

export function SimulationBotProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<SimBotConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<SimStatus>(() => {
    try {
      return localStorage.getItem(LAST_KNOWN_RUNNING_KEY) === '1' ? 'running' : 'idle';
    } catch {
      return 'idle';
    }
  });
  const [serverSnapshot, setServerSnapshot] = useState<SimBotSnapshot | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const fearGreedIndex = useFearGreedIndex();
  // True once this bot's own /state has delivered a config. The RUNNING
  // config is a fact and always beats the worker's starting defaults.
  const configFromServer = useRef(false);
  const { baseUrl } = useWorkerAuth();

  const isRunning = status === 'running';

  // Fetch live market data for simulation
  const { cryptoData } = useCryptoData();

  // Run autonomous client-side simulation engine
  const localSim = useSimulationBot({
    config,
    // The server owns execution as soon as it has supplied a snapshot. Keep
    // the local engine only as an offline fallback; it must not continue
    // calculating or persisting a competing simulation in synced mode.
    isRunning: isRunning && serverSnapshot === null,
    cryptoData: cryptoData || [],
    fearGreedIndex
  });

  const applyServerState = useCallback((st: SimBotStateResponse) => {
    if (st.snapshot) {
      setServerSnapshot(st.snapshot);
    }
    if (typeof st.running === 'boolean') {
      setStatus(st.running ? 'running' : current => current === 'paused' ? 'paused' : 'idle');
      try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, st.running ? '1' : '0'); } catch { /* ignore */ }
    }
    if (st.config) {
      configFromServer.current = true;
      setConfigState(st.config as SimBotConfig);
    }
  }, []);

  // Poll server state with exponential backoff on 429s / network errors.
  // The server is the actual execution authority — a reload or network blip
  // on the client never pauses real trading, it only affects what this device
  // can currently SEE. Backoff prevents hammering an already rate-limited
  // backend and lets the rate-limit window recover.
  // Fills the window before the first poll: the compile-time base cannot
  // carry this worker's BOT_* environment overrides. Writes locally only —
  // it never POSTs a config the operator did not choose.
  useServerSimDefaults('intraday', baseUrl, setConfigState, configFromServer.current);

  const { data: simStateData, syncStatus, syncError, refresh: refreshSimState } = useApiPolling<SimBotStateResponse>(
    () => getSimState(baseUrl),
    { baseInterval: 5000, maxInterval: 30000 }
  );

  useEffect(() => {
    if (simStateData) {
      applyServerState(simStateData);
    }
  }, [simStateData, applyServerState]);

  useEffect(() => {
    if (syncStatus === 'local-only') setServerSnapshot(null);
  }, [syncStatus]);

  // Immediately sync with server on mount so a reload shows the true
  // running state without waiting for the first polling interval.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const serverState = await getSimState(baseUrl);
        if (!cancelled) applyServerState(serverState);
      } catch {
        // Keep local state if server unreachable
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, applyServerState]);

  const start = useCallback(async () => {
    setControlError(null);
    setStatus('running');
    try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, '1'); } catch { /* ignore */ }
    if (!baseUrl) return;
    try {
      applyServerState(await startSim(baseUrl));
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
      const state = await stopSim(baseUrl);
      if (state.snapshot) setServerSnapshot(state.snapshot);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'שגיאה בהשהיית הבוט');
    }
  }, [baseUrl]);

  const resetAll = useCallback(async () => {
    setControlError(null);
    setStatus('idle');
    try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, '0'); } catch { /* ignore */ }
    localSim.reset();
    setServerSnapshot(null);
    if (!baseUrl) return;
    try {
      await resetSim(baseUrl);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'שגיאה באיפוס הבוט');
    }
  }, [localSim, baseUrl]);

  const setConfig = useCallback((c: SimBotConfig) => {
    setControlError(null);
    setConfigState(c);
    if (baseUrl) {
      setSimConfig(c, baseUrl).catch((error) => {
        setControlError(error instanceof Error ? error.message : 'שגיאה בשמירת ההגדרות');
      });
    }
  }, [baseUrl]);

  // The server is the execution authority. Use its data whenever the
  // server is reachable and synced, even if it hasn't produced trades yet.
  const useServer = serverSnapshot !== null && syncStatus === 'synced';

  const activeSource: SimBotSnapshot = useServer ? serverSnapshot : localSim;

  const value: SimulationBotContextValue = {
    cash: activeSource.cash ?? 10000,
    positions: (activeSource.positions ?? []) as SimPosition[],
    positionsValue: activeSource.positionsValue ?? 0,
    equity: activeSource.equity ?? 10000,
    trades: (activeSource.trades ?? []) as SimTrade[],
    history: (activeSource.history ?? []) as SimPoint[],
    pending: (activeSource.pending ?? []) as PendingOrder[],
    totalFees: activeSource.totalFees ?? 0,
    totalSlippageCost: activeSource.totalSlippageCost ?? 0,
    winRate: activeSource.winRate ?? 0,
    totalTrades: activeSource.totalTrades ?? 0,
    closedTrades: activeSource.closedTrades ?? 0,
    lastEvaluation: activeSource.lastEvaluation ?? '',
    evaluations: (activeSource.evaluations ?? []) as SignalEvaluation[],
    minConfidence: activeSource.minConfidence ?? SIM_MIN_CONFIDENCE.intraday,
    hasSavedSession: activeSource.hasSavedSession ?? false,
    nextTickAt: activeSource.nextTickAt ?? 0,
    totalLeveragedExposureUsd: activeSource.totalLeveragedExposureUsd ?? 0,
    dailyDrawdownPercent: activeSource.dailyDrawdownPercent ?? 0,
    weeklyDrawdownPercent: activeSource.weeklyDrawdownPercent ?? 0,
    candleCount: activeSource.candleCount ?? 0,
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

  return <SimulationBotContext.Provider value={value}>{children}</SimulationBotContext.Provider>;
}

export function useSimulationBotContext(): SimulationBotContextValue {
  const ctx = useContext(SimulationBotContext);
  if (!ctx) throw new Error('useSimulationBotContext must be used within a SimulationBotProvider');
  return ctx;
}

export function useSimulationBotContextSafe(): SimulationBotContextValue | null {
  return useContext(SimulationBotContext);
}

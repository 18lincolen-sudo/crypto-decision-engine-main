import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo, ReactNode } from 'react';
import {
  getProSimState,
  startProSim,
  stopProSim,
  resetProSim,
  setProSimConfig,
  ProSimBotStateResponse
} from '../services/tradingApiClient';
import {
  useProSimulationBot,
  SimBotConfig,
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder
} from '../hooks/useProSimulationBot';
import type { SignalEvaluation } from '@cde/engine';
import { useCryptoData } from '../hooks/useCryptoData';
import { useFearGreedIndex } from '../hooks/useFearGreedIndex';
import { useWorkerAuth } from './WorkerAuthContext';
import type { SimStatus } from './SimulationBotContext';
import { useApiPolling } from '../hooks/useApiPolling';
import { simBotDefaults } from '@cde/engine/execution';
import { SIM_MIN_CONFIDENCE } from '@cde/engine/execution';
import { useServerSimDefaults } from '../hooks/useServerSimDefaults';

// Matches server/proSimEngine.ts DEFAULT_PRO_SIM_CONFIG — this engine is
// server-driven (the poll effect below overwrites this with the server's
// real config on sync), so this is only the pre-sync placeholder shown
// briefly on first load.
// The static base, shared with server/tradingWorker.ts so the two runtimes
// cannot drift. What is NOT shared: the operator's deploy-time environment
// (BOT_MIN_CONFIDENCE, BOT_POSITION_PERCENT, BOT_MAX_OPEN_POSITIONS,
// BOT_RISK_LEVEL). The browser cannot read those, so this is the value shown
// until the first successful poll adopts the server's real config — a
// placeholder that is now provably the same number the worker starts from,
// rather than a second hand-maintained copy of it.
const DEFAULT_PRO_CONFIG: SimBotConfig = simBotDefaults('pro');

export interface ProSimulationBotContextValue {
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
  syncStatus: 'synced' | 'local-only' | 'connecting';
  syncError: string | null;
}

const ProSimulationBotContext = createContext<ProSimulationBotContextValue | null>(null);

// The server is the actual execution authority for this engine (same as the
// other two) — a reload or network blip on the client never pauses the bot,
// it only affects what this device can currently SEE. Seed from the last
// known value so a reload-while-offline keeps showing the truth until the
// next successful poll corrects it (see applyServerState below).
const LAST_KNOWN_RUNNING_KEY = 'pro-sim-bot-last-known-running';

export function ProSimulationBotProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<SimBotConfig>(DEFAULT_PRO_CONFIG);
  const [status, setStatus] = useState<SimStatus>(() => {
    try {
      return localStorage.getItem(LAST_KNOWN_RUNNING_KEY) === '1' ? 'running' : 'idle';
    } catch {
      return 'idle';
    }
  });
  const [serverSnapshot, setServerSnapshot] = useState<ProSimBotStateResponse['snapshot']>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const fearGreedIndex = useFearGreedIndex();
  // True once this bot's own /state has delivered a config. The RUNNING
  // config is a fact and always beats the worker's starting defaults.
  const configFromServer = useRef(false);
  const { baseUrl } = useWorkerAuth();

  const isRunning = status === 'running';

  const { cryptoData } = useCryptoData();

  // Local fallback engine — same role as the other two contexts' localSim.
  const localSim = useProSimulationBot({
    config,
    isRunning: isRunning && serverSnapshot === null,
    cryptoData: cryptoData || [],
    fearGreedIndex
  });

  const applyServerState = useCallback((st: ProSimBotStateResponse) => {
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
  const pollingOptions = useMemo(() => ({ baseInterval: 5000, maxInterval: 30000 }), []);
  // Fills the window before the first poll: the compile-time base cannot
  // carry this worker's BOT_* environment overrides. Writes locally only —
  // it never POSTs a config the operator did not choose.
  useServerSimDefaults('pro', baseUrl, setConfigState, configFromServer.current);

  const { data: proSimStateData, syncStatus, syncError } = useApiPolling<ProSimBotStateResponse>(
    () => getProSimState(baseUrl),
    pollingOptions
  );

  useEffect(() => {
    if (proSimStateData) {
      applyServerState(proSimStateData);
    }
  }, [proSimStateData, applyServerState]);

  useEffect(() => {
    if (syncStatus === 'local-only') setServerSnapshot(null);
  }, [syncStatus]);

  // Immediately sync with server on mount so a reload shows the true
  // running state without waiting for the first polling interval.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const serverState = await getProSimState(baseUrl);
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
      applyServerState(await startProSim(baseUrl));
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
      const state = await stopProSim(baseUrl);
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
      await resetProSim(baseUrl);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : 'שגיאה באיפוס הבוט');
    }
  }, [localSim, baseUrl]);

  const setConfig = useCallback((c: SimBotConfig) => {
    setControlError(null);
    setConfigState(c);
    if (baseUrl) {
      setProSimConfig(c, baseUrl).catch((error) => {
        setControlError(error instanceof Error ? error.message : 'שגיאה בשמירת ההגדרות');
      });
    }
  }, [baseUrl]);

  // The server is the execution authority. Use its data whenever the
  // server is reachable and synced, even if it hasn't produced trades yet.
  const useServer = serverSnapshot !== null && syncStatus === 'synced';

  const activeSource = useServer && serverSnapshot ? serverSnapshot : localSim;

  const value: ProSimulationBotContextValue = {
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
    minConfidence: activeSource.minConfidence ?? SIM_MIN_CONFIDENCE.pro,
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

  return <ProSimulationBotContext.Provider value={value}>{children}</ProSimulationBotContext.Provider>;
}

export function useProSimulationBotContext(): ProSimulationBotContextValue {
  const ctx = useContext(ProSimulationBotContext);
  if (!ctx) throw new Error('useProSimulationBotContext must be used within a ProSimulationBotProvider');
  return ctx;
}

export function useProSimulationBotContextSafe(): ProSimulationBotContextValue | null {
  return useContext(ProSimulationBotContext);
}

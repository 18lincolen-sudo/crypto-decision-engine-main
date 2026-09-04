import { createContext, useContext, useState, useCallback, useEffect, useMemo, ReactNode } from 'react';
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

// Matches server/proSimEngine.ts DEFAULT_PRO_SIM_CONFIG — this engine is
// server-driven (the poll effect below overwrites this with the server's
// real config on sync), so this is only the pre-sync placeholder shown
// briefly on first load.
const DEFAULT_PRO_CONFIG: SimBotConfig = {
  riskLevel: 'medium',
  initialAmount: 10000,
  // 5, the same cap the live bot runs (BOT_MAX_OPEN_POSITIONS) and the same
  // one the server sims now take from it. At 7 the simulations were allowed
  // 40% more concurrent risk than the bot they exist to predict.
  maxPositions: 5,
  maxFuturesPositions: 2,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 3,
  // 58, matching tradingWorker.ts DEFAULT_PRO_SIM_CONFIG. At 60 this browser
  // fallback gated two points tighter than the 24/7 engine running the same
  // bot, so the two runtimes disagreed about which signals Pro takes.
  minConfidenceOverride: 58,
  // Matches the server config (tradingWorker.ts DEFAULT_SIM_CONFIG) and the
  // real bot's BOT_POSITION_PERCENT. Absent, this browser fallback would size
  // entries at the engine default of 15% while the 24/7 engine running the
  // same bot sized them at 10%.
  positionPercent: 10,
};

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
      setConfigState(st.config as SimBotConfig);
    }
  }, []);

  // Poll server state with exponential backoff on 429s / network errors.
  const pollingOptions = useMemo(() => ({ baseInterval: 5000, maxInterval: 30000 }), []);
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
    minConfidence: activeSource.minConfidence ?? 60,
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

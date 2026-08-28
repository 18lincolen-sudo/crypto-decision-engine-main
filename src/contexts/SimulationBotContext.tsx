import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import {
  getSimState,
  startSim,
  stopSim,
  resetSim,
  setSimConfig,
  pushSimState,
  SimBotSnapshot,
  SimBotStateResponse
} from '../services/tradingApiClient';
import { useSimulationBot, SimBotConfig, SimPosition, SimTrade, SimPoint, PendingOrder } from '../hooks/useSimulationBot';
import type { SignalEvaluation } from '../services/intradayBridge';
import { useCryptoData } from '../hooks/useCryptoData';
import { useFearGreedIndex } from '../hooks/useFearGreedIndex';
import { useWorkerAuth } from './WorkerAuthContext';
import { useApiPolling } from '../hooks/useApiPolling';

// Matches server/simEngine.ts DEFAULT_SIM_CONFIG — this engine is server-driven
// (the poll effect below overwrites this with the server's real config on sync),
// so this is only the pre-sync placeholder shown for a moment on first load.
const DEFAULT_CONFIG: SimBotConfig = {
  riskLevel: 'medium',
  initialAmount: 10000,
  stopLoss: 4.2,
  takeProfit: 3,
  maxPositions: 7,
  maxFuturesPositions: 2,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 3,
  minConfidenceOverride: 52,
  positionPercent: 10
};

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
  start: () => void;
  pause: () => void;
  resetAll: () => void;
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
  const fearGreedIndex = useFearGreedIndex();
  const { baseUrl } = useWorkerAuth();

  const isRunning = status === 'running';

  // Fetch live market data for simulation
  const { cryptoData } = useCryptoData();

  // Run autonomous client-side simulation engine
  const localSim = useSimulationBot({
    config,
    isRunning,
    cryptoData: cryptoData || [],
    fearGreedIndex,
    persist: (state) => {
      pushSimState('browser-leader', state as unknown as SimBotSnapshot, baseUrl).catch(() => {});
    }
  });

  const applyServerState = useCallback((st: SimBotStateResponse) => {
    if (st.snapshot) {
      setServerSnapshot(st.snapshot);
    }
    if (typeof st.running === 'boolean') {
      setStatus(st.running ? 'running' : 'idle');
      try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, st.running ? '1' : '0'); } catch { /* ignore */ }
    }
    if (st.config) {
      setConfigState(st.config as SimBotConfig);
    }
  }, []);

  // Poll server state with exponential backoff on 429s / network errors.
  // The server is the actual execution authority — a reload or network blip
  // on the client never pauses real trading, it only affects what this device
  // can currently SEE. Backoff prevents hammering an already rate-limited
  // backend and lets the rate-limit window recover.
  const { data: simStateData, syncStatus, syncError, refresh: refreshSimState } = useApiPolling<SimBotStateResponse>(
    () => getSimState(baseUrl),
    { baseInterval: 5000, maxInterval: 30000 }
  );

  useEffect(() => {
    if (simStateData) {
      applyServerState(simStateData);
    }
  }, [simStateData, applyServerState]);

  const start = useCallback(() => {
    setStatus('running');
    startSim(baseUrl).catch(() => {});
  }, [baseUrl]);

  const pause = useCallback(() => {
    setStatus('idle');
    stopSim(baseUrl).catch(() => {});
  }, [baseUrl]);

  const resetAll = useCallback(() => {
    setStatus('idle');
    localSim.reset();
    setServerSnapshot(null);
    resetSim(baseUrl).catch(() => {});
  }, [localSim, baseUrl]);

  const setConfig = useCallback((c: SimBotConfig) => {
    setConfigState(c);
    setSimConfig(c, baseUrl).catch(() => {});
  }, [baseUrl]);

  // If server has an active snapshot with data, use server data; otherwise use local client simulation engine
  const useServer = serverSnapshot !== null && (
    (serverSnapshot.positions && (serverSnapshot.positions as unknown[]).length > 0) ||
    (serverSnapshot.trades && (serverSnapshot.trades as unknown[]).length > 0)
  );

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
    minConfidence: activeSource.minConfidence ?? 52,
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

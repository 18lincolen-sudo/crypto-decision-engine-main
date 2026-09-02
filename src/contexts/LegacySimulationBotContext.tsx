import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import {
  getLegacySimState,
  startLegacySim,
  stopLegacySim,
  resetLegacySim,
  setLegacySimConfig,
  LegacySimBotStateResponse
} from '../services/tradingApiClient';
import {
  useLegacySimulationBot,
  SimBotConfig,
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder
} from '../hooks/useLegacySimulationBot';
import type { SignalEvaluation } from '../services/intradayBridge';
import { useCryptoData } from '../hooks/useCryptoData';
import { useFearGreedIndex } from '../hooks/useFearGreedIndex';
import { useWorkerAuth } from './WorkerAuthContext';
import type { SimStatus } from './SimulationBotContext';
import { useApiPolling } from '../hooks/useApiPolling';

// Matches server/legacySimEngine.ts DEFAULT_LEGACY_SIM_CONFIG — this engine is
// server-driven (the poll effect below overwrites this with the server's real
// config on sync), so this is only the pre-sync placeholder shown briefly on
// first load.
const DEFAULT_LEGACY_CONFIG: SimBotConfig = {
  riskLevel: 'medium',
  initialAmount: 10000,
  stopLoss: 4.2,
  takeProfit: 3,
  maxPositions: 7,
  maxFuturesPositions: 2,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 3,
  minConfidenceOverride: 58
};

export interface LegacySimulationBotContextValue {
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

const LegacySimulationBotContext = createContext<LegacySimulationBotContextValue | null>(null);

// The server is the actual execution authority for this engine (same as the
// new engine) — a reload or network blip on the client never pauses the bot,
// it only affects what this device can currently SEE. Seed from the last
// known value so a reload-while-offline keeps showing the truth until the
// next successful poll corrects it (see applyServerState below).
const LAST_KNOWN_RUNNING_KEY = 'legacy-sim-bot-last-known-running';

export function LegacySimulationBotProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<SimBotConfig>(DEFAULT_LEGACY_CONFIG);
  const [status, setStatus] = useState<SimStatus>(() => {
    try {
      return localStorage.getItem(LAST_KNOWN_RUNNING_KEY) === '1' ? 'running' : 'idle';
    } catch {
      return 'idle';
    }
  });
  const [serverSnapshot, setServerSnapshot] = useState<LegacySimBotStateResponse['snapshot']>(null);
  const fearGreedIndex = useFearGreedIndex();
  const { baseUrl } = useWorkerAuth();

  const isRunning = status === 'running';

  const { cryptoData } = useCryptoData();

  // Local fallback engine — same role as SimulationBotContext's localSim.
  const localSim = useLegacySimulationBot({
    config,
    isRunning: isRunning && serverSnapshot === null,
    cryptoData: cryptoData || [],
    fearGreedIndex
  });

  const applyServerState = useCallback((st: LegacySimBotStateResponse) => {
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
  const { data: legacySimStateData, syncStatus, syncError } = useApiPolling<LegacySimBotStateResponse>(
    () => getLegacySimState(baseUrl),
    { baseInterval: 5000, maxInterval: 30000 }
  );

  useEffect(() => {
    if (legacySimStateData) {
      applyServerState(legacySimStateData);
    }
  }, [legacySimStateData, applyServerState]);

  // Immediately sync with server on mount so a reload shows the true
  // running state without waiting for the first polling interval.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const serverState = await getLegacySimState(baseUrl);
        if (!cancelled) applyServerState(serverState);
      } catch {
        // Keep local state if server unreachable
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, applyServerState]);

  const start = useCallback(() => {
    setStatus('running');
    try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, '1'); } catch { /* ignore */ }
    startLegacySim(baseUrl).catch(() => {});
  }, [baseUrl]);

  const pause = useCallback(() => {
    setStatus('idle');
    try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, '0'); } catch { /* ignore */ }
    stopLegacySim(baseUrl).catch(() => {});
  }, [baseUrl]);

  const resetAll = useCallback(() => {
    setStatus('idle');
    try { localStorage.setItem(LAST_KNOWN_RUNNING_KEY, '0'); } catch { /* ignore */ }
    localSim.reset();
    setServerSnapshot(null);
    resetLegacySim(baseUrl).catch(() => {});
  }, [localSim, baseUrl]);

  const setConfig = useCallback((c: SimBotConfig) => {
    setConfigState(c);
    setLegacySimConfig(c, baseUrl).catch(() => {});
  }, [baseUrl]);

  // The server is the execution authority. Use its data whenever the
  // server is reachable and synced, even if it hasn't produced trades yet.
  const useServer = serverSnapshot !== null && syncStatus === 'synced';

  const activeSource = useServer && serverSnapshot ? serverSnapshot : localSim;

  const value: LegacySimulationBotContextValue = {
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
    minConfidence: activeSource.minConfidence ?? 58,
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

  return <LegacySimulationBotContext.Provider value={value}>{children}</LegacySimulationBotContext.Provider>;
}

export function useLegacySimulationBotContext(): LegacySimulationBotContextValue {
  const ctx = useContext(LegacySimulationBotContext);
  if (!ctx) throw new Error('useLegacySimulationBotContext must be used within a LegacySimulationBotProvider');
  return ctx;
}

export function useLegacySimulationBotContextSafe(): LegacySimulationBotContextValue | null {
  return useContext(LegacySimulationBotContext);
}

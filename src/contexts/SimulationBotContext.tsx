import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import {
  getSimState,
  startSim,
  stopSim,
  resetSim,
  setSimConfig,
  SimBotSnapshot,
  SimBotStateResponse
} from '../services/tradingApiClient';
import { useSimulationBot, SimBotConfig } from '../hooks/useSimulationBot';
import { useCryptoData } from '../hooks/useCryptoData';
import { fearGreedApi } from '../services/fearGreedApi';

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
  minConfidenceOverride: 0
};

const POLL_INTERVAL_MS = 5000;

export type SimStatus = 'running' | 'paused' | 'idle';

export interface SimulationBotContextValue {
  cash: number;
  positions: any[];
  positionsValue: number;
  equity: number;
  trades: any[];
  history: any[];
  pending: any[];
  totalFees: number;
  totalSlippageCost: number;
  winRate: number;
  totalTrades: number;
  closedTrades: number;
  lastEvaluation: string;
  evaluations: any[];
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
}

const SimulationBotContext = createContext<SimulationBotContextValue | null>(null);

export function SimulationBotProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<SimBotConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<SimStatus>('idle');
  const [serverSnapshot, setServerSnapshot] = useState<SimBotSnapshot | null>(null);
  const [fearGreedIndex, setFearGreedIndex] = useState(50);

  const isRunning = status === 'running';

  // Fetch live market data for simulation
  const { cryptoData } = useCryptoData();

  useEffect(() => {
    fearGreedApi.getFearGreedIndex()
      .then(fg => {
        if (fg?.value) setFearGreedIndex(fg.value);
      })
      .catch(() => {});
  }, []);

  // Run autonomous client-side simulation engine
  const localSim = useSimulationBot({
    config,
    isRunning,
    cryptoData: cryptoData || [],
    persist: (state) => {
      pushSimState('browser-leader', state as any).catch(() => {});
    }
  });

  const applyServerState = useCallback((st: SimBotStateResponse) => {
    if (st.snapshot) {
      setServerSnapshot(st.snapshot);
    }
    if (typeof st.running === 'boolean') {
      setStatus(st.running ? 'running' : 'idle');
    }
    if (st.config) {
      setConfigState(st.config as SimBotConfig);
    }
  }, []);

  // Poll server state if a dedicated worker backend is present
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const st = await getSimState();
        if (cancelled) return;
        applyServerState(st);
      } catch {
        /* no backend server; client engine runs locally */
      }
    };
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [applyServerState]);

  const start = useCallback(() => {
    setStatus('running');
    startSim().catch(() => {});
  }, []);

  const pause = useCallback(() => {
    setStatus('idle');
    stopSim().catch(() => {});
  }, []);

  const resetAll = useCallback(() => {
    setStatus('idle');
    localSim.reset();
    setServerSnapshot(null);
    resetSim().catch(() => {});
  }, [localSim]);

  const setConfig = useCallback((c: SimBotConfig) => {
    setConfigState(c);
    setSimConfig(c).catch(() => {});
  }, []);

  // If server has an active snapshot with data, use server data; otherwise use local client simulation engine
  const useServer = serverSnapshot !== null && (
    (serverSnapshot.positions && (serverSnapshot.positions as any[]).length > 0) ||
    (serverSnapshot.trades && (serverSnapshot.trades as any[]).length > 0)
  );

  const activeSource: any = useServer ? serverSnapshot : localSim;

  const value: SimulationBotContextValue = {
    cash: activeSource.cash ?? 10000,
    positions: activeSource.positions ?? [],
    positionsValue: activeSource.positionsValue ?? 0,
    equity: activeSource.equity ?? 10000,
    trades: activeSource.trades ?? [],
    history: activeSource.history ?? [],
    pending: activeSource.pending ?? [],
    totalFees: activeSource.totalFees ?? 0,
    totalSlippageCost: activeSource.totalSlippageCost ?? 0,
    winRate: activeSource.winRate ?? 0,
    totalTrades: activeSource.totalTrades ?? 0,
    closedTrades: activeSource.closedTrades ?? 0,
    lastEvaluation: activeSource.lastEvaluation ?? '',
    evaluations: activeSource.evaluations ?? [],
    minConfidence: activeSource.minConfidence ?? 40,
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
    resetAll
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

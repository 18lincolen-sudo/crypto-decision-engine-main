import { createContext, useContext, useState, useCallback, useEffect, ReactNode, useRef } from 'react';
import {
  getSimState,
  startSim,
  stopSim,
  resetSim,
  setSimConfig,
  SimBotSnapshot,
  SimBotStateResponse
} from '../services/tradingApiClient';
import type { SimBotConfig } from '../hooks/useSimulationBot';

const DEFAULT_CONFIG: SimBotConfig = {
  riskLevel: 'medium',
  initialAmount: 10000,
  stopLoss: 4.2,
  takeProfit: 3,
  maxPositions: 5,
  maxFuturesPositions: 2,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 3,
  minConfidenceOverride: 0
};

const POLL_INTERVAL_MS = 2000; // viewers: read shared state

export type SimStatus = 'running' | 'paused' | 'idle';

export interface SimulationBotContextValue {
  // Live state from the bot engine (server-side, shared by every viewer)
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
  // Config + lifecycle control
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

  const isRunning = status === 'running';

  // Clear any legacy per-device localStorage so the server is the only source of truth.
  useEffect(() => {
    try {
      localStorage.removeItem('simulation-bot-state-v2');
      localStorage.removeItem('simulation-bot-state-v1');
    } catch {
      /* ignore */
    }
  }, []);

  const applyServerState = useCallback((st: SimBotStateResponse) => {
    setServerSnapshot(st.snapshot);
    setStatus(st.running ? 'running' : 'idle');
    if (st.config) setConfigState(st.config as SimBotConfig);
  }, []);

  // Poll the shared state so every device shows the SAME bot. The engine runs
  // server-side and advances 24/7; clients are pure viewers.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const st = await getSimState();
        if (cancelled) return;
        applyServerState(st);
      } catch {
        /* worker unreachable */
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
    startSim()
      .then(() => setStatus('running'))
      .catch(() => setStatus('running'));
  }, []);

  const pause = useCallback(() => {
    stopSim().catch(() => {});
    setStatus('idle');
  }, []);

  const resetAll = useCallback(() => {
    resetSim().catch(() => {});
    setStatus('idle');
    setServerSnapshot(null);
  }, []);

  const setConfig = useCallback((c: SimBotConfig) => {
    setConfigState(c);
    setSimConfig(c).catch(() => {});
  }, []);

  const source: any = serverSnapshot || {};
  const initialCash = config.initialAmount || 10000;
  const hasActivity = (source.positions && source.positions.length > 0) || (source.trades && source.trades.length > 0);
  const currentCash = typeof source.cash === 'number' && (source.cash > 0 || hasActivity) ? source.cash : initialCash;
  const currentEquity = typeof source.equity === 'number' && (source.equity > 0 || hasActivity) ? source.equity : currentCash;

  const value: SimulationBotContextValue = {
    cash: currentCash,
    positions: source.positions ?? [],
    positionsValue: source.positionsValue ?? 0,
    equity: currentEquity,
    trades: source.trades ?? [],
    history: source.history ?? [],
    pending: source.pending ?? [],
    totalFees: source.totalFees ?? 0,
    totalSlippageCost: source.totalSlippageCost ?? 0,
    winRate: source.winRate ?? 0,
    totalTrades: source.totalTrades ?? 0,
    closedTrades: source.closedTrades ?? 0,
    lastEvaluation: source.lastEvaluation ?? '',
    evaluations: source.evaluations ?? [],
    minConfidence: source.minConfidence ?? 40,
    hasSavedSession: source.hasSavedSession ?? hasActivity,
    nextTickAt: source.nextTickAt ?? 0,
    totalLeveragedExposureUsd: source.totalLeveragedExposureUsd ?? 0,
    dailyDrawdownPercent: source.dailyDrawdownPercent ?? 0,
    weeklyDrawdownPercent: source.weeklyDrawdownPercent ?? 0,
    candleCount: source.candleCount ?? 0,
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

// Non-throwing variant: returns null when no provider is mounted (defensive for
// components that may render outside the provider tree).
export function useSimulationBotContextSafe(): SimulationBotContextValue | null {
  return useContext(SimulationBotContext);
}

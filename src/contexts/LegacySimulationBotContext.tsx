import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { useLegacySimulationBot, SimBotConfig } from '../hooks/useLegacySimulationBot';
import { useCryptoData } from '../hooks/useCryptoData';
import { fearGreedApi } from '../services/fearGreedApi';
import type { SimStatus } from './SimulationBotContext';

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
  minConfidenceOverride: 0
};

export interface LegacySimulationBotContextValue {
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

const LegacySimulationBotContext = createContext<LegacySimulationBotContextValue | null>(null);

// Purely client-side — the original algorithm never had a server-worker path,
// so unlike SimulationBotContext there's nothing to poll; this engine only
// exists to run side by side with the main sim for comparison.
export function LegacySimulationBotProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SimBotConfig>(DEFAULT_LEGACY_CONFIG);
  const [status, setStatus] = useState<SimStatus>('idle');
  const [fearGreedIndex, setFearGreedIndex] = useState(50);

  const isRunning = status === 'running';
  const { cryptoData } = useCryptoData();

  useEffect(() => {
    fearGreedApi.getFearGreedIndex()
      .then((fg) => { if (fg?.value) setFearGreedIndex(fg.value); })
      .catch(() => {});
  }, []);

  const sim = useLegacySimulationBot({ config, isRunning, cryptoData: cryptoData || [], fearGreedIndex });

  const start = useCallback(() => setStatus('running'), []);
  const pause = useCallback(() => setStatus('idle'), []);
  const resetAll = useCallback(() => {
    setStatus('idle');
    sim.reset();
  }, [sim]);

  const value: LegacySimulationBotContextValue = {
    cash: sim.cash,
    positions: sim.positions,
    positionsValue: sim.positionsValue,
    equity: sim.equity,
    trades: sim.trades,
    history: sim.history,
    pending: sim.pending,
    totalFees: sim.totalFees,
    totalSlippageCost: sim.totalSlippageCost,
    winRate: sim.winRate,
    totalTrades: sim.totalTrades,
    closedTrades: sim.closedTrades,
    lastEvaluation: sim.lastEvaluation,
    evaluations: sim.evaluations,
    minConfidence: sim.minConfidence,
    hasSavedSession: sim.hasSavedSession,
    nextTickAt: sim.nextTickAt,
    totalLeveragedExposureUsd: sim.totalLeveragedExposureUsd,
    dailyDrawdownPercent: sim.dailyDrawdownPercent,
    weeklyDrawdownPercent: sim.weeklyDrawdownPercent,
    candleCount: sim.candleCount,
    config,
    setConfig,
    status,
    isRunning,
    start,
    pause,
    resetAll
  };

  return <LegacySimulationBotContext.Provider value={value}>{children}</LegacySimulationBotContext.Provider>;
}

export function useLegacySimulationBotContext(): LegacySimulationBotContextValue {
  const ctx = useContext(LegacySimulationBotContext);
  if (!ctx) throw new Error('useLegacySimulationBotContext must be used within a LegacySimulationBotProvider');
  return ctx;
}

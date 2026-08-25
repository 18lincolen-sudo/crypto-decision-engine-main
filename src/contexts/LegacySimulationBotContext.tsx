import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
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
}

const LegacySimulationBotContext = createContext<LegacySimulationBotContextValue | null>(null);

// Whether the user has told this engine to run — separate from the admin
// token (never persisted, by design, since it authorizes real trading). This
// flag carries no secret, so it CAN survive a full page reload: the user's
// stated requirement is that once Start is pressed, the bot keeps running
// until Pause/Stop, "in every case" — including a real reload (mobile Safari
// tab-suspend, manual refresh), not just in-app navigation between pages
// (which already worked, since this Provider lives above the router).
const LEGACY_RUNNING_KEY = 'legacy-sim-bot-running';

// Purely client-side — the original algorithm never had a server-worker path,
// so unlike SimulationBotContext there's nothing to poll; this engine only
// exists to run side by side with the main sim for comparison.
export function LegacySimulationBotProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SimBotConfig>(DEFAULT_LEGACY_CONFIG);
  const [status, setStatus] = useState<SimStatus>(() => {
    try {
      return localStorage.getItem(LEGACY_RUNNING_KEY) === '1' ? 'running' : 'idle';
    } catch {
      return 'idle';
    }
  });
  const fearGreedIndex = useFearGreedIndex();

  const isRunning = status === 'running';
  const { cryptoData } = useCryptoData();

  const sim = useLegacySimulationBot({ config, isRunning, cryptoData: cryptoData || [], fearGreedIndex });

  const start = useCallback(() => {
    setStatus('running');
    try { localStorage.setItem(LEGACY_RUNNING_KEY, '1'); } catch { /* ignore */ }
  }, []);
  const pause = useCallback(() => {
    setStatus('idle');
    try { localStorage.setItem(LEGACY_RUNNING_KEY, '0'); } catch { /* ignore */ }
  }, []);
  const resetAll = useCallback(() => {
    setStatus('idle');
    try { localStorage.setItem(LEGACY_RUNNING_KEY, '0'); } catch { /* ignore */ }
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

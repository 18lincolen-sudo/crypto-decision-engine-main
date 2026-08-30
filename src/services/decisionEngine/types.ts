/**
 * DecisionEngine — unified decision-making framework
 * ============================================================================
 * A single orchestrator that runs any of the three trading algorithms
 * (Intraday MTF, Legacy H1, Pro alg.md) through a common pipeline.
 *
 * Each engine's specific logic lives in its own adapter, which implements
 * the EngineAdapter interface. The orchestrator handles:
 *   - Adapter selection based on input capabilities
 *   - Pipeline execution with stage-level blocking
 *   - Unified result normalization
 *   - Cross-cutting concerns (logging, metrics, correlation)
 *
 * The three engines remain completely independent in their algorithms —
 * this framework only unifies the orchestration, not the logic.
 */

// ── Shared Types ──────────────────────────────────────────────────────────────

export type TradeDirection = 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE';
export type TradeType = 'SPOT' | 'FUTURES' | 'HOLD';
export type DecisionOutcome = 'SIGNAL' | 'NO_SIGNAL' | 'NO_DATA';
export type EngineId = 'intraday' | 'legacy' | 'pro';

/** Market data snapshot — what the engine needs to evaluate a symbol */
export interface MarketDataSnapshot {
  spreadPercent?: number;
  quoteVolume24h?: number;
  quoteVolume24hSpot?: number;
  livePrice?: number;
  fearGreedIndex?: number;
  priceChange24h?: number;
  marketCap?: number;
  volume24h?: number;
}

/** Portfolio risk statistics — shared across all engines */
export interface PortfolioRiskStats {
  portfolioValue: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  openPositionsCount: number;
  openFuturesPositionsCount: number;
  totalLeveragedExposureUsd: number;
  existingExposureByAsset?: Record<string, number>;
  systemLocked?: boolean;
  lockReason?: string;
  lockedAt?: number;
}

/** Open position — shared across all engines */
export interface OpenPosition {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
}

/** Multi-timeframe candles — each engine uses what it needs */
export interface MultiTimeframeCandles {
  h1: number[][]; // [timestamp, open, high, low, close, volume] arrays
  m15?: number[][];
  m5?: number[][];
}

/** Engine-specific parameters — each engine defines its own */
export interface EngineParams {
  [key: string]: unknown;
}

/** Unified decision context — input to any engine */
export interface DecisionContext {
  /** Trading symbol (e.g. 'BTCUSDT') */
  symbol: string;
  /** Candles for all timeframes — engine uses what it needs */
  candles: MultiTimeframeCandles;
  /** Current market price */
  currentPrice: number;
  /** Portfolio state */
  portfolio: PortfolioRiskStats;
  /** Currently open positions (for same-asset exclusion, correlation) */
  openPositions: OpenPosition[];
  /** Market data snapshot */
  marketData: MarketDataSnapshot;
  /** Engine-specific parameters */
  params: EngineParams;
  /** Timestamp (for backtest determinism) */
  now?: number;
  /** Closed trade history (for adaptive sizing) */
  closedTrades?: ClosedTradeRecord[];
  /** Configuration overrides */
  config?: {
    minConfidenceOverride?: number;
    maxPositions?: number;
    maxFuturesPositions?: number;
    executionDelaySec?: number;
  };
}

/** Closed trade record — for adaptive risk management */
export interface ClosedTradeRecord {
  pnl: number;
  at?: number;
  symbol?: string;
}

/** Unified decision result — output from any engine */
export interface DecisionResult {
  /** Which engine produced this result */
  engineId: EngineId;
  /** Symbol */
  symbol: string;
  /** Outcome */
  outcome: DecisionOutcome;
  /** First failing gate, or 'APPROVED' when trade is approved */
  gate: string;
  /** Trade type (SPOT, FUTURES, or HOLD) */
  tradeType: TradeType;
  /** Trade direction */
  direction: TradeDirection;
  /** Confidence score (0-100) */
  confidence: number;
  /** Risk plan (SL, TP, leverage, size) — null if no trade */
  riskPlan: RiskPlan | null;
  /** Human-readable reasoning */
  reasoning: string[];
  /** Structured metrics */
  metrics: Record<string, number>;
  /** Raw engine-specific output (for advanced consumers) */
  raw?: unknown;
}

/** Risk plan — unified across all engines */
export interface RiskPlan {
  approved: boolean;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  leverage: number;
  betSizeUsd: number;
  positionPercentOfPortfolio: number;
  riskRewardRatio: number;
  kellyFraction?: number;
  maxRiskAmountUsd?: number;
  stopDistanceUsd?: number;
  blockReason?: string;
}

/** Pipeline stage result */
export interface StageResult<C extends DecisionContext> {
  context: C;
  blocked: boolean;
  blockReason?: string;
  gate?: string;
}

/** Pipeline stage interface */
export interface PipelineStage<C extends DecisionContext> {
  /** Stage name for logging */
  name: string;
  /** Execute the stage */
  execute(context: C): StageResult<C> | Promise<StageResult<C>>;
}

/** Engine adapter interface */
export interface EngineAdapter<C extends DecisionContext> {
  /** Engine identifier */
  id: EngineId;
  /** Human-readable name */
  name: string;
  /** Can this engine handle the given input? */
  canHandle(input: Partial<DecisionContext>): boolean;
  /** Pipeline stages */
  stages: PipelineStage<C>[];
  /** Engine-specific parameters */
  params: EngineParams;
  /** Normalize engine-specific output to unified DecisionResult */
  normalize(output: unknown, context: C): DecisionResult;
}

// ── Re-export shared infrastructure types ─────────────────────────────────────

export type { ClosedTradeRecord } from './adaptiveRisk';
export { computeSizingMultiplier, adaptiveRiskPercentFromHistory, sizingMultiplierFromHistory, summarizeRecentPerformance, isInStreakCooldown, streakCooldownFromHistory, MIN_STOP_PERCENT, MAX_STOP_PERCENT, MIN_RISK_REWARD_RATIO } from './adaptiveRisk';
export type { CorrelatedHolding, CorrelationGateInput, CorrelationGateResult } from './correlation';
export { evaluateCorrelationGate, toPositionDirection, DEFAULT_CORRELATION_LOOKBACK, DEFAULT_CORRELATION_THRESHOLD, DEFAULT_MAX_CORRELATED } from './correlation';
export type { Candle, PortfolioRiskStats as SharedPortfolioRiskStats } from './tradeEngine';
export { calculateEMA, calculateATR, calculateADX, calculateSupertrend, formatDynamicPrice, computeRelativeVolume, MIN_ENTRY_RELATIVE_VOLUME } from './tradeEngine';

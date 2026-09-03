/**
 * @cde/engine/execution — the Legacy trade-math engine, order generation,
 * fills, and adaptive risk sizing.
 * ============================================================================
 */

// ── Legacy engine core (regime → signals → route → entry → risk → exit) ─────
export type { Candle, PortfolioRiskStats, TradeRouterOptions, EntryTimingResult, ClosedTradeMetric, ExitDecision } from './services/tradeEngine';
export {
  formatDynamicPrice,
  calculateEMA,
  calculateATR,
  calculateADX,
  calculateSupertrend,
  detectMarketRegime,
  evaluateSignals,
  dynamicConfidenceThreshold,
  routeTradeType,
  computeEntryIndicators,
  computeRelativeVolume,
  MIN_ENTRY_RELATIVE_VOLUME,
  calculateOptimalEntry,
  calculateRiskParameters,
  evaluateExit,
  BYBIT_FEES,
  calculateTradingFee,
  simulateSlippage,
  calculateBreakEvenPrice
} from './services/tradeEngine';

// ── Order generation per engine ──────────────────────────────────────────────
export type { LegacyOrderGenContext } from './services/legacySimExecution';
export {
  MIN_LEGACY_CANDLES,
  HIGH_CONFIDENCE_BYPASS as LEGACY_HIGH_CONFIDENCE_BYPASS,
  buildFallbackLegacyRisk,
  activeMarketRegimesFrom as activeLegacyMarketRegimesFrom,
  generateLegacyOrders
} from './services/legacySimExecution';

export type { ProOrderGenContext } from './services/proSimExecution';
export {
  MIN_PRO_CANDLES,
  HIGH_CONFIDENCE_BYPASS as PRO_HIGH_CONFIDENCE_BYPASS,
  buildFallbackProRisk,
  activeMarketRegimesFrom as activeProMarketRegimesFrom,
  generateProOrders
} from './services/proSimExecution';

// ── Simulation bot: positions, fills, config (shared by all three engines) ──
export type {
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig,
  OrderGenContext,
  FillableOrdersResult,
  FillEvent,
  FillResult
} from './services/simExecution';
export {
  SIM_INTRADAY_PARAMS_OVERRIDE,
  reanchorLevel,
  computeEntryBudget,
  ENTRY_COOLDOWN_MS,
  isInEntryCooldown,
  generateNewOrders,
  LIMIT_ORDER_TTL_MS,
  selectFillableOrders,
  fillDueOrders
} from './services/simExecution';

// ── Adaptive risk sizing (win/loss streaks, drawdown, Kelly-style sizing) ────
export type { ClosedTradeRecord, PerformanceWindow, AdaptiveRiskInput } from './services/adaptiveRisk';
export {
  EMPTY_PERFORMANCE_WINDOW,
  MIN_PERFORMANCE_SAMPLE,
  PERFORMANCE_WINDOW_SIZE,
  MIN_STOP_PERCENT,
  MAX_STOP_PERCENT,
  MIN_RISK_REWARD_RATIO,
  kellyPayoffRatio,
  KELLY_MIN_SAMPLE,
  KELLY_MULTIPLIER,
  summarizeRecentPerformance,
  computeStreakFactor,
  computeDrawdownFactor,
  computeWinRateFactor,
  computeAdaptiveRiskPercent,
  adaptiveRiskPercentFromHistory,
  computeSizingMultiplier,
  sizingMultiplierFromHistory,
  STREAK_COOLDOWN_LOSSES,
  STREAK_COOLDOWN_MS,
  STREAK_COOLDOWN_BIG_LOSS_THRESHOLD,
  computeSymbolStreakCooldownUntil,
  isInStreakCooldown,
  streakCooldownFromHistory,
  streakCooldownReason
} from './services/adaptiveRisk';

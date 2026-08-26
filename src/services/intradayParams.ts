/**
 * IntradayParams — Types & tunable parameters for the Intraday MTF engine
 * ============================================================================
 * Every threshold lives here so the backtest / walk-forward harness can sweep
 * them without touching decision logic (§20, §24, §47, §49).
 *
 *      1H  → MARKET REGIME
 *      15M → SETUP DETECTION
 *      5M  → ENTRY CONFIRMATION
 */

export type Regime1HType = 'BULL_TREND' | 'BEAR_TREND' | 'TRANSITIONAL' | 'RANGING';
export type SetupType = 'TREND_PULLBACK' | 'BREAKOUT_RETEST' | 'MEAN_REVERSION' | 'NONE';
export type Direction = 'LONG' | 'SHORT' | 'NONE';
export type EntryTrigger = 'PULLBACK_HOLD' | 'BREAKOUT_RETEST' | 'REVERSAL_RECOVERY' | 'NONE';

/** Ordered gates — the first failing gate is reported as the block reason (§55) */
export type DecisionGate =
  | 'NO_DATA'
  | 'CIRCUIT_BREAKER'
  | 'EXPOSURE'
  | 'NO_REGIME'
  | 'VOLATILITY'
  | 'LIQUIDITY'
  | 'SPREAD'
  | 'NO_SETUP'
  | 'NO_ENTRY'
  | 'COST'
  | 'RISK';

export interface IntradayParams {
  // ── Layer A — 1H regime ────────────────────────────────────────────────────
  adxTrendMin: number;
  adxRangeMax: number;
  atrPercentileLookback: number;
  atrPercentileLow: number;
  atrPercentileHigh: number;
  atrPercentileExtreme: number;

  // ── Layer B — 15M setup ───────────────────────────────────────────────────
  setupScoreMin: number;
  setupScoreStrong: number;
  /** Min confirmations (VWAP/Structure/Momentum/Volume/EMA) for a setup to pass (§20) */
  setupConfirmationsMin: number;
  /** Weights must sum to 1 (§20) */
  setupWeights: {
    trend: number;
    momentum: number;
    location: number;
    participation: number;
    structure: number;
  };
  /** Max distance from the 15M EMA20, in 15M ATR units, to still be a pullback */
  pullbackMaxAtrFromEma: number;
  /** Bollinger bandwidth percentile that qualifies as compression */
  compressionPercentileMax: number;
  /** Relative volume required to confirm a breakout candle */
  breakoutVolumeMin: number;
  /** VWAP deviation (in ATR) that qualifies as "significantly away from value" */
  meanReversionVwapAtr: number;
  meanReversionRsiMax: number;
  meanReversionRsiMin: number;

  // ── Layer C — 5M entry ────────────────────────────────────────────────────
  entryScoreMin: number;
  entryScoreStrong: number;
  /** Min entry confirmations (per setup type) for the 5M trigger to confirm (§24) */
  entryConfirmationsMin: number;
  /** Distance beyond the trigger level (in 5M ATR) that counts as chasing */
  maxChaseAtr: number;
  entryLimitOffsetAtr: number;
  /** Minimum relative volume on the 5M trigger candle */
  minEntryRelativeVolume: number;

  // ── Cost / Edge (§25) ─────────────────────────────────────────────────────
  costSafetyMultiplier: number;
  /** Spread may not exceed this share of the expected move */
  maxSpreadShareOfMove: number;
  /** Absolute spread ceiling in percent */
  maxSpreadPercent: number;
  /** Minimum 24h quote turnover (USDT) for the asset to be tradable */
  minQuoteVolume24h: number;
  /** Base slippage assumption in percent, before spread/volatility adjustment */
  baseSlippagePercent: number;
  minRewardRisk: number;

  // ── Risk (§30-§35) ────────────────────────────────────────────────────────
  riskPerTradePercent: number;
  maxRiskPerTradePercent: number;
  minStopAtrMult: number;
  maxStopAtrMult: number;
  minStopPercent: number;
  maxStopPercent: number;
  stopStructureBufferAtr: number;
  tp1RewardRisk: number;
  tp2RewardRisk: number;
  maxLeverage: number;
  /** Margin budget per futures trade, as a share of equity */
  maxMarginPerTradePercent: number;
  maxSpotNotionalPercent: number;
  maxLeveragedExposurePercent: number;
  maxOpenPositions: number;
  maxOpenFutures: number;
  minOrderUsd: number;
  /** Real-money default is false: FUTURES (and therefore SHORT) is normally
   *  blocked outright whenever ATR volatility is HIGH or EXTREME (§10/§34),
   *  which means the bot's only tool for profiting from a sharp down-move is
   *  switched off exactly when the down-move is sharpest. When true, a SHORT
   *  setup gets a carve-out to still trade FUTURES during HIGH volatility
   *  (not EXTREME — that stays blocked for both directions regardless of this
   *  flag). LONG stays blocked in HIGH volatility either way. Simulation-only
   *  for now (see buildEvaluations in simExecution.ts) while this is being
   *  evaluated against real results before enabling it on the live bot.
   */
  allowShortDuringHighVolatility: boolean;

  // ── Duration / time stops (§28/§29) ───────────────────────────────────────
  maxHoldMinutes: Record<Exclude<SetupType, 'NONE'>, number>;
  /** Share of max hold after which a stagnant trade is cut */
  timeStopFraction: number;
  /** Favourable progress (in R) required at the time-stop checkpoint */
  timeStopMinProgressR: number;

  // ── Trailing (§32) ────────────────────────────────────────────────────────
  /** MFE (in R) required before trailing may activate */
  trailingActivationR: number;
  trailingAtrMult: number;

  // ── Execution realism (§39/§40) ───────────────────────────────────────────
  limitOrderTtlMinutes: number;
  /** Probability a limit order fills when price only touches the level */
  touchFillProbability: number;
  partialFillRatio: number;

  // ── Circuit breakers (§38) ────────────────────────────────────────────────
  dailyDrawdownBlockPercent: number;
  weeklyDrawdownLockPercent: number;
  weeklyDrawdownFlattenPercent: number;
}

export const DEFAULT_INTRADAY_PARAMS: IntradayParams = {
  adxTrendMin: 25,
  adxRangeMax: 20,
  atrPercentileLookback: 200,
  atrPercentileLow: 30,
  atrPercentileHigh: 80,
  atrPercentileExtreme: 95,

  setupScoreMin: 46,
  setupScoreStrong: 64,
  setupConfirmationsMin: 2,
  setupWeights: { trend: 0.25, momentum: 0.2, location: 0.2, participation: 0.15, structure: 0.2 },
  pullbackMaxAtrFromEma: 2.0,
  compressionPercentileMax: 45,
  breakoutVolumeMin: 1.3,
  meanReversionVwapAtr: 1.0,
  meanReversionRsiMax: 35,
  meanReversionRsiMin: 65,

  entryScoreMin: 50,
  entryScoreStrong: 68,
  /** Min entry confirmations (per setup type) for the 5M trigger to confirm (§24) */
  entryConfirmationsMin: 1,
  maxChaseAtr: 1.2,
  entryLimitOffsetAtr: 0.15,
  minEntryRelativeVolume: 0.7,

  costSafetyMultiplier: 2.0,
  maxSpreadShareOfMove: 0.2,
  maxSpreadPercent: 0.12,
  // Gates a SINGLE Bybit venue's (spot or linear) own 24h turnover for the
  // symbol about to trade (intradayEngine.ts §26). This was 20_000_000 —
  // copied from symbolUniverse.ts's LIQUID_THRESHOLD, which sums turnover
  // ACROSS spot+linear+usdc+inverse to curate the universe. Checked against
  // one venue's volume alone, 20M blocked nearly every symbol (observed live:
  // real Bybit spot volumes of $0.9M-$7M on coins the universe already
  // curated as liquid, all rejected). Lowered to a per-venue execution-safety
  // floor — well above the universe's own MIN_SPOT_VOLUME_FOR_INCLUSION
  // (200k) sanity check, low enough that curated-liquid coins can actually
  // trade.
  minQuoteVolume24h: 1_000_000,
  baseSlippagePercent: 0.02,
  minRewardRisk: 1.2,

  riskPerTradePercent: 0.5,
  maxRiskPerTradePercent: 0.75,
  minStopAtrMult: 0.8,
  maxStopAtrMult: 2.5,
  minStopPercent: 0.12,
  maxStopPercent: 1.5,
  stopStructureBufferAtr: 0.15,
  tp1RewardRisk: 1.5,
  tp2RewardRisk: 2.5,
  maxLeverage: 5,
  maxMarginPerTradePercent: 4,
  maxSpotNotionalPercent: 15,
  // Matches the legacy engine's hard-coded 20% cap (tradeEngine.ts) and the
  // 20% the risk-meter UI actually displays — was 40 here, silently allowing
  // double the exposure the UI showed as the limit (observed live: 62%
  // exposure against a displayed "20% max", flagged as "limit exceeded").
  maxLeveragedExposurePercent: 20,
  maxOpenPositions: 5,
  maxOpenFutures: 2,
  minOrderUsd: 5,
  allowShortDuringHighVolatility: false,

  maxHoldMinutes: { TREND_PULLBACK: 90, BREAKOUT_RETEST: 60, MEAN_REVERSION: 45 },
  timeStopFraction: 0.45,
  timeStopMinProgressR: 0.3,

  trailingActivationR: 1.0,
  trailingAtrMult: 1.2,

  limitOrderTtlMinutes: 10,
  touchFillProbability: 0.5,
  partialFillRatio: 0.5,

  dailyDrawdownBlockPercent: 6,
  weeklyDrawdownLockPercent: 13,
  weeklyDrawdownFlattenPercent: 15
};

/** Risk-per-trade variants compared during backtest (§33) */
export const RISK_VARIANTS = [0.25, 0.5, 0.75] as const;

export function withParams(overrides: Partial<IntradayParams> = {}): IntradayParams {
  return {
    ...DEFAULT_INTRADAY_PARAMS,
    ...overrides,
    setupWeights: { ...DEFAULT_INTRADAY_PARAMS.setupWeights, ...(overrides.setupWeights || {}) },
    maxHoldMinutes: { ...DEFAULT_INTRADAY_PARAMS.maxHoldMinutes, ...(overrides.maxHoldMinutes || {}) }
  };
}

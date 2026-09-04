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

export type Regime1HType = 'BULL_TREND' | 'BEAR_TREND' | 'TRANSITIONAL' | 'RANGING' | 'SOFT_TREND';
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
  /** Minimum relative volume for MEAN_REVERSION entries (lower than trend/breakout
   *  since reversals can print on thinner tape, but still needs some participation) */
  minMeanReversionRelativeVolume: number;

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
    *  for now while this is being
   *  evaluated against real results before enabling it on the live bot.
   */
  allowShortDuringHighVolatility: boolean;
  // MEAN_REVERSION's stopReference is the swing low/high over just the last 6
  // 5M candles (30 min) — and MEAN_REVERSION only fires in a RANGING regime,
  // where ATR5 is naturally small too — so its computed stop distance is
  // structurally tighter than trend/breakout setups, making it prone to
  // whipsaw: a brief wick stops the trade out, and moments later the SAME
  // setup (still-valid oversold/extreme reading) fires again, sometimes at a
  // worse price than the original entry (MEAN_REVERSION also has no
  // chase-penalty protection against that — see intradayEntry.ts). Both knobs
  // below default to unset (no effect — same behavior as before) and are
  // simulation-only for now (see SIM_INTRADAY_PARAMS_OVERRIDE in
  // simExecution.ts), evaluated against real results before considering them
  // for the live bot.
  /** Overrides minStopAtrMult specifically for MEAN_REVERSION positions. */
  meanReversionMinStopAtrMult?: number;
  /** Overrides minStopPercent specifically for MEAN_REVERSION positions. */
  meanReversionMinStopPercent?: number;
  /** When true, a MEAN_REVERSION position's stop-loss only triggers once a
   *  CLOSED 5M candle is beyond the level (not a live-price touch) — filters
   *  out a wick that reverses within the same candle. Only implementable in
   *  the simulation engines: the real bot's SL is a native Bybit bracket
   *  order, touch-triggered by the exchange itself, with no "confirm on
   *  close" order type. */
  meanReversionCloseConfirmStop?: boolean;

  // ── Duration / time stops (§28/§29) ───────────────────────────────────────
  maxHoldMinutes: Record<Exclude<SetupType, 'NONE'>, number>;
  /** Share of max hold after which a stagnant trade is cut */
  timeStopFraction: number;
  /** Favourable progress (in R) required at the time-stop checkpoint */
  timeStopMinProgressR: number;
  /** Multiplier applied to a setup's max hold when the trade is ALREADY
   *  working at the max-hold checkpoint (>= maxHoldExtensionMinProgressR).
   *  1 = no extension. A fixed clock cut is the wrong tool for a position
   *  that is demonstrably progressing — but the extension is re-tested on
   *  every subsequent evaluation, so a trade that stalls after earning it
   *  is cut at the next check rather than riding the longer budget out. */
  maxHoldExtensionFactor: Record<Exclude<SetupType, 'NONE'>, number>;
  /** Favourable progress (in R) required to earn the max-hold extension. */
  maxHoldExtensionMinProgressR: number;

  // ── Trailing (§32) ────────────────────────────────────────────────────────
  /** MFE (in R) required before trailing may activate — per-setup override */
  trailingActivationRBySetup: Record<Exclude<SetupType, 'NONE'>, number>;
  /** Fallback when setupType is unknown or not in the record */
  trailingActivationR: number;
  trailingAtrMult: number;

  // ── Execution realism (§39/§40) ───────────────────────────────────────────
  limitOrderTtlMinutes: number;
  /** Probability a limit order fills when price only touches the level */
  touchFillProbability: number;
  partialFillRatio: number;

  // ── Circuit breakers (§38) ────────────────────────────────────────────────
  /** Caps the liquidity slippage term at this many percentage points, so a
   *  near-zero relativeVolume reading cannot blow up the cost model.
   *  SUGGESTED STARTING VALUE, not a measured one — validate via
   *  scripts/abBacktest.ts before relying on it live, the same standard every
   *  other tuned constant in this repo is held to. */
  liquidityTermCap: number;
  /** Scales how much a volume shortfall (1/relativeVolume - 1) turns into extra
   *  slippage. SUGGESTED STARTING VALUE — same validation requirement as
   *  liquidityTermCap. */
  liquidityTermWeight: number;
  dailyDrawdownBlockPercent: number;
  weeklyDrawdownLockPercent: number;
  weeklyDrawdownFlattenPercent: number;
}

/** Portfolio circuit-breaker thresholds, in percent of equity.
 *
 *  Single definition on purpose: these two numbers were written out by hand in
 *  the Legacy adapter, the Pro adapter, tradeEngine's exit check and the
 *  intraday defaults. Four copies that happened to agree is not the same thing
 *  as one threshold — the next edit only has to miss one of them.
 */
export const DAILY_DRAWDOWN_BLOCK_PERCENT = 8;
export const WEEKLY_DRAWDOWN_LOCK_PERCENT = 15;

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
  compressionPercentileMax: 40,
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
  minMeanReversionRelativeVolume: 0.5,

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
  maxOpenPositions: 7,
  maxOpenFutures: 2,
  minOrderUsd: 5,
  allowShortDuringHighVolatility: true,

  maxHoldMinutes: { TREND_PULLBACK: 120, BREAKOUT_RETEST: 60, MEAN_REVERSION: 45 },
  timeStopFraction: 0.45,
  timeStopMinProgressR: 0.3,
  // MEAN_REVERSION is deliberately excluded (1 = no extension): its edge is
  // the snap back to the mean and it decays with time held — extending it is
  // not patience, it is holding a thesis after its window closed.
  maxHoldExtensionFactor: { TREND_PULLBACK: 1.5, BREAKOUT_RETEST: 1.5, MEAN_REVERSION: 1 },
  maxHoldExtensionMinProgressR: 0.5,

  trailingActivationRBySetup: { TREND_PULLBACK: 0.8, BREAKOUT_RETEST: 1.0, MEAN_REVERSION: 1.5 },
  trailingActivationR: 1.0,
  trailingAtrMult: 1.2,

  limitOrderTtlMinutes: 10,
  touchFillProbability: 0.5,
  partialFillRatio: 0.5,

  liquidityTermCap: 0.05,
  liquidityTermWeight: 0.4,
  dailyDrawdownBlockPercent: DAILY_DRAWDOWN_BLOCK_PERCENT,
  weeklyDrawdownLockPercent: WEEKLY_DRAWDOWN_LOCK_PERCENT,
  weeklyDrawdownFlattenPercent: WEEKLY_DRAWDOWN_LOCK_PERCENT
};

/** Risk-per-trade variants compared during backtest (§33) */
export const RISK_VARIANTS = [0.25, 0.5, 0.75] as const;

export function withParams(overrides: Partial<IntradayParams> = {}): IntradayParams {
  return {
    ...DEFAULT_INTRADAY_PARAMS,
    ...overrides,
    setupWeights: { ...DEFAULT_INTRADAY_PARAMS.setupWeights, ...(overrides.setupWeights || {}) },
    maxHoldMinutes: { ...DEFAULT_INTRADAY_PARAMS.maxHoldMinutes, ...(overrides.maxHoldMinutes || {}) },
    maxHoldExtensionFactor: { ...DEFAULT_INTRADAY_PARAMS.maxHoldExtensionFactor, ...(overrides.maxHoldExtensionFactor || {}) },
    trailingActivationRBySetup: { ...DEFAULT_INTRADAY_PARAMS.trailingActivationRBySetup, ...(overrides.trailingActivationRBySetup || {}) }
  };
}

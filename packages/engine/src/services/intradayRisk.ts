/**
 * Cost / Edge filter + Risk-first position sizing (§25/§26/§27/§30-§35)
 * ============================================================================
 * A short trade is only worth taking when the expected move is large enough to
 * pay for fees + slippage + spread AND still leave a positive expectancy.
 */

import { BYBIT_FEES } from './tradeEngine';
import { clamp } from './intradayIndicators';
import { DEFAULT_INTRADAY_PARAMS, Direction, IntradayParams, SetupType, PER_ASSET_EXPOSURE_CAP_PERCENT } from './intradayParams';

export interface CostAnalysis {
  // ── The exact levels this analysis was computed on ────────────────────────
  // Echoed back verbatim so a caller can assert they are identical to the risk
  // plan's levels (the single source of truth). If these ever differ from what
  // the order will use, every number below describes a trade that will not
  // happen — the "shadow levels" bug.
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;

  entryFeePercent: number;
  exitFeePercent: number;
  spreadPercent: number;
  slippagePercent: number;
  totalCostPercent: number;
  /** rewardPercent = |takeProfit1 - entryPrice| / entryPrice * 100.
   *  Kept under the old name `expectedMovePercent` too (identical value) for
   *  the §25 cost gate that reads it. */
  rewardPercent: number;
  /** Alias of rewardPercent — the §25 gate and existing telemetry read this. */
  expectedMovePercent: number;
  /** riskPercent = |entryPrice - stopLoss| / entryPrice * 100. */
  riskPercent: number;
  /** rewardPercent / totalCostPercent */
  edgeRatio: number;
  /** (rewardPercent - totalCostPercent) / riskPercent */
  netRewardRisk: number;
  /** rewardPercent / riskPercent */
  grossRewardRisk: number;
  approved: boolean;
  reason: string;
  blockGate: 'COST' | 'SPREAD' | null;
}

export interface CostInput {
  tradeType: 'SPOT' | 'FUTURES';
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  spreadPercent: number;
  atrPercentile: number;
  entryIsLimit?: boolean;
  /** Relative volume (current / rolling average) for the same candle series and
   *  timeframe already used for entry-volume gating. Optional and backward
   *  compatible: omitting it reproduces today's slippage exactly (liquidity
   *  term = 0). */
  relativeVolume?: number;
  params?: IntradayParams;
}

export function evaluateCostEdge(input: CostInput): CostAnalysis {
  const params = input.params ?? DEFAULT_INTRADAY_PARAMS;
  // Echoed verbatim on every return path so the caller can assert these are the
  // SAME entry / SL / TP1 the risk plan and the order use (single source of
  // truth). Nothing here derives its own levels.
  const levels = { entryPrice: input.entryPrice, stopLoss: input.stopLoss, takeProfit1: input.takeProfit1 };
  const fees = input.tradeType === 'SPOT' ? BYBIT_FEES.spot : BYBIT_FEES.futures;
  const entryFeePercent = (input.entryIsLimit === false ? fees.taker : fees.maker) * 100;
  const exitFeePercent = fees.taker * 100; // SL/TP exits cross the book
  const spreadPercent = Math.max(0, input.spreadPercent);

  // Liquidity-aware slippage: below-average volume means a thinner book, so a
  // market order (the exit leg, always taker) moves price more per unit size
  // than the spread alone implies. Derived from the SAME relative-volume signal
  // already computed for entry gating — not an assumed hour-of-day calendar —
  // so a thin altcoin's dead hours and a major's dead hours are both caught by
  // one mechanism, and no new assumption is introduced. Zero when relativeVolume
  // is omitted or at/above average, so existing callers see no change until they
  // opt in by passing it.
  const liquidityTerm = (input.relativeVolume !== undefined && input.relativeVolume > 0)
    ? clamp((1 / input.relativeVolume) - 1, 0, params.liquidityTermCap) * params.liquidityTermWeight
    : 0;

  // Volatility-aware slippage: entry is a resting limit (low slip), exit is market.
  const volatilityTerm = (clamp(input.atrPercentile, 0, 100) / 100) * 0.03;
  const entrySlippage = input.entryIsLimit === false
    ? spreadPercent / 2 + params.baseSlippagePercent + liquidityTerm
    : 0.005; // resting limit fill/no-fill is not modelled here
  const exitSlippage = params.baseSlippagePercent + spreadPercent / 2 + volatilityTerm + liquidityTerm;
  const slippagePercent = Number((entrySlippage + exitSlippage).toFixed(5));

  const totalCostPercent = Number((entryFeePercent + exitFeePercent + slippagePercent).toFixed(5));
  const expectedMovePercent = input.entryPrice > 0 ? (Math.abs(input.takeProfit1 - input.entryPrice) / input.entryPrice) * 100 : 0;
  const riskPercent = input.entryPrice > 0 ? (Math.abs(input.entryPrice - input.stopLoss) / input.entryPrice) * 100 : 0;

  const edgeRatio = totalCostPercent > 0 ? expectedMovePercent / totalCostPercent : 0;
  const grossRewardRisk = riskPercent > 0 ? expectedMovePercent / riskPercent : 0;
  const netRewardRisk = riskPercent > 0 ? (expectedMovePercent - totalCostPercent) / riskPercent : 0;

  if (spreadPercent > params.maxSpreadPercent) {
    return {
      ...levels,
      entryFeePercent,
      exitFeePercent,
      spreadPercent,
      slippagePercent,
      totalCostPercent,
      rewardPercent: Number(expectedMovePercent.toFixed(4)),
      expectedMovePercent: Number(expectedMovePercent.toFixed(4)),
      riskPercent: Number(riskPercent.toFixed(4)),
      edgeRatio: Number(edgeRatio.toFixed(2)),
      netRewardRisk: Number(netRewardRisk.toFixed(2)),
      grossRewardRisk: Number(grossRewardRisk.toFixed(2)),
      approved: false,
      reason: `Spread ${spreadPercent.toFixed(3)}% מעל התקרה (${params.maxSpreadPercent}%) — נזילות לא מספקת (§26)`,
      blockGate: 'SPREAD'
    };
  }

  if (spreadPercent > expectedMovePercent * params.maxSpreadShareOfMove) {
    return {
      ...levels,
      entryFeePercent,
      exitFeePercent,
      spreadPercent,
      slippagePercent,
      totalCostPercent,
      rewardPercent: Number(expectedMovePercent.toFixed(4)),
      expectedMovePercent: Number(expectedMovePercent.toFixed(4)),
      riskPercent: Number(riskPercent.toFixed(4)),
      edgeRatio: Number(edgeRatio.toFixed(2)),
      netRewardRisk: Number(netRewardRisk.toFixed(2)),
      grossRewardRisk: Number(grossRewardRisk.toFixed(2)),
      approved: false,
      reason: `Spread ${spreadPercent.toFixed(3)}% גדול מ-${(params.maxSpreadShareOfMove * 100).toFixed(0)}% מהמהלך הצפוי (${expectedMovePercent.toFixed(3)}%) — NO TRADE`,
      blockGate: 'SPREAD'
    };
  }

  const costApproved = expectedMovePercent > totalCostPercent * params.costSafetyMultiplier;
  const rrApproved = netRewardRisk >= params.minRewardRisk;
  const approved = costApproved && rrApproved;

  const reason = approved
    ? `מהלך צפוי ${expectedMovePercent.toFixed(3)}% > עלות ${totalCostPercent.toFixed(3)}% × ${params.costSafetyMultiplier} | R:R נטו ${netRewardRisk.toFixed(2)}`
    : !costApproved
    ? `מהלך צפוי ${expectedMovePercent.toFixed(3)}% אינו מכסה עלות ${totalCostPercent.toFixed(3)}% × ${params.costSafetyMultiplier} — NO TRADE (§25)`
    : `R:R נטו ${netRewardRisk.toFixed(2)} מתחת ל-${params.minRewardRisk} אחרי עלויות — NO TRADE`;

  return {
    ...levels,
    entryFeePercent,
    exitFeePercent,
    spreadPercent,
    slippagePercent,
    totalCostPercent,
    rewardPercent: Number(expectedMovePercent.toFixed(4)),
    expectedMovePercent: Number(expectedMovePercent.toFixed(4)),
    riskPercent: Number(riskPercent.toFixed(4)),
    edgeRatio: Number(edgeRatio.toFixed(2)),
    netRewardRisk: Number(netRewardRisk.toFixed(2)),
    grossRewardRisk: Number(grossRewardRisk.toFixed(2)),
    approved,
    reason,
    blockGate: approved ? null : 'COST'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RISK PLAN — FIXED-percentage SL/TP + risk-first sizing + min leverage
// ═══════════════════════════════════════════════════════════════════════════
//
// The executed stop and target are a FIXED percentage of entry
// (FIXED_SL_PERCENT / FIXED_TP_PERCENT), NOT a structural level. This is the
// single source of truth for entry / stopLoss / takeProfit1; the cost analysis
// and the order generator both read these exact numbers back.
//
// `stopReference` / `targetReference` on RiskPlanInput are TELEMETRY ONLY (see
// their field docs). If the strategy is ever changed back to structural stops,
// that is a deliberate strategy change — do it in one place, here, and the
// direction-sanity check below is what will catch a stop on the wrong side.

/** Executed stop distance, as a percentage of entry price. Fixed by strategy. */
export const FIXED_SL_PERCENT = 1.8;
/** Executed take-profit distance (TP1), as a percentage of entry price. */
export const FIXED_TP_PERCENT = 3.0;

export interface RiskPlanInput {
  symbol?: string;
  direction: Exclude<Direction, 'NONE'>;
  tradeType: 'SPOT' | 'FUTURES';
  setupType: Exclude<SetupType, 'NONE'>;
  entryPrice: number;
  /** TELEMETRY ONLY — NOT used to compute the executed stop, and optional for
   *  that reason. The executed SL is a fixed FIXED_SL_PERCENT of entry (see
   *  buildRiskPlan). This structural swing low/high is carried through to the
   *  decision log for diagnosis and is read by the setup/entry quality scorers
   *  upstream; buildRiskPlan itself ignores it for level computation. */
  stopReference?: number;
  /** TELEMETRY ONLY — NOT used to compute the executed target. The executed TP1
   *  is a fixed FIXED_TP_PERCENT of entry (see buildRiskPlan). */
  targetReference?: number | null;
  atr5: number;
  atr15: number;
  equity: number;
  openPositions: number;
  openFutures: number;
  currentLeveragedExposureUsd: number;
  /** Current notional exposure per asset for per-asset cap */
  existingExposureByAsset?: Record<string, number>;
  riskPercent?: number;
  params?: IntradayParams;
  /** Signal confidence (0-100). Telemetry only — nothing in buildRiskPlan reads
   *  it. It used to waive the exposure caps, the per-asset cap, the exchange
   *  minimum and the stop-direction invariant at >= 72; every one of those is now
   *  unconditional. The threshold was never calibrated: no measurement in this
   *  repo shows that a 72+ score corresponds to a higher win rate than a 60,
   *  which is the standard every other tuned constant here is held to (see
   *  KELLY_MIN_SAMPLE / SL_ATR_MULTIPLIER in adaptiveRisk.ts). Establishing that
   *  would take the same method pathStudy.ts already uses: bucket closed trades
   *  by score and compare Wilson lower-bound win rates per bucket. */
  confidence?: number;
  /** Adaptive sizing multiplier (clamped to [0,1]) injected by the
   *  DecisionEngine orchestrator from recent closed-trade performance — it
   *  only ever de-risks. The live scan() path passes none → 1 (base sizing). */
  sizingMultiplier?: number;
}

export interface RiskPlan {
  approved: boolean;
  blockReason?: string;
  /** The entry price these levels were computed from — echoed so the cost
   *  analysis and the order can be asserted identical to it (single source of
   *  truth for levels). */
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  stopDistance: number;
  stopDistancePercent: number;
  /** |entryPrice - stopLoss| / entryPrice * 100 — the ONE risk % for this trade. */
  riskPercent: number;
  /** |takeProfit1 - entryPrice| / entryPrice * 100 — the ONE reward % for this trade. */
  rewardPercent: number;
  /** rewardPercent / riskPercent — gross R:R on the executed levels. */
  grossRewardRisk: number;
  riskUsd: number;
  quantity: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  rewardRisk1: number;
  rewardRisk2: number;
  maxHoldMs: number;
  timeStopMs: number;
  positionPercentOfEquity: number;
  riskPercentUsed: number;
  /** The sizing multiplier actually applied to this plan (1 = base sizing). */
   sizingMultiplier: number;
   /** Which exposure cap was the binding constraint on this plan's notional (§23).
    *  Empty string or absent means no cap was hit — the full target was used. */
   bindingConstraint?: 'per_asset' | 'total' | 'cash' | 'min_order';
}

/**
 * The ONE place that decides whether entry / SL / TP1 sit on the correct sides
 * for a direction (§3 step 3). Returns a Hebrew reason string on failure, or
 * null when the levels are valid. Also rejects a zero / negative stop distance
 * and a target equal to entry.
 *
 * Called by buildRiskPlan (and available to callers / tests). Under the fixed
 * SL/TP model it should never fail from within buildRiskPlan; it is the guard
 * that catches a wrong-side level if the model is ever changed or a caller
 * hand-builds a plan.
 */
export function validateLevelDirection(
  direction: Exclude<Direction, 'NONE'>,
  entryPrice: number,
  stopLoss: number,
  takeProfit1: number
): string | null {
  if (!(entryPrice > 0)) return 'מחיר כניסה לא תקין';
  if (!(Math.abs(entryPrice - stopLoss) > 0)) return 'מרחק סטופ אפס/שלילי';
  if (direction === 'LONG') {
    if (stopLoss >= entryPrice) return 'SL חייב להיות מתחת למחיר הכניסה ב-LONG';
    if (takeProfit1 <= entryPrice) return 'TP1 חייב להיות מעל מחיר הכניסה ב-LONG';
  } else {
    if (stopLoss <= entryPrice) return 'SL חייב להיות מעל מחיר הכניסה ב-SHORT';
    if (takeProfit1 >= entryPrice) return 'TP1 חייב להיות מתחת למחיר הכניסה ב-SHORT';
  }
  return null;
}

const rejected = (reason: string): RiskPlan => ({
  approved: false,
  blockReason: reason,
  entryPrice: 0,
  stopLoss: 0,
  takeProfit1: 0,
  takeProfit2: 0,
  stopDistance: 0,
  stopDistancePercent: 0,
  riskPercent: 0,
  rewardPercent: 0,
  grossRewardRisk: 0,
  riskUsd: 0,
  quantity: 0,
  notionalUsd: 0,
  marginUsd: 0,
  leverage: 1,
  rewardRisk1: 0,
  rewardRisk2: 0,
  maxHoldMs: 0,
  timeStopMs: 0,
  positionPercentOfEquity: 0,
  riskPercentUsed: 0,
  sizingMultiplier: 1,
  bindingConstraint: undefined
});

export function buildRiskPlan(input: RiskPlanInput): RiskPlan {
   const params = input.params ?? DEFAULT_INTRADAY_PARAMS;
   const entry = input.entryPrice;

  if (!(entry > 0) || !(input.equity > 0)) return rejected('נתוני מחיר/הון לא תקינים');
  if (input.openPositions >= params.maxOpenPositions) return rejected(`מקסימום ${params.maxOpenPositions} פוזיציות פתוחות`);
  if (input.tradeType === 'FUTURES' && input.openFutures >= params.maxOpenFutures) {
    return rejected(`מקסימום ${params.maxOpenFutures} פוזיציות Futures`);
  }

  // Fixed SL/TP: FIXED_SL_PERCENT stop, FIXED_TP_PERCENT target — one definition
  // (module scope). Prevents the bot from exiting before meaningful profit or
  // before a reasonable loss threshold. The legacy riskPerTradePercent input is
  // accepted for API stability but is NOT used for sizing (§21/N2/N4): sizing
  // always targets positionTargetPct, and the stop is always FIXED_SL_PERCENT.
  const slDistance = entry * FIXED_SL_PERCENT / 100;
  const tpDistance = entry * FIXED_TP_PERCENT / 100;

  let stopLoss: number;
  let takeProfit1: number;
  let takeProfit2: number;
  const stopDistance = slDistance;
  const isLong = input.direction === 'LONG';

  if (input.tradeType === 'SPOT') {
    stopLoss = Math.max(0.00000001, entry - slDistance);
    takeProfit1 = entry + tpDistance;
    takeProfit2 = entry + tpDistance * 1.5;
  } else if (isLong) {
    stopLoss = Math.max(0.00000001, entry - slDistance);
    takeProfit1 = entry + tpDistance;
    takeProfit2 = entry + tpDistance * 1.5;
  } else {
    stopLoss = entry + slDistance;
    takeProfit1 = Math.max(0.00000001, entry - tpDistance);
    takeProfit2 = Math.max(0.00000001, entry - tpDistance * 1.5);
  }

  // Direction check (§3 step 3) — ONE authoritative validator for SL AND TP1
  // side, zero stop distance, and target==entry. Under the fixed-percentage
  // model this cannot legitimately fire (SL/TP are entry ± a positive fixed %,
  // sign-correct); it is the invariant that catches a wrong-side level if the
  // model is ever changed back to structural stops, or a caller hand-builds one.
  const dirError = validateLevelDirection(input.direction, entry, stopLoss, takeProfit1);
  if (dirError) return rejected(dirError);

  const rewardRisk1 = Math.abs(takeProfit1 - entry) / stopDistance;
  const rewardRisk2 = Math.abs(takeProfit2 - entry) / stopDistance;

  // ── Size: target notional first (§NEW) ─────────────────────────────────────
  // Position sizing is now 10% of equity, independent of stop-loss distance.
  // SL is used only to measure the resulting dollar risk.
   const targetNotional = input.equity * params.positionTargetPct;
   let notionalUsd = targetNotional;
   let quantity = notionalUsd / entry;
   let leverage = 1;
   let bindingConstraint: 'per_asset' | 'total' | 'cash' | 'min_order' | undefined;

  if (input.tradeType === 'SPOT') {
    // SPOT exposure: same 10% per-asset cap as FUTURES (unified model).
    // `maxSpotNotionalPercent` is the cap expressed in percent-of-equity terms;
    // the actual per-asset check (against existingExposureByAsset) mirrors the
    // FUTURES branch below.
    const notionalCap = (input.equity * params.maxSpotNotionalPercent) / 100;
    if (input.symbol && input.existingExposureByAsset) {
      const maxPerAssetExposure = input.equity * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
      const currentAssetExposure = input.existingExposureByAsset[input.symbol] ?? 0;
      const perAssetCap = maxPerAssetExposure - currentAssetExposure;
      if (perAssetCap <= 0) {
        return rejected(
          `אקספוזר על נכס זה כבר חורג ממגבלת נכס בודד (${maxPerAssetExposure.toFixed(0)}$ = ${PER_ASSET_EXPOSURE_CAP_PERCENT}% מהתיק)`
        );
      }
      if (notionalUsd > perAssetCap) {
        notionalUsd = perAssetCap;
        quantity = notionalUsd / entry;
        bindingConstraint = 'per_asset';
      }
     }
     if (notionalUsd > notionalCap) {
       notionalUsd = notionalCap;
       quantity = notionalUsd / entry;
       bindingConstraint = 'cash';
     }

    // Total SPOT exposure cap (§N7) — mirrors FUTURES's maxLeveragedExposurePercent
    // check. The per-asset cap prevents concentration; this prevents the aggregate
    // from exceeding the portfolio ceiling even if maxOpenPositions is raised.
    const totalSpotExposure = input.existingExposureByAsset
      ? Object.values(input.existingExposureByAsset).reduce((sum, v) => sum + v, 0)
      : 0;
    const totalCap = (input.equity * params.maxLeveragedExposurePercent) / 100;
    if (totalSpotExposure + notionalUsd > totalCap) {
      return rejected(
        `סה״כ חשיפת SPOT ${Math.round(totalSpotExposure + notionalUsd)}$ מעל התקרה ${Math.round(totalCap)}$ (${params.maxLeveragedExposurePercent}% מהתיק)`
      );
    }
  } else {
    // FUTURES exposure: three independent caps, all mandatory.
    // 1. Margin budget: maxMarginPerTradePercent (4%) × maxLeverage (5x) = 20% notional
    //    cap. This is the "entry gate" cap — not per-asset, not total.
    // 2. Per-asset concentration: PER_ASSET_EXPOSURE_CAP_PERCENT (10%) — same number
    //    the Strategy spec applies to every engine. This is the per-asset cap
    //    for FUTURES, distinct from SPOT's `maxSpotNotionalPercent`.
    // 3. Total leveraged exposure: maxLeveragedExposurePercent (20%).
    const marginBudget = (input.equity * params.maxMarginPerTradePercent) / 100;
    const notionalCap = marginBudget * params.maxLeverage;
    if (notionalUsd > notionalCap) {
       notionalUsd = notionalCap;
       quantity = notionalUsd / entry;
       bindingConstraint = 'cash';
     }

    // ── Per-asset exposure cap (§35b) ──────────────────────────────────────────
    // Unconditional. A concentration cap exists precisely for the trade that
    // looks strong enough to justify doubling down on one asset, so exempting
    // high scores removed it exactly when it was doing work. Note the exemption
    // also skipped the CLAMP branch below, not just the rejection: a
    // high-confidence signal did not merely bypass the limit, it never had its
    // size trimmed to fit under it either.
    if (input.symbol && input.existingExposureByAsset) {
      const maxPerAssetExposure = input.equity * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
      const currentAssetExposure = input.existingExposureByAsset[input.symbol] ?? 0;
      const perAssetCap = maxPerAssetExposure - currentAssetExposure;
      if (perAssetCap <= 0) {
        return rejected(
          `אקספוזר על נכס זה כבר חורג ממגבלת נכס בודד (${maxPerAssetExposure.toFixed(0)}$ = ${PER_ASSET_EXPOSURE_CAP_PERCENT}% מהתיק)`
        );
      }
      if (notionalUsd > perAssetCap) {
        notionalUsd = perAssetCap;
        quantity = notionalUsd / entry;
        bindingConstraint = 'per_asset';
      }
    }

    // Minimum leverage that supports the required exposure (§35) — never "max".
    leverage = clamp(Math.ceil(notionalUsd / marginBudget), 1, params.maxLeverage);

    const exposureCap = (input.equity * params.maxLeveragedExposurePercent) / 100;
    // Unconditional — see the per-asset cap above.
    if (input.currentLeveragedExposureUsd + notionalUsd > exposureCap) {
      return rejected(
        `חשיפה ממונפת ${(input.currentLeveragedExposureUsd + notionalUsd).toFixed(0)}$ מעל התקרה ${exposureCap.toFixed(0)}$ (${params.maxLeveragedExposurePercent}% מהתיק)`
      );
    }
  }

  const marginUsd = input.tradeType === 'FUTURES' ? notionalUsd / leverage : notionalUsd;
  if (marginUsd < params.minOrderUsd) {
    return rejected(`גודל פוזיציה ${marginUsd.toFixed(2)}$ מתחת למינימום ${params.minOrderUsd}$ — MIN_ORDER_EXCEEDS_POSITION_TARGET`);
  }
  if (bindingConstraint === undefined && notionalUsd < targetNotional) {
    bindingConstraint = 'min_order';
  }

  const maxHoldMs = params.maxHoldMinutes[input.setupType] * 60_000;

  // ── Diagnostic assertions (§24) — BEFORE return, fail-loud if violated ─────
  // Position target = positionTargetPct of equity. Below target is OK (trimmed
  // by caps or cash); above target is a bug.
  if (notionalUsd > 0 && input.equity > 0) {
    const actualPct = (notionalUsd / input.equity) * 100;
    if (actualPct > params.positionTargetPct * 100 + 0.01) {
      throw new Error(
        `ASSERTION_FAIL §24: positionPercentOfEquity ${actualPct.toFixed(2)}% ` +
        `exceeds target ${(params.positionTargetPct * 100).toFixed(2)}% — ` +
        `cap not enforced correctly`
      );
    }
  }
  // Per-asset cap must be >= position target: a cap below target silently
  // shrinks every position below its intended size.
  const perAssetCapPct = params.maxSpotNotionalPercent;
  if (perAssetCapPct < params.positionTargetPct * 100) {
    throw new Error(
      `ASSERTION_FAIL §24: perAssetCapPct (${perAssetCapPct}%) ` +
      `< positionTargetPct (${(params.positionTargetPct * 100).toFixed(1)}%)`
    );
  }

  // Final levels are fixed now. Derive the ONE risk % / reward % / gross R:R
  // from them — everything downstream reads these back, nothing recomputes.
  const finalStopLoss = Number(stopLoss.toFixed(8));
  const finalTakeProfit1 = Number(takeProfit1.toFixed(8));
  const riskPct = Math.abs(entry - finalStopLoss) / entry * 100;
  const rewardPct = Math.abs(finalTakeProfit1 - entry) / entry * 100;
  const grossRR = rewardPct / riskPct;
  const actualRiskUsd = notionalUsd * riskPct / 100;

  // R:R consistency: recomputed RR must match what we return.
  const displayedRR = Number((rewardPct / riskPct).toFixed(4));
  if (Math.abs(grossRR - displayedRR) > 0.01) {
    throw new Error(
      `ASSERTION_FAIL §24: grossRR ${grossRR.toFixed(4)} ≠ displayedRR ${displayedRR} — ` +
      `floating point drift in risk/reward derivation`
    );
  }

  return {
    approved: true,
    entryPrice: entry,
    stopLoss: finalStopLoss,
    takeProfit1: finalTakeProfit1,
    takeProfit2: Number(takeProfit2.toFixed(8)),
    stopDistance: Number(stopDistance.toFixed(8)),
    stopDistancePercent: Number(((stopDistance / entry) * 100).toFixed(4)),
    riskPercent: Number(riskPct.toFixed(6)),
    rewardPercent: Number(rewardPct.toFixed(6)),
    grossRewardRisk: Number((rewardPct / riskPct).toFixed(4)),
    riskUsd: Number(actualRiskUsd.toFixed(2)),
    quantity: Number(quantity.toFixed(8)),
    notionalUsd: Number(notionalUsd.toFixed(2)),
    marginUsd: Number(marginUsd.toFixed(2)),
    leverage,
    rewardRisk1: Number(rewardRisk1.toFixed(2)),
    rewardRisk2: Number(rewardRisk2.toFixed(2)),
    maxHoldMs,
    timeStopMs: Math.round(maxHoldMs * params.timeStopFraction),
    positionPercentOfEquity: Number(((notionalUsd / input.equity) * 100).toFixed(2)),
     riskPercentUsed: Number(riskPct.toFixed(6)),
     sizingMultiplier: typeof input.sizingMultiplier === 'number' && Number.isFinite(input.sizingMultiplier)
       ? Math.max(0, Math.min(1, input.sizingMultiplier))
       : 1,
     bindingConstraint
   };
}

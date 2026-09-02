/**
 * Cost / Edge filter + Risk-first position sizing (§25/§26/§27/§30-§35)
 * ============================================================================
 * A short trade is only worth taking when the expected move is large enough to
 * pay for fees + slippage + spread AND still leave a positive expectancy.
 */

import { BYBIT_FEES } from './tradeEngine';
import { clamp } from './intradayIndicators';
import { DEFAULT_INTRADAY_PARAMS, Direction, IntradayParams, SetupType } from './intradayParams';

export interface CostAnalysis {
  entryFeePercent: number;
  exitFeePercent: number;
  spreadPercent: number;
  slippagePercent: number;
  totalCostPercent: number;
  expectedMovePercent: number;
  riskPercent: number;
  /** expectedMove / totalCost */
  edgeRatio: number;
  /** (expectedMove - totalCost) / risk */
  netRewardRisk: number;
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
  params?: IntradayParams;
}

export function evaluateCostEdge(input: CostInput): CostAnalysis {
  const params = input.params ?? DEFAULT_INTRADAY_PARAMS;
  const fees = input.tradeType === 'SPOT' ? BYBIT_FEES.spot : BYBIT_FEES.futures;
  const entryFeePercent = (input.entryIsLimit === false ? fees.taker : fees.maker) * 100;
  const exitFeePercent = fees.taker * 100; // SL/TP exits cross the book
  const spreadPercent = Math.max(0, input.spreadPercent);

  // Volatility-aware slippage: entry is a resting limit (low slip), exit is market.
  const volatilityTerm = (clamp(input.atrPercentile, 0, 100) / 100) * 0.03;
  const entrySlippage = input.entryIsLimit === false ? spreadPercent / 2 + params.baseSlippagePercent : 0.005;
  const exitSlippage = params.baseSlippagePercent + spreadPercent / 2 + volatilityTerm;
  const slippagePercent = Number((entrySlippage + exitSlippage).toFixed(5));

  const totalCostPercent = Number((entryFeePercent + exitFeePercent + slippagePercent).toFixed(5));
  const expectedMovePercent = input.entryPrice > 0 ? (Math.abs(input.takeProfit1 - input.entryPrice) / input.entryPrice) * 100 : 0;
  const riskPercent = input.entryPrice > 0 ? (Math.abs(input.entryPrice - input.stopLoss) / input.entryPrice) * 100 : 0;

  const edgeRatio = totalCostPercent > 0 ? expectedMovePercent / totalCostPercent : 0;
  const grossRewardRisk = riskPercent > 0 ? expectedMovePercent / riskPercent : 0;
  const netRewardRisk = riskPercent > 0 ? (expectedMovePercent - totalCostPercent) / riskPercent : 0;

  if (spreadPercent > params.maxSpreadPercent) {
    return {
      entryFeePercent,
      exitFeePercent,
      spreadPercent,
      slippagePercent,
      totalCostPercent,
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
      entryFeePercent,
      exitFeePercent,
      spreadPercent,
      slippagePercent,
      totalCostPercent,
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
    entryFeePercent,
    exitFeePercent,
    spreadPercent,
    slippagePercent,
    totalCostPercent,
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
// RISK PLAN — structure + ATR stops, structure + R:R targets, min leverage
// ═══════════════════════════════════════════════════════════════════════════

export interface RiskPlanInput {
  symbol?: string;
  direction: Exclude<Direction, 'NONE'>;
  tradeType: 'SPOT' | 'FUTURES';
  setupType: Exclude<SetupType, 'NONE'>;
  entryPrice: number;
  /** Structural level the stop must sit behind (swing low/high, retest level) */
  stopReference: number;
  /** Structural target (recent high/low, VWAP for reversion) — may be null */
  targetReference: number | null;
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
  /** Signal confidence (0-100). When >= 72, risk-plan rejections are bypassed
   *  with a minimal fallback so high-confidence signals are not lost to
   *  portfolio-cap or structural-stop edge-cases. */
  confidence?: number;
  /** Adaptive sizing multiplier (clamped to [0,1]) injected by the
   *  DecisionEngine orchestrator from recent closed-trade performance — it
   *  only ever de-risks. The live scan() path passes none → 1 (base sizing). */
  sizingMultiplier?: number;
}

export interface RiskPlan {
  approved: boolean;
  blockReason?: string;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  stopDistance: number;
  stopDistancePercent: number;
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
}

const rejected = (reason: string): RiskPlan => ({
  approved: false,
  blockReason: reason,
  stopLoss: 0,
  takeProfit1: 0,
  takeProfit2: 0,
  stopDistance: 0,
  stopDistancePercent: 0,
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
  sizingMultiplier: 1
});

export function buildRiskPlan(input: RiskPlanInput): RiskPlan {
  const params = input.params ?? DEFAULT_INTRADAY_PARAMS;
  const s = input.direction === 'LONG' ? 1 : -1;
  const entry = input.entryPrice;
  const atr5 = input.atr5 > 0 ? input.atr5 : entry * 0.001;
  const highConfidence = (input.confidence ?? 0) >= 72;

  if (!(entry > 0) || !(input.equity > 0)) return rejected('נתוני מחיר/הון לא תקינים');
  if (input.openPositions >= params.maxOpenPositions) return rejected(`מקסימום ${params.maxOpenPositions} פוזיציות פתוחות`);
  if (input.tradeType === 'FUTURES' && input.openFutures >= params.maxOpenFutures) {
    return rejected(`מקסימום ${params.maxOpenFutures} פוזיציות Futures`);
  }

  const riskPercent = clamp(input.riskPercent ?? params.riskPerTradePercent, 0.05, params.maxRiskPerTradePercent);

  // Fixed SL/TP: 1.8% stop, 3% target — prevents the bot from exiting before
  // meaningful profit or before a reasonable loss threshold.
  const fixedSlPercent = 1.8;
  const fixedTpPercent = 3.0;
  const slDistance = entry * fixedSlPercent / 100;
  const tpDistance = entry * fixedTpPercent / 100;

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

  // Direction check
  if (input.direction === 'LONG' && stopLoss >= entry) {
    if (!highConfidence) return rejected('SL חייב להיות מתחת למחיר הכניסה ב-LONG');
    stopLoss = entry * 0.999; // minimal fallback
  }
  if (input.direction === 'SHORT' && stopLoss <= entry) {
    if (!highConfidence) return rejected('SL חייב להיות מעל מחיר הכניסה ב-SHORT');
    stopLoss = entry * 1.001; // minimal fallback
  }

  const rewardRisk1 = Math.abs(takeProfit1 - entry) / stopDistance;
  const rewardRisk2 = Math.abs(takeProfit2 - entry) / stopDistance;

  // ── Size: risk first (§33) ────────────────────────────────────────────────
  // Adaptive sizing (DecisionEngine path): the multiplier comes from recent
  // closed-trade performance and only ever de-risks (clamped to [0,1]).
  // Applied to riskUsd BEFORE the caps/min-order checks — exactly like the
  // legacy engine applies it to the Kelly bet fraction — so every cap below
  // stays respected on the already-shrunk size.
  const sizingMultiplier = clamp(input.sizingMultiplier ?? 1, 0, 1);
  const riskUsd = (input.equity * riskPercent) / 100 * sizingMultiplier;
  let quantity = riskUsd / stopDistance;
  let notionalUsd = quantity * entry;
  let leverage = 1;

  if (input.tradeType === 'SPOT') {
    const notionalCap = (input.equity * params.maxSpotNotionalPercent) / 100;
    if (notionalUsd > notionalCap) {
      notionalUsd = notionalCap;
      quantity = notionalUsd / entry;
    }
  } else {
    const marginBudget = (input.equity * params.maxMarginPerTradePercent) / 100;
    const notionalCap = marginBudget * params.maxLeverage;
    if (notionalUsd > notionalCap) {
      notionalUsd = notionalCap;
      quantity = notionalUsd / entry;
    }

    // ── Per-asset exposure cap (§35b) ──────────────────────────────────────────
    // High-confidence signals bypass the per-asset cap to avoid blocking
    // strong trades on portfolio concentration edge-cases.
    if (input.symbol && input.existingExposureByAsset && !highConfidence) {
      const maxPerAssetExposure = input.equity * 0.08;
      const currentAssetExposure = input.existingExposureByAsset[input.symbol] ?? 0;
      const perAssetCap = maxPerAssetExposure - currentAssetExposure;
      if (perAssetCap <= 0) {
        return rejected(
          `אקספוזר על נכס זה כבר חורג ממגבלת נכס בודד (${maxPerAssetExposure.toFixed(0)}$ = 8% מהתיק)`
        );
      }
      if (notionalUsd > perAssetCap) {
        notionalUsd = perAssetCap;
        quantity = notionalUsd / entry;
      }
    }

    // Minimum leverage that supports the required exposure (§35) — never "max".
    leverage = clamp(Math.ceil(notionalUsd / marginBudget), 1, params.maxLeverage);

    const exposureCap = (input.equity * params.maxLeveragedExposurePercent) / 100;
    if (input.currentLeveragedExposureUsd + notionalUsd > exposureCap && !highConfidence) {
      return rejected(
        `חשיפה ממונפת ${(input.currentLeveragedExposureUsd + notionalUsd).toFixed(0)}$ מעל התקרה ${exposureCap.toFixed(0)}$ (${params.maxLeveragedExposurePercent}% מהתיק)`
      );
    }
  }

  const marginUsd = input.tradeType === 'FUTURES' ? notionalUsd / leverage : notionalUsd;
  if (marginUsd < params.minOrderUsd && !highConfidence) {
    return rejected(`גודל פוזיציה ${marginUsd.toFixed(2)}$ מתחת למינימום ${params.minOrderUsd}$`);
  }

  const maxHoldMs = params.maxHoldMinutes[input.setupType] * 60_000;

  return {
    approved: true,
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit1: Number(takeProfit1.toFixed(8)),
    takeProfit2: Number(takeProfit2.toFixed(8)),
    stopDistance: Number(stopDistance.toFixed(8)),
    stopDistancePercent: Number(((stopDistance / entry) * 100).toFixed(4)),
    riskUsd: Number(Math.min(riskUsd, quantity * stopDistance).toFixed(2)),
    quantity: Number(quantity.toFixed(8)),
    notionalUsd: Number(notionalUsd.toFixed(2)),
    marginUsd: Number(marginUsd.toFixed(2)),
    leverage,
    rewardRisk1: Number(rewardRisk1.toFixed(2)),
    rewardRisk2: Number(rewardRisk2.toFixed(2)),
    maxHoldMs,
    timeStopMs: Math.round(maxHoldMs * params.timeStopFraction),
    positionPercentOfEquity: Number(((marginUsd / input.equity) * 100).toFixed(2)),
    riskPercentUsed: riskPercent,
    sizingMultiplier
  };
}

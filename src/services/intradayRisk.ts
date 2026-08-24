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
  riskPercent?: number;
  params?: IntradayParams;
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
  riskPercentUsed: 0
});

export function buildRiskPlan(input: RiskPlanInput): RiskPlan {
  const params = input.params ?? DEFAULT_INTRADAY_PARAMS;
  const s = input.direction === 'LONG' ? 1 : -1;
  const entry = input.entryPrice;
  const atr5 = input.atr5 > 0 ? input.atr5 : entry * 0.001;

  if (!(entry > 0) || !(input.equity > 0)) return rejected('נתוני מחיר/הון לא תקינים');
  if (input.openPositions >= params.maxOpenPositions) return rejected(`מקסימום ${params.maxOpenPositions} פוזיציות פתוחות`);
  if (input.tradeType === 'FUTURES' && input.openFutures >= params.maxOpenFutures) {
    return rejected(`מקסימום ${params.maxOpenFutures} פוזיציות Futures`);
  }

  const riskPercent = clamp(input.riskPercent ?? params.riskPerTradePercent, 0.05, params.maxRiskPerTradePercent);

  // ── Stop: structure first, ATR as the MINIMUM distance (§30) ───────────────
  const structuralStop = input.stopReference - s * params.stopStructureBufferAtr * atr5;
  const structuralDistance = Math.abs(entry - structuralStop);
  const minDistance = Math.max(params.minStopAtrMult * atr5, (entry * params.minStopPercent) / 100);
  const maxDistance = Math.min(params.maxStopAtrMult * atr5, (entry * params.maxStopPercent) / 100);

  let stopDistance = Math.max(structuralDistance, minDistance);
  if (stopDistance > maxDistance) {
    // A stop this wide is a swing trade, not a 5-60 minute trade.
    return rejected(
      `מרחק SL ${(stopDistance / entry * 100).toFixed(2)}% רחב מדי לעסקה תוך-יומית (מקס' ${(maxDistance / entry * 100).toFixed(2)}%)`
    );
  }

  const stopLoss = entry - s * stopDistance;
  if (stopLoss <= 0) return rejected('SL מחושב שלילי');

  // ── Targets: structure + ATR + R:R (§31) ──────────────────────────────────
  const rrTp1 = entry + s * params.tp1RewardRisk * stopDistance;
  const structuralTarget = input.targetReference;
  let takeProfit1 = rrTp1;
  if (structuralTarget !== null && Number.isFinite(structuralTarget)) {
    const structuralDistanceToTarget = (structuralTarget - entry) * s;
    if (structuralDistanceToTarget > 0) {
      // Take the nearer of "structure" and "R:R target" so TP1 is realistic,
      // but never accept a target that is below the minimum R:R.
      const candidate = Math.min(Math.abs(structuralDistanceToTarget), params.tp1RewardRisk * stopDistance * 1.6);
      if (candidate >= params.minRewardRisk * stopDistance) {
        takeProfit1 = entry + s * candidate;
      }
    }
  }
  const takeProfit2 = entry + s * Math.max(params.tp2RewardRisk * stopDistance, Math.abs(takeProfit1 - entry) * 1.5);

  const rewardRisk1 = Math.abs(takeProfit1 - entry) / stopDistance;
  const rewardRisk2 = Math.abs(takeProfit2 - entry) / stopDistance;
  if (rewardRisk1 < params.minRewardRisk) {
    return rejected(`R:R ${rewardRisk1.toFixed(2)} מתחת למינימום ${params.minRewardRisk}`);
  }

  // ── Size: risk first (§33) ────────────────────────────────────────────────
  const riskUsd = (input.equity * riskPercent) / 100;
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
    // Minimum leverage that supports the required exposure (§35) — never "max".
    leverage = clamp(Math.ceil(notionalUsd / marginBudget), 1, params.maxLeverage);

    const exposureCap = (input.equity * params.maxLeveragedExposurePercent) / 100;
    if (input.currentLeveragedExposureUsd + notionalUsd > exposureCap) {
      return rejected(
        `חשיפה ממונפת ${(input.currentLeveragedExposureUsd + notionalUsd).toFixed(0)}$ מעל התקרה ${exposureCap.toFixed(0)}$ (${params.maxLeveragedExposurePercent}% מהתיק)`
      );
    }
  }

  const marginUsd = input.tradeType === 'FUTURES' ? notionalUsd / leverage : notionalUsd;
  if (marginUsd < params.minOrderUsd) {
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
    riskPercentUsed: riskPercent
  };
}

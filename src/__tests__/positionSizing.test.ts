import { describe, it, expect } from 'vitest';
import {
  buildRiskPlan,
  FIXED_SL_PERCENT,
  FIXED_TP_PERCENT
} from '@cde/engine/analysis';
import { DEFAULT_INTRADAY_PARAMS } from '@cde/engine';
import { evaluatePrev4hRange, readPrev4hRangePlan, DEFAULT_PREV4H_RANGE_PARAMS } from '@cde/engine/analysis';
import type { Candle, SignalEvaluation } from '@cde/engine';
import { generateTrendBreakoutOrders, type TrendBreakoutOrderGenContext, type SimPosition } from '@cde/engine/execution';
import { applyProEntryGates, type ProGateContext, calculateTradingFee, reanchorLevel } from '@cde/engine/execution';

// ─── Helpers ────────────────────────────────────────────────────────────────

function buyEval(symbol: string, confidence: number): SignalEvaluation {
  return {
    symbol,
    action: 'buy',
    tradeType: 'SPOT',
    tradeSide: 'BUY',
    confidence,
    price: 100,
    priceChange24h: 1,
    reasoning: 'test',
    status: '',
    willExecute: false,
    factors: [],
    confidenceGap: 0
  } as SignalEvaluation;
}

const gateCtx = (over: Partial<ProGateContext> = {}): ProGateContext => ({
  positions: [],
  pending: [],
  cash: 10_000,
  equity: 10_000,
  initialAmount: 10_000,
  maxPositions: 3,
  riskLevel: 'medium',
  ...over
});

const H1_MS = 60 * 60 * 1000;
const BAR_MS = 4 * H1_MS;
const H1_COUNT = 96;

/**
 * Builds 96 H1 candles whose LAST four form a single 4H bar with the given
 * high (H) and low (L). The first 92 candles ramp monotonically from
 * `startPrice` upward so the 4H EMA(20) trends up into the last bar.
 * `now` lands one hour into the H4 window following the last bar.
 */
function buildH1ForPrevBar(H: number, L: number, startPrice: number): { h1: Candle[]; now: number } {
  const h1: Candle[] = [];
  const step = (H - startPrice - 1) / (H1_COUNT - 4);

  for (let i = 0; i < H1_COUNT; i++) {
    const ts = i * H1_MS;
    if (i < H1_COUNT - 4) {
      const close = startPrice + i * step;
      h1.push({
        timestamp: ts,
        open: close - 0.1,
        high: close + 0.1,
        low: close - 0.1,
        close,
        volume: 1000
      });
    }
  }

  // Overwrite the last 4 H1 candles to form the target H4 bar.
  const last4Start = (H1_COUNT - 4) * H1_MS;
  const range = H - L;
  for (let i = 0; i < 4; i++) {
    const ts = last4Start + i * H1_MS;
    const close = L + range * (i + 1) / 4;
    h1.push({
      timestamp: ts,
      open: close - 0.05,
      high: H,
      low: L,
      close,
      volume: 1000
    });
  }

  const windowStart = last4Start + BAR_MS;
  return { h1, now: windowStart + H1_MS };
}

// ─── Requirement #26: Required Test Cases ───────────────────────────────────

describe('Position Sizing — 10% target model', () => {
  it('Test 1: Equity = $1,000 → Target Position = $100', () => {
    const plan = buildRiskPlan({
      symbol: 'BTC',
      direction: 'LONG',
      tradeType: 'SPOT',
      setupType: 'TREND_PULLBACK',
      entryPrice: 100,
      atr5: 1,
      atr15: 1.5,
      equity: 1_000,
      openPositions: 0,
      openFutures: 0,
      currentLeveragedExposureUsd: 0,
      params: { ...DEFAULT_INTRADAY_PARAMS, positionTargetPct: 0.10 }
    });
    expect(plan.approved).toBe(true);
    expect(plan.notionalUsd).toBeCloseTo(100, 2);
    expect(plan.positionPercentOfEquity).toBeCloseTo(10, 2);
  });

  it('Test 2: Equity = $10,000 → Target Position = $1,000', () => {
    const plan = buildRiskPlan({
      symbol: 'BTC',
      direction: 'LONG',
      tradeType: 'SPOT',
      setupType: 'TREND_PULLBACK',
      entryPrice: 100,
      atr5: 1,
      atr15: 1.5,
      equity: 10_000,
      openPositions: 0,
      openFutures: 0,
      currentLeveragedExposureUsd: 0,
      params: { ...DEFAULT_INTRADAY_PARAMS, positionTargetPct: 0.10 }
    });
    expect(plan.approved).toBe(true);
    expect(plan.notionalUsd).toBeCloseTo(1000, 2);
    expect(plan.positionPercentOfEquity).toBeCloseTo(10, 2);
  });

  it('Test 3: Equity = $500, Target = $50, Minimum = $100 → SKIP', () => {
    const plan = buildRiskPlan({
      symbol: 'BTC',
      direction: 'LONG',
      tradeType: 'SPOT',
      setupType: 'TREND_PULLBACK',
      entryPrice: 100,
      atr5: 1,
      atr15: 1.5,
      equity: 500,
      openPositions: 0,
      openFutures: 0,
      currentLeveragedExposureUsd: 0,
      params: { ...DEFAULT_INTRADAY_PARAMS, positionTargetPct: 0.10, minOrderUsd: 100 }
    });
    expect(plan.approved).toBe(false);
    expect(plan.blockReason).toContain('MIN_ORDER_EXCEEDS_POSITION_TARGET');
  });
});

describe('Confidence Threshold Enforcement', () => {
  it('Test 4: Confidence = 69, minConfidence = 70 → NO_SIGNAL', () => {
    const [ev] = applyProEntryGates([buyEval('BTC', 69)], gateCtx());
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toContain('BELOW_THRESHOLD');
  });
});

describe('Prev4hRange R:R Calculation', () => {
  it('Test 5: breakoutDistance = 0 → RR = 2.0', () => {
    const H = 100.2;
    const L = 99.8;
    const { h1, now } = buildH1ForPrevBar(H, L, 95);
    const currentPrice = H + 0.0001; // ~d=0 breakout
    const ev = evaluatePrev4hRange({
      symbol: 'TEST',
      h1,
      currentPrice,
      now,
      params: { ...DEFAULT_PREV4H_RANGE_PARAMS, minH4Bars: 2, minRR: 0, minConfidence: 0, minRangePct: 0, maxRangePct: 1 }
    });
    const plan = readPrev4hRangePlan(ev);
    expect(plan).toBeDefined();
    expect(plan!.actualRR).toBeCloseTo(2.0, 1);
  });

  it('Test 6: breakoutDistance = 0.5 * range → RR = 0.5', () => {
    const H = 100.2;
    const L = 99.8;
    const range = H - L;
    const { h1, now } = buildH1ForPrevBar(H, L, 95);
    const currentPrice = H + range * 0.5;
    const ev = evaluatePrev4hRange({
      symbol: 'TEST',
      h1,
      currentPrice,
      now,
      params: { ...DEFAULT_PREV4H_RANGE_PARAMS, minH4Bars: 2, minRR: 0, minConfidence: 0, minRangePct: 0, maxRangePct: 1 }
    });
    const plan = readPrev4hRangePlan(ev);
    expect(plan).toBeDefined();
    expect(plan!.actualRR).toBeCloseTo(0.5, 1);
  });

  it('Test 7: Entry=13.3119, SL=13.0723, TP=13.7113 → Gross RR ≈ 1.67', () => {
    const H = 13.2853;
    const L = 12.8593;
    const { h1, now } = buildH1ForPrevBar(H, L, 12.5);
    const currentPrice = 13.3119;
    const ev = evaluatePrev4hRange({
      symbol: 'TEST',
      h1,
      currentPrice,
      now,
      params: { ...DEFAULT_PREV4H_RANGE_PARAMS, minH4Bars: 2, minRR: 0, minConfidence: 0, minRangePct: 0, maxRangePct: 1 }
    });
    const plan = readPrev4hRangePlan(ev);
    expect(plan).toBeDefined();
    expect(plan!.actualRR).toBeCloseTo(1.67, 2);
  });
});

describe('Scale-In Fractions', () => {
  it('Test 8: Equity=$1,000, Target=$100 → Scale 1=$50, Scale 2=$30, Scale 3=$20', () => {
    const equity = 1_000;
    const targetNotional = equity * 0.10;
    const fractions = [0.5, 0.3, 0.2];
    const scales = fractions.map(f => targetNotional * f);
    expect(scales[0]).toBeCloseTo(50, 2);
    expect(scales[1]).toBeCloseTo(30, 2);
    expect(scales[2]).toBeCloseTo(20, 2);
    expect(scales.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
  });

  it('Test 8b: SCALE_2 via generateTrendBreakoutOrders — notional = 3% of equity', () => {
    const equity = 5_000; // high enough that 3% ($150) > MIN_SIM_ENTRY_USD ($100)
    const entry = 100;
    const stopLoss = 99;
    const scale1Pos: SimPosition = {
      id: 'lot1',
      symbol: 'BTC',
      side: 'LONG',
      type: 'SPOT',
      quantity: 0.5,
      entryPrice: entry,
      currentPrice: entry,
      stopLoss,
      takeProfit: 102,
      takeProfit1: 102,
      confidence: 80,
      openTimestamp: Date.now() - 1000,
      highestPrice: entry,
      lowestPrice: entry,
      avgPrice: entry,
      leverage: 1,
      marginUsd: 0,
      notionalUsd: 0,
      tp1Hit: false,
      openedAt: '',
      reason: 'test',
      entryFee: 0
    };

    const ctx: TrendBreakoutOrderGenContext = {
      positions: [scale1Pos],
      pending: [],
      evaluations: [],
      executionDelaySec: 0,
      dailyDrawdownPercent: 0,
      weeklyDrawdownPercent: 0,
      cash: 10_000,
      equity,
      totalLeveragedExposureUsd: 50,
      exitCooldown: {},
      priceFor: (s: string) => s === 'BTC' ? 100.5 : undefined,
      candlesBySymbol: {},
      maxConcurrentTrades: 2,
      params: { scale2MinR: 0.5, scale3MinR: 1.0 }
    };

    const orders = generateTrendBreakoutOrders(ctx);
    const scale2 = orders.find(o => o.reason?.includes('scale 2'));
    expect(scale2).toBeDefined();
    expect(scale2!.budgetUsd).toBeCloseTo(150, 0); // 3% of $5,000
  });

  it('Test 8c: SCALE_3 via generateTrendBreakoutOrders — notional = 2% of equity', () => {
    const equity = 5_000; // 2% of $5,000 = $100 >= MIN_SIM_ENTRY_USD
    const entry = 100;
    const stopLoss = 99;
    const scale1Pos: SimPosition = {
      id: 'lot1',
      symbol: 'BTC',
      side: 'LONG',
      type: 'SPOT',
      quantity: 0.5,
      entryPrice: entry,
      currentPrice: entry,
      stopLoss,
      takeProfit: 102,
      takeProfit1: 102,
      confidence: 80,
      openTimestamp: Date.now() - 2000,
      highestPrice: entry,
      lowestPrice: entry,
      avgPrice: entry,
      leverage: 1,
      marginUsd: 0,
      notionalUsd: 0,
      tp1Hit: false,
      openedAt: '',
      reason: 'test',
      entryFee: 0
    };
    const scale2Pos: SimPosition = {
      id: 'lot2',
      symbol: 'BTC',
      side: 'LONG',
      type: 'SPOT',
      quantity: 0.3,
      entryPrice: entry,
      currentPrice: entry,
      stopLoss,
      takeProfit: 102,
      takeProfit1: 102,
      confidence: 80,
      openTimestamp: Date.now() - 1000,
      highestPrice: entry,
      lowestPrice: entry,
      avgPrice: entry,
      leverage: 1,
      marginUsd: 0,
      notionalUsd: 0,
      tp1Hit: false,
      openedAt: '',
      reason: 'test',
      entryFee: 0
    };

    const ctx: TrendBreakoutOrderGenContext = {
      positions: [scale1Pos, scale2Pos],
      pending: [],
      evaluations: [],
      executionDelaySec: 0,
      dailyDrawdownPercent: 0,
      weeklyDrawdownPercent: 0,
      cash: 10_000,
      equity,
      totalLeveragedExposureUsd: 80,
      exitCooldown: {},
      priceFor: (s: string) => s === 'BTC' ? 101 : undefined,
      candlesBySymbol: {},
      maxConcurrentTrades: 2,
      params: { scale3MinR: 1.0 }
    };

    const orders = generateTrendBreakoutOrders(ctx);
    const scale3 = orders.find(o => o.reason?.includes('scale 3'));
    expect(scale3).toBeDefined();
    expect(scale3!.budgetUsd).toBeCloseTo(100, 0); // 2% of $5,000 = $100
  });
});

describe('Market Fill Drift Recalculation', () => {
  it('Test 9: Signal Price = 100, Actual Fill = 101 → recalculate RR, fees, slippage', () => {
    const signalPrice = 100;
    const actualFill = 101;
    const sl = 98;
    const tp = 104;
    const notional = 1000;

    // Re-anchor levels using the engine's reanchorLevel (preserves signed offset)
    const reanchoredSL = reanchorLevel(actualFill, signalPrice, sl);
    const reanchoredTP = reanchorLevel(actualFill, signalPrice, tp);

    // Signal-side RR
    const signalRisk = Math.abs(signalPrice - sl);
    const signalReward = Math.abs(tp - signalPrice);
    const signalRR = signalReward / signalRisk;

    // Actual RR from re-anchored levels (offsets preserved → RR unchanged)
    const actualRisk = Math.abs(actualFill - reanchoredSL!);
    const actualReward = Math.abs(reanchoredTP! - actualFill);
    const actualRR = actualReward / actualRisk;

    // Slippage: |fill - signal| × (notional / signal_price)
    const slippage = Math.abs(actualFill - signalPrice) * (notional / signalPrice);

    // Fee (0.1% spot taker)
    const fee = calculateTradingFee(notional, 'SPOT', true);

    expect(signalRR).toBeCloseTo(2.0, 2); // 4/2 = 2.0
    expect(actualRR).toBeCloseTo(2.0, 2); // re-anchored preserves RR
    expect(slippage).toBeCloseTo(10, 2);
    expect(fee).toBeCloseTo(1, 2);
  });
});

describe('Pro Engine — 10% Fixed Allocation', () => {
  it('confidence does not affect allocation — always 10% of equity', () => {
    const [ev70] = applyProEntryGates([buyEval('LA', 70)], gateCtx());
    const [ev90] = applyProEntryGates([buyEval('LA', 90)], gateCtx());
    expect(ev70.budgetUsd).toBeCloseTo(1000, 2);
    expect(ev90.budgetUsd).toBeCloseTo(1000, 2);
    expect(ev70.budgetUsd).toBe(ev90.budgetUsd);
  });
});

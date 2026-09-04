import { describe, it, expect } from 'vitest';
import {
  computeEntryBudget,
  riskLevelSizingMultiplier,
  calculateTradingFee,
  simulateSlippage,
  generateLegacyOrders,
  DEFAULT_POSITION_PERCENT,
  DEFAULT_SLIPPAGE_PERCENT,
  FEE_REFERENCE_PERCENT,
  BYBIT_FEES
} from '@cde/engine/execution';
import { Candle } from '@cde/engine';
import type { PendingOrder } from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';

// Four SimBotConfig fields — positionPercent, riskLevel, feePercent and
// slippagePercent — were settable from the bot panel and from the environment
// while no engine read any of them. These tests hold them connected.
//
// The first assertion of each pair is the one that matters most: at the values
// the shipped configs already carry, wiring the control must change nothing.
// Only then do the tests check that moving it does.

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

function series(n: number, start: number): Candle[] {
  const out: Candle[] = [];
  let price = start;
  let x = 7;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const open = price;
    price = price * (1 + ((x / 2147483648) - 0.5) * 0.04);
    out.push({
      timestamp: T0 + i * HOUR,
      open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 1000
    });
  }
  return out;
}

const candlesBySymbol: Record<string, Candle[]> = { LA: series(90, 100) };

function evaluation(symbol: string): SignalEvaluation {
  return {
    symbol, action: 'buy', tradeType: 'SPOT', tradeSide: 'BUY', confidence: 70,
    price: 100, priceChange24h: 1, reasoning: 'test', status: 'ready',
    willExecute: true, factors: [], confidenceGap: 0, leverage: 1,
    stopLoss: 90, takeProfit: 130
  } as unknown as SignalEvaluation;
}

const baseCtx = {
  positions: [],
  pending: [] as PendingOrder[],
  executionDelaySec: 0,
  dailyDrawdownPercent: 0,
  weeklyDrawdownPercent: 0,
  cash: 1000,
  equity: 10_000,
  exitCooldown: {} as Record<string, number>,
  priceFor: () => 100,
  candlesBySymbol,
  maxPositions: 7,
  maxFuturesPositions: 2,
  evaluations: [evaluation('LA')]
};

describe('positionPercent sizes entries', () => {
  it('falls back to the engine default when unset', () => {
    expect(computeEntryBudget(1000, 'SPOT')).toBeCloseTo(1000 * DEFAULT_POSITION_PERCENT / 100, 6);
  });

  it('SPOT commits the configured percentage of free cash', () => {
    expect(computeEntryBudget(1000, 'SPOT', 10)).toBeCloseTo(100, 6);
    expect(computeEntryBudget(1000, 'SPOT', 25)).toBeCloseTo(250, 6);
  });

  it('FUTURES moves with it, keeping the third-of-SPOT ratio', () => {
    expect(computeEntryBudget(1000, 'FUTURES', 15)).toBeCloseTo(50, 6);
    expect(computeEntryBudget(1000, 'FUTURES', 30)).toBeCloseTo(100, 6);
  });

  it('keeps the absolute dollar caps', () => {
    expect(computeEntryBudget(1_000_000, 'SPOT', 50)).toBe(1000);
    expect(computeEntryBudget(1_000_000, 'FUTURES', 50)).toBe(500);
  });

  it('ignores a nonsensical value rather than sizing to zero', () => {
    expect(computeEntryBudget(1000, 'SPOT', 0)).toBeCloseTo(150, 6);
    expect(computeEntryBudget(1000, 'SPOT', Number.NaN)).toBeCloseTo(150, 6);
  });

  it('reaches the order the legacy engine actually queues', () => {
    const orders = generateLegacyOrders({ ...baseCtx, positionPercent: 8 });
    expect(orders.find((o) => o.side === 'buy')?.budgetUsd).toBeCloseTo(80, 6);
  });
});

describe('riskLevel scales the entry budget', () => {
  it('medium and unset are the neutral case', () => {
    expect(riskLevelSizingMultiplier('medium')).toBe(1);
    expect(riskLevelSizingMultiplier(undefined)).toBe(1);
  });

  it('low de-risks and high adds size', () => {
    expect(riskLevelSizingMultiplier('low')).toBe(0.6);
    expect(riskLevelSizingMultiplier('high')).toBe(1.5);
  });

  it('reaches the order, and compounds with positionPercent', () => {
    const low = generateLegacyOrders({ ...baseCtx, positionPercent: 10, riskLevel: 'low' });
    const high = generateLegacyOrders({ ...baseCtx, positionPercent: 10, riskLevel: 'high' });
    expect(low.find((o) => o.side === 'buy')?.budgetUsd).toBeCloseTo(60, 6);
    expect(high.find((o) => o.side === 'buy')?.budgetUsd).toBeCloseTo(150, 6);
  });
});

describe('feePercent scales the cost model', () => {
  it('is neutral at the rate the shipped configs carry', () => {
    expect(FEE_REFERENCE_PERCENT).toBeCloseTo(0.1, 10);
    expect(calculateTradingFee(1000, 'SPOT', true, 0.1)).toBeCloseTo(calculateTradingFee(1000, 'SPOT', true), 10);
    expect(calculateTradingFee(1000, 'FUTURES', false, 0.1)).toBeCloseTo(calculateTradingFee(1000, 'FUTURES', false), 10);
  });

  it('scales every rate by the same factor, preserving maker/taker structure', () => {
    expect(calculateTradingFee(1000, 'SPOT', true, 0.2)).toBeCloseTo(1000 * BYBIT_FEES.spot.taker * 2, 10);
    expect(calculateTradingFee(1000, 'FUTURES', true, 0.2)).toBeCloseTo(1000 * BYBIT_FEES.futures.taker * 2, 10);
    expect(calculateTradingFee(1000, 'FUTURES', false, 0.2)).toBeCloseTo(1000 * BYBIT_FEES.futures.maker * 2, 10);
  });

  it('a zero-fee simulation is expressible', () => {
    expect(calculateTradingFee(1000, 'SPOT', true, 0)).toBe(0);
  });

  it('falls back to the real schedule when unset', () => {
    expect(calculateTradingFee(1000, 'SPOT', true)).toBeCloseTo(1000 * BYBIT_FEES.spot.taker, 10);
  });
});

describe('slippagePercent sets the fill band', () => {
  it('reproduces the historical 0.05%-0.15% band at the shipped default', () => {
    expect(DEFAULT_SLIPPAGE_PERCENT).toBeCloseTo(0.05, 10);
    for (let i = 0; i < 200; i++) {
      const { slippagePercent } = simulateSlippage(100, 'BUY');
      expect(slippagePercent).toBeGreaterThanOrEqual(0.05);
      expect(slippagePercent).toBeLessThanOrEqual(0.15);
    }
  });

  it('a configured value shifts and widens the band proportionally', () => {
    for (let i = 0; i < 200; i++) {
      const { slippagePercent } = simulateSlippage(100, 'BUY', 0.2);
      expect(slippagePercent).toBeGreaterThanOrEqual(0.2);
      expect(slippagePercent).toBeLessThanOrEqual(0.6);
    }
  });

  it('zero slippage fills at the market price', () => {
    const { fillPrice, slippagePercent } = simulateSlippage(100, 'BUY', 0);
    expect(slippagePercent).toBe(0);
    expect(fillPrice).toBeCloseTo(100, 10);
  });

  it('still costs the taker: a buy fills above market, a sell below', () => {
    expect(simulateSlippage(100, 'BUY', 0.1).fillPrice).toBeGreaterThan(100);
    expect(simulateSlippage(100, 'SELL', 0.1).fillPrice).toBeLessThan(100);
  });
});

describe('Kelly decides the size, the operator caps it', () => {
  it('uses the risk plan size when the engine produced one', () => {
    const withKelly = { ...evaluation('LA'), betSizeUsd: 40 } as SignalEvaluation;
    const orders = generateLegacyOrders({ ...baseCtx, cash: 1000, evaluations: [withKelly] });
    expect(orders.find((o) => o.side === 'buy')?.budgetUsd).toBeCloseTo(40, 6);
  });

  it('never exceeds positionPercent of free cash, however large Kelly gets', () => {
    const hugeKelly = { ...evaluation('LA'), betSizeUsd: 900 } as SignalEvaluation;
    const orders = generateLegacyOrders({
      ...baseCtx, cash: 1000, positionPercent: 10, evaluations: [hugeKelly]
    });
    expect(orders.find((o) => o.side === 'buy')?.budgetUsd).toBeCloseTo(100, 6);
  });

  it('riskLevel scales the ceiling, not the Kelly bet', () => {
    const kelly = { ...evaluation('LA'), betSizeUsd: 120 } as SignalEvaluation;
    const medium = generateLegacyOrders({
      ...baseCtx, cash: 1000, positionPercent: 10, riskLevel: 'medium', evaluations: [kelly]
    });
    const high = generateLegacyOrders({
      ...baseCtx, cash: 1000, positionPercent: 10, riskLevel: 'high', evaluations: [kelly]
    });
    // medium: ceiling 100 binds. high: ceiling 150, so Kelly's own 120 stands —
    // appetite widened the cap, it did not inflate the bet.
    expect(medium.find((o) => o.side === 'buy')?.budgetUsd).toBeCloseTo(100, 6);
    expect(high.find((o) => o.side === 'buy')?.budgetUsd).toBeCloseTo(120, 6);
  });

  it('falls back to the cash budget when no risk plan reached the order', () => {
    const orders = generateLegacyOrders({ ...baseCtx, cash: 1000, evaluations: [evaluation('LA')] });
    expect(orders.find((o) => o.side === 'buy')?.budgetUsd).toBeCloseTo(150, 6);
  });
});

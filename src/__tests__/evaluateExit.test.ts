import { describe, it, expect } from 'vitest';
import { evaluateExit } from '../services/tradeEngine';
import type { ActivePosition } from '../types/crypto';

function makePosition(overrides: Partial<ActivePosition> = {}): ActivePosition {
  return {
    id: 'test-1',
    symbol: 'BTCUSDT',
    type: 'SPOT',
    side: 'BUY',
    quantity: 0.1,
    entryPrice: 100,
    currentPrice: 100,
    avgPrice: 100,
    leverage: 1,
    marginUsd: 10,
    notionalUsd: 10,
    stopLoss: 95,
    takeProfit1: 110,
    takeProfit2: 120,
    trailingStopActive: false,
    trailingStopPrice: 90,
    highestPriceSinceTP1: undefined,
    lowestPriceSinceTP1: undefined,
    highestPrice: undefined,
    lowestPrice: undefined,
    tp1Hit: false,
    openedAt: new Date().toISOString(),
    openTimestamp: Date.now(),
    entryFee: 0.1,
    reason: 'test',
    confidence: 50,
    ...overrides
  };
}

describe('evaluateExit', () => {
  it('returns FULL exit on weekly drawdown >= 15%', () => {
    const pos = makePosition();
    const result = evaluateExit(pos, 100, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 5, weeklyDrawdownPercent: 15 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns FULL exit on stop loss hit for LONG', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG', stopLoss: 100 });
    const result = evaluateExit(pos, 99, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns FULL exit on stop loss hit for SHORT', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'SHORT', stopLoss: 100 });
    const result = evaluateExit(pos, 101, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns FULL exit on spot take profit', () => {
    const pos = makePosition({ takeProfit1: 110 });
    const result = evaluateExit(pos, 111, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns FULL exit on futures TP2 for LONG', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG', takeProfit1: 110, takeProfit2: 120 });
    const result = evaluateExit(pos, 121, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns PARTIAL_50 on futures TP1 for LONG', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG', takeProfit1: 110, takeProfit2: 120, tp1Hit: false });
    const result = evaluateExit(pos, 111, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('PARTIAL_50');
  });

  it('returns PARTIAL_50 on futures TP1 for SHORT', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'SHORT', takeProfit1: 90, takeProfit2: 80, tp1Hit: false });
    const result = evaluateExit(pos, 89, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('PARTIAL_50');
  });

  it('returns TRAILING_STOP for futures LONG after TP1', () => {
    const pos = makePosition({
      type: 'FUTURES',
      side: 'LONG',
      takeProfit1: 110,
      takeProfit2: 120,
      tp1Hit: true,
      highestPriceSinceTP1: 115,
      entryPrice: 100
    });
    const result = evaluateExit(pos, 113, 2, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('TRAILING_STOP');
  });

  it('returns REVERSAL on strong opposite signal for LONG', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG' });
    const result = evaluateExit(pos, 100, 1, { buy: 0, sell: 70 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('REVERSAL');
  });

  it('returns TIME_BASED for spot after 48h with significant loss', () => {
    const pos = makePosition({
      openTimestamp: Date.now() - 48 * 60 * 60 * 1000,
      entryPrice: 100,
      stopLoss: 90
    });
    const result = evaluateExit(pos, 92, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('TIME_BASED');
  });

  it('returns PARTIAL_50 for futures after 24h without TP1', () => {
    const pos = makePosition({
      type: 'FUTURES',
      side: 'LONG',
      takeProfit1: 110,
      tp1Hit: false,
      openTimestamp: Date.now() - 24 * 60 * 60 * 1000
    });
    const result = evaluateExit(pos, 100, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('PARTIAL_50');
  });

  it('returns NONE when no exit conditions met', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG', takeProfit1: 110, tp1Hit: false });
    const result = evaluateExit(pos, 105, 1, { buy: 50, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(false);
    expect(result.exitType).toBe('NONE');
  });
});

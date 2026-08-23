import { describe, it, expect } from 'vitest';
import { calculateRiskParameters } from '../services/tradeEngine';

describe('calculateRiskParameters', () => {
  it('returns null for HOLD trade type', () => {
    const result = calculateRiskParameters(100, 'HOLD', 'BUY', 1, 'NORMAL', 50, 10000);
    expect(result).toBeNull();
  });

  it('returns null for non-positive entry price', () => {
    const result = calculateRiskParameters(0, 'SPOT', 'BUY', 1, 'NORMAL', 50, 10000);
    expect(result).toBeNull();
  });

  it('returns null for non-positive ATR', () => {
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 0, 'NORMAL', 50, 10000);
    expect(result).toBeNull();
  });

  it('returns null when max open positions reached', () => {
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 1, 'NORMAL', 50, 10000, [], 5, 0, 0);
    expect(result).toBeNull();
  });

  it('returns null when max futures positions reached', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'LONG', 1, 'NORMAL', 50, 10000, [], 0, 2, 0);
    expect(result).toBeNull();
  });

  it('calculates SPOT risk parameters correctly', () => {
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 2, 'NORMAL', 50, 10000);
    expect(result).not.toBeNull();
    expect(result!.stopLoss).toBeCloseTo(100 - 2 * 1.8, 4);
    expect(result!.takeProfit).toBeCloseTo(100 + 2 * 2.7, 4);
    expect(result!.leverage).toBe(1);
    expect(result!.kellyFraction).toBeCloseTo(0.06, 4);
  });

  it('calculates FUTURES LONG risk parameters correctly', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'LONG', 2, 'NORMAL', 50, 10000);
    expect(result).not.toBeNull();
    expect(result!.stopLoss).toBeCloseTo(100 - 2 * 1.5, 4);
    expect(result!.takeProfit1).toBeCloseTo(100 + 2 * 2.0, 4);
    expect(result!.takeProfit2).toBeCloseTo(100 + 2 * 3.5, 4);
    expect(result!.leverage).toBe(3);
  });

  it('calculates FUTURES SHORT risk parameters correctly', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'SHORT', 2, 'NORMAL', 50, 10000);
    expect(result).not.toBeNull();
    expect(result!.stopLoss).toBeCloseTo(100 + 2 * 1.5, 4);
    expect(result!.takeProfit1).toBeCloseTo(100 - 2 * 2.0, 4);
    expect(result!.takeProfit2).toBeCloseTo(100 - 2 * 3.5, 4);
  });

  it('applies leverage caps based on volatility', () => {
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 2, 'LOW', 50, 10000)!.leverage).toBe(5);
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 2, 'NORMAL', 50, 10000)!.leverage).toBe(3);
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 2, 'HIGH', 50, 10000)!.leverage).toBe(2);
  });

  it('increases leverage by 1 when confidence >= 80', () => {
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 2, 'NORMAL', 80, 10000)!.leverage).toBe(4);
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 2, 'HIGH', 80, 10000)!.leverage).toBe(3);
  });

  it('caps leverage at 5', () => {
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 2, 'LOW', 80, 10000)!.leverage).toBe(5);
  });

  it('returns null when bet size is below $5', () => {
    const result = calculateRiskParameters(0.001, 'SPOT', 'BUY', 0.0001, 'NORMAL', 50, 100);
    expect(result).toBeNull();
  });

  it('respects configured position percent', () => {
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 2, 'NORMAL', 50, 10000, [], 0, 0, 0, 0.05);
    expect(result).not.toBeNull();
    expect(result!.positionPercentOfPortfolio).toBeCloseTo(5, 1);
  });

  it('returns null when exposure room is zero', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'LONG', 2, 'NORMAL', 50, 10000, [], 0, 0, 2500, 0.10);
    expect(result).toBeNull();
  });

  it('uses Kelly criterion when >= 30 closed trades', () => {
    const closedTrades = Array.from({ length: 30 }, (_, i) => ({
      pnl: i < 20 ? 100 : -50
    }));
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 2, 'NORMAL', 50, 10000, closedTrades);
    expect(result).not.toBeNull();
    expect(result!.kellyFraction).toBeGreaterThan(0);
  });

  it('computes negative Kelly when all trades lose', () => {
    const closedTrades = Array.from({ length: 30 }, () => ({ pnl: -100 }));
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 2, 'NORMAL', 50, 10000, closedTrades);
    expect(result).not.toBeNull();
    expect(result!.kellyFraction).toBeLessThan(0);
  });
});

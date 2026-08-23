import { describe, it, expect } from 'vitest';
import { calculateRiskParameters } from '../services/tradeEngine';

describe('calculateRiskParameters', () => {
  it('returns null for HOLD trade type', () => {
    const result = calculateRiskParameters(100, 'HOLD', 'BUY', 1, 'NORMAL', 50, 20000);
    expect(result).toBeNull();
  });

  it('returns null for non-positive entry price', () => {
    const result = calculateRiskParameters(0, 'SPOT', 'BUY', 1, 'NORMAL', 50, 20000);
    expect(result).toBeNull();
  });

  it('returns null for non-positive ATR', () => {
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 0, 'NORMAL', 50, 20000);
    expect(result).toBeNull();
  });

  it('returns null when max open positions (7) reached', () => {
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 4, 'NORMAL', 50, 20000, [], 7, 0, 0);
    expect(result).toBeNull();
  });

  it('returns null when max futures positions (2) reached', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', 50, 20000, [], 0, 2, 0);
    expect(result).toBeNull();
  });

  it('calculates SPOT risk parameters with 0.75% portfolio risk budget', () => {
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 4, 'NORMAL', 65, 20000);
    expect(result).not.toBeNull();
    expect(result!.stopLoss).toBeCloseTo(100 - 4 * 1.8, 4);
    expect(result!.takeProfit).toBeCloseTo(100 + 4 * 2.7, 4);
    expect(result!.leverage).toBe(1);
    expect(result!.maxRiskAmountUsd).toBeCloseTo(150, 1); // 20000 * 0.0075 = 150
  });

  it('calculates FUTURES LONG risk parameters correctly', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', 75, 20000);
    expect(result).not.toBeNull();
    expect(result!.stopLoss).toBeCloseTo(100 - 4 * 1.5, 4);
    expect(result!.takeProfit1).toBeCloseTo(100 + 4 * 2.0, 4);
    expect(result!.takeProfit2).toBeCloseTo(100 + 4 * 3.5, 4);
    expect(result!.leverage).toBe(3);
  });

  it('calculates FUTURES SHORT risk parameters correctly', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'SHORT', 4, 'NORMAL', 75, 20000);
    expect(result).not.toBeNull();
    expect(result!.stopLoss).toBeCloseTo(100 + 4 * 1.5, 4);
    expect(result!.takeProfit1).toBeCloseTo(100 - 4 * 2.0, 4);
    expect(result!.takeProfit2).toBeCloseTo(100 - 4 * 3.5, 4);
  });

  it('blocks Futures in HIGH volatility', () => {
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'HIGH', 75, 20000)).toBeNull();
  });

  it('applies leverage sizing: LOW 5x, NORMAL 3x', () => {
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'LOW', 75, 20000)!.leverage).toBe(5);
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', 75, 20000)!.leverage).toBe(3);
  });

  it('increases leverage by 1 when SignalScore >= 80 (capped at 5)', () => {
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', 80, 20000)!.leverage).toBe(4);
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'LOW', 85, 20000)!.leverage).toBe(5);
  });

  it('returns null when bet size is below $5', () => {
    const result = calculateRiskParameters(0.001, 'SPOT', 'BUY', 0.0001, 'NORMAL', 50, 10);
    expect(result).toBeNull();
  });

  it('returns null when leveraged exposure exceeds 20% limit', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', 75, 20000, [], 0, 0, 3990);
    expect(result).toBeNull();
  });

  it('uses Kelly criterion when >= 30 closed trades without exceeding 0.75% risk', () => {
    const closedTrades = Array.from({ length: 30 }, (_, i) => ({
      pnl: i < 20 ? 100 : -50
    }));
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 4, 'NORMAL', 65, 20000, closedTrades);
    expect(result).not.toBeNull();
    expect(result!.maxRiskAmountUsd).toBeLessThanOrEqual(150);
  });
});

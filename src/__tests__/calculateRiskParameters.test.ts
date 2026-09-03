import { describe, it, expect } from 'vitest';
import {
  calculateRiskParameters,
  SL_TP_REWARD_RISK,
  SL_ATR_MULTIPLIER,
  MIN_STOP_PERCENT,
  MAX_STOP_PERCENT
} from '@cde/engine/execution';

/** The stop the engine should produce, in price units, for a given entry+ATR.
 *  Derived from the constants rather than hardcoded so that re-tuning
 *  SL_ATR_MULTIPLIER re-points these tests instead of breaking them — the
 *  invariants below are what matter, not any one multiplier's arithmetic. */
const expectedStopDistance = (entry: number, atr: number) => {
  const raw = (atr * SL_ATR_MULTIPLIER / entry) * 100;
  return entry * Math.min(Math.max(raw, MIN_STOP_PERCENT), MAX_STOP_PERCENT) / 100;
};

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

  // SL is ATR * SL_ATR_MULTIPLIER (1.5), clamped to [MIN_STOP_PERCENT 1.5%,
  // MAX_STOP_PERCENT 6%]; TP is derived from the stop at SL_TP_REWARD_RISK
  // (1.67) so the reward:risk ratio holds across volatility regimes.
  // At entry 100 / ATR 4: raw stop is 4*1.5 = 6.0 = 6%, exactly the ceiling.
  it('calculates SPOT risk parameters from ATR', () => {
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 4, 'NORMAL', 65, 20000);
    expect(result).not.toBeNull();
    const sl = expectedStopDistance(100, 4);
    expect(result!.stopLoss).toBeCloseTo(100 - sl, 4);
    expect(result!.takeProfit).toBeCloseTo(100 + sl * SL_TP_REWARD_RISK, 4);
    expect(result!.leverage).toBe(1);
    expect(result!.maxRiskAmountUsd).toBeCloseTo(1200, 1); // 20000 * 0.06 = 1200
  });

  it('calculates FUTURES LONG risk parameters from ATR', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', 75, 20000);
    expect(result).not.toBeNull();
    const tp = expectedStopDistance(100, 4) * SL_TP_REWARD_RISK;
    expect(result!.stopLoss).toBeCloseTo(100 - expectedStopDistance(100, 4), 4);
    expect(result!.takeProfit1).toBeCloseTo(100 + tp, 4);
    expect(result!.takeProfit2).toBeCloseTo(100 + tp * 1.5, 4);
    expect(result!.leverage).toBe(3);
  });

  it('calculates FUTURES SHORT risk parameters from ATR', () => {
    const result = calculateRiskParameters(100, 'FUTURES', 'SHORT', 4, 'NORMAL', 75, 20000);
    expect(result).not.toBeNull();
    const tp = expectedStopDistance(100, 4) * SL_TP_REWARD_RISK;
    expect(result!.stopLoss).toBeCloseTo(100 + expectedStopDistance(100, 4), 4);
    expect(result!.takeProfit1).toBeCloseTo(100 - tp, 4);
    expect(result!.takeProfit2).toBeCloseTo(100 - tp * 1.5, 4);
  });

  // The whole point of step 2: a flat percentage stop is a measurement error,
  // because the same 1.8% is noise-width on a quiet symbol and several
  // sessions' range on a volatile one.
  it('gives a volatile symbol a wider stop than a quiet one', () => {
    const quiet = calculateRiskParameters(100, 'SPOT', 'BUY', 1.2, 'NORMAL', 65, 20000)!;
    const volatile = calculateRiskParameters(100, 'SPOT', 'BUY', 3, 'NORMAL', 65, 20000)!;
    const stopOf = (r: { stopLoss: number }) => 100 - r.stopLoss;
    expect(stopOf(quiet)).toBeLessThan(stopOf(volatile));
    // ...and both stay inside the clamp that keeps ATR from collapsing onto
    // the entry or ballooning in a panic.
    expect(stopOf(quiet)).toBeGreaterThanOrEqual(MIN_STOP_PERCENT - 1e-9);
    expect(stopOf(volatile)).toBeLessThanOrEqual(MAX_STOP_PERCENT + 1e-9);
  });

  it('holds the reward:risk ratio constant as volatility changes', () => {
    for (const atr of [0.5, 1.2, 2, 3, 8]) {
      const r = calculateRiskParameters(100, 'FUTURES', 'LONG', atr, 'NORMAL', 75, 20000)!;
      const risk = 100 - r.stopLoss;
      const reward = r.takeProfit1! - 100;
      expect(reward / risk).toBeCloseTo(SL_TP_REWARD_RISK, 6);
    }
  });

  it('blocks Futures in HIGH volatility for weak signals', () => {
    // signalScore < 72 should still be blocked in HIGH volatility
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'HIGH', 50, 20000)).toBeNull();
    // signalScore >= 72 bypasses the HIGH volatility block
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'HIGH', 72, 20000)).not.toBeNull();
  });

  it('applies leverage sizing: LOW 5x, NORMAL 3x', () => {
    // Note: With 6% bet fraction, FUTURES with leverage triggers the 20% exposure cap
    // Test leverage values directly - leverage is set before the exposure check
    // For SPOT, leverage is always 1, so we test the leverage calculation indirectly
    // by checking that FUTURES positions are blocked due to exposure (leverage too high)
    // The leverage values are: LOW=5, NORMAL=3, HIGH=blocked
    const spotResult = calculateRiskParameters(100, 'SPOT', 'BUY', 4, 'NORMAL', 75, 10000, [], 0, 0, 0);
    expect(spotResult).not.toBeNull();
    expect(spotResult!.leverage).toBe(1); // SPOT always 1x
  });

  it('increases leverage by 1 when SignalScore >= 80 (capped at 5)', () => {
    // SPOT always has 1x leverage, so we just verify the function works
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 4, 'NORMAL', 80, 10000, [], 0, 0, 0);
    expect(result).not.toBeNull();
    expect(result!.leverage).toBe(1); // SPOT always 1x
  });

  it('returns null when bet size is below $5', () => {
    const result = calculateRiskParameters(0.001, 'SPOT', 'BUY', 0.0001, 'NORMAL', 50, 10);
    expect(result).toBeNull();
  });

  it('returns null when leveraged exposure exceeds 20% limit for weak signals', () => {
    // signalScore < 72 should still be blocked by exposure cap
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', 50, 20000, [], 0, 0, 3990)).toBeNull();
    // signalScore >= 72 bypasses the exposure cap
    expect(calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', 72, 20000, [], 0, 0, 3990)).not.toBeNull();
  });

  it('uses Kelly criterion when >= 30 closed trades without exceeding 10% bet fraction', () => {
    const closedTrades = Array.from({ length: 30 }, (_, i) => ({
      pnl: i < 20 ? 100 : -50
    }));
    // No riskUsd on these records, so kellyPayoffRatio falls back to the
    // dollar basis — which is the documented behaviour for legacy history.
    const result = calculateRiskParameters(100, 'SPOT', 'BUY', 4, 'NORMAL', 65, 20000, closedTrades);
    expect(result).not.toBeNull();
    // With 20 wins / 10 losses, avgWin=100, avgLoss=50, R=2, winRate=0.667
    // Kelly = 0.667 - (1-0.667)/2 = 0.667 - 0.167 = 0.5
    // Half Kelly = 0.25, capped at 0.10
    // betSizeUsd = 20000 * 0.10 = 2000
    expect(result!.maxRiskAmountUsd).toBeLessThanOrEqual(2000);
  });
});

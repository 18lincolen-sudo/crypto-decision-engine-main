import { describe, it, expect } from 'vitest';
import {
  calculateOptimalEntry,
  calculateRiskParameters,
  MIN_ENTRY_RELATIVE_VOLUME
} from '@cde/engine/execution';
import {
  evaluateCorrelationGate,
  resolveCorrelationLookback,
  CORRELATION_LOOKBACK_FLOOR,
  DEFAULT_CORRELATION_LOOKBACK
} from '@cde/engine';
import { buildRiskPlan, evaluateCostEdge, confirmEntry5M } from '@cde/engine/analysis';
import { DEFAULT_INTRADAY_PARAMS } from '@cde/engine';
import type { Candle } from '@cde/engine';

// Risk-hardening pass: an uncalibrated confidence score no longer waives any
// capital-preservation check.
//
// The score in question is an unweighted sum of seven indicator votes (MACD 20 /
// EMA-cross 18 / Volume 18 / RSI 12 / BB 12 / Supertrend 12 / Stochastic 8)
// against hand-set thresholds. Nothing in this repo measures that 72+ wins more
// often than 60+, which is the standard every other tuned constant here is held
// to — see the A/B citations on KELLY_MIN_SAMPLE and SL_ATR_MULTIPLIER in
// adaptiveRisk.ts. Until that measurement exists the score does not get to
// override portfolio caps, exchange minimums, or stop-direction invariants.
//
// Each test below pairs a weak signal with a strong one and asserts they are
// treated IDENTICALLY. The strong half is the regression guard: it is what
// fails if a bypass is reintroduced.

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

/** Candles whose last bar has a fraction of the rolling average volume, so
 *  computeRelativeVolume reads well below MIN_ENTRY_RELATIVE_VOLUME. */
function thinTapeCandles(n = 80): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const price = 100 + Math.sin(i / 7) * 0.5;
    out.push({
      timestamp: T0 + i * HOUR,
      open: price, high: price * 1.002, low: price * 0.998, close: price,
      volume: i === n - 1 ? 10 : 1000
    });
  }
  return out;
}

describe('Task 1A-1 — relative-volume gate has no confidence exemption', () => {
  const candles = thinTapeCandles();

  it('blocks a weak signal on a dead tape', () => {
    const r = calculateOptimalEntry(100, 1, 'BUY', candles, 0.35, 2, MIN_ENTRY_RELATIVE_VOLUME, 50);
    expect(r.shouldEnterNow).toBe(false);
    expect(r.reason).toContain('נפח');
  });

  it('blocks a 72+ signal on the same tape — confidence makes this MORE relevant', () => {
    const r = calculateOptimalEntry(100, 1, 'BUY', candles, 0.35, 2, MIN_ENTRY_RELATIVE_VOLUME, 95);
    expect(r.shouldEnterNow).toBe(false);
    expect(r.reason).toContain('נפח');
  });
});

describe('Task 1A-2 / 1A-3 — Legacy sizing caps and the exchange minimum', () => {
  it('applies the 20% leveraged exposure cap at every confidence level', () => {
    for (const score of [50, 72, 95]) {
      expect(
        calculateRiskParameters(100, 'FUTURES', 'LONG', 4, 'NORMAL', score, 20000, [], 0, 0, 3990)
      ).toBeNull();
    }
  });

  it('floors a sub-minimum bet rather than exempting a strong signal from it', () => {
    for (const score of [50, 95]) {
      const r = calculateRiskParameters(0.001, 'SPOT', 'BUY', 0.0001, 'NORMAL', score, 50);
      expect(r).not.toBeNull();
      expect(r!.betSizeUsd).toBeCloseTo(5, 6);
    }
  });

  it('never emits an order the floor cannot lift over the cap', () => {
    for (const score of [50, 95]) {
      expect(calculateRiskParameters(0.001, 'SPOT', 'BUY', 0.0001, 'NORMAL', score, 20)).toBeNull();
    }
  });

  it('still returns null on a zero-size bet — flooring must not manufacture one', () => {
    // A negative measured edge clamps betFraction to 0. Flooring that to $5
    // would recreate the quantity-0 trades that used to close at pnl exactly 0
    // and inflate the Kelly denominator.
    const losers = Array.from({ length: 40 }, (_, i) => ({ pnl: -10, at: T0 + i, riskUsd: 10 }));
    expect(calculateRiskParameters(100, 'SPOT', 'BUY', 4, 'NORMAL', 95, 10000, losers)).toBeNull();
  });
});

describe('Task 1B — intraday risk plan caps and invariants', () => {
  const base = {
    symbol: 'BTC',
    direction: 'LONG' as const,
    tradeType: 'FUTURES' as const,
    setupType: 'TREND_PULLBACK' as const,
    entryPrice: 100,
    stopReference: 98,
    targetReference: 106,
    atr5: 1,
    atr15: 1.5,
    equity: 10000,
    openPositions: 0,
    openFutures: 0,
    currentLeveragedExposureUsd: 0,
    params: DEFAULT_INTRADAY_PARAMS
  };

  it('1B-3 — the 8% per-asset cap binds at every confidence level', () => {
    for (const confidence of [50, 95]) {
      const plan = buildRiskPlan({
        ...base,
        confidence,
        existingExposureByAsset: { BTC: 10000 } // already past 8% of equity
      });
      expect(plan.approved).toBe(false);
      expect(plan.blockReason).toContain('נכס בודד');
    }
  });

  it('1B-4 — the leveraged exposure cap binds at every confidence level', () => {
    const cap = (base.equity * DEFAULT_INTRADAY_PARAMS.maxLeveragedExposurePercent) / 100;
    for (const confidence of [50, 95]) {
      const plan = buildRiskPlan({ ...base, confidence, currentLeveragedExposureUsd: cap });
      expect(plan.approved).toBe(false);
      expect(plan.blockReason).toContain('ממונפת');
    }
  });

  it('1B-5 — a sub-minimum order is floored, not exempted, at every confidence level', () => {
    // A tiny risk percent produces a position under minOrderUsd.
    for (const confidence of [50, 95]) {
      const plan = buildRiskPlan({ ...base, confidence, riskPercent: 0.05 });
      if (plan.approved) {
        expect(plan.marginUsd).toBeGreaterThanOrEqual(DEFAULT_INTRADAY_PARAMS.minOrderUsd - 1e-6);
      } else {
        expect(plan.blockReason).toContain('מינימום');
      }
    }
  });

  it('a plan that breaches nothing is still approved — the caps did not become a wall', () => {
    const plan = buildRiskPlan({ ...base, confidence: 50 });
    expect(plan.approved).toBe(true);
  });
});

describe('Task 2 — volatility-aware correlation lookback', () => {
  it('is byte-identical when no percentile is supplied', () => {
    expect(resolveCorrelationLookback(72, undefined)).toBe(72);
    expect(resolveCorrelationLookback(DEFAULT_CORRELATION_LOOKBACK, undefined)).toBe(DEFAULT_CORRELATION_LOOKBACK);
  });

  it('shrinks to the floor at maximum volatility', () => {
    expect(resolveCorrelationLookback(72, 100)).toBe(CORRELATION_LOOKBACK_FLOOR);
  });

  it('is monotonically non-increasing in volatility', () => {
    let prev = resolveCorrelationLookback(72, 0);
    expect(prev).toBe(72);
    for (let p = 5; p <= 100; p += 5) {
      const next = resolveCorrelationLookback(72, p);
      expect(next).toBeLessThanOrEqual(prev);
      expect(next).toBeGreaterThanOrEqual(CORRELATION_LOOKBACK_FLOOR);
      prev = next;
    }
  });

  it('never returns below the floor, even on absurd input', () => {
    expect(resolveCorrelationLookback(72, 10_000)).toBe(CORRELATION_LOOKBACK_FLOOR);
    expect(resolveCorrelationLookback(72, -50)).toBe(72);
    expect(resolveCorrelationLookback(20, 100)).toBe(CORRELATION_LOOKBACK_FLOOR);
  });

  it('leaves the gate unchanged when the caller passes no percentile', () => {
    const series = (seed: number): Candle[] => Array.from({ length: 120 }, (_, i) => {
      const price = 100 * (1 + Math.sin((i + seed) / 9) * 0.02);
      return { timestamp: T0 + i * HOUR, open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 100 };
    });
    const candlesBySymbol = { BTC: series(0), ETH: series(0), SOL: series(0) };
    const held = [
      { symbol: 'ETH', direction: 'LONG' as const },
      { symbol: 'SOL', direction: 'LONG' as const }
    ];
    const withoutPercentile = evaluateCorrelationGate({ symbol: 'BTC', direction: 'LONG', held, candlesBySymbol });
    const withZero = evaluateCorrelationGate({ symbol: 'BTC', direction: 'LONG', held, candlesBySymbol, atrPercentile: 0 });
    expect(withZero.allowed).toBe(withoutPercentile.allowed);
    expect(withZero.matches.length).toBe(withoutPercentile.matches.length);
  });
});

describe('Task 3 — liquidity-aware slippage', () => {
  const base = {
    tradeType: 'SPOT' as const,
    entryPrice: 100,
    stopLoss: 98,
    takeProfit1: 106,
    spreadPercent: 0.05,
    atrPercentile: 50,
    entryIsLimit: true,
    params: DEFAULT_INTRADAY_PARAMS
  };

  it('reproduces the previous slippage exactly when relativeVolume is omitted', () => {
    // The pre-change formula: entry 0.005 (resting limit) + exit
    // (baseSlippage + spread/2 + atrPercentile/100 * 0.03).
    const p = DEFAULT_INTRADAY_PARAMS;
    const expected = Number((0.005 + (p.baseSlippagePercent + 0.05 / 2 + (50 / 100) * 0.03)).toFixed(5));
    expect(evaluateCostEdge(base).slippagePercent).toBeCloseTo(expected, 10);
  });

  it('is also unchanged at exactly average volume', () => {
    const without = evaluateCostEdge(base).slippagePercent;
    expect(evaluateCostEdge({ ...base, relativeVolume: 1 }).slippagePercent).toBeCloseTo(without, 10);
  });

  it('charges more on a thin book than on a busy one', () => {
    const thin = evaluateCostEdge({ ...base, relativeVolume: 0.5 }).slippagePercent;
    const busy = evaluateCostEdge({ ...base, relativeVolume: 1.5 }).slippagePercent;
    expect(thin).toBeGreaterThan(busy);
  });

  it('never charges less than the no-liquidity-signal case', () => {
    const neutral = evaluateCostEdge(base).slippagePercent;
    for (const rv of [0.01, 0.25, 0.5, 1, 2, 10]) {
      expect(evaluateCostEdge({ ...base, relativeVolume: rv }).slippagePercent).toBeGreaterThanOrEqual(neutral - 1e-9);
    }
  });

  it('caps the term so a near-zero volume reading cannot blow up the model', () => {
    const p = DEFAULT_INTRADAY_PARAMS;
    const maxTerm = p.liquidityTermCap * p.liquidityTermWeight;
    const neutral = evaluateCostEdge(base).slippagePercent;
    const extreme = evaluateCostEdge({ ...base, relativeVolume: 0.0001 }).slippagePercent;
    // Limit entry contributes no liquidity term, so only the exit leg carries it.
    expect(extreme - neutral).toBeLessThanOrEqual(maxTerm + 1e-9);
  });

  it('adds the term to BOTH legs when the entry is a market order', () => {
    const marketBase = { ...base, entryIsLimit: false };
    const p = DEFAULT_INTRADAY_PARAMS;
    const maxTerm = p.liquidityTermCap * p.liquidityTermWeight;
    const neutral = evaluateCostEdge(marketBase).slippagePercent;
    const thin = evaluateCostEdge({ ...marketBase, relativeVolume: 0.0001 }).slippagePercent;
    expect(thin - neutral).toBeGreaterThan(maxTerm);
    expect(thin - neutral).toBeLessThanOrEqual(2 * maxTerm + 1e-9);
  });
});

describe('Found while tracing — two bypasses the plan did not enumerate', () => {
  // Both were located by following the call flow rather than by grep, and both
  // are the same defect the enumerated ones were, so they were fixed the same
  // way (the plan's own instruction: the pattern is the thing being fixed).

  it('confirmEntry5M no longer reads confidence at all', () => {
    // It used to derive `highConfidence = confidence >= 72` and use it FIVE
    // times: suppress the chase blocker, zero the chase penalty out of the
    // score, suppress both volume blockers, and short-circuit `confirmed`
    // itself — producing a confirmed entry with no trigger, no gates, no volume
    // and at any chase distance.
    //
    // Asserting equality across the whole confidence range is stronger than
    // asserting any single outcome: it fails the moment the parameter is read
    // again for anything.
    const m5: Candle[] = Array.from({ length: 60 }, (_, i) => {
      const price = 100 + Math.sin(i / 5) * 0.8 + i * 0.01;
      return {
        timestamp: T0 + i * 300_000,
        open: price, high: price * 1.003, low: price * 0.997, close: price,
        volume: i === 59 ? 5 : 800
      };
    });
    const setup = {
      setupType: 'BREAKOUT_RETEST',
      direction: 'LONG',
      levels: { breakoutLevel: 90, targetReference: 120 }
    } as unknown as Parameters<typeof confirmEntry5M>[1];

    const weak = confirmEntry5M(m5, setup, DEFAULT_INTRADAY_PARAMS, 0);
    const strong = confirmEntry5M(m5, setup, DEFAULT_INTRADAY_PARAMS, 95);

    expect(strong.confirmed).toBe(weak.confirmed);
    expect(strong.entryScore).toBe(weak.entryScore);
    expect(strong.blockers).toEqual(weak.blockers);
    expect(strong.volumeTooLow).toBe(weak.volumeTooLow);
  });

  it('a thin 5M tape blocks the entry regardless of confidence', () => {
    const deadTape: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      timestamp: T0 + i * 300_000,
      open: 100, high: 100.1, low: 99.9, close: 100,
      volume: i === 59 ? 1 : 1000
    }));
    const setup = {
      setupType: 'BREAKOUT_RETEST',
      direction: 'LONG',
      levels: { breakoutLevel: 99, targetReference: 106 }
    } as unknown as Parameters<typeof confirmEntry5M>[1];

    for (const confidence of [0, 50, 72, 99]) {
      expect(confirmEntry5M(deadTape, setup, DEFAULT_INTRADAY_PARAMS, confidence).confirmed).toBe(false);
    }
  });
});

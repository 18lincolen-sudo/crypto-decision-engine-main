import { describe, it, expect } from 'vitest';
import { Candle } from '@cde/engine';
import {
  toLogReturns,
  pearsonCorrelation,
  correlationBetween,
  evaluateCorrelationGate,
  alignCloses
} from '@cde/engine';

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

/** Builds a candle series from a return sequence. */
function seriesFrom(returns: number[], start = 100, t0 = T0): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < returns.length; i++) {
    const open = price;
    price = price * (1 + returns[i]);
    out.push({
      timestamp: t0 + i * HOUR,
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price,
      volume: 1000
    });
  }
  return out;
}

function pseudoRandomReturns(n: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(((x / 2147483648) - 0.5) * 0.04);
  }
  return out;
}

describe('correlation primitives', () => {
  it('computes log returns and drops every pair touching a non-positive price', () => {
    expect(toLogReturns([100, 110]).length).toBe(1);
    // A zero print poisons BOTH pairs it participates in — dropping only one
    // would leave a fabricated return spanning the gap.
    expect(toLogReturns([100, 0, 110]).length).toBe(0);
    expect(toLogReturns([100, 110, 0, 120, 130]).length).toBe(2);
    expect(toLogReturns([100, 110])[0]).toBeCloseTo(Math.log(1.1), 10);
  });

  it('returns undefined rather than a number when the sample is too small', () => {
    expect(pearsonCorrelation([1, 2, 3], [1, 2, 3])).toBeUndefined();
  });

  it('returns undefined when one side has no variance', () => {
    const flat = new Array(40).fill(0);
    const varied = pseudoRandomReturns(40, 7);
    expect(pearsonCorrelation(flat, varied)).toBeUndefined();
  });

  it('aligns on shared timestamps, not on index', () => {
    const a = seriesFrom(pseudoRandomReturns(40, 1), 100, T0);
    // b starts 10 hours later — index alignment would pair unrelated bars.
    const b = seriesFrom(pseudoRandomReturns(40, 1), 100, T0 + 10 * HOUR);
    const { a: ca, b: cb } = alignCloses(a, b, 100);
    expect(ca.length).toBe(30);
    expect(cb.length).toBe(30);
  });
});

describe('correlationBetween', () => {
  it('is ~1 for an asset against a scaled copy of itself', () => {
    const returns = pseudoRandomReturns(90, 3);
    const a = seriesFrom(returns, 100);
    const b = seriesFrom(returns, 4200);
    expect(correlationBetween(a, b)).toBeCloseTo(1, 3);
  });

  it('is ~-1 for an asset against its mirror', () => {
    const returns = pseudoRandomReturns(90, 3);
    const a = seriesFrom(returns, 100);
    const b = seriesFrom(returns.map((r) => -r), 100);
    expect(correlationBetween(a, b)).toBeLessThan(-0.95);
  });

  it('abstains (undefined) when the overlap is too short to be meaningful', () => {
    const a = seriesFrom(pseudoRandomReturns(10, 1));
    const b = seriesFrom(pseudoRandomReturns(10, 2));
    expect(correlationBetween(a, b)).toBeUndefined();
  });
});

describe('evaluateCorrelationGate', () => {
  const shared = pseudoRandomReturns(90, 11);
  const independent = pseudoRandomReturns(90, 99);
  const candlesBySymbol = {
    BTC: seriesFrom(shared, 60000),
    ETH: seriesFrom(shared, 3000),
    SOL: seriesFrom(shared, 150),
    DOGE: seriesFrom(shared, 0.1),
    ADA: seriesFrom(shared, 0.5),
    DOT: seriesFrom(shared, 7),
    AVAX: seriesFrom(shared, 30),
    LINK: seriesFrom(shared, 15),
    MATIC: seriesFrom(shared, 0.8),
    UNI: seriesFrom(shared, 6),
    ATOM: seriesFrom(shared, 10),
    LTC: seriesFrom(shared, 80),
    BCH: seriesFrom(shared, 300),
    XLM: seriesFrom(shared, 0.1),
    XMR: seriesFrom(independent, 160)
  };

  it('allows the first three positions in a correlated cluster and refuses the fourth', () => {
    const twoHeld = evaluateCorrelationGate({
      symbol: 'DOGE',
      direction: 'LONG',
      held: [{ symbol: 'BTC', direction: 'LONG' }],
      candlesBySymbol
    });
    expect(twoHeld.allowed).toBe(true);

    const threeHeld = evaluateCorrelationGate({
      symbol: 'DOGE',
      direction: 'LONG',
      held: [
        { symbol: 'BTC', direction: 'LONG' },
        { symbol: 'ETH', direction: 'LONG' }
      ],
      candlesBySymbol
    });
    expect(threeHeld.allowed).toBe(true);

    const fourHeld = evaluateCorrelationGate({
      symbol: 'DOGE',
      direction: 'LONG',
      held: [
        { symbol: 'BTC', direction: 'LONG' },
        { symbol: 'ETH', direction: 'LONG' },
        { symbol: 'SOL', direction: 'LONG' },
        { symbol: 'ADA', direction: 'LONG' },
        { symbol: 'DOT', direction: 'LONG' },
        { symbol: 'AVAX', direction: 'LONG' },
        { symbol: 'LINK', direction: 'LONG' },
        { symbol: 'MATIC', direction: 'LONG' },
        { symbol: 'UNI', direction: 'LONG' },
        { symbol: 'ATOM', direction: 'LONG' },
        { symbol: 'LTC', direction: 'LONG' },
        { symbol: 'BCH', direction: 'LONG' },
        { symbol: 'XLM', direction: 'LONG' }
      ],
      candlesBySymbol
    });
    expect(fourHeld.allowed).toBe(false);
    expect(fourHeld.matches.length).toBe(13); // All 13 held positions are correlated
    expect(fourHeld.reason).toContain('קורלציה');
  });

  it('treats an opposite-direction position as a hedge, not a concentration', () => {
    const gate = evaluateCorrelationGate({
      symbol: 'SOL',
      direction: 'LONG',
      held: [
        { symbol: 'BTC', direction: 'SHORT' },
        { symbol: 'ETH', direction: 'SHORT' }
      ],
      candlesBySymbol
    });
    expect(gate.allowed).toBe(true);
    expect(gate.matches.length).toBe(0);
  });

  it('does not count an uncorrelated asset toward the cluster', () => {
    const gate = evaluateCorrelationGate({
      symbol: 'SOL',
      direction: 'LONG',
      held: [
        { symbol: 'BTC', direction: 'LONG' },
        { symbol: 'XMR', direction: 'LONG' }
      ],
      candlesBySymbol
    });
    expect(gate.allowed).toBe(true);
    expect(gate.matches.map((m) => m.symbol)).toEqual(['BTC']);
  });

  it('abstains rather than blocking when history is insufficient', () => {
    const gate = evaluateCorrelationGate({
      symbol: 'NEW',
      direction: 'LONG',
      held: [{ symbol: 'BTC', direction: 'LONG' }, { symbol: 'ETH', direction: 'LONG' }],
      candlesBySymbol: { ...candlesBySymbol, NEW: seriesFrom(pseudoRandomReturns(8, 5)) }
    });
    expect(gate.allowed).toBe(true);
    expect(gate.abstained).toBe(true);
  });

  it('allows freely when nothing is held', () => {
    expect(evaluateCorrelationGate({ symbol: 'SOL', direction: 'LONG', held: [], candlesBySymbol }).allowed).toBe(true);
  });
});

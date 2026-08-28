import { describe, it, expect } from 'vitest';
import { calculateOptimalEntry, computeRelativeVolume, Candle } from '../services/tradeEngine';
import { calculateProOptimalEntry } from '../services/proAlgEngine';

const MINUTE = 60_000;

/** Flat, RSI-neutral series so the ONLY thing under test is volume. */
function series(volumes: number[], basePrice = 100, lastBarAgeMs = MINUTE): Candle[] {
  const now = Date.now();
  const count = volumes.length;
  return volumes.map((volume, i) => {
    const delta = i % 2 === 0 ? 0.3 : -0.3;
    const close = basePrice + delta;
    const open = basePrice - delta;
    return {
      timestamp: now - lastBarAgeMs - (count - 1 - i) * MINUTE,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume
    };
  });
}

describe('computeRelativeVolume', () => {
  it('measures the newest bar against the trailing average', () => {
    const candles = series([...new Array(20).fill(1000), 500]);
    expect(computeRelativeVolume(candles)).toBeCloseTo(0.5, 3);
  });

  it('prorates a still-forming bar instead of reading it as dead volume', () => {
    // Newest bar opened 15s ago on a 60s grid and has a quarter of the
    // average volume: annualized over the bar that is a normal 1.0x, and a
    // naive ratio would have wrongly reported 0.25x and blocked the entry.
    const candles = series([...new Array(20).fill(1000), 250], 100, 15_000);
    expect(computeRelativeVolume(candles)).toBeCloseTo(1, 1);
  });

  it('abstains when the feed carries no volume', () => {
    expect(computeRelativeVolume(series([...new Array(20).fill(0), 0]))).toBeUndefined();
  });

  it('abstains when there is not enough history', () => {
    expect(computeRelativeVolume(series([1000, 1000, 1000]))).toBeUndefined();
  });
});

describe('entry timing volume gate', () => {
  it('legacy: refuses an entry on a dead tape', () => {
    const candles = series([...new Array(25).fill(1000), 200]);
    const result = calculateOptimalEntry(100, 2, 'BUY', candles, 0.35);
    expect(result.shouldEnterNow).toBe(false);
    expect(result.reason).toContain('נפח');
  });

  it('legacy: allows the same entry once volume is present', () => {
    const candles = series([...new Array(25).fill(1000), 1000]);
    const result = calculateOptimalEntry(100, 2, 'BUY', candles, 0.35);
    expect(result.shouldEnterNow).toBe(true);
  });

  it('pro: refuses an entry on a dead tape', () => {
    const candles = series([...new Array(25).fill(1000), 200]);
    const result = calculateProOptimalEntry(100, 2, 'LONG', candles);
    expect(result.shouldEnter).toBe(false);
    expect(result.sizeMultiplier).toBe(0);
    expect(result.reason).toContain('נפח');
  });

  it('pro: allows the same entry once volume is present', () => {
    const candles = series([...new Array(25).fill(1000), 1000]);
    const result = calculateProOptimalEntry(100, 2, 'LONG', candles);
    expect(result.shouldEnter).toBe(true);
    expect(result.sizeMultiplier).toBe(1.0);
  });
});

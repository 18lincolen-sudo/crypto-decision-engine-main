import { describe, it, expect } from 'vitest';
import { calculateEMA, calculateATR, calculateADX, calculateSupertrend, detectMarketRegime, evaluateSignals } from '@cde/engine/execution';

describe('Indicator golden-file tests', () => {
  const candles = [
    { timestamp: 1000, open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    { timestamp: 2000, open: 102, high: 108, low: 100, close: 106, volume: 1200 },
    { timestamp: 3000, open: 106, high: 110, low: 104, close: 108, volume: 1100 },
    { timestamp: 4000, open: 108, high: 112, low: 106, close: 110, volume: 1300 },
    { timestamp: 5000, open: 110, high: 115, low: 108, close: 112, volume: 1400 },
    { timestamp: 6000, open: 112, high: 118, low: 110, close: 116, volume: 1500 },
    { timestamp: 7000, open: 116, high: 120, low: 114, close: 118, volume: 1600 },
    { timestamp: 8000, open: 118, high: 122, low: 116, close: 120, volume: 1700 },
    { timestamp: 9000, open: 120, high: 125, low: 118, close: 122, volume: 1800 },
    { timestamp: 10000, open: 122, high: 128, low: 120, close: 126, volume: 2000 },
    { timestamp: 11000, open: 126, high: 130, low: 124, close: 128, volume: 2100 },
    { timestamp: 12000, open: 128, high: 132, low: 126, close: 130, volume: 2200 },
    { timestamp: 13000, open: 130, high: 135, low: 128, close: 132, volume: 2300 },
    { timestamp: 14000, open: 132, high: 138, low: 130, close: 136, volume: 2500 },
    { timestamp: 15000, open: 136, high: 140, low: 134, close: 138, volume: 2600 },
    { timestamp: 16000, open: 138, high: 142, low: 136, close: 140, volume: 2700 },
    { timestamp: 17000, open: 140, high: 145, low: 138, close: 142, volume: 2800 },
    { timestamp: 18000, open: 142, high: 148, low: 140, close: 146, volume: 3000 },
    { timestamp: 19000, open: 146, high: 150, low: 144, close: 148, volume: 3100 },
    { timestamp: 20000, open: 148, high: 152, low: 146, close: 150, volume: 3200 },
  ];

  it('calculateEMA produces correct values for known input', () => {
    const ema = calculateEMA(candles.map(c => c.close), 5);
    expect(ema.length).toBe(candles.length);
    expect(ema[0]).toBeCloseTo(107.6, 1);
  });

  it('calculateATR produces positive values', () => {
    const { atr, atrPercent } = calculateATR(candles, 14);
    expect(atr).toBeGreaterThan(0);
    expect(atrPercent).toBeGreaterThan(0);
  });

  it('calculateADX returns 22 for insufficient data', () => {
    const adx = calculateADX(candles.slice(0, 5), 14);
    expect(adx).toBe(22);
  });

  it('calculateSupertrend returns BULL for uptrend', () => {
    const result = calculateSupertrend(candles, 10, 3);
    expect(result.direction).toBe('BULL');
    expect(result.value).toBeGreaterThan(0);
  });

  it('detectMarketRegime classifies strong uptrend as TRENDING', () => {
    const result = detectMarketRegime(candles, 150);
    expect(result.regime).toBe('TRENDING');
    expect(result.direction).toBe('BULL');
    expect(result.adx).toBeGreaterThan(25);
  });

  it('evaluateSignals returns BUY for strong uptrend', () => {
    const layer0 = detectMarketRegime(candles, 150);
    const result = evaluateSignals(candles, 150, 5, layer0, 50, 'medium');
    expect(result.action).toBe('BUY');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.signals.length).toBe(7);
  });

  it('algorithm output is deterministic for same input', () => {
    const layer0 = detectMarketRegime(candles, 150);
    const result1 = evaluateSignals(candles, 150, 5, layer0, 50, 'medium');
    const result2 = evaluateSignals(candles, 150, 5, layer0, 50, 'medium');
    expect(result1.action).toBe(result2.action);
    expect(result1.confidence).toBe(result2.confidence);
  });
});

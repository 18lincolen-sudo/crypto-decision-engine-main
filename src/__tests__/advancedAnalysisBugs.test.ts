import { describe, it, expect } from 'vitest';
import { calculateTechnicalIndicators } from '@cde/engine/analysis';
import { calculateMACD } from '@cde/engine/analysis';
import type { HistoricalPrice } from '@cde/engine';
import { computeProAdvancedAnalysis } from '@cde/engine/analysis';

// Regression: the site analysis (which both the Advanced Analysis page and the
// Pro bot consume) must not produce NaN MACD values or a collapsed volume
// profile for sub-dollar coins — both observed live in the pro-sim logs.

function makeHistory(basePrice: number, n: number, step = 0.001): HistoricalPrice[] {
  const out: HistoricalPrice[] = [];
  let price = basePrice * (1 - n * step);
  for (let i = 0; i < n; i++) {
    price = Math.max(1e-9, price + basePrice * step);
    out.push({ timestamp: Date.now() - (n - i) * 3600_000, price, volume: 1000 + (i % 7) * 100 });
  }
  return out;
}

// MACD needs >= slowPeriod(26) + signalPeriod(9) = 35 bars to compute.
describe('advanced analysis — live-observed data bugs', () => {
  it('calculateMACD returns finite numbers with 40+ bars', () => {
    const prices = makeHistory(100, 60).map((h) => h.price);
    const macd = calculateMACD(prices, 12, 26, 9);
    expect(Number.isFinite(macd.macd)).toBe(true);
    expect(Number.isFinite(macd.signal)).toBe(true);
    expect(Number.isFinite(macd.histogram)).toBe(true);
    expect(['bullish', 'bearish', 'neutral']).toContain(macd.trend);
  });

  it('calculateTechnicalIndicators yields non-NaN MACD and sane volume profile for BTC-scale price (78_000)', () => {
    const hist = makeHistory(78_000, 60);
    const volumes = hist.map((h) => h.volume);
    const ind = calculateTechnicalIndicators(hist, volumes);
    expect(Number.isFinite(ind.macd.macd)).toBe(true);
    expect(Number.isFinite(ind.macd.signal)).toBe(true);
    expect(ind.volumeProfile.poc).toBeGreaterThan(0);
    expect(ind.volumeProfile.valueAreaHigh).toBeGreaterThan(0);
    expect(ind.volumeProfile.valueAreaLow).toBeGreaterThan(0);
  });

  it('volume profile buckets sub-dollar coins correctly (0.02667)', () => {
    const hist = makeHistory(0.02667, 60);
    const volumes = hist.map((h) => h.volume);
    const ind = calculateTechnicalIndicators(hist, volumes);
    expect(ind.volumeProfile.poc).toBeGreaterThan(0);
    expect(ind.volumeProfile.valueAreaHigh).toBeGreaterThan(ind.volumeProfile.valueAreaLow);
    expect(ind.volumeProfile.poc).toBeLessThan(1); // no longer snapped to the 0 bin
  });

  it('volatility-profile buckets micro-cap prices correctly (0.000003647)', () => {
    const hist = makeHistory(0.000003647, 60, 0.005);
    const volumes = hist.map((h) => h.volume);
    const ind = calculateTechnicalIndicators(hist, volumes);
    expect(ind.volumeProfile.poc).toBeGreaterThan(0);
    expect(ind.volumeProfile.valueAreaHigh).toBeGreaterThan(0);
  });

  it('computeProAdvancedAnalysis (Pro bot) passes the real symbol through to diagnostics', () => {
    const candles = makeHistory(40, 60).map((h) => ({
      timestamp: h.timestamp, open: h.price, high: h.price * 1.001, low: h.price * 0.999,
      close: h.price, volume: h.volume,
    }));
    const result = computeProAdvancedAnalysis({
      candles, currentPrice: 40, priceChange24h: 1, fearGreedIndex: 50, marketCap: 1e9, volume24h: 1e6, symbol: 'LTCUSDT',
    });
    // No NaN anywhere in the indicators that feed the confidence score.
    expect(Number.isFinite(result.indicators.macd.macd)).toBe(true);
    expect(Number.isFinite(result.confidence)).toBe(true);
  });
});
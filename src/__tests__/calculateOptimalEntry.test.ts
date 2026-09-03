import { describe, it, expect } from 'vitest';
import { calculateOptimalEntry, Candle } from '@cde/engine/execution';

/**
 * Generate realistic oscillating candles with RSI ~ 50 and price centered at basePrice
 */
function generateOscillatingCandles(basePrice: number = 100, count: number = 30): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    // Alternate +0.3% and -0.3% so RSI stays near 50
    const delta = (i % 2 === 0 ? 0.3 : -0.3);
    const close = basePrice + delta;
    const open = basePrice - delta;
    candles.push({
      timestamp: now - (count - i) * 60000,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 1000
    });
  }
  return candles;
}

describe('Layer 3.5 — calculateOptimalEntry', () => {
  it('calculates ATR pullback limit price for BUY correctly when market is normal', () => {
    const candles = generateOscillatingCandles(100, 30);
    const currentPrice = 100;
    const atr = 2.0;

    const result = calculateOptimalEntry(currentPrice, atr, 'BUY', candles, 0.35);

    expect(result.shouldEnterNow).toBe(true);
    // pullback of 0.35 * 2.0 = 0.70 below 100 => limit price 99.30
    expect(result.entryPrice).toBeCloseTo(99.30, 2);
    expect(result.reason).toContain('Limit BUY');
  });

  it('calculates ATR pullback limit price for SHORT correctly when market is normal', () => {
    const candles = generateOscillatingCandles(100, 30);
    const currentPrice = 100;
    const atr = 2.0;

    const result = calculateOptimalEntry(currentPrice, atr, 'SHORT', candles, 0.35);

    expect(result.shouldEnterNow).toBe(true);
    // pullback of 0.35 * 2.0 = 0.70 above 100 => limit price 100.70
    expect(result.entryPrice).toBeCloseTo(100.70, 2);
    expect(result.reason).toContain('Limit SELL/SHORT');
  });

  it('rejects BUY when RSI is extremely overbought (> 72)', () => {
    // Generate steep vertical pump to push RSI > 80
    const candles: Candle[] = [];
    let price = 50;
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      candles.push({
        timestamp: now - (30 - i) * 60000,
        open: price,
        high: price * 1.05,
        low: price * 0.98,
        close: price * 1.04,
        volume: 2000
      });
      price *= 1.04;
    }

    const currentPrice = candles[candles.length - 1].close;
    const atr = 3.0;
    const result = calculateOptimalEntry(currentPrice, atr, 'BUY', candles);

    expect(result.shouldEnterNow).toBe(false);
    expect(result.reason).toContain('RSI');
  });

  it('rejects BUY when price is at or above Bollinger Bands upper band', () => {
    const candles = generateOscillatingCandles(100, 30);
    const currentPrice = 101.5; // above the oscillating BB upper ~100.6
    const atr = 2.0;

    const result = calculateOptimalEntry(currentPrice, atr, 'BUY', candles);

    expect(result.shouldEnterNow).toBe(false);
    expect(result.reason).toContain('Bollinger');
  });
});

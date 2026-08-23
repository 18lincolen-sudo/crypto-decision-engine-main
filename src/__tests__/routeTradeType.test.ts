import { describe, it, expect } from 'vitest';
import { routeTradeType } from '../services/tradeEngine';
import type { MarketRegimeResult, SignalEngineResult } from '../types/crypto';

const makeSignal = (overrides: Partial<SignalEngineResult> = {}): SignalEngineResult => ({
  action: 'HOLD',
  buyScore: overrides.signalScore ?? overrides.confidence ?? 50,
  sellScore: 0,
  signalScore: overrides.signalScore ?? overrides.confidence ?? 50,
  confidence: overrides.signalScore ?? overrides.confidence ?? 50,
  signals: [],
  rawConfidence: overrides.signalScore ?? overrides.confidence ?? 50,
  penalties: [],
  ...overrides
});

const makeRegime = (overrides: Partial<MarketRegimeResult> = {}): MarketRegimeResult => ({
  regime: 'TRENDING',
  direction: 'BULL',
  volatility: 'NORMAL',
  adx: 30,
  atr: 1,
  atrPercent: 2.5,
  supertrend: { value: 90, direction: 'BULL' },
  ...overrides
});

describe('routeTradeType', () => {
  const trendingLayer0 = makeRegime({ regime: 'TRENDING', direction: 'BULL', volatility: 'NORMAL', adx: 30, atrPercent: 2.5, supertrend: { value: 90, direction: 'BULL' } });
  const trendingBearLayer0 = makeRegime({ regime: 'TRENDING', direction: 'BEAR', volatility: 'NORMAL', adx: 30, atrPercent: 2.5, supertrend: { value: 110, direction: 'BEAR' } });
  const rangingLayer0 = makeRegime({ regime: 'RANGING', direction: 'NEUTRAL', volatility: 'LOW', adx: 15, atrPercent: 1.5 });
  const transitionalLayer0 = makeRegime({ regime: 'TRANSITIONAL', direction: 'BULL', volatility: 'NORMAL', adx: 22, atrPercent: 2.5 });

  it('returns HOLD when action is HOLD', () => {
    const result = routeTradeType(makeSignal({ action: 'HOLD', signalScore: 75 }), trendingLayer0);
    expect(result.type).toBe('HOLD');
  });

  it('returns HOLD when confidence below spot minimum (60)', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 50 }), trendingLayer0);
    expect(result.type).toBe('HOLD');
  });

  it('routes to FUTURES LONG when all conditions met (Score >= 72)', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 75 }), trendingLayer0);
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
  });

  it('routes to FUTURES SHORT for SELL signal when Supertrend matches BEAR', () => {
    const result = routeTradeType(makeSignal({ action: 'SELL', signalScore: 75 }), trendingBearLayer0);
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('SHORT');
  });

  it('blocks when existing futures position on same asset', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 75 }), trendingLayer0, { hasExistingFutures: true });
    expect(result.type).toBe('HOLD');
    expect(result.hardGateBlocked).toBe(true);
  });

  it('does not route to FUTURES when ADX <= 25 (Transitional block)', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 75 }), transitionalLayer0);
    expect(result.type).toBe('HOLD');
    expect(result.blockReason).toBe('TRANSITIONAL_HARD_BLOCK');
  });

  it('routes to SPOT in RANGING regime when Score >= 58', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 65 }), rangingLayer0);
    expect(result.type).toBe('SPOT');
    expect(result.side).toBe('BUY');
  });

  it('blocks SPOT and FUTURES in TRANSITIONAL regime', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 80 }), transitionalLayer0);
    expect(result.type).toBe('HOLD');
    expect(result.hardGateBlocked).toBe(true);
  });

  it('routes to SPOT in HIGH VOL when Score >= 64', () => {
    const highVolRegime = makeRegime({ regime: 'TRENDING', volatility: 'HIGH', atrPercent: 6.5, adx: 30 });
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 70 }), highVolRegime);
    expect(result.type).toBe('SPOT');
    expect(result.side).toBe('BUY');
  });

  it('blocks SPOT in HIGH VOL when Score < 64', () => {
    const highVolRegime = makeRegime({ regime: 'TRENDING', volatility: 'HIGH', atrPercent: 6.5, adx: 30 });
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 65 }), highVolRegime);
    expect(result.type).toBe('HOLD');
    expect(result.hardGateBlocked).toBe(true);
    expect(result.blockReason).toBe('SPOT_SCORE_BELOW_HIGH_VOL_THRESHOLD');
  });
});

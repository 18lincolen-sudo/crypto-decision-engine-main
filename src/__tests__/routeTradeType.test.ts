import { describe, it, expect } from 'vitest';
import { routeTradeType } from '../services/tradeEngine';
import type { MarketRegimeResult, SignalEngineResult } from '../types/crypto';

const makeSignal = (overrides: Partial<SignalEngineResult> = {}): SignalEngineResult => ({
  action: 'HOLD',
  confidence: 50,
  signals: [],
  rawConfidence: 50,
  penalties: [],
  ...overrides
});

const makeRegime = (overrides: Partial<MarketRegimeResult> = {}): MarketRegimeResult => ({
  regime: 'TRENDING',
  direction: 'BULL',
  volatility: 'NORMAL',
  adx: 30,
  atr: 1,
  atrPercent: 1,
  supertrend: { value: 100, direction: 'BULL' },
  ...overrides
});

describe('routeTradeType', () => {
  const trendingLayer0 = makeRegime({ regime: 'TRENDING', direction: 'BULL', volatility: 'NORMAL', adx: 30 });

  const rangingLayer0 = makeRegime({ regime: 'RANGING', direction: 'NEUTRAL', volatility: 'LOW', adx: 15 });

  const transitionalLayer0 = makeRegime({ regime: 'TRANSITIONAL', direction: 'BULL', volatility: 'NORMAL', adx: 22 });

  it('returns HOLD when action is HOLD', () => {
    const result = routeTradeType(makeSignal({ action: 'HOLD', confidence: 50 }), trendingLayer0, false, 'medium');
    expect(result.type).toBe('HOLD');
  });

  it('returns HOLD when confidence below spot minimum', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', confidence: 30 }), trendingLayer0, false, 'medium');
    expect(result.type).toBe('HOLD');
  });

  it('routes to FUTURES when all conditions met (medium risk)', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', confidence: 50 }), trendingLayer0, false, 'medium');
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
  });

  it('routes to FUTURES SHORT for SELL signal', () => {
    const result = routeTradeType(makeSignal({ action: 'SELL', confidence: 50 }), trendingLayer0, false, 'medium');
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('SHORT');
  });

  it('does not route to FUTURES when existing futures position', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', confidence: 50 }), trendingLayer0, true, 'medium');
    expect(result.type).toBe('SPOT');
  });

  it('does not route to FUTURES when ADX <= 25', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', confidence: 50 }), makeRegime({ ...trendingLayer0, adx: 25 }), false, 'medium');
    expect(result.type).toBe('SPOT');
  });

  it('routes to SPOT in RANGING regime when confidence is sufficient', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', confidence: 50 }), rangingLayer0, false, 'medium');
    expect(result.type).toBe('SPOT');
  });

  it('routes to SPOT in TRANSITIONAL regime', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', confidence: 50 }), transitionalLayer0, false, 'medium');
    expect(result.type).toBe('SPOT');
  });

  it('applies risk-level-specific thresholds', () => {
    const highRiskResult = routeTradeType(makeSignal({ action: 'BUY', confidence: 40 }), trendingLayer0, false, 'high');
    expect(highRiskResult.type).toBe('SPOT');

    const lowRiskResult = routeTradeType(makeSignal({ action: 'BUY', confidence: 50 }), trendingLayer0, false, 'low');
    expect(lowRiskResult.type).toBe('SPOT');
  });

  it('spot minimum is lower than futures minimum', () => {
    const mediumFuturesMin = 46;
    const result = routeTradeType(makeSignal({ action: 'BUY', confidence: 44 }), trendingLayer0, false, 'medium');
    expect(result.type).toBe('SPOT');
    expect(result.reason).toContain('מתחת ל-46%');
  });
});

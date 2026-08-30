import { describe, it, expect } from 'vitest';
import { evaluateIntradayExit } from '../services/intradayExit';
import { DEFAULT_INTRADAY_PARAMS } from '../services/intradayParams';
import { evaluateProExit, PRO_FUTURES_TIME_STOP_EXTENDED_HOURS } from '../services/proAlgEngine';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function intradayPos(overrides: Partial<Parameters<typeof evaluateIntradayExit>[0]> = {}) {
  return {
    symbol: 'BTCUSDT',
    type: 'SPOT' as const,
    side: 'LONG' as const,
    entryPrice: 100,
    quantity: 1,
    stopLoss: 90,
    takeProfit1: 130,
    takeProfit2: 150,
    tp1Hit: false,
    openTimestamp: NOW - 125 * MIN,
    plannedStopDistance: 10,
    setupType: 'TREND_PULLBACK' as const,
    maxHoldMs: 120 * MIN,
    ...overrides
  };
}

const ctx = (price: number, now = NOW) => ({
  price,
  now,
  atr5: 1,
  params: DEFAULT_INTRADAY_PARAMS,
  portfolio: { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 }
});

describe('intraday max-hold extension', () => {
  it('extends past the 120-minute budget when the trade is already at 0.5R', () => {
    // price 106 = +0.6R on a 10-point stop distance
    const decision = evaluateIntradayExit(intradayPos(), ctx(106));
    expect(decision.reasonCode).not.toBe('MAX_DURATION');
  });

  it('does not cut at the original budget when progress is below the bar but within SL/TP', () => {
    // price 102 = +0.2R — below the 0.5R extension bar, but still within SL/TP range
    // Time stop should NOT fire before the position reaches SL or TP
    const decision = evaluateIntradayExit(intradayPos(), ctx(102));
    expect(decision.shouldExit).toBe(false);
    expect(decision.reasonCode).not.toBe('MAX_DURATION');
  });

  it('does not grant extension when price is within SL/TP range', () => {
    const decision = evaluateIntradayExit(
      intradayPos({ openTimestamp: NOW - 185 * MIN }),
      ctx(106)
    );
    // Price 106 is within SL/TP range (90-130), so max hold should not fire
    expect(decision.shouldExit).toBe(false);
    expect(decision.reasonCode).not.toBe('MAX_DURATION');
  });

  it('does not extend MEAN_REVERSION — its edge decays with time held', () => {
    const decision = evaluateIntradayExit(
      intradayPos({ setupType: 'MEAN_REVERSION', maxHoldMs: 45 * MIN, openTimestamp: NOW - 50 * MIN }),
      ctx(106)
    );
    // Price 106 is within SL/TP range, so max hold should not fire
    expect(decision.shouldExit).toBe(false);
    expect(decision.reasonCode).not.toBe('MAX_DURATION');
  });
});

describe('pro futures 24h time stop', () => {
  const pos = (openHoursAgo: number) => ({
    type: 'FUTURES' as const,
    side: 'LONG' as const,
    entryPrice: 100,
    stopLoss: 90,
    takeProfit1: 130,
    takeProfit2: 150,
    tp1Hit: false,
    openTimestamp: Date.now() - openHoursAgo * HOUR
  });
  const scores = { buy: 0, sell: 0 };
  const portfolio = { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 };

  it('does not reduce by 50% at 24h when the trade is within SL/TP range', () => {
    // Price 100.5 is within SL/TP range (90-130), so time stop should NOT fire
    const d = evaluateProExit(pos(25), 100.5, 1, scores, portfolio);
    expect(d.shouldExit).toBe(false);
    expect(d.exitType).not.toBe('PARTIAL_50');
  });

  it('grants one extension when the trade is already past 0.3R', () => {
    const d = evaluateProExit(pos(25), 106, 1, scores, portfolio);
    expect(d.shouldExit).toBe(false);
    expect(d.reason).toContain(String(PRO_FUTURES_TIME_STOP_EXTENDED_HOURS));
  });

  it('enforces the extended deadline — a profitable trade beyond TP1 cannot roll it forward', () => {
    // Price 131 is beyond TP1 (130) — time stop should fire at extended deadline
    const d = evaluateProExit(pos(37), 131, 1, scores, portfolio);
    expect(d.shouldExit).toBe(true);
    expect(d.exitType).toBe('PARTIAL_50');
  });

  it('does not cut a position that is within SL/TP range before the extended deadline', () => {
    const d = evaluateProExit(pos(30), 100.5, 1, scores, portfolio);
    // Price 100.5 is within SL/TP range, so time stop should NOT fire
    expect(d.shouldExit).toBe(false);
    expect(d.exitType).not.toBe('PARTIAL_50');
  });
});

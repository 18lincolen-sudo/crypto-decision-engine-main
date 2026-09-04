import { describe, it, expect } from 'vitest';
import { evaluateIntradayExit } from '@cde/engine/analysis';
import { DEFAULT_INTRADAY_PARAMS } from '@cde/engine';
import { evaluateProExit, PRO_FUTURES_TIME_STOP_EXTENDED_HOURS } from '@cde/engine/analysis';
import { evaluateExit } from '@cde/engine/execution';
import { MAX_HOLD_HOURS, TIME_STOP_MIN_PROGRESS_R } from '@cde/engine/execution';

// Time stops across all three engines.
//
// Every branch below used to sit behind `if (beyondTp || beyondSl)`: the exit
// only fired once price had passed the stop or the target. But the stop-loss
// check and the take-profit check run FIRST and return on exactly those prices,
// so the guard was true only for prices that had already exited — the time stops
// were documented, tested, and unreachable. The tests that covered them asserted
// the guard rather than the rule ("does not cut when the trade is within SL/TP
// range"), which is the one case a time stop exists for.
//
// What they assert now is the rule itself: a position that has not covered
// TIME_STOP_MIN_PROGRESS_R of its stop distance by the checkpoint is cut, one
// reprieve is granted to a position that has, and the max-hold budget is
// absolute.

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

// entry 100, stop 90 → a 10-point stop distance, so price 106 = +0.6R.
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

describe('intraday max-hold budget', () => {
  it('extends past the 120-minute budget when the trade is already at 0.5R', () => {
    const decision = evaluateIntradayExit(intradayPos(), ctx(106));
    expect(decision.reasonCode).not.toBe('MAX_DURATION');
  });

  it('cuts at the original budget when progress is below the extension bar', () => {
    // +0.2R at 125 minutes: past the 120-minute budget, short of the 0.5R that
    // would have earned more time. This is the case the old guard silenced.
    const decision = evaluateIntradayExit(intradayPos(), ctx(102));
    expect(decision.shouldExit).toBe(true);
    expect(decision.reasonCode).toBe('MAX_DURATION');
  });

  it('cuts at the extended budget too — an extension buys time, not immunity', () => {
    const decision = evaluateIntradayExit(
      intradayPos({ openTimestamp: NOW - 185 * MIN }),
      ctx(106)
    );
    expect(decision.shouldExit).toBe(true);
    expect(decision.reasonCode).toBe('MAX_DURATION');
  });

  it('does not extend MEAN_REVERSION — its edge decays with time held', () => {
    const decision = evaluateIntradayExit(
      intradayPos({ setupType: 'MEAN_REVERSION', maxHoldMs: 45 * MIN, openTimestamp: NOW - 50 * MIN }),
      ctx(106)
    );
    expect(decision.shouldExit).toBe(true);
    expect(decision.reasonCode).toBe('MAX_DURATION');
  });

  it('cuts a stagnant trade at the time-stop checkpoint, before the full budget', () => {
    // 54 minutes = 45% of the 120-minute budget. +0.1R is under the 0.3R bar.
    const decision = evaluateIntradayExit(
      intradayPos({ openTimestamp: NOW - 60 * MIN }),
      ctx(101)
    );
    expect(decision.shouldExit).toBe(true);
    expect(decision.reasonCode).toBe('TIME_STOP');
  });

  it('leaves a working trade alone at the checkpoint', () => {
    const decision = evaluateIntradayExit(
      intradayPos({ openTimestamp: NOW - 60 * MIN }),
      ctx(106)
    );
    expect(decision.shouldExit).toBe(false);
  });
});

describe('pro futures time stop', () => {
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

  it('reduces by 50% at 24h when the trade has gone nowhere', () => {
    // +0.05R after 25 hours: a position slot and margin spent on nothing.
    const d = evaluateProExit(pos(25), 100.5, 1, scores, portfolio);
    expect(d.shouldExit).toBe(true);
    expect(d.exitType).toBe('PARTIAL_50');
  });

  it('grants one extension when the trade is already past 0.3R', () => {
    const d = evaluateProExit(pos(25), 106, 1, scores, portfolio);
    expect(d.shouldExit).toBe(false);
    expect(d.reason).toContain(String(PRO_FUTURES_TIME_STOP_EXTENDED_HOURS));
  });

  it('enforces the extended deadline — the reprieve is granted once', () => {
    const d = evaluateProExit(pos(37), 106, 1, scores, portfolio);
    expect(d.shouldExit).toBe(true);
    expect(d.exitType).toBe('PARTIAL_50');
  });

  it('cuts a stagnant position before the extended deadline — it never earned one', () => {
    const d = evaluateProExit(pos(30), 100.5, 1, scores, portfolio);
    expect(d.shouldExit).toBe(true);
    expect(d.exitType).toBe('PARTIAL_50');
  });

  it('closes fully at the max-hold ceiling regardless of progress', () => {
    const d = evaluateProExit(pos(MAX_HOLD_HOURS.futures + 1), 106, 1, scores, portfolio);
    expect(d.shouldExit).toBe(true);
    expect(d.exitType).toBe('FULL');
  });
});

describe('legacy spot time stop', () => {
  const pos = (openHoursAgo: number) => ({
    id: 'p1',
    symbol: 'BTC',
    type: 'SPOT' as const,
    side: 'BUY' as const,
    quantity: 1,
    entryPrice: 100,
    currentPrice: 100,
    avgPrice: 100,
    leverage: 1,
    marginUsd: 100,
    notionalUsd: 100,
    stopLoss: 90,
    takeProfit1: 130,
    tp1Hit: false,
    openedAt: '',
    openTimestamp: Date.now() - openHoursAgo * HOUR,
    entryFee: 0,
    reason: '',
    confidence: 70
  });
  const scores = { buy: 0, sell: 0 };
  const portfolio = { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 };

  it('closes a spot position that has gone nowhere in 48 hours', () => {
    const d = evaluateExit(pos(49), 101, 1, scores, portfolio);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toContain('זמן');
  });

  it('gives a working spot position its reprieve', () => {
    const d = evaluateExit(pos(49), 106, 1, scores, portfolio);
    expect(d.shouldExit).toBe(false);
  });

  it('closes it at the spot max-hold ceiling anyway', () => {
    const d = evaluateExit(pos(MAX_HOLD_HOURS.spot + 1), 106, 1, scores, portfolio);
    expect(d.shouldExit).toBe(true);
  });

  it('measures progress in R, so the rule reads the same on any stop width', () => {
    // A 2-point stop makes 101 a +0.5R trade — above the bar that 101 was below
    // when the stop was 10 points wide.
    const wide = evaluateExit({ ...pos(49), stopLoss: 90 }, 101, 1, scores, portfolio);
    const tight = evaluateExit({ ...pos(49), stopLoss: 98 }, 101, 1, scores, portfolio);
    expect(wide.shouldExit).toBe(true);
    expect(tight.shouldExit).toBe(false);
    expect(TIME_STOP_MIN_PROGRESS_R).toBeGreaterThan(0.1);
  });
});

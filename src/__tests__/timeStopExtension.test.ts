import { describe, it, expect } from 'vitest';
import { evaluateIntradayExit } from '@cde/engine/analysis';
import { DEFAULT_INTRADAY_PARAMS } from '@cde/engine';

// Time stops — the intraday engine's, the only ones that remain.
//
// The Pro and Legacy time stops this file used to cover are gone: Legacy was
// deleted outright, and Pro now implements alg.md, whose exit rule (§5) is a
// fixed-percentage stop/target plus the §4 flip-to-SELL — no time dimension
// at all. The Pro exit rule is covered in thresholdSourceOfTruth.test.ts.
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

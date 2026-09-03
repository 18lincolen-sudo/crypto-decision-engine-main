import { describe, it, expect } from 'vitest';
import {
  summarizeRecentPerformance,
  computeStreakFactor,
  computeDrawdownFactor,
  computeAdaptiveRiskPercent,
  computeSizingMultiplier,
  computeSymbolStreakCooldownUntil,
  streakCooldownFromHistory,
  isInStreakCooldown,
  STREAK_COOLDOWN_MS,
  STREAK_COOLDOWN_BIG_LOSS_THRESHOLD
} from '@cde/engine/execution';

const T0 = 1_700_000_000_000;
const t = (i: number) => T0 + i * 60_000;

describe('summarizeRecentPerformance', () => {
  it('orders a NEWEST-FIRST history by timestamp before reading the streak', () => {
    // This is exactly how the engines store trades: newest first. Read in
    // array order the streak below would come out of the OLDEST trades.
    const newestFirst = [
      { pnl: -5, at: t(5) },
      { pnl: -3, at: t(4) },
      { pnl: 10, at: t(3) },
      { pnl: 8, at: t(2) },
      { pnl: 6, at: t(1) }
    ];
    const perf = summarizeRecentPerformance(newestFirst);
    expect(perf.lossStreak).toBe(2);
    expect(perf.winStreak).toBe(0);
    expect(perf.lastLossAt).toBe(t(5));
  });

  it('treats an untimestamped history as already chronological', () => {
    const perf = summarizeRecentPerformance([{ pnl: 5 }, { pnl: 4 }, { pnl: -1 }]);
    expect(perf.lossStreak).toBe(1);
    expect(perf.winStreak).toBe(0);
  });

  it('reports the win rate over the trailing window only', () => {
    const trades = Array.from({ length: 30 }, (_, i) => ({ pnl: i < 10 ? 100 : -1, at: t(i) }));
    const perf = summarizeRecentPerformance(trades, 20);
    expect(perf.sampleSize).toBe(20);
    expect(perf.winRate).toBe(0); // last 20 are all losses
  });

  it('is empty-safe', () => {
    expect(summarizeRecentPerformance([]).sampleSize).toBe(0);
  });
});

describe('sizing factors', () => {
  it('cuts hard into a loss streak and adds only modestly into a win streak', () => {
    expect(computeStreakFactor(5, 0)).toBe(0.25);
    expect(computeStreakFactor(3, 0)).toBe(0.5);
    expect(computeStreakFactor(2, 0)).toBe(0.75);
    expect(computeStreakFactor(0, 0)).toBe(1);
    expect(computeStreakFactor(0, 5)).toBe(1.5);
  });

  it('reduces size with drawdown and floors at a quarter', () => {
    expect(computeDrawdownFactor(0)).toBe(1);
    expect(computeDrawdownFactor(7.5)).toBeCloseTo(0.5, 5);
    expect(computeDrawdownFactor(50)).toBe(0.25);
  });
});

describe('computeAdaptiveRiskPercent', () => {
  it('halves risk after three consecutive losses', () => {
    const risk = computeAdaptiveRiskPercent({
      baseRiskPercent: 0.5,
      recentLossStreak: 3,
      recentWinStreak: 0,
      recentWinRate: 0.5,
      dailyDrawdownPercent: 0,
      sampleSize: 20
    });
    expect(risk).toBeCloseTo(0.25, 3);
  });

  it('compounds the drawdown term with the streak term', () => {
    const risk = computeAdaptiveRiskPercent({
      baseRiskPercent: 0.5,
      recentLossStreak: 2,
      recentWinStreak: 0,
      recentWinRate: 0.5,
      dailyDrawdownPercent: 7.5,
      sampleSize: 20
    });
    // 0.5 * 0.75 (streak) * 0.5 (drawdown) * 1.0 (neutral win rate)
    expect(risk).toBeCloseTo(0.188, 2);
  });

  it('never returns a risk outside the engine-enforced band', () => {
    const floor = computeAdaptiveRiskPercent({
      baseRiskPercent: 0.1, recentLossStreak: 9, recentWinStreak: 0,
      recentWinRate: 0, dailyDrawdownPercent: 40, sampleSize: 20
    });
    expect(floor).toBeGreaterThanOrEqual(0.05);
  });
});

describe('computeSizingMultiplier (Kelly-sized engines)', () => {
  it('never exceeds 1 — half-Kelly is already the ceiling', () => {
    const perf = summarizeRecentPerformance(
      Array.from({ length: 12 }, (_, i) => ({ pnl: 100, at: t(i) }))
    );
    expect(computeSizingMultiplier(perf, 0)).toBe(1);
  });

  it('de-risks on a losing streak', () => {
    const perf = summarizeRecentPerformance([
      { pnl: 5, at: t(1) }, { pnl: 5, at: t(2) }, { pnl: 5, at: t(3) },
      { pnl: -5, at: t(4) }, { pnl: -5, at: t(5) }, { pnl: -5, at: t(6) }
    ]);
    expect(computeSizingMultiplier(perf, 0)).toBeLessThanOrEqual(0.5);
  });

  it('still applies the drawdown term below the minimum trade sample', () => {
    const perf = summarizeRecentPerformance([{ pnl: -1, at: t(1) }]);
    expect(computeSizingMultiplier(perf, 7.5)).toBeCloseTo(0.5, 5);
  });
});

describe('streak cooldown', () => {
  const PORTFOLIO_VALUE = 10000;

  it('opens a 30-minute per-symbol block after two consecutive losses', () => {
    const perf = summarizeRecentPerformance([
      { pnl: 5, at: t(1) }, { pnl: -5, at: t(2) }, { pnl: -5, at: t(3) }
    ], 20, PORTFOLIO_VALUE);
    const until = computeSymbolStreakCooldownUntil(perf, PORTFOLIO_VALUE);
    expect(until).toBe(t(3) + STREAK_COOLDOWN_MS);
    expect(isInStreakCooldown(until, t(3) + 60_000)).toBe(true);
    expect(isInStreakCooldown(until, t(3) + STREAK_COOLDOWN_MS + 1)).toBe(false);
  });

  it('is anchored on the loss, not on evaluation time — re-checking cannot restart it', () => {
    const perf = summarizeRecentPerformance([
      { pnl: -5, at: t(1) }, { pnl: -5, at: t(2) }
    ], 20, PORTFOLIO_VALUE);
    expect(computeSymbolStreakCooldownUntil(perf, PORTFOLIO_VALUE)).toBe(computeSymbolStreakCooldownUntil(perf, PORTFOLIO_VALUE));
  });

  it('does not fire on a single loss', () => {
    const perf = summarizeRecentPerformance([{ pnl: 5, at: t(1) }, { pnl: -5, at: t(2) }], 20, PORTFOLIO_VALUE);
    expect(computeSymbolStreakCooldownUntil(perf, PORTFOLIO_VALUE)).toBeUndefined();
  });

  it('CANCELS cooldown when loss is > 5% of portfolio', () => {
    // Loss of 600 on 10000 portfolio = 6% > 5% threshold
    const perf = summarizeRecentPerformance([
      { pnl: 5, at: t(1) }, { pnl: -600, at: t(2) }, { pnl: -600, at: t(3) }
    ], 20, PORTFOLIO_VALUE);
    expect(computeSymbolStreakCooldownUntil(perf, PORTFOLIO_VALUE)).toBeUndefined();
  });

  it('APPLIES cooldown when loss is <= 5% of portfolio', () => {
    // Loss of 400 on 10000 portfolio = 4% <= 5% threshold
    const perf = summarizeRecentPerformance([
      { pnl: 5, at: t(1) }, { pnl: -400, at: t(2) }, { pnl: -400, at: t(3) }
    ], 20, PORTFOLIO_VALUE);
    expect(computeSymbolStreakCooldownUntil(perf, PORTFOLIO_VALUE)).toBe(t(3) + STREAK_COOLDOWN_MS);
  });

  it('filters by symbol when computing cooldown', () => {
    const closedTrades = [
      { pnl: -5, at: t(1), symbol: 'BTC' },
      { pnl: -5, at: t(2), symbol: 'BTC' },
      { pnl: -5, at: t(3), symbol: 'ETH' }
    ];
    // BTC has 2 losses → cooldown
    expect(streakCooldownFromHistory(closedTrades, PORTFOLIO_VALUE, 'BTC')).toBe(t(2) + STREAK_COOLDOWN_MS);
    // ETH has only 1 loss → no cooldown
    expect(streakCooldownFromHistory(closedTrades, PORTFOLIO_VALUE, 'ETH')).toBeUndefined();
  });
});

// Performance-adaptive position sizing and the streak cooldown — shared by
// all three simulation engines and by the server's 24/7 runners.
//
// The problem this solves: every engine sized each trade from a CONSTANT
// (0.5%/0.75% risk-per-trade for the intraday engine, a Kelly bet fraction
// for the legacy and pro engines). A constant means the fifth consecutive
// loss is taken at exactly the same size as the first, and the book keeps
// pressing while whatever edge it had is demonstrably not working. Neither
// the streak nor the open drawdown fed back into size anywhere.
//
// Two mechanisms live here:
//   1. A size multiplier from the recent streak, the recent win rate and the
//      current daily drawdown — de-risking into losses, re-risking (only
//      where the sizing model allows it) into wins.
//   2. A portfolio-level entry cooldown after consecutive losses, so a bad
//      patch stops the book entirely for a while rather than merely
//      shrinking it. A confidence threshold cannot do this: the signals that
//      lose in a chop are frequently the high-confidence ones.

/** A closed trade as the engines record it. `at` is the fill timestamp —
 *  supply it whenever available: it is what lets this module order the
 *  history itself instead of trusting the caller's array order. */
export interface ClosedTradeRecord {
  pnl: number;
  at?: number;
}

export interface PerformanceWindow {
  /** Number of closed trades actually considered. */
  sampleSize: number;
  /** Consecutive losses ending at the most recent closed trade. */
  lossStreak: number;
  /** Consecutive wins ending at the most recent closed trade. */
  winStreak: number;
  /** Fraction in [0,1] over the window. */
  winRate: number;
  /** Timestamp of the most recent losing trade, when known. */
  lastLossAt?: number;
}

export const EMPTY_PERFORMANCE_WINDOW: PerformanceWindow = {
  sampleSize: 0,
  lossStreak: 0,
  winStreak: 0,
  winRate: 0
};

/** Trades below this many closed trades are not a sample — sizing stays at
 *  base rather than reacting to two coin flips. */
export const MIN_PERFORMANCE_SAMPLE = 5;

/** Rolling window of closed trades used for the win-rate term. */
export const PERFORMANCE_WINDOW_SIZE = 20;

/**
 * Summarizes recent closed trades into the streak/win-rate figures the
 * sizing rules below consume.
 *
 * Ordering: if every record carries `at`, the history is sorted ascending by
 * it here. That is deliberate and load-bearing — the engines keep their
 * trade arrays NEWEST-FIRST for display, so a caller that simply took the
 * tail of its own array and walked it backwards was reading the OLDEST
 * trades and reporting a streak from ancient history. Records without `at`
 * are assumed to be in chronological (oldest-first) order.
 */
export function summarizeRecentPerformance(
  closed: ClosedTradeRecord[],
  windowSize: number = PERFORMANCE_WINDOW_SIZE
): PerformanceWindow {
  if (!closed?.length) return { ...EMPTY_PERFORMANCE_WINDOW };

  const hasTimestamps = closed.every((t) => typeof t.at === 'number');
  const ordered = hasTimestamps
    ? [...closed].sort((a, b) => (a.at as number) - (b.at as number))
    : closed;

  const window = ordered.slice(-Math.max(1, windowSize));

  let lossStreak = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].pnl < 0) lossStreak++;
    else break;
  }

  let winStreak = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].pnl > 0) winStreak++;
    else break;
  }

  const wins = window.filter((t) => t.pnl > 0).length;

  let lastLossAt: number | undefined;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].pnl < 0) { lastLossAt = ordered[i].at; break; }
  }

  return {
    sampleSize: window.length,
    lossStreak,
    winStreak,
    winRate: window.length ? wins / window.length : 0,
    lastLossAt
  };
}

/**
 * Streak term. Cuts hard into a losing run and adds only modestly into a
 * winning one — the asymmetry is intentional: a loss streak is evidence the
 * current regime does not suit the strategy, while a win streak is mostly
 * evidence the regime is favourable, which is the situation in which
 * over-sizing does the most damage when it ends.
 */
export function computeStreakFactor(lossStreak: number, winStreak: number): number {
  if (lossStreak >= 5) return 0.25;
  if (lossStreak >= 3) return 0.5;
  if (lossStreak >= 2) return 0.75;
  if (winStreak >= 5) return 1.5;
  if (winStreak >= 3) return 1.25;
  return 1;
}

/**
 * Drawdown term. Linear from 1.0 at flat to 0.25 at the 11.25% mark, floored
 * there — the daily circuit breaker halts the book at 8% anyway, so this
 * shapes sizing on the way to that line rather than replacing it.
 */
export function computeDrawdownFactor(dailyDrawdownPercent: number): number {
  if (!(dailyDrawdownPercent > 0)) return 1;
  return Math.max(0.25, 1 - dailyDrawdownPercent / 15);
}

/**
 * Win-rate term — a gentle tilt, not a lever. Requires a real sample before
 * it does anything, and is capped at +/-10% so a 20-trade window can never
 * dominate the streak and drawdown terms.
 */
export function computeWinRateFactor(perf: PerformanceWindow): number {
  if (perf.sampleSize < 10) return 1;
  const tilt = (perf.winRate - 0.5) * 0.2;
  return Math.max(0.9, Math.min(1.1, 1 + tilt));
}

export interface AdaptiveRiskInput {
  baseRiskPercent: number;
  recentLossStreak: number;
  recentWinStreak: number;
  recentWinRate: number;
  dailyDrawdownPercent: number;
  /** Window size behind the win-rate figure; below MIN=10 the win-rate term
   *  is neutral. Defaults to a full window for backward compatibility. */
  sampleSize?: number;
}

/**
 * Risk-per-trade sizing (the intraday engine): returns the percentage of
 * equity to risk on the next trade. Used as an override for
 * IntradayParams.riskPerTradePercent, and clamped to the same 0.05..2.0
 * band that intradayRisk.ts enforces downstream.
 */
export function computeAdaptiveRiskPercent(input: AdaptiveRiskInput): number {
  const {
    baseRiskPercent, recentLossStreak, recentWinStreak, recentWinRate,
    dailyDrawdownPercent, sampleSize = PERFORMANCE_WINDOW_SIZE
  } = input;

  const streakFactor = computeStreakFactor(recentLossStreak, recentWinStreak);
  const drawdownFactor = computeDrawdownFactor(dailyDrawdownPercent);
  const winRateFactor = computeWinRateFactor({
    sampleSize, lossStreak: recentLossStreak, winStreak: recentWinStreak, winRate: recentWinRate
  });

  const adjusted = baseRiskPercent * streakFactor * drawdownFactor * winRateFactor;
  return Number(Math.max(0.05, Math.min(2, adjusted)).toFixed(3));
}

/** Convenience wrapper: performance window in, risk percent out. */
export function adaptiveRiskPercentFromHistory(
  baseRiskPercent: number,
  closed: ClosedTradeRecord[],
  dailyDrawdownPercent: number
): number | undefined {
  const perf = summarizeRecentPerformance(closed);
  if (perf.sampleSize < MIN_PERFORMANCE_SAMPLE) return undefined;
  return computeAdaptiveRiskPercent({
    baseRiskPercent,
    recentLossStreak: perf.lossStreak,
    recentWinStreak: perf.winStreak,
    recentWinRate: perf.winRate,
    dailyDrawdownPercent,
    sampleSize: perf.sampleSize
  });
}

/**
 * Bet-fraction sizing (the legacy and pro engines, which size directly from
 * Kelly rather than from a risk percentage).
 *
 * Deliberately capped at 1.0 — it can only de-risk. Half-Kelly is already
 * the growth-optimal ceiling for the estimated edge; scaling ABOVE it on a
 * win streak is not "pressing the edge", it is betting more than the edge
 * supports precisely when the estimate is most inflated by a lucky run. The
 * upside branch of computeStreakFactor is therefore clamped away here while
 * the downside branch is kept in full.
 */
export function computeSizingMultiplier(perf: PerformanceWindow, dailyDrawdownPercent: number): number {
  if (perf.sampleSize < MIN_PERFORMANCE_SAMPLE) {
    // Not enough trades to judge the streak, but the drawdown is a fact
    // regardless of sample size — it is measured from equity, not from wins.
    return computeDrawdownFactor(dailyDrawdownPercent);
  }
  const streakFactor = Math.min(1, computeStreakFactor(perf.lossStreak, perf.winStreak));
  const multiplier = streakFactor * computeDrawdownFactor(dailyDrawdownPercent) * computeWinRateFactor(perf);
  return Number(Math.max(0.2, Math.min(1, multiplier)).toFixed(4));
}

/** Convenience wrapper for the Kelly-sized engines. */
export function sizingMultiplierFromHistory(closed: ClosedTradeRecord[], dailyDrawdownPercent: number): number {
  return computeSizingMultiplier(summarizeRecentPerformance(closed), dailyDrawdownPercent);
}

// ── Streak cooldown ──────────────────────────────────────────────────────────
// Sizing down is not the same as standing down. Two consecutive losses on a
// book that trades several symbols usually means the market, not the symbol,
// is the problem — so the cooldown is PORTFOLIO-level and applies to every
// symbol, unlike simExecution.ts's per-symbol re-entry cooldown (which only
// stops churning the one instrument that just stopped out).

export const STREAK_COOLDOWN_LOSSES = 2;
export const STREAK_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Timestamp until which new entries are blocked, or undefined when the book
 * is clear. Anchored on the LAST LOSS, not on "now" — so the clock starts
 * when the damage happened and a cooldown is never restarted by merely
 * re-evaluating.
 */
export function computeStreakCooldownUntil(
  perf: PerformanceWindow,
  lossesRequired: number = STREAK_COOLDOWN_LOSSES,
  cooldownMs: number = STREAK_COOLDOWN_MS
): number | undefined {
  if (perf.lossStreak < lossesRequired || typeof perf.lastLossAt !== 'number') return undefined;
  return perf.lastLossAt + cooldownMs;
}

export function isInStreakCooldown(until: number | undefined, now: number = Date.now()): boolean {
  return typeof until === 'number' && now < until;
}

/** Convenience wrapper: closed-trade history in, cooldown deadline out. */
export function streakCooldownFromHistory(closed: ClosedTradeRecord[]): number | undefined {
  return computeStreakCooldownUntil(summarizeRecentPerformance(closed));
}

export function streakCooldownReason(until: number): string {
  const minutesLeft = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `הפוגה אחרי רצף הפסדים — כניסות חדשות חסומות עוד ${minutesLeft} דק'`;
}

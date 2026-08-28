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

import { toBaseAsset } from './assetUniverse';

/** A closed trade as the engines record it. `at` is the fill timestamp —
 *  supply it whenever available: it is what lets this module order the
 *  history itself instead of trusting the caller's array order.
 *  `symbol` is the base asset (e.g. "BTC") — required for per-symbol cooldown. */
export interface ClosedTradeRecord {
  pnl: number;
  /** Base symbol (e.g. "BTC") — used for per-symbol cooldown tracking. */
  symbol?: string;
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
  /** PnL percentage of the most recent losing trade (vs portfolio value). */
  lastLossPnlPercent?: number;
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

// ── Stop Loss floor / ceiling (shared by Legacy + Pro) ─────────────────────
// Prevents ATR-based SL from collapsing onto the entry (a sub-1.5% stop on a
// low-vol coin like TRUMPUSDT gets blown through by normal noise) or from
// ballooning in a high-vol regime into a stop so wide it commits far more
// capital than intended. Applied as a clamp on the SL distance in
// tradeEngine.calculateRiskParameters and proAlgEngine.calculateProRisk.
export const MIN_STOP_PERCENT = 1.5;  // floor — minimum SL distance (% of entry)
export const MAX_STOP_PERCENT = 6;    // ceiling — maximum SL distance (% of entry)

// ── Cost / Edge Gate (shared by Legacy + Pro) ──────────────────────────────
// Minimum risk-reward ratio for a trade to be worth taking. Derived from the
// ATR multipliers (SL = ATR*1.5/1.8, TP = ATR*2.0/2.7) which produce ratios
// in the 1.33-1.5 range. Trades below this threshold don't have enough edge
// to justify the risk. Applied in legacySimExecution and proSimExecution.
export const MIN_RISK_REWARD_RATIO = 1.5;

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
 *
 * @param portfolioValue  If supplied, used to calculate lastLossPnlPercent
 *                        (the most recent loss as % of portfolio).
 */
export function summarizeRecentPerformance(
  closed: ClosedTradeRecord[],
  windowSize: number = PERFORMANCE_WINDOW_SIZE,
  portfolioValue?: number
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
  let lastLossPnl: number | undefined;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].pnl < 0) { lastLossAt = ordered[i].at; lastLossPnl = ordered[i].pnl; break; }
  }

  // Calculate last loss as percentage of portfolio value
  let lastLossPnlPercent: number | undefined;
  if (typeof lastLossPnl === 'number' && portfolioValue && portfolioValue > 0) {
    lastLossPnlPercent = (lastLossPnl / portfolioValue) * 100;
  }

  return {
    sampleSize: window.length,
    lossStreak,
    winStreak,
    winRate: window.length ? wins / window.length : 0,
    lastLossAt,
    lastLossPnlPercent
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
// Sizing down is not the same as standing down. A losing streak on a single
// symbol usually means that symbol is the problem — so the cooldown is now
// PER-SYMBOL, not portfolio-level.
//
// The cooldown is CANCELLED if the loss was greater than 5% of the total
// portfolio value — large losses are a different regime and should not
// trigger a cooldown (the position was already stopped out).

export const STREAK_COOLDOWN_LOSSES = 2;
export const STREAK_COOLDOWN_MS = 30 * 60 * 1000;
/** Losses above this percentage of portfolio value cancel the cooldown. */
export const STREAK_COOLDOWN_BIG_LOSS_THRESHOLD = 5;

/**
 * Timestamp until which new entries are blocked for a specific symbol, or
 * undefined when the book is clear for that symbol.
 *
 * @param perf  Performance window for the symbol
 * @param portfolioValue  Total portfolio value — used to check if the loss
 *                        was > 5% (which cancels the cooldown)
 * @param lossesRequired  Consecutive losses before cooldown triggers
 * @param cooldownMs  Duration of the cooldown
 */
export function computeSymbolStreakCooldownUntil(
  perf: PerformanceWindow,
  portfolioValue: number,
  lossesRequired: number = STREAK_COOLDOWN_LOSSES,
  cooldownMs: number = STREAK_COOLDOWN_MS
): number | undefined {
  if (perf.lossStreak < lossesRequired || typeof perf.lastLossAt !== 'number') return undefined;

  // Cancel cooldown if the loss was > 5% of portfolio — large losses are
  // a different regime and should not trigger a cooldown.
  if (portfolioValue > 0 && perf.lastLossPnlPercent !== undefined) {
    const lossPercentOfPortfolio = Math.abs(perf.lastLossPnlPercent);
    if (lossPercentOfPortfolio > STREAK_COOLDOWN_BIG_LOSS_THRESHOLD) return undefined;
  }

  return perf.lastLossAt + cooldownMs;
}

export function isInStreakCooldown(until: number | undefined, now: number = Date.now()): boolean {
  return typeof until === 'number' && now < until;
}

/** Convenience wrapper: closed-trade history in, cooldown deadline out.
 *  Filters trades by the given symbol. If no trades have symbols (legacy data),
 *  falls back to portfolio-level behavior (all trades considered). */
export function streakCooldownFromHistory(
  closed: ClosedTradeRecord[],
  portfolioValue: number,
  symbol?: string
): number | undefined {
  // Check if any trades have symbols — if not, use portfolio-level behavior
  const hasSymbolData = closed.some((t) => t.symbol !== undefined);
  const filtered = (hasSymbolData && symbol)
    ? closed.filter((t) => t.symbol && toBaseAsset(t.symbol) === toBaseAsset(symbol))
    : closed;
  return computeSymbolStreakCooldownUntil(
    summarizeRecentPerformance(filtered, PERFORMANCE_WINDOW_SIZE, portfolioValue),
    portfolioValue
  );
}

export function streakCooldownReason(until: number, symbol?: string): string {
  const minutesLeft = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  const symbolText = symbol ? ` על ${symbol}` : '';
  return `הפוגה אחרי רצף הפסדים${symbolText} — כניסות חדשות חסומות עוד ${minutesLeft} דק'`;
}

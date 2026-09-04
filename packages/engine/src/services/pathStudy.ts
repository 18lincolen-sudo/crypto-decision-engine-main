// Empirical intra-bar path study — the statistics layer of the 4H Path bot.
//
// The question this file answers is deliberately NOT "where will price go".
// It is: given a 4-hour bar that OPENED in a particular state, how often did an
// entry taken in each of its sixteen 15-minute slots reach a target of N·R
// before it reached −1R, historically, across the whole universe?
//
// That is Maximum Favourable / Adverse Excursion analysis. It produces the two
// numbers position sizing actually needs — a hit rate and a payoff ratio —
// measured rather than assumed, which is also exactly what Kelly consumes.
//
// Two rules govern everything here, and both exist because the failure mode of
// this kind of study is finding structure in noise:
//
//   1. A bar's state label may only use data that closed BEFORE the bar opened.
//      Every field in BarState is derived from prior bars. The forming candle is
//      already dropped upstream (dropFormingCandle in marketDataService.ts); this
//      keeps the same discipline through the study.
//
//   2. Nothing is scored on its point estimate. A bucket is scored on the LOWER
//      bound of a Wilson interval, so a bucket with twelve samples and a 75% hit
//      rate cannot outrank one with four hundred samples and 45%.

import { Candle, calculateATR, detectMarketRegime } from './tradeEngine';
import { SL_ATR_MULTIPLIER } from './adaptiveRisk';

/** Fear & Greed buckets, from the alternative.me 0-100 scale. */
export type FearGreedBucket = 'EXTREME_FEAR' | 'FEAR' | 'NEUTRAL' | 'GREED' | 'EXTREME_GREED';

export function fearGreedBucket(index: number): FearGreedBucket {
  if (index <= 24) return 'EXTREME_FEAR';
  if (index <= 44) return 'FEAR';
  if (index <= 55) return 'NEUTRAL';
  if (index <= 74) return 'GREED';
  return 'EXTREME_GREED';
}

export type PathRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING';
export type PathDirection = 'LONG' | 'SHORT';

/**
 * The state a 4H bar opened in.
 *
 * Kept to three fields on purpose. Sixteen slots × two directions is already 32
 * hypotheses per state; every field multiplies the bucket count and divides the
 * samples. Three regimes × five sentiment buckets × 16 slots × 2 directions =
 * 480 buckets, which a 60-symbol universe over six months can actually fill.
 * ATR decile and hour-of-day are the obvious next splits — add them only after
 * the base version survives out-of-sample, and only one at a time.
 */
export interface BarState {
  regime: PathRegime;
  fng: FearGreedBucket;
}

export const SLOTS_PER_BAR = 16;
export const BAR_MS = 4 * 60 * 60 * 1000;
export const SLOT_MS = 15 * 60 * 1000;

/** Reward:risk multiples tested for each bucket. */
export const TP_GRID_R = [1.0, 1.5, 2.0, 2.5, 3.0];

/** Below this many samples a bucket is not eligible, whatever it scores. */
export const MIN_BUCKET_SAMPLES = 200;

/** Half-life for recency weighting, in days. Market structure drifts; a bar from
 *  two years ago is evidence, but not the same weight as one from last month. */
export const RECENCY_HALF_LIFE_DAYS = 90;

export function stateKey(state: BarState): string {
  return `${state.regime}|${state.fng}`;
}

export function bucketKey(state: BarState, slot: number, direction: PathDirection): string {
  return `${stateKey(state)}|${slot}|${direction}`;
}

/**
 * Labels the state a bar opened in, using only bars that closed before it.
 *
 * `priorBars` must END with the bar immediately preceding the one being
 * labelled. Returns undefined when there is not enough history to judge.
 */
export function labelBarState(priorBars: Candle[], fearGreedIndex: number): BarState | undefined {
  if (priorBars.length < 60) return undefined;
  const last = priorBars[priorBars.length - 1];
  const regimeResult = detectMarketRegime(priorBars, last.close);

  const regime: PathRegime = regimeResult.regime === 'TRENDING'
    ? (regimeResult.direction === 'BEAR' ? 'TRENDING_DOWN' : 'TRENDING_UP')
    : 'RANGING';

  return { regime, fng: fearGreedBucket(fearGreedIndex) };
}

/**
 * Multiplier on the 15-MINUTE ATR that defines one risk unit for this bot.
 *
 * Measured, not chosen. 1R was originally drawn on the 4H ATR (× the shared
 * SL_ATR_MULTIPLIER of 1.2), which is the typical range of a whole 4-hour bar —
 * so asking price to cover it from a mid-bar entry, inside that same bar, almost
 * never happened. Over 295k measured outcomes only 8.2% reached +1R and 8.3%
 * stopped: 91.5% resolved neither way, and the stop and target were decorative.
 *
 * Sweep over the same snapshot (6 symbols, 221,088 slot-entries each row, LONG,
 * 16-slot horizon), 1R = ATR(15M) × mult:
 *
 *     mult   hit +1R    stopped    flat
 *      0.8     48.1%      51.4%     0.5%
 *      1.2     46.6%      48.7%     4.7%
 *      1.6     42.2%      44.2%    13.6%
 *      2.0     36.5%      38.7%    24.8%     <- chosen
 *      2.5     29.2%      31.8%    39.0%
 *      3.0     23.0%      25.7%    51.3%
 *      4.0     14.2%      16.5%    69.3%
 *
 * Below ~1.6 the stop sits inside 15-minute noise and roughly half the entries
 * are stopped on nothing, with round-trip costs charged every time. Above ~3.0
 * the original problem returns and most trades expire unresolved. 2.0 is where
 * about three quarters of entries actually reach a level while a quarter still
 * run out of time — the region where the stop and the target are what decide the
 * trade, which is the precondition for the study measuring anything at all.
 *
 * This is a starting value backed by a resolution sweep, NOT by a P&L
 * measurement: it makes the experiment informative, it does not claim to be
 * optimal. Re-derive it if the horizon or the slot width changes.
 */
export const PATH_RISK_UNIT_ATR_MULT = 2.0;

/**
 * One risk unit, drawn on the 15-MINUTE series.
 *
 * `prior15m` must contain only candles that closed BEFORE the bar being
 * measured — the ATR is part of the label, and a label that peeks at its own bar
 * is the leak this whole study is built to avoid.
 *
 * Returns 0 when there is not enough history, so callers skip the bar rather
 * than divide by a fabricated unit.
 */
export function riskUnitFrom15M(prior15m: Candle[]): number {
  if (prior15m.length < 20) return 0;
  const { atr } = calculateATR(prior15m, 14);
  return atr > 0 ? atr * PATH_RISK_UNIT_ATR_MULT : 0;
}

/** How many trailing 15M candles the risk unit is computed from. ATR(14) needs
 *  15; 60 gives it a stable base without reaching far enough back to describe a
 *  different volatility regime than the bar it is sizing. */
export const RISK_UNIT_LOOKBACK_15M = 60;

/**
 * The trailing 15M window that closed before `barOpenAt`.
 *
 * Takes a cursor so a caller walking bars in order does not rescan the series
 * for every bar — the study runs this over a million times.
 */
export function prior15mFor(
  m15: Candle[],
  barOpenAt: number,
  cursor: { i: number }
): Candle[] {
  while (cursor.i < m15.length && m15[cursor.i].timestamp < barOpenAt) cursor.i++;
  return m15.slice(Math.max(0, cursor.i - RISK_UNIT_LOOKBACK_15M), cursor.i);
}

export interface PathOutcome {
  state: BarState;
  slot: number;
  direction: PathDirection;
  /** Best favourable excursion reached before the stop, in R. */
  mfeR: number;
  /** Worst adverse excursion, in R (positive number). */
  maeR: number;
  /** Whether −1R was reached at all within the horizon. */
  stopped: boolean;
  /** Return in R at the END of the horizon, for a trade that reached neither the
   *  target nor the stop.
   *
   *  This exists because charging those a full −1R — which this study did — is not
   *  merely conservative, it is wrong, and at this horizon it dominates
   *  everything: measured over 295k outcomes, 8.2% reach +1R, 8.3% stop, and the
   *  remaining 91.5% resolve neither way inside one 4H bar. Scoring all of those
   *  as full losses makes every bucket's expectancy about −0.9R by construction,
   *  which is a property of the accounting rather than of the market.
   *
   *  A flat trade is not a loss. The bot closes it at market on its max-hold (see
   *  PATH_MAX_HOLD_MS), so what it actually earns is its excursion at that moment,
   *  which is what this records. */
  terminalR: number;
  /** Bar open timestamp — drives recency weighting. */
  at: number;
}

/**
 * Walks the 15-minute candles that make up one 4H bar and, for every slot,
 * measures what an entry there would have experienced.
 *
 * The horizon deliberately extends PAST the parent bar: an entry in slot 14 has
 * only 30 minutes left inside its own bar, and judging it on that alone would
 * score late slots as structurally worse for a reason that has nothing to do
 * with the market. Every slot gets the same forward budget.
 */
export function measureBarPaths(
  state: BarState,
  barOpenAt: number,
  slots: Candle[],
  forward: Candle[],
  riskUnit: number,
  horizonSlots: number = SLOTS_PER_BAR
): PathOutcome[] {
  if (!(riskUnit > 0) || slots.length === 0) return [];
  const out: PathOutcome[] = [];
  const series = [...slots, ...forward];

  for (let slot = 0; slot < Math.min(slots.length, SLOTS_PER_BAR); slot++) {
    const entry = slots[slot].close;
    if (!(entry > 0)) continue;
    const window = series.slice(slot + 1, slot + 1 + horizonSlots);
    // A SHORT window is discarded, not measured. Accepting one silently broke
    // the "same forward budget for every slot" guarantee at the edge of the
    // available history: the last bars of a dataset would score their late slots
    // against fewer candles than their early ones, which biases the comparison
    // between slots — the single thing this study exists to measure. Losing one
    // bar's worth of samples at the boundary is the cheaper error by far.
    if (window.length < horizonSlots) continue;

    for (const direction of ['LONG', 'SHORT'] as PathDirection[]) {
      const sign = direction === 'LONG' ? 1 : -1;
      let mfeR = 0;
      let maeR = 0;
      let stopped = false;
      let terminalR = 0;

      for (const candle of window) {
        // Worst-case ordering inside a candle: the adverse extreme is assumed to
        // print first. A study that assumes the favourable one prints first
        // reports an edge that no fill could have captured.
        const adverse = ((direction === 'LONG' ? candle.low : candle.high) - entry) * sign / riskUnit;
        const favourable = ((direction === 'LONG' ? candle.high : candle.low) - entry) * sign / riskUnit;
        maeR = Math.max(maeR, -adverse);
        if (maeR >= 1) { stopped = true; break; }
        mfeR = Math.max(mfeR, favourable);
        // Close-to-close, so the terminal value is where the position would
        // actually be marked when the hold budget runs out — not the extreme it
        // touched on the way.
        terminalR = ((candle.close - entry) * sign) / riskUnit;
      }

      out.push({ state, slot, direction, mfeR, maeR, stopped, terminalR, at: barOpenAt });
    }
  }

  return out;
}

/**
 * Wilson score interval lower bound.
 *
 * The reason this is here rather than a plain hit rate: with 480 buckets, some
 * will show a high rate on a handful of samples purely by chance. The Wilson
 * lower bound charges a bucket for its own uncertainty, so small samples cannot
 * win the ranking — which is the single most effective guard against building a
 * strategy on noise.
 */
export function wilsonLowerBound(successes: number, total: number, z: number = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denominator);
}

export function recencyWeight(at: number, now: number, halfLifeDays: number = RECENCY_HALF_LIFE_DAYS): number {
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** One row of the lookup table the live bot reads. */
export interface PathBucket {
  state: BarState;
  slot: number;
  direction: PathDirection;
  /** Effective sample count (recency-weighted). */
  n: number;
  /** Raw sample count, before weighting — the honest denominator for the interval. */
  rawN: number;
  tpR: number;
  slR: number;
  pHit: number;
  pLow: number;
  /** Expected R per trade at pLow, net of the round-trip cost estimate. */
  expectedR: number;
}

/** Round-trip cost in R, subtracted from every bucket's expectancy. Taker fees
 *  plus slippage on both sides, expressed against a 1R stop — an edge of 0.05R
 *  is not an edge once the exchange is paid. */
export const DEFAULT_COST_R = 0.06;

export interface BuildTableOptions {
  now?: number;
  minSamples?: number;
  costR?: number;
  tpGrid?: number[];
}

/**
 * Collapses raw outcomes into the lookup table.
 *
 * For each (state, slot, direction) the whole TP grid is evaluated and the
 * best-expectancy row is kept — one row per bucket, not one per TP, so the live
 * engine reads a single answer rather than re-deciding at runtime.
 */
export function buildPathTable(outcomes: PathOutcome[], options: BuildTableOptions = {}): PathBucket[] {
  const now = options.now ?? Date.now();
  const minSamples = options.minSamples ?? MIN_BUCKET_SAMPLES;
  const costR = options.costR ?? DEFAULT_COST_R;
  const tpGrid = options.tpGrid ?? TP_GRID_R;

  const grouped = new Map<string, PathOutcome[]>();
  for (const outcome of outcomes) {
    const key = bucketKey(outcome.state, outcome.slot, outcome.direction);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(outcome);
    else grouped.set(key, [outcome]);
  }

  const table: PathBucket[] = [];

  for (const group of grouped.values()) {
    if (group.length < minSamples) continue;

    let best: PathBucket | undefined;

    for (const tpR of tpGrid) {
      let weightedHits = 0;
      let weightedTotal = 0;
      let hits = 0;
      // Expectancy is built from the THREE outcomes a trade can actually have,
      // not two: target reached (+tpR), stop reached (−1R), or neither — in which
      // case the hold budget expires and the position closes at whatever it is
      // worth (terminalR). Collapsing the third case into the second is what
      // made every bucket look like −0.9R.
      let weightedR = 0;

      for (const outcome of group) {
        const weight = recencyWeight(outcome.at, now);
        // A win is reaching the target BEFORE the stop. measureBarPaths stops
        // walking at −1R, so an outcome that stopped can only count as a win if
        // it had already printed the target on an earlier candle.
        const won = outcome.mfeR >= tpR;
        weightedTotal += weight;
        if (won) { weightedHits += weight; hits++; }
        const realisedR = won ? tpR : outcome.stopped ? -1 : outcome.terminalR;
        weightedR += weight * realisedR;
      }

      if (weightedTotal <= 0) continue;

      const pHit = weightedHits / weightedTotal;
      // The interval is computed on the RAW counts: recency weighting expresses
      // a belief about relevance, not about how much evidence exists, and
      // letting it inflate the sample size would defeat the guard.
      const pLow = wilsonLowerBound(hits, group.length);
      // Realised expectancy, then discounted by the gap between the point
      // estimate and its lower bound — so a thin bucket is still charged for its
      // own uncertainty without pretending a flat trade was a full loss.
      const realisedExpectedR = weightedR / weightedTotal;
      const confidenceHaircut = (pHit - pLow) * tpR;
      const expectedR = realisedExpectedR - confidenceHaircut - costR;

      if (!best || expectedR > best.expectedR) {
        best = {
          state: group[0].state,
          slot: group[0].slot,
          direction: group[0].direction,
          n: Number(weightedTotal.toFixed(2)),
          rawN: group.length,
          tpR,
          slR: 1,
          pHit: Number(pHit.toFixed(4)),
          pLow: Number(pLow.toFixed(4)),
          expectedR: Number(expectedR.toFixed(4))
        };
      }
    }

    if (best) table.push(best);
  }

  return table.sort((a, b) => b.expectedR - a.expectedR);
}

/**
 * The best eligible bucket for a state, or undefined when the state has nothing
 * that clears the bar. Abstaining is the correct answer far more often than not:
 * of 480 buckets, the ones with a real edge are expected to be a handful.
 */
export function selectBucket(
  table: PathBucket[],
  state: BarState,
  minExpectedR: number = 0
): PathBucket | undefined {
  const key = stateKey(state);
  let best: PathBucket | undefined;
  for (const row of table) {
    if (stateKey(row.state) !== key) continue;
    if (row.expectedR <= minExpectedR) continue;
    if (!best || row.expectedR > best.expectedR) best = row;
  }
  return best;
}

/** Which 15-minute slot of its parent 4H bar a timestamp falls in. */
export function slotIndexAt(timestamp: number, barOpenAt: number): number {
  return Math.floor((timestamp - barOpenAt) / SLOT_MS);
}

/** Open timestamp of the 4H bar containing a moment. Bars are aligned to the
 *  UTC epoch, which is how every exchange buckets them. */
export function barOpenFor(timestamp: number): number {
  return Math.floor(timestamp / BAR_MS) * BAR_MS;
}

// ── Walk-forward validation ──────────────────────────────────────────────────
//
// The Wilson lower bound protects a single bucket against its own small sample.
// It does NOT protect the TABLE against having chosen the best of ~480 buckets ×
// 5 targets = 2,400 hypotheses. Under a true null of no edge anywhere, roughly
// 5% of buckets clear a 95% bound on noise alone — that is the look-elsewhere
// effect, and no per-bucket statistic can see it, because each of those buckets
// looks fine on its own.
//
// The only thing that separates a real edge from a filter survivor is a period
// the table was not built on. Everything below exists to produce that number.

export interface WalkForwardWindow {
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
}

/**
 * Splits a time range into rolling train/test windows.
 *
 * Rolling rather than one 70/30 cut: a single split answers "did this survive
 * one particular quarter", which one lucky quarter can pass. Requiring the sign
 * of expectancy to hold across SEVERAL disjoint test windows is a far harder
 * bar, and it is the bar `windows` in the final table counts.
 */
export function buildWalkForwardWindows(
  from: number,
  to: number,
  trainMs: number,
  testMs: number,
  stepMs: number = testMs
): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  let trainFrom = from;
  while (trainFrom + trainMs + testMs <= to) {
    const trainTo = trainFrom + trainMs;
    windows.push({ trainFrom, trainTo, testFrom: trainTo, testTo: trainTo + testMs });
    trainFrom += stepMs;
  }
  return windows;
}

/** A bucket that survived out-of-sample testing. Only these are tradeable. */
export interface ValidatedBucket extends PathBucket {
  /** Expectancy in R measured on data the bucket was NOT built from, averaged
   *  over the test windows it appeared in. This is the number that decides. */
  oosExpectedR: number;
  /** How many test windows it held a positive expectancy in. */
  windows: number;
  /** How many test windows it appeared in at all. */
  windowsTested: number;
  /** Total out-of-sample samples behind oosExpectedR. */
  oosSamples: number;
}

/** Replays a bucket's rule over outcomes it never saw, and reports what it
 *  actually earned there. No Wilson bound here on purpose: out-of-sample is the
 *  test, so it is scored on its realised rate, not on a discounted one. */
export function scoreBucketOutOfSample(
  bucket: PathBucket,
  testOutcomes: PathOutcome[],
  costR: number = DEFAULT_COST_R
): { expectedR: number; samples: number } | undefined {
  const key = bucketKey(bucket.state, bucket.slot, bucket.direction);
  let total = 0;
  let sumR = 0;
  for (const outcome of testOutcomes) {
    if (bucketKey(outcome.state, outcome.slot, outcome.direction) !== key) continue;
    total++;
    // Same three-outcome model as buildPathTable. No Wilson haircut here: this
    // IS the test, so it is scored on what the rule actually earned.
    sumR += outcome.mfeR >= bucket.tpR ? bucket.tpR : outcome.stopped ? -1 : outcome.terminalR;
  }
  if (total === 0) return undefined;
  return { expectedR: sumR / total - costR, samples: total };
}

export interface WalkForwardOptions {
  minSamples?: number;
  costR?: number;
  tpGrid?: number[];
  /** Test windows in which the bucket must hold a positive expectancy. */
  minWindowsPositive?: number;
  /** Minimum averaged out-of-sample expectancy, in R. */
  minOosExpectedR?: number;
}

export interface WalkForwardReport {
  windows: number;
  /** Buckets that cleared the in-sample bar in at least one training window. */
  candidates: number;
  /** Of those, how many survived out-of-sample. */
  survivors: number;
  /** Expected survivors under a pure-noise null, for comparison. If `survivors`
   *  is not clearly above this, the table found nothing. */
  expectedUnderNull: number;
  table: ValidatedBucket[];
}

/**
 * Builds a table and validates it, in one pass.
 *
 * `outcomes` must carry honest `at` timestamps — the split is by time, and a
 * shuffled or synthetic ordering silently turns this into an in-sample build
 * wearing an out-of-sample label.
 */
export function buildValidatedPathTable(
  outcomes: PathOutcome[],
  windows: WalkForwardWindow[],
  options: WalkForwardOptions = {}
): WalkForwardReport {
  const minWindowsPositive = options.minWindowsPositive ?? 2;
  const minOosExpectedR = options.minOosExpectedR ?? 0;
  const costR = options.costR ?? DEFAULT_COST_R;

  // key → accumulated evidence across windows
  const acc = new Map<string, {
    bucket: PathBucket;
    oosTotalR: number;
    oosSamples: number;
    windowsPositive: number;
    windowsTested: number;
  }>();
  const candidateKeys = new Set<string>();

  for (const window of windows) {
    const train = outcomes.filter((o) => o.at >= window.trainFrom && o.at < window.trainTo);
    const test = outcomes.filter((o) => o.at >= window.testFrom && o.at < window.testTo);
    if (train.length === 0 || test.length === 0) continue;

    // Built on the training slice only, and scored with `now` at the END of that
    // slice so recency weighting cannot reach into the test period.
    const trained = buildPathTable(train, {
      now: window.trainTo,
      minSamples: options.minSamples,
      costR,
      tpGrid: options.tpGrid
    });

    for (const bucket of trained) {
      if (bucket.expectedR <= 0) continue;
      const key = bucketKey(bucket.state, bucket.slot, bucket.direction);
      candidateKeys.add(key);

      const oos = scoreBucketOutOfSample(bucket, test, costR);
      if (!oos) continue;

      const entry = acc.get(key) ?? {
        bucket,
        oosTotalR: 0,
        oosSamples: 0,
        windowsPositive: 0,
        windowsTested: 0
      };
      entry.bucket = bucket; // most recent training view of the rule
      entry.oosTotalR += oos.expectedR * oos.samples;
      entry.oosSamples += oos.samples;
      entry.windowsTested++;
      if (oos.expectedR > 0) entry.windowsPositive++;
      acc.set(key, entry);
    }
  }

  const table: ValidatedBucket[] = [];
  for (const entry of acc.values()) {
    if (entry.oosSamples === 0) continue;
    const oosExpectedR = entry.oosTotalR / entry.oosSamples;
    if (entry.windowsPositive < minWindowsPositive) continue;
    if (oosExpectedR <= minOosExpectedR) continue;
    table.push({
      ...entry.bucket,
      oosExpectedR: Number(oosExpectedR.toFixed(4)),
      windows: entry.windowsPositive,
      windowsTested: entry.windowsTested,
      oosSamples: entry.oosSamples
    });
  }

  table.sort((a, b) => b.oosExpectedR - a.oosExpectedR);

  return {
    windows: windows.length,
    candidates: candidateKeys.size,
    survivors: table.length,
    // 5% of the hypotheses tested is what pure noise produces at a 95% bound.
    // Printed next to the survivor count so the comparison is unavoidable.
    expectedUnderNull: Number((candidateKeys.size * 0.05).toFixed(2)),
    table
  };
}

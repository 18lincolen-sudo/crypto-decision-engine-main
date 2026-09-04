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

/** One risk unit for a bar: the same ATR-based stop distance the live engines
 *  size with, so an R measured in the study means what an R means in a trade. */
export function riskUnitFor(priorBars: Candle[]): number {
  const { atr } = calculateATR(priorBars, 14);
  return atr * SL_ATR_MULTIPLIER;
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
    if (window.length === 0) continue;

    for (const direction of ['LONG', 'SHORT'] as PathDirection[]) {
      const sign = direction === 'LONG' ? 1 : -1;
      let mfeR = 0;
      let maeR = 0;
      let stopped = false;

      for (const candle of window) {
        // Worst-case ordering inside a candle: the adverse extreme is assumed to
        // print first. A study that assumes the favourable one prints first
        // reports an edge that no fill could have captured.
        const adverse = ((direction === 'LONG' ? candle.low : candle.high) - entry) * sign / riskUnit;
        const favourable = ((direction === 'LONG' ? candle.high : candle.low) - entry) * sign / riskUnit;
        maeR = Math.max(maeR, -adverse);
        if (maeR >= 1) { stopped = true; break; }
        mfeR = Math.max(mfeR, favourable);
      }

      out.push({ state, slot, direction, mfeR, maeR, stopped, at: barOpenAt });
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

      for (const outcome of group) {
        const weight = recencyWeight(outcome.at, now);
        // A win is reaching the target BEFORE the stop. measureBarPaths stops
        // walking at −1R, so an outcome that stopped can only count as a win if
        // it had already printed the target on an earlier candle.
        const won = outcome.mfeR >= tpR;
        weightedTotal += weight;
        if (won) { weightedHits += weight; hits++; }
      }

      if (weightedTotal <= 0) continue;

      const pHit = weightedHits / weightedTotal;
      // The interval is computed on the RAW counts: recency weighting expresses
      // a belief about relevance, not about how much evidence exists, and
      // letting it inflate the sample size would defeat the guard.
      const pLow = wilsonLowerBound(hits, group.length);
      const expectedR = pLow * tpR - (1 - pLow) * 1 - costR;

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

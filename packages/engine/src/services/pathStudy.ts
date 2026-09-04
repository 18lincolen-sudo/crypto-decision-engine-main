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

/**
 * The target this study commits to, ahead of looking at the data.
 *
 * Testing five targets per bucket is testing five hypotheses per bucket, and the
 * noise floor scales with the product: 96 buckets × 5 targets is 480 questions,
 * 96 × 1 is 96. Picking the best-scoring target per bucket after the fact is the
 * same look-elsewhere error as picking the best-scoring bucket, one level down,
 * and it was invisible because the grid search looked like thoroughness.
 *
 * 1.5R is chosen from the RESOLUTION sweep, not from any P&L: at the 15M risk
 * unit, 36.5% of entries reach +1R within the hold budget, so a 1.5R target is
 * demanding but not out of reach, while 2.5R and 3R are reached rarely enough
 * that a bucket's hit count would be too thin to bound. It is a pre-registration,
 * not an optimum.
 */
export const DEFAULT_TP_R = 1.5;

/** The full grid, retained for a deliberate, separately-reported sweep. Passing
 *  it to a production build re-introduces the multiple-comparisons problem it
 *  was removed to avoid. */
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
/**
 * Whether the sentiment split is part of the state.
 *
 * Off by default, and that is the single highest-leverage decision in the whole
 * study. Every extra split multiplies the hypothesis count, and the noise floor
 * moves with it:
 *
 *     with F&G:  3 regimes × 5 sentiment × 16 slots × 2 directions = 480 buckets
 *     without:   3 regimes ×             16 slots × 2 directions =  96 buckets
 *
 * At 480 buckets a pure-noise null produces ~10 apparent survivors; at 96 it
 * produces ~2. The same 10 real survivors are ambiguous against the first floor
 * and decisive against the second. Nothing about the data changed — only how
 * many questions were asked of it.
 *
 * The discipline this encodes: add ONE split, measure, keep it only if it earns
 * its own multiplier. Sentiment is a plausible conditioner for intra-bar path
 * shape, but plausible is not the standard, and it was never tested on its own.
 */
export const DEFAULT_USE_FEAR_GREED = false;

/** The bucket every state collapses to when the sentiment split is off. Chosen
 *  rather than inventing a sixth 'ALL' member, so the type, the keys and the
 *  persisted tables stay one shape whichever way the study is run. */
const COLLAPSED_FNG: FearGreedBucket = 'NEUTRAL';

export function labelBarState(
  priorBars: Candle[],
  fearGreedIndex: number,
  useFearGreed: boolean = DEFAULT_USE_FEAR_GREED
): BarState | undefined {
  if (priorBars.length < 60) return undefined;
  const last = priorBars[priorBars.length - 1];
  const regimeResult = detectMarketRegime(priorBars, last.close);

  const regime: PathRegime = regimeResult.regime === 'TRENDING'
    ? (regimeResult.direction === 'BEAR' ? 'TRENDING_DOWN' : 'TRENDING_UP')
    : 'RANGING';

  return { regime, fng: useFearGreed ? fearGreedBucket(fearGreedIndex) : COLLAPSED_FNG };
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
 * Which timeframe 1R is drawn on.
 *
 * This is the third corner of the horizon/R/cost triangle, and the only one that
 * can be moved without leaving spot. Cost in R is cost% / R%, so doubling R
 * halves the bill — but a bigger R also needs a longer hold to stay reachable,
 * which is why this ships paired with the horizon flag rather than alone.
 *
 * '15m' — 1R = ATR(15M) × 2.0. Reachable inside one 4H bar, costs ~0.30R.
 * '1h'  — 1R = ATR(1H)  × 2.0, built from four 15M candles per hour. Roughly
 *         twice as wide, so roughly half the cost in R, and it needs a horizon
 *         of several bars to be reached at all.
 */
export type RiskBasis = '15m' | '1h';

/** Aggregates 15M candles into 1H, then measures ATR on those. Same multiplier,
 *  so the only thing that changes between bases is the timeframe the volatility
 *  is read from. */
export function riskUnitFrom1H(prior15m: Candle[]): number {
  if (prior15m.length < 80) return 0;
  const hourly: Candle[] = [];
  const byHour = new Map<number, Candle[]>();
  for (const c of prior15m) {
    const h = Math.floor(c.timestamp / 3_600_000) * 3_600_000;
    const g = byHour.get(h);
    if (g) g.push(c); else byHour.set(h, [c]);
  }
  for (const [open, group] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length < 4) continue;
    group.sort((a, b) => a.timestamp - b.timestamp);
    hourly.push({
      timestamp: open,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0)
    });
  }
  if (hourly.length < 20) return 0;
  const { atr } = calculateATR(hourly, 14);
  return atr > 0 ? atr * PATH_RISK_UNIT_ATR_MULT : 0;
}

/** Dispatches on the configured basis. */
export function riskUnitFor(prior15m: Candle[], basis: RiskBasis): number {
  return basis === '1h' ? riskUnitFrom1H(prior15m) : riskUnitFrom15M(prior15m);
}

/**
 * The trailing 15M window that closed before `barOpenAt`.
 *
 * Takes a cursor so a caller walking bars in order does not rescan the series
 * for every bar — the study runs this over a million times.
 */
export function prior15mFor(
  m15: Candle[],
  barOpenAt: number,
  cursor: { i: number },
  /** How many trailing candles to return. Must cover the ATR window of the basis
   *  being measured: ATR(14) on the 1H series needs 15 hours, which is 60 of
   *  these candles before the aggregation even starts — handing it the 15M
   *  lookback returned an empty risk unit for every bar, and the study silently
   *  produced zero outcomes. */
  lookback: number = RISK_UNIT_LOOKBACK_15M
): Candle[] {
  while (cursor.i < m15.length && m15[cursor.i].timestamp < barOpenAt) cursor.i++;
  return m15.slice(Math.max(0, cursor.i - lookback), cursor.i);
}

/** Trailing 15M candles needed to measure a risk unit on each basis. */
export function lookbackForBasis(basis: RiskBasis): number {
  return basis === '1h' ? 240 : RISK_UNIT_LOOKBACK_15M;
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
  /** Round-trip cost in R for THIS trade, from its own risk unit and price.
   *  Carried per outcome rather than applied as a constant because it varies by
   *  a factor of two across the universe (0.21R on NEAR, 0.49R on BTC) and by
   *  volatility regime within a single symbol. */
  costR: number;
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
/**
 * Which extreme of a candle is assumed to print first.
 *
 * An OHLC candle records that price visited both its high and its low, and not
 * in which order. When one of them is the stop and the other is the target, that
 * missing ordering decides the trade, and no amount of care elsewhere recovers
 * it — only finer-grained data does.
 *
 * 'adverse'    — the stop prints first. The conservative bound, and the default:
 *                a study that assumes otherwise reports an edge no fill could
 *                have captured.
 * 'favourable' — the target prints first. The optimistic bound.
 *
 * Running both brackets the truth. If the two bounds agree on the conclusion,
 * the ordering does not matter and 1-minute data would buy nothing; if they
 * straddle it, the conclusion is unresolved at 15-minute resolution and the
 * honest next step is finer candles rather than a firmer opinion.
 */
export type CandleOrdering = 'adverse' | 'favourable';

export function measureBarPaths(
  state: BarState,
  barOpenAt: number,
  slots: Candle[],
  forward: Candle[],
  riskUnit: number,
  horizonSlots: number = SLOTS_PER_BAR,
  ordering: CandleOrdering = 'adverse'
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
        const adverse = ((direction === 'LONG' ? candle.low : candle.high) - entry) * sign / riskUnit;
        const favourable = ((direction === 'LONG' ? candle.high : candle.low) - entry) * sign / riskUnit;

        if (ordering === 'favourable') {
          // Optimistic bound: the target is credited before the stop is checked,
          // so a candle that spans both counts as a win.
          mfeR = Math.max(mfeR, favourable);
          maeR = Math.max(maeR, -adverse);
          if (maeR >= 1) { stopped = true; break; }
        } else {
          maeR = Math.max(maeR, -adverse);
          if (maeR >= 1) { stopped = true; break; }
          mfeR = Math.max(mfeR, favourable);
        }
        // Close-to-close, so the terminal value is where the position would
        // actually be marked when the hold budget runs out — not the extreme it
        // touched on the way.
        terminalR = ((candle.close - entry) * sign) / riskUnit;
      }

      out.push({
        state, slot, direction, mfeR, maeR, stopped, terminalR,
        costR: costInR(riskUnit, entry),
        at: barOpenAt
      });
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
  /** Expected R per trade at pLow, net of the round-trip cost actually paid. */
  expectedR: number;
  /** Mean round-trip cost in R across this bucket's trades. Surfaced because it
   *  is usually the largest single term in expectedR, and a reader comparing two
   *  buckets needs to see whether the difference is edge or just cheaper R. */
  costR: number;
}

// ── Cost ─────────────────────────────────────────────────────────────────────
//
// Cost is charged in R, and R is not a fixed fraction of price — so a flat
// "cost = 0.06R" is not a conservative simplification, it is a wrong number that
// happens to look small. Measured against the 15M risk unit this bot actually
// trades, the true figure ranges from 0.21R on a volatile alt to 0.49R on BTC:
// four to eight times what was being charged.
//
// The direction of the error is the dangerous one. Under-charging cost inflates
// every bucket's expectancy, which inflates the number of buckets that clear the
// in-sample bar, which inflates the multiple-comparisons problem the whole
// walk-forward apparatus exists to control.
//
// The relationship is structural and worth stating plainly: cost/R = cost% / R%.
// Shrinking R to make it reachable inside the hold budget makes cost/R larger by
// exactly the same factor. Horizon, R and cost are one triangle, and it has to
// be closed deliberately rather than one corner at a time.

/** Entry is a resting limit order (maker); the exit is a stop or a time close,
 *  both of which cross the book (taker). Bybit SPOT: 0.1% either side. */
export const SPOT_MAKER_PCT = 0.1;
export const SPOT_TAKER_PCT = 0.1;

/** Slippage charged on the taker leg only. Midpoint of the simulator's own
 *  0.05-0.15% band (simulateSlippage), so the study and the sim agree. */
export const EXIT_SLIPPAGE_PCT = 0.10;

/** Round-trip cost as a percentage of notional, for the SPOT path this bot
 *  trades. Deliberately not parameterised by market type: bot 4 is spot-only,
 *  and quoting a futures number here would invite someone to apply it without
 *  the rest of the futures machinery. */
export const ROUND_TRIP_COST_PCT = SPOT_MAKER_PCT + SPOT_TAKER_PCT + EXIT_SLIPPAGE_PCT;

/**
 * Round-trip cost expressed in R for one specific trade.
 *
 * `riskUnit` and `price` are in the same units, so this is cost% / R%. Returns a
 * large finite number rather than Infinity when the risk unit is degenerate, so
 * a bad bar is scored as unprofitable instead of poisoning an average with NaN.
 *
 * What this still does NOT model: the per-symbol bid/ask spread at the moment of
 * the fill. Historical klines do not carry it, and inventing one would be the
 * same class of error this function was written to remove. The omission biases
 * cost DOWNWARD, so every expectancy below remains optimistic by roughly half a
 * spread.
 */
export function costInR(riskUnit: number, price: number): number {
  if (!(riskUnit > 0) || !(price > 0)) return 999;
  const riskPercent = (riskUnit / price) * 100;
  return ROUND_TRIP_COST_PCT / riskPercent;
}

/** Fallback used only where a per-trade cost is genuinely unavailable. Kept at
 *  the OLD flat value on purpose: if it ever shows up in a result, the number is
 *  recognisable as the placeholder it is rather than blending in. */
export const DEFAULT_COST_R = 0.06;

export interface BuildTableOptions {
  now?: number;
  minSamples?: number;
  /** Overrides the per-outcome cost with a flat figure. For tests and for
   *  measuring how much of a result is the cost model — not for production
   *  builds, where each trade should pay its own bill. */
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
  const costOverrideR = options.costR;
  const tpGrid = options.tpGrid ?? [DEFAULT_TP_R];

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
      let weightedCost = 0;

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
        // Each trade pays its OWN cost. Averaging riskUnit across a bucket first
        // and costing that would understate the bill, because cost/R is convex
        // in R: the cheap wide-R bars cannot subsidise the expensive tight-R ones.
        weightedCost += weight * (Number.isFinite(outcome.costR) ? outcome.costR : DEFAULT_COST_R);
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
      const bucketCostR = costOverrideR ?? (weightedCost / weightedTotal);
      const expectedR = realisedExpectedR - confidenceHaircut - bucketCostR;

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
          costR: Number(bucketCostR.toFixed(4)),
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
  /** Flat override. Omit in production so each trade pays its own cost. */
  costR?: number
): { expectedR: number; samples: number } | undefined {
  const key = bucketKey(bucket.state, bucket.slot, bucket.direction);
  let total = 0;
  let sumR = 0;
  let sumCost = 0;
  for (const outcome of testOutcomes) {
    if (bucketKey(outcome.state, outcome.slot, outcome.direction) !== key) continue;
    total++;
    // Same three-outcome model as buildPathTable. No Wilson haircut here: this
    // IS the test, so it is scored on what the rule actually earned.
    sumR += outcome.mfeR >= bucket.tpR ? bucket.tpR : outcome.stopped ? -1 : outcome.terminalR;
    sumCost += costR ?? (Number.isFinite(outcome.costR) ? outcome.costR : DEFAULT_COST_R);
  }
  if (total === 0) return undefined;
  return { expectedR: (sumR - sumCost) / total, samples: total };
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
  // Left undefined unless the caller explicitly overrides: resolving it to
  // DEFAULT_COST_R here would push a flat 0.06R into both the in-sample build and
  // the out-of-sample scoring, silently undoing the per-trade cost model. That is
  // exactly what it did on the first run — the surviving bucket reported
  // cost=0.06R while the universe mean was 0.304R.
  const costOverrideR = options.costR;

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
      costR: costOverrideR,
      tpGrid: options.tpGrid
    });

    for (const bucket of trained) {
      if (bucket.expectedR <= 0) continue;
      const key = bucketKey(bucket.state, bucket.slot, bucket.direction);
      candidateKeys.add(key);

      const oos = scoreBucketOutOfSample(bucket, test, costOverrideR);
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

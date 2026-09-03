/**
 * Perpetual funding rate — the one orthogonal factor in this codebase.
 *
 * WHY THIS EXISTS
 * ---------------
 * Legacy and Pro both score seven weighted indicators: MACD 20, EMA20/50 18,
 * Volume Surge 18, RSI 12, Bollinger 12, Supertrend 12, Stochastic 8. These are
 * highly collinear — MACD, EMA-cross and Supertrend are three derivatives of the
 * same moving average; RSI and Stochastic are two oscillators on the same
 * short-horizon momentum. The effective breadth is closer to 2 than to 7, which
 * is why adding an eighth PRICE indicator would buy almost nothing.
 *
 * Funding is not a price indicator. It measures POSITIONING — what leveraged
 * traders are paying to hold their side — and it is the only quantity in crypto
 * with a fair value enforced by arbitrage: the perpetual must track spot, and
 * funding is the payment that drags it back. That makes it close to orthogonal
 * to everything the engines already look at.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * -----------------------------
 * It is not an entry trigger, and there is no "mispricing > 8%" rule here. An
 * 8% price threshold was rejected: it is 4.4x the engines' stop distance and
 * 2.7x their first target, so it could never affect a decision it was supposed
 * to gate, and dislocations that large in crypto are usually information (a
 * depeg, a liquidation cascade) rather than error. Fading them is a negative-skew
 * trade.
 *
 * What funding is used for instead is a VETO and a size reduction on crowded
 * trades, thresholded in annualised percent — a unit that is comparable across
 * symbols and independent of the engines' price geometry.
 *
 * NO NETWORK CALLS LIVE HERE. This module is pure scoring; fetching belongs to
 * the caller (see fetchFundingRates in marketDataService.ts) so the engine stays
 * testable and deterministic.
 */

/** Binance pays funding every 8 hours: 3 payments a day, 1095 a year. */
export const FUNDING_PERIODS_PER_YEAR = 3 * 365;

/** Annualised funding (%) at or above which the signalled side is considered
 *  crowded and its size is trimmed.
 *
 *  CALIBRATION. Binance's resting funding is 0.01% per 8h = ~10.95%/yr; a large
 *  mass of readings sits exactly there, so any threshold at or below ~11% would
 *  fire on roughly half of all signals and amount to a standing size cut rather
 *  than a crowding signal. Measured over the A/B window (6 majors, 2025 H1,
 *  3,156 directional signals — scripts/fundingOrthogonality.ts), the funding
 *  FACED by the signalled side distributes:
 *
 *      p50 3.1   p75 8.8   p90 10.9   p95 10.9   p99 17.5   max 45.8
 *
 *  25%/yr is ~2.3x baseline and sits above p99, so it engages only on a genuine
 *  tail. That is the intended behaviour: crowding IS a tail phenomenon, and a
 *  gate that fired routinely in a calm market would be mis-specified. */
export const FUNDING_CROWDED_ANNUAL_PCT = 25;

/** Annualised funding (%) beyond which the crowded side is refused outright.
 *
 *  ~4.5x baseline (0.045% per 8h). Nothing in the 2025-H1 window reaches it —
 *  the maximum observed was 45.8%/yr — which is correct: this is insurance
 *  against mania conditions, where alt funding has historically run 100-300%/yr
 *  immediately before a squeeze, not a routine filter. */
export const FUNDING_EXTREME_ANNUAL_PCT = 50;

/** Floor on the size multiplier, so the veto stays the mechanism that stops a
 *  trade and this only ever trims one. */
export const FUNDING_MIN_SIZE_MULTIPLIER = 0.5;

export interface FundingSnapshot {
  /** Funding rate for ONE period, as a fraction (Binance's lastFundingRate).
   *  0.0001 = 0.01% per 8h. */
  lastFundingRate: number;
  /** When the reading was taken (ms). Used to reject stale data. */
  at: number;
}

export type FundingVerdict =
  | { kind: 'abstain'; reason: string }
  | { kind: 'allow'; annualPct: number; sizeMultiplier: number; reason: string }
  | { kind: 'trim'; annualPct: number; sizeMultiplier: number; reason: string }
  | { kind: 'veto'; annualPct: number; reason: string };

/** Funding older than this is not evidence about the current book. Binance
 *  settles every 8h, so a reading over a full cycle old is discarded. */
export const FUNDING_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export function annualisedFundingPct(lastFundingRate: number): number {
  return lastFundingRate * FUNDING_PERIODS_PER_YEAR * 100;
}

/**
 * Scores a prospective trade against the funding rate.
 *
 * Positive funding = longs pay shorts = the crowd is long. That penalises LONG
 * entries and leaves SHORT entries alone (and vice versa). The asymmetry is the
 * point: this is a crowding penalty, never a reason to take the other side.
 *
 * Abstains — never blocks — when data is missing or stale. A funding feed
 * outage must not stop the bots trading.
 */
export function evaluateFundingGate(
  snapshot: FundingSnapshot | undefined,
  direction: 'LONG' | 'SHORT',
  now: number = Date.now()
): FundingVerdict {
  if (!snapshot || !Number.isFinite(snapshot.lastFundingRate)) {
    return { kind: 'abstain', reason: 'FUNDING_GATE: no funding data for this symbol' };
  }
  if (now - snapshot.at > FUNDING_MAX_AGE_MS) {
    return { kind: 'abstain', reason: 'FUNDING_GATE: funding reading is stale (>8h)' };
  }

  const annualPct = annualisedFundingPct(snapshot.lastFundingRate);
  // How much the CROWD is paying to hold the side we are about to take. A long
  // faces positive funding; a short faces negative funding.
  const crowdedCost = direction === 'LONG' ? annualPct : -annualPct;
  const label = `${annualPct >= 0 ? '+' : ''}${annualPct.toFixed(1)}%/yr`;

  if (crowdedCost >= FUNDING_EXTREME_ANNUAL_PCT) {
    return {
      kind: 'veto',
      annualPct,
      reason: `FUNDING_GATE: ${direction} refused — funding ${label} is beyond the ` +
        `${FUNDING_EXTREME_ANNUAL_PCT}%/yr extreme; the ${direction} side is crowded and paying to stay in`
    };
  }

  if (crowdedCost >= FUNDING_CROWDED_ANNUAL_PCT) {
    // Linear taper between crowded and extreme, so the penalty is continuous
    // rather than a cliff a single reading can hop across.
    const span = FUNDING_EXTREME_ANNUAL_PCT - FUNDING_CROWDED_ANNUAL_PCT;
    const through = (crowdedCost - FUNDING_CROWDED_ANNUAL_PCT) / span;
    const sizeMultiplier = 1 - through * (1 - FUNDING_MIN_SIZE_MULTIPLIER);
    return {
      kind: 'trim',
      annualPct,
      sizeMultiplier,
      reason: `FUNDING_GATE: ${direction} size trimmed to ${(sizeMultiplier * 100).toFixed(0)}% — ` +
        `funding ${label} shows a crowded ${direction} book`
    };
  }

  return {
    kind: 'allow',
    annualPct,
    sizeMultiplier: 1,
    reason: `FUNDING_GATE: funding ${label} — no crowding penalty`
  };
}

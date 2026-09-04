/**
 * Simulation-bot default configuration — one definition, two consumers.
 * ============================================================================
 *
 * The frontend contexts and `server/tradingWorker.ts` each held their own copy
 * of these numbers, kept in step by hand and by comments that said "matches
 * tradingWorker.ts". That is not a source of truth, it is two sources that
 * happen to agree today: the Pro floor had already drifted to 60 in the browser
 * while the worker ran 58, so the same bot gated two points apart depending on
 * which runtime evaluated it.
 *
 * WHAT LIVES HERE: the static, compile-time base. Every value below is a
 * constant with no environment input.
 *
 * WHAT DOES NOT: anything the operator sets at deploy time. The worker reads
 * BOT_MIN_CONFIDENCE, BOT_POSITION_PERCENT, BOT_MAX_OPEN_POSITIONS and
 * BOT_RISK_LEVEL from the environment and layers them ON TOP of these defaults.
 * The browser cannot see those variables, so the values it renders before the
 * first poll are the base, not necessarily what the worker is running. That gap
 * is real and is NOT closed by this file — closing it needs a config endpoint
 * the frontend reads at boot. Until then the contexts adopt the server's config
 * on the first successful poll, which is what makes the base a placeholder
 * rather than a lie.
 */

import type { SimBotConfig } from './simExecution';

export type SimBotId = 'intraday' | 'legacy' | 'pro' | 'path';

/**
 * Confidence floor per bot, as a compile-time base.
 *
 * The three H1 bots express this as a signal score. Path expresses it as a
 * PROBABILITY — its confidence is the bucket's Wilson lower bound — which is
 * why 33 sits next to 58 without being "too low". The two are not comparable
 * and must never be aligned for the look of the table.
 */
export const SIM_MIN_CONFIDENCE: Record<SimBotId, number> = {
  intraday: 52,
  legacy: 58,
  pro: 58,
  path: 33
};

/**
 * Futures capacity per bot. Path is 0 and that is a strategy decision, not an
 * oversight: bot 4 is spot-only.
 */
export const SIM_MAX_FUTURES_POSITIONS: Record<SimBotId, number> = {
  intraday: 2,
  legacy: 2,
  pro: 2,
  path: 0
};

/**
 * Everything the four bots hold in common.
 *
 * `maxPositions` is 5 — the cap the live bot runs (BOT_MAX_OPEN_POSITIONS). It
 * used to be 7 in the sims, which let every simulation carry 40% more
 * concurrent risk than the bot it exists to predict.
 *
 * `positionPercent` is 10, matching the live bot. The engine's own internal
 * default is 15, so omitting this made the browser fallback size entries half
 * again as large as the 24/7 worker running the same strategy.
 */
export const SIM_BASE_DEFAULTS = {
  riskLevel: 'medium' as const,
  initialAmount: 10000,
  maxPositions: 5,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 3,
  positionPercent: 10
};

/** The full default config for one bot. Callers layer their own overrides on top. */
export function simBotDefaults(id: SimBotId): SimBotConfig {
  return {
    ...SIM_BASE_DEFAULTS,
    maxFuturesPositions: SIM_MAX_FUTURES_POSITIONS[id],
    minConfidenceOverride: SIM_MIN_CONFIDENCE[id]
  };
}

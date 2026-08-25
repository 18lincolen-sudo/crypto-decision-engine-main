// Shared pure functions for the paper-trading fill/exit mechanics used by ALL
// THREE simulation engines: the browser's intraday hook (useSimulationBot.ts),
// the browser's legacy hook (useLegacySimulationBot.ts), and the server's 24/7
// engine (server/simEngine.ts). These three used to each carry their own copy
// of this logic — which is exactly how the SL/TP re-anchoring bug and the
// held/queued dedup bug each shipped fixed in one place and broken in another
// earlier in this project. No framework/runtime dependency (works in the
// browser and in the Node worker bundle) — keep it that way.

/**
 * SL/TP were computed relative to the SIGNAL price at evaluation time, which
 * can be stale by the time the order actually fills (execution delay + live
 * price drift). Re-anchor by preserving the SIGNED offset from the signal
 * price — not just its distance — so SL stays below / TP stays above entry
 * for a LONG (opposite for SHORT) regardless of which way the price drifted.
 * Forcing a single sign here (an earlier version of this fix did) silently
 * flips TP1/TP2 to the wrong side of the fill price.
 */
export function reanchorLevel(fillPrice: number, signalPrice: number, level: number | undefined): number | undefined {
  return level === undefined ? undefined : fillPrice + (level - signalPrice);
}

/** Entry position sizing: FUTURES risk is capped in absolute $ terms (not just %) since leverage already amplifies exposure; SPOT is capped higher since there's no leverage multiplier. */
export function computeEntryBudget(cash: number, tradeType: 'SPOT' | 'FUTURES'): number {
  return tradeType === 'FUTURES'
    ? Math.min(cash * 0.05, 500)
    : Math.min(cash * 0.15, 1000);
}

/** Safety net against rapid re-entry churn: after a LOSING full exit, skip new entries on that symbol for this cooldown window even if the signal still fires. */
export const ENTRY_COOLDOWN_MS = 2 * 60 * 1000;

export function isInEntryCooldown(cooldownAt: number | undefined, now: number = Date.now()): boolean {
  return typeof cooldownAt === 'number' && now - cooldownAt < ENTRY_COOLDOWN_MS;
}

import { useEffect, useRef } from 'react';
import { getSimDefaults, type SimDefaultsResponse } from '../services/tradingApiClient';
import type { SimBotConfig } from '@cde/engine/execution';
import type { SimBotId } from '@cde/engine/execution';

/**
 * Adopts the worker's starting config for one bot, once, at boot.
 * ============================================================================
 *
 * The gap this closes: `simBotDefaults()` gives the browser and the worker the
 * same compile-time base, but the worker then applies BOT_MIN_CONFIDENCE,
 * BOT_POSITION_PERCENT, BOT_MAX_OPEN_POSITIONS and BOT_RISK_LEVEL from its
 * environment. A browser cannot read those, so the panel was rendering the base
 * and labelling it "the default" — correct only where none of the four are set.
 *
 * Two rules make this safe to run alongside the existing state polling:
 *
 *  1. The RUNNING config always wins. If a bot's /state has already delivered a
 *     config, this does nothing — a bot mid-run has a config that is a fact, and
 *     overwriting it with what a fresh bot WOULD start with is worse than the
 *     wrong placeholder it replaces.
 *
 *  2. It writes locally and never pushes. Calling setConfig() here would POST a
 *     config the operator did not choose back to the worker, turning a display
 *     fix into an unrequested write. The value is corrected on screen; the
 *     server's own state is left exactly as it was.
 *
 * One request per bot per mount is deliberate. The response is small, the four
 * calls share the browser's HTTP cache, and a shared module-level promise would
 * make the four contexts order-dependent for no measurable gain.
 */
export function useServerSimDefaults(
  bot: SimBotId,
  baseUrl: string | undefined,
  /** Writes the config into local state. Must NOT push to the server. */
  applyLocally: (config: SimBotConfig) => void,
  /** True once this bot's own /state has delivered a config. */
  hasServerConfig: boolean
): void {
  // Read inside the effect so a config that lands mid-flight still wins, without
  // making the request itself depend on the flag and re-fire when it flips.
  const hasServerConfigRef = useRef(hasServerConfig);
  hasServerConfigRef.current = hasServerConfig;

  const applyRef = useRef(applyLocally);
  applyRef.current = applyLocally;

  useEffect(() => {
    if (!baseUrl) return;
    let cancelled = false;
    getSimDefaults(baseUrl)
      .then((defaults: SimDefaultsResponse) => {
        if (cancelled || hasServerConfigRef.current) return;
        const config = defaults[bot];
        if (config) applyRef.current(config);
      })
      .catch(() => {
        // An unreachable worker leaves the compile-time base in place, which is
        // the honest fallback: it is what this deployment would start with if
        // nobody set an environment override.
      });
    return () => { cancelled = true; };
  }, [bot, baseUrl]);
}

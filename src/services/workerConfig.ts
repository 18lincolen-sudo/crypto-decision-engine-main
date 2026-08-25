/**
 * Single source of truth for reading the saved Worker base URL — used by
 * tradingApiClient.ts, liveUniverse.ts, and WorkerAuthContext.tsx so the
 * resolution order (explicit > saved localStorage > build-time env) never
 * drifts between them. Written defensively (no direct `import.meta.env`
 * property access) because liveUniverse.ts is reachable from a Node
 * typecheck context (server/_smoke.ts -> bybitApi.ts) with no Vite types.
 */
export function resolveWorkerBaseUrl(configured?: string): string {
  let savedUrl = '';
  try {
    const saved = localStorage.getItem('workerConfig');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.baseUrl) savedUrl = parsed.baseUrl;
    }
  } catch { /* ignore */ }
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromEnv = env?.VITE_TRADING_API_URL;
  // Prefer an explicitly configured (manually entered/saved) URL over the build-time
  // VITE_TRADING_API_URL, so a saved Worker address is actually used.
  return (configured || savedUrl || fromEnv || '').replace(/\/$/, '');
}

/**
 * Single source of truth for reading the saved Worker base URL — used by
 * tradingApiClient.ts, liveUniverse.ts, and WorkerAuthContext.tsx so the
 * resolution order (explicit > saved localStorage > build-time env) never
 * drifts between them. Written defensively (no direct `import.meta.env`
 * property access) because liveUniverse.ts is reachable from a Node
 * typecheck context (server/_smoke.ts -> bybitApi.ts) with no Vite types.
 */
export function resolveWorkerBaseUrl(configured?: string): string {
  const { url, source } = resolveWorkerBaseUrlWithSource(configured);
  return url;
}

export type UrlSource = 'manual' | 'localStorage' | 'env' | 'none';

export function resolveWorkerBaseUrlWithSource(configured?: string): { url: string; source: UrlSource } {
  if (configured && configured.trim()) {
    return { url: configured.trim().replace(/\/$/, ''), source: 'manual' };
  }
  try {
    const saved = localStorage.getItem('workerConfig');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.baseUrl && parsed.baseUrl.trim()) {
        return { url: parsed.baseUrl.trim().replace(/\/$/, ''), source: 'localStorage' };
      }
    }
  } catch { /* ignore */ }
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromEnv = env?.VITE_TRADING_API_URL;
  if (fromEnv && fromEnv.trim()) {
    return { url: fromEnv.trim().replace(/\/$/, ''), source: 'env' };
  }
  return { url: '', source: 'none' };
}

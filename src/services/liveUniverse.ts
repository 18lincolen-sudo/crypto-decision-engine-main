/**
 * Mirrors the SAME liquidity-based trading universe the live worker uses
 * (see symbolUniverse.ts / tradingWorker.ts refreshUniverseIfStale), read
 * from the worker's public GET /api/public/universe (no admin token needed).
 * Falls back to the static TARGET_SYMBOLS list when the worker is
 * unreachable or not configured — the simulation must keep working offline.
 */
import { TARGET_SYMBOLS } from '../shared/targetSymbols';
import { resolveWorkerBaseUrl } from './workerConfig';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — avoid hammering the worker every render
let cached: { symbols: string[]; fetchedAt: number } | null = null;
let inFlight: Promise<string[]> | null = null;

async function fetchLiveUniverse(): Promise<string[]> {
  const base = resolveWorkerBaseUrl();
  if (!base) return TARGET_SYMBOLS;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${base}/api/public/universe`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return TARGET_SYMBOLS;
    const data = (await res.json()) as { symbols?: string[] };
    return data.symbols?.length ? data.symbols : TARGET_SYMBOLS;
  } catch {
    return TARGET_SYMBOLS;
  }
}

/** Current trading universe — the live worker's liquidity-refreshed list when reachable, else the static fallback. */
export async function getActiveSymbols(): Promise<string[]> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.symbols;
  if (inFlight) return inFlight;
  inFlight = fetchLiveUniverse().then((symbols) => {
    cached = { symbols, fetchedAt: Date.now() };
    inFlight = null;
    return symbols;
  });
  return inFlight;
}

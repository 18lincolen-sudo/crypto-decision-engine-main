/**
 * Historical Candle Cache — shared cache layer for candle history.
 *
 * Uses the same KV store mechanism as the simulation state persistence
 * (Firestore in production, local file in dev) so cached data survives
 * deploys on Render (which wipes local disk).
 *
 * Data is gzip-compressed before storage to reduce Firestore document
 * size (1MB limit) and transfer costs.
 *
 * Failures are swallowed: a failed read returns null (treat as cache miss),
 * a failed write doesn't block the caller. This matches the existing
 * "keep last-known-good on failure" pattern in the codebase.
 *
 * IMPORTANT: This module is server-side only (uses Node.js modules).
 * It should never be imported directly by frontend code.
 * Use dynamic import() with a Node.js environment check.
 */

import type { Candle } from '../src/services/tradeEngine';

// Lazy-initialized modules — only loaded when first accessed in Node.js env.
// This prevents Vite from trying to bundle server-only code for the browser.
let zlibModule: typeof import('node:zlib') | null = null;
let store: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> } | null = null;

async function getZlib() {
  if (zlibModule) return zlibModule;
  zlibModule = await import('node:zlib');
  return zlibModule;
}

async function getStore() {
  if (store) return store;
  const { createKVStore } = await import('./kvStore');
  store = createKVStore('candles', '.data/candles-kv.json');
  return store;
}

function cacheKey(symbol: string, timeframe: string): string {
  return `history-${symbol}-${timeframe}`;
}

/**
 * Maximum age of cached data before it's considered stale.
 * H1 candles: 1 hour is enough (new candle every hour).
 * 15m candles: 15 minutes.
 * 5m candles: 5 minutes.
 * We use a conservative 30-minute max for all timeframes — if the cache
 * is younger than that, we trust it; otherwise we refetch.
 */
const MAX_CACHE_AGE_MS = 8 * 24 * 60 * 60 * 1000; // 8 days — covers the weekly backtest cycle

interface CacheEntry {
  candles: Candle[];
  savedAt: number;
}

/**
 * Retrieve cached candle history for a symbol+timeframe.
 * Returns null on cache miss, stale cache, or any error (never throws).
 */
export async function getCachedHistory(
  symbol: string,
  timeframe: string
): Promise<Candle[] | null> {
  try {
    const [s, zlib] = await Promise.all([getStore(), getZlib()]);
    const raw = await s.get(cacheKey(symbol, timeframe));
    if (!raw) return null;

    // Decompress and parse
    const decompressed = zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8');
    const entry = JSON.parse(decompressed) as CacheEntry;

    // Validate structure
    if (!entry.candles?.length || !entry.savedAt) return null;

    // Check freshness
    const age = Date.now() - entry.savedAt;
    if (age > MAX_CACHE_AGE_MS) return null;

    // Validate candles have required fields
    const valid = entry.candles.every(
      (c) =>
        Number.isFinite(c.timestamp) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.high >= c.low
    );
    if (!valid) return null;

    return entry.candles;
  } catch {
    // Cache read failure = cache miss (never throw to caller)
    return null;
  }
}

/**
 * Save candle history to cache for a symbol+timeframe.
 * Failures are swallowed — cache write failure must not block the caller.
 */
export async function saveCachedHistory(
  symbol: string,
  timeframe: string,
  candles: Candle[]
): Promise<void> {
  try {
    if (!candles?.length) return;

    const entry: CacheEntry = {
      candles,
      savedAt: Date.now(),
    };

    const json = JSON.stringify(entry);
    const zlib = await getZlib();
    const compressed = zlib.gzipSync(Buffer.from(json, 'utf8'));
    const base64 = compressed.toString('base64');

    const s = await getStore();
    await s.set(cacheKey(symbol, timeframe), base64);
  } catch {
    // Cache write failure = silent (never throw to caller)
  }
}

/**
 * Check if cached history is fresh enough to use without refetching.
 * Returns true if cache exists and is newer than maxAgeMs.
 */
export async function isCacheFresh(
  symbol: string,
  timeframe: string,
  maxAgeMs: number = MAX_CACHE_AGE_MS
): Promise<boolean> {
  try {
    const [s, zlib] = await Promise.all([getStore(), getZlib()]);
    const raw = await s.get(cacheKey(symbol, timeframe));
    if (!raw) return false;

    const decompressed = zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8');
    const entry = JSON.parse(decompressed) as CacheEntry;

    return Date.now() - entry.savedAt < maxAgeMs;
  } catch {
    return false;
  }
}

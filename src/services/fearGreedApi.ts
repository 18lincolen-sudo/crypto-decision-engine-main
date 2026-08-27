
import { FearGreedIndex } from '../types/crypto';
import { resolveWorkerBaseUrl } from './workerConfig';

const FEAR_GREED_API_URL = 'https://api.alternative.me/fng/';
const WORKER_FEAR_GREED_PATH = '/api/fear-greed';
// The index updates once a day, but this used to be called by multiple
// independent callers (useCryptoData + all three sim contexts) on every page
// load — and the worker fetches the same API separately. Under that combined
// load api.alternative.me rate-limits (HTTP 429) and the hanging requests
// die on the 8s AbortController timeout ("signal is aborted without reason").
const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { data: FearGreedIndex; at: number } | null = null;
// De-duplicate concurrent callers: one shared request instead of N parallel hits.
let inFlight: Promise<FearGreedIndex> | null = null;

/**
 * Preferred source: the trading worker (GET /api/fear-greed). The worker
 * caches the reading 15 minutes and serves every browser from one upstream
 * request, so N tabs cost the API zero extra calls.
 */
async function fetchFromWorker(): Promise<FearGreedIndex> {
  const base = resolveWorkerBaseUrl();
  if (!base) throw new Error('no worker configured');
  const res = await fetch(`${base}${WORKER_FEAR_GREED_PATH}`);
  if (!res.ok) throw new Error(`worker fear-greed HTTP ${res.status}`);
  const data = await res.json() as { value?: unknown; value_classification?: unknown; timestamp?: unknown };
  if (typeof data?.value !== 'number' || !isFinite(data.value)) {
    throw new Error('invalid worker fear-greed payload');
  }
  return {
    value: data.value,
    value_classification: typeof data.value_classification === 'string' ? data.value_classification : 'Neutral',
    timestamp: String(data.timestamp ?? Math.floor(Date.now() / 1000))
  };
}

/** Fallback source: direct browser call to api.alternative.me (8s timeout). */
async function fetchDirect(): Promise<FearGreedIndex> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

  try {
    const response = await fetch(`${FEAR_GREED_API_URL}?limit=1`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.data || !data.data[0]) {
      throw new Error('Invalid API response format');
    }

    const latest = data.data[0];
    return {
      value: parseInt(latest.value),
      value_classification: latest.value_classification,
      timestamp: latest.timestamp
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function neutralFallback(): FearGreedIndex {
  return {
    value: 50,
    value_classification: 'Neutral',
    timestamp: Math.floor(Date.now() / 1000).toString()
  };
}

export const fearGreedApi = {
  async getFearGreedIndex(): Promise<FearGreedIndex> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return cache.data;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        // Worker first; on any failure (not configured / endpoint missing /
        // offline) fall back to the direct API call.
        const result = await fetchFromWorker().catch(() => fetchDirect());
        cache = { data: result, at: Date.now() };
        return result;
      } catch (error) {
        console.warn('Error fetching Fear & Greed index:', error);

        // Serve a stale cached value over a fabricated neutral one if we have
        // one — a real (if slightly old) sentiment reading beats a fake 50.
        if (cache) return cache.data;
        return neutralFallback();
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }
};


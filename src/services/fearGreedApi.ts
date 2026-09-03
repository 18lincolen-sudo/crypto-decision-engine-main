
import { FearGreedIndex } from '@cde/engine';
import { resolveWorkerBaseUrl } from './workerConfig';
import { fetchJson, ValidationError } from '../utils/errorHandler';

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
  const data = await fetchJson<{ value?: unknown; value_classification?: unknown; timestamp?: unknown }>(
    `${base}${WORKER_FEAR_GREED_PATH}`,
    { timeoutMs: 6000, label: 'worker fear-greed' }
  );
  if (typeof data?.value !== 'number' || !isFinite(data.value)) {
    throw new ValidationError('invalid worker fear-greed payload');
  }
  return {
    value: data.value,
    value_classification: typeof data.value_classification === 'string' ? data.value_classification : 'Neutral',
    timestamp: String(data.timestamp ?? Math.floor(Date.now() / 1000))
  };
}

/** Fallback source: direct browser call to api.alternative.me (8s timeout).
 *  The timeout/abort/status handling all lives in fetchJson now — this
 *  function is left with the one thing specific to it: the payload shape. */
interface AlternativeMeResponse {
  data?: Array<{ value?: string | number; value_classification?: string; timestamp?: string | number }>;
}

async function fetchDirect(): Promise<FearGreedIndex> {
  const data = await fetchJson<AlternativeMeResponse>(`${FEAR_GREED_API_URL}?limit=1`, {
    timeoutMs: 8000,
    label: 'alternative.me fear-greed'
  });

  const latest = data.data?.[0];
  if (!latest) {
    throw new ValidationError('Invalid API response format');
  }

  const value = Number(latest.value);
  if (!isFinite(value)) {
    throw new ValidationError('Invalid fear-greed value');
  }

  return {
    value,
    value_classification: latest.value_classification ?? 'Neutral',
    timestamp: String(latest.timestamp ?? Math.floor(Date.now() / 1000))
  };
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


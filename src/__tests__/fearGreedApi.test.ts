import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// workerConfig is mocked so tests control whether a worker URL is configured,
// regardless of the repo's .env (which Vite injects into import.meta.env and
// which vi.stubEnv cannot reliably neutralize here).
const mockWorkerConfig = vi.hoisted(() => ({ baseUrl: '' }));
vi.mock('../services/workerConfig', () => ({
  resolveWorkerBaseUrl: () => mockWorkerConfig.baseUrl
}));


/**
 * Diagnosis / regression tests for src/services/fearGreedApi.ts.
 *
 * Reproduces the exact browser-console failures reported on
 * https://crypto-d.netlify.app:
 *
 *   Error fetching Fear & Greed index: AbortError: signal is aborted
 *   without reason            ← the 8s AbortController timeout (line 18)
 *
 *   state:1  ... status of 429  ← api.alternative.me rate-limiting the
 *                                 browser when it polls the API directly,
 *                                 in parallel with the worker's own
 *                                 fetchFearGreed() (tradingWorker.ts:859).
 *
 * The module keeps a module-level cache, so every test imports a fresh
 * module instance via vi.resetModules() + dynamic import.
 */

const API_URL = 'https://api.alternative.me/fng/?limit=1';
const API_OK_BODY = {
  data: [{ value: '42', value_classification: 'Fear', timestamp: '1700000000' }]
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Import a fresh module instance (fresh module-level cache). */
async function fresh() {
  vi.resetModules();
  return await import('../services/fearGreedApi');
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // Default: no worker configured → the direct Alternative.me path
  mockWorkerConfig.baseUrl = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fearGreedApi.getFearGreedIndex', () => {
  it('parses a successful Alternative.me response', async () => {
    const { fearGreedApi } = await fresh();
    const fetchMock = vi.fn(async (_url?: unknown) => jsonResponse(API_OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const r = await fearGreedApi.getFearGreedIndex();

    expect(r).toEqual({ value: 42, value_classification: 'Fear', timestamp: '1700000000' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(API_URL);
  });

  it('caches for 15 minutes — repeated calls within the TTL do NOT refetch', async () => {
    const { fearGreedApi } = await fresh();
    const fetchMock = vi.fn(async () => jsonResponse(API_OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await fearGreedApi.getFearGreedIndex();
    await fearGreedApi.getFearGreedIndex();
    await fearGreedApi.getFearGreedIndex();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 429 → neutral 50 fallback when there is no cached value yet', async () => {
    const { fearGreedApi } = await fresh();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'rate limited' }, 429)));

    const r = await fearGreedApi.getFearGreedIndex();

    expect(r.value).toBe(50);
    expect(r.value_classification).toBe('Neutral');
  });

  it('HTTP 429 → serves the STALE cached value instead of a fabricated 50', async () => {
    const { fearGreedApi } = await fresh();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(API_OK_BODY)));
    const first = await fearGreedApi.getFearGreedIndex();
    expect(first.value).toBe(42);

    // TTL (15 min) expires, then the API starts rate-limiting (429)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'rate limited' }, 429)));

    const stale = await fearGreedApi.getFearGreedIndex();

    // A real (slightly old) sentiment reading beats a fake neutral 50
    expect(stale.value).toBe(42);
  });

  it('8s timeout aborts the request (AbortError) and falls back to neutral — the exact console error', async () => {
    vi.useFakeTimers();
    const { fearGreedApi } = await fresh();

    // Simulates a hung / rate-limited connection: the promise only rejects
    // when the AbortController signal fires — exactly like a real fetch.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })
      )
    );

    const pending = fearGreedApi.getFearGreedIndex();
    // Fire the module's 8s abort timer
    await vi.advanceTimersByTimeAsync(8_100);
    const r = await pending;

    // Graceful fallback — no crash, and the signal was aborted without a
    // reason argument (controller.abort(), fearGreedApi.ts)
    expect(r.value).toBe(50);
    expect(r.value_classification).toBe('Neutral');
  });

  it('prefers the worker endpoint (/api/fear-greed) when a worker URL is configured', async () => {
    mockWorkerConfig.baseUrl = 'https://worker.example.com';
    const { fearGreedApi } = await fresh();
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/fear-greed')) {
        return new Response(JSON.stringify({ value: 44, value_classification: 'Fear', timestamp: '1700000001' }), { status: 200 });
      }
      return jsonResponse(API_OK_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await fearGreedApi.getFearGreedIndex();

    // One call, to the worker — api.alternative.me is never hit by the browser
    expect(r.value).toBe(44);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://worker.example.com/api/fear-greed');
  });

  it('falls back to the direct Alternative.me call when the worker endpoint fails', async () => {
    mockWorkerConfig.baseUrl = 'https://worker.example.com';
    const { fearGreedApi } = await fresh();
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/fear-greed')) return new Response('not found', { status: 404 });
      return jsonResponse(API_OK_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await fearGreedApi.getFearGreedIndex();

    expect(r.value).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://worker.example.com/api/fear-greed');
    expect(String(fetchMock.mock.calls[1][0])).toBe(API_URL);
  });

  it('de-duplicates concurrent callers into ONE shared request', async () => {
    const { fearGreedApi } = await fresh();
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn((_url: unknown) => new Promise<Response>((res) => { resolveFetch = res; }));
    vi.stubGlobal('fetch', fetchMock);

    // useCryptoData + the three sim contexts all call this on page load
    const a = fearGreedApi.getFearGreedIndex();
    const b = fearGreedApi.getFearGreedIndex();
    const c = fearGreedApi.getFearGreedIndex();
    // The fetch happens a few microtasks in (worker-first → catch → direct)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(jsonResponse(API_OK_BODY));
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ra.value).toBe(42);
    expect(rb.value).toBe(42);
    expect(rc.value).toBe(42);
  });
});

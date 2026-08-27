import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Exercises public/service-worker.js in a sandbox to verify the NEW runtime
 * behaviour on https://crypto-d.netlify.app.
 *
 * Fixed behaviour under test:
 *
 * 1. /api/*, /health and external hosts are NOT intercepted anymore — the old
 *    SW masked network failures with a synthetic 503 Response, which made a
 *    connectivity problem (Render worker asleep, DNS hiccup) look like a
 *    server-side "Worker 503" in the dashboard. Now failures surface as real
 *    network errors.
 *
 * 2. /manifest.json is network-first WITH a cache fallback (seeded by the
 *    install precache). The old SW had NO fallback and never cached the
 *    manifest, so a transient Netlify deploy-protection 401 reached the
 *    browser unchanged and the manifest stayed broken.
 *
 * 3. Static assets keep network-first + cache fallback.
 */

const SW_SOURCE = readFileSync(
  fileURLToPath(new URL('../../public/service-worker.js', import.meta.url)),
  'utf8'
);

const ORIGIN = 'https://crypto-d.netlify.app';

function loadSW() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const cacheStore = new Map<string, Map<string, Response>>();
  const CACHE_NAME = 'crypto-decision-engine-v4';

  const cachesApi = {
    async keys(): Promise<string[]> { return [...cacheStore.keys()]; },
    async delete(name: string): Promise<boolean> { return cacheStore.delete(name); },
    async match(req: Request | string): Promise<Response | undefined> {
      return cacheStore.get(CACHE_NAME)?.get(typeof req === 'string' ? req : req.url);
    },
    async open(name: string) {
      if (!cacheStore.has(name)) cacheStore.set(name, new Map());
      const bucket = cacheStore.get(name)!;
      return {
        async put(req: Request | string, resp: Response): Promise<void> {
          bucket.set(typeof req === 'string' ? req : req.url, resp);
        },
        async addAll(urls: string[]): Promise<void> {
          for (const u of urls) bucket.set(u, new Response(`precache:${u}`));
        }
      };
    }
  };

  const sandbox: Record<string, unknown> = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URL,
    Response,
    Request,
    setTimeout,
    clearTimeout,
    caches: cachesApi,
    fetch: undefined as unknown,
    self: {
      location: { origin: ORIGIN },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
      addEventListener(type: string, fn: (e: unknown) => void) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type)!.push(fn);
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);

  return {
    cachesApi,
    setFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
      sandbox.fetch = fn;
    },
    /**
     * Dispatch a fetch event. Returns null when the SW did NOT call
     * respondWith — i.e. the request passes through to the network untouched.
     */
    dispatchFetch(url: string): Promise<Response> | null {
      let responded: Promise<Response> | null = null;
      const event = {
        request: new Request(url),
        respondWith(p: Promise<Response>) { responded = p; }
      };
      for (const fn of listeners.get('fetch') ?? []) fn(event);
      return responded;
    },
    /** Dispatch the install event and await its waitUntil promise. */
    async dispatchInstall(): Promise<void> {
      const waited: Promise<unknown>[] = [];
      const event = { waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
      for (const fn of listeners.get('install') ?? []) fn(event);
      await Promise.all(waited);
    }
  };
}

describe('public/service-worker.js runtime behaviour', () => {
  it('does NOT intercept /api/* — network failures surface as real errors (no synthetic 503)', async () => {
    const sw = loadSW();
    sw.setFetch(async () => { throw new Error('render is asleep'); });

    // null = the SW never called respondWith — the browser handles the
    // request and the app sees a real network failure, not a fake 503.
    expect(sw.dispatchFetch(`${ORIGIN}/api/sim/state`)).toBeNull();
    expect(sw.dispatchFetch(`${ORIGIN}/health`)).toBeNull();
  });

  it('does NOT intercept external hosts (alternative.me, bybit, binance, coingecko)', () => {
    const sw = loadSW();
    expect(sw.dispatchFetch('https://api.alternative.me/fng/?limit=1')).toBeNull();
    expect(sw.dispatchFetch('https://api.bybit.com/v5/market/tickers')).toBeNull();
    expect(sw.dispatchFetch('https://api.binance.com/api/v3/ticker/price')).toBeNull();
    expect(sw.dispatchFetch('https://api.coingecko.com/api/v3/ping')).toBeNull();
  });

  it('install precaches /index.html and /manifest.json', async () => {
    const sw = loadSW();
    await sw.dispatchInstall();
    expect(await sw.cachesApi.match('/manifest.json')).toBeDefined();
    expect(await sw.cachesApi.match('/index.html')).toBeDefined();
  });

  it('manifest: a successful network response passes through and is cached', async () => {
    const sw = loadSW();
    sw.setFetch(async () => new Response('{"name":"Crypto Decision Engine"}', { status: 200 }));

    const res = await sw.dispatchFetch(`${ORIGIN}/manifest.json`);

    expect(res!.status).toBe(200);
    expect(await (await sw.cachesApi.match('/manifest.json'))!.text()).toBe('{"name":"Crypto Decision Engine"}');
  });

  it('manifest: a transient 401 (deploy-protection window) is replaced by the last good cached copy', async () => {
    const sw = loadSW();
    await sw.dispatchInstall(); // seeds a good manifest copy
    sw.setFetch(async () => new Response('Unauthorized', { status: 401 }));

    const res = await sw.dispatchFetch(`${ORIGIN}/manifest.json`);

    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe('precache:/manifest.json');
  });

  it('manifest: a network failure also falls back to the cached copy', async () => {
    const sw = loadSW();
    await sw.dispatchInstall();
    sw.setFetch(async () => { throw new Error('offline'); });

    const res = await sw.dispatchFetch(`${ORIGIN}/manifest.json`);

    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe('precache:/manifest.json');
  });

  it('manifest: a 401 with NO cached copy passes through unchanged (honest failure)', async () => {
    const sw = loadSW(); // no install → empty cache
    sw.setFetch(async () => new Response('Unauthorized', { status: 401 }));

    const res = await sw.dispatchFetch(`${ORIGIN}/manifest.json`);

    expect(res!.status).toBe(401);
  });

  it('static assets get network-first + cache fallback (works as intended)', async () => {
    const sw = loadSW();

    // First load succeeds and is cached
    sw.setFetch(async () => new Response('console.log("app")', { status: 200 }));
    const first = await sw.dispatchFetch(`${ORIGIN}/assets/app.js`);
    expect(first.status).toBe(200);

    // Network dies — cached copy is served
    sw.setFetch(async () => { throw new Error('offline'); });
    const second = await sw.dispatchFetch(`${ORIGIN}/assets/app.js`);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe('console.log("app")');
  });
});

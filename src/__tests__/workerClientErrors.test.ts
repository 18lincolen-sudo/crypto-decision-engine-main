import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTradingApiClient } from '../services/tradingApiClient';

/**
 * Documents the exact client-side error strings from the user's console:
 *
 *   index-DV-7bIH3.js:481 [Worker] fetchWorkerData error: Worker 503
 *
 * That message is produced by tradingApiClient.ts:
 *   - getHealth() → `Worker ${res.status}`            (line 322)
 *   - authed()    → `Worker ${res.status}: ${body}`   (line 312)
 *
 * A 503 here can come from (a) the Render free-tier proxy while the worker
 * sleeps/wakes, or (b) public/service-worker.js masking a NETWORK failure as
 * a synthetic 503 for /api/* and /health (see serviceWorker.test.ts).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tradingApiClient error surface', () => {
  it('getHealth throws exactly "Worker 503" when the worker returns 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Service Unavailable', { status: 503 })));
    const client = createTradingApiClient('https://worker.example.com', 'token');
    await expect(client.getHealth()).rejects.toThrow('Worker 503');
  });

  it('authed endpoints surface "Worker 503: <body>" (account-summary path)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Account context unavailable"}', { status: 503 }))
    );
    const client = createTradingApiClient('https://worker.example.com', 'token');
    await expect(client.getState()).rejects.toThrow('Worker 503');
  });

  it('getHealth throws "Worker 429" when the per-IP rate limiter trips', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Too many requests', { status: 429 })));
    const client = createTradingApiClient('https://worker.example.com', 'token');
    await expect(client.getHealth()).rejects.toThrow('Worker 429');
  });
});

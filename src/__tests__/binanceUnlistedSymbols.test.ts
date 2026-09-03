/**
 * Regression tests: never ask Binance for a pair it does not list.
 * ============================================================================
 * The asset universe comes from Bybit, which trades pairs Binance does not
 * (CAPUSDT, HUSDT, …). Binance answers those with 400 {"code":-1121,
 * "msg":"Invalid symbol."} and — critically — sends NO CORS headers on 4xx,
 * so in a browser the request never resolves: it surfaces as
 *
 *   Access to fetch at '…/klines?symbol=CAPUSDT…' has been blocked by CORS
 *   policy: No 'Access-Control-Allow-Origin' header is present
 *   Failed to load resource: net::ERR_FAILED
 *
 * `fetch` REJECTS rather than returning the 400, so the message is
 * "Failed to fetch", which matches none of the SYMBOL_NOT_FOUND patterns — the
 * doomed request was therefore also retried, once per symbol per timeframe per
 * scan, and the console filled with what looked like a CORS misconfiguration.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchTimeframe, fetchBinanceKlines } from '../services/marketDataService';

function makeResponse(body: unknown, status = 200, ok = status >= 200 && status < 300): Response {
  return {
    ok, status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  } as unknown as Response;
}

const HOUR = 3_600_000;
const now = 1_788_400_000_000;
const endTs = Math.floor(now / HOUR) * HOUR - HOUR;

function binanceRows(n: number): unknown[][] {
  return Array.from({ length: n }, (_, i) => {
    const ts = endTs - i * HOUR;
    return [ts, '100', '101', '99', '100', '10', ts + HOUR - 1, '100', 1, ''];
  });
}

/** The real /ticker/price shape: Binance lists BTC and NEO, but not CAP or H. */
const REGISTRY = [{ symbol: 'BTCUSDT', price: '1' }, { symbol: 'NEOUSDT', price: '1' }];

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Binance symbol registry', () => {
  it('never issues a klines request for a pair Binance does not list', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('ticker/price')) return makeResponse(REGISTRY);
      if (url.includes('bybit.com')) return makeResponse({ retCode: 10001, retMsg: 'Not supported symbols', result: { list: [] } }, 200, true);
      return makeResponse(binanceRows(240));
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchTimeframe('CAPUSDT', '1h', { now, limit: 240 });

    const klineCalls = fetchMock.mock.calls
      .map(([u]) => String(u))
      .filter(u => u.includes('binance') && u.includes('/klines'));
    expect(klineCalls, 'an unlisted pair must never reach Binance /klines').toEqual([]);
    expect(r.candles.length).toBe(0);
    expect(r.reason).toBe('SYMBOL_NOT_FOUND');
  });

  it('reports an unlisted pair as SYMBOL_NOT_FOUND so it is not retried', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('ticker/price') ? makeResponse(REGISTRY) : makeResponse(binanceRows(240))
    ));
    await expect(fetchBinanceKlines('HUSDT', '1h', 7)).rejects.toThrow(/invalid symbol/i);
  });

  it('still fetches pairs Binance does list', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('ticker/price')) return makeResponse(REGISTRY);
      if (url.includes('bybit.com')) return makeResponse({ retCode: 10001, retMsg: 'Not supported symbols', result: { list: [] } }, 200, true);
      return makeResponse(binanceRows(240));
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchTimeframe('NEOUSDT', '1h', { now, limit: 240 });
    expect(r.source).toBe('binance');
    expect(r.candles.length).toBe(240);
  });

  it('fails OPEN when the registry itself is unavailable', async () => {
    // A guard that silences a healthy source on a transient network blip would
    // be far worse than the bug it fixes.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('ticker/price')) return makeResponse('gateway timeout', 504, false);
      if (url.includes('bybit.com')) return makeResponse({ retCode: 10001, retMsg: 'Not supported symbols', result: { list: [] } }, 200, true);
      return makeResponse(binanceRows(240));
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchTimeframe('NEOUSDT', '1h', { now, limit: 240 });
    expect(r.source).toBe('binance');
    expect(r.candles.length).toBe(240);
  });
});

describe('delta mode treats "no new candles" as an answer, not a failure', () => {
  it('does not fall through to Binance when the primary simply has nothing new', async () => {
    // The bots poll every few seconds; a 1h candle closes once an hour. Falling
    // over to the fallback on every empty delta is what sent every Bybit-only
    // pair to Binance on every single tick.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('ticker/price')) return makeResponse(REGISTRY);
      if (url.includes('bybit.com')) return makeResponse({ retCode: 0, retMsg: 'OK', result: { list: [] } });
      return makeResponse(binanceRows(240));
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchTimeframe('BTCUSDT', '1h', { now, limit: 240, since: endTs - HOUR });

    expect(r.reason).toBe('NO_NEW_CANDLES');
    const binanceCalls = fetchMock.mock.calls.map(([u]) => String(u)).filter(u => u.includes('binance') && u.includes('/klines'));
    expect(binanceCalls, 'an empty delta must not trigger the fallback source').toEqual([]);
  });

  it('still fails over when the primary genuinely errors', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('ticker/price')) return makeResponse(REGISTRY);
      if (url.includes('bybit.com')) return makeResponse({ retCode: 10001, retMsg: 'Not supported symbols', result: { list: [] } }, 200, true);
      return makeResponse(binanceRows(3));
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchTimeframe('BTCUSDT', '1h', { now, limit: 240, since: endTs - 4 * HOUR });
    expect(r.source).toBe('binance');
    expect(r.candles.length).toBeGreaterThan(0);
  });
});

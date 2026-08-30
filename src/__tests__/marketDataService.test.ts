/**
 * marketDataService tests
 * ============================================================================
 * Unit tests mock `fetch` (no network). Integration / full-universe tests hit
 * the real Bybit/Binance APIs and are gated behind RUN_LIVE_MARKET_TESTS so
 * they don't run (or flake) in CI. Run locally with:
 *   RUN_LIVE_MARKET_TESTS=1 npx vitest run src/__tests__/marketDataService.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateCandles,
  dropFormingCandle,
  isAlignedToTimeframe,
  fetchTimeframe,
  fetchBybitKlines,
  fetchBinanceKlines,
  getMultiTimeframeData,
  clearMarketDataCache,
  TIMEFRAME_SPECS
} from '../services/marketDataService';
import type { Candle } from '../services/tradeEngine';
import { TARGET_SYMBOLS } from '../shared/targetSymbols';

// ── fetch mocking helpers ─────────────────────────────────────────────────────
function makeResponse(body: unknown, status = 200, ok = status >= 200 && status < 300): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  } as unknown as Response;
}

function bybitKlineBody(rows: [string, string, string, string, string, string][]) {
  return { retCode: 0, retMsg: 'OK', result: { list: rows } };
}

function candleRow(ts: number, price = 100): [string, string, string, string, string, string] {
  return [String(ts), String(price), String(price + 1), String(price - 1), String(price), '10'];
}

// Build N closed candles ending at `endTs` (inclusive), spaced `ms` apart, newest→oldest.
function buildBybitRows(endTs: number, ms: number, n: number, price = 100): [string, string, string, string, string, string][] {
  const rows: [string, string, string, string, string, string][] = [];
  for (let i = 0; i < n; i++) rows.push(candleRow(endTs - i * ms, price + i));
  return rows; // newest first
}

function buildBinanceRows(endTs: number, ms: number, n: number, price = 100): unknown[][] {
  const rows: unknown[][] = [];
  for (let i = 0; i < n; i++) {
    const ts = endTs - i * ms;
    rows.push([ts, String(price), String(price + 1), String(price - 1), String(price), '10', ts + ms - 1, '100', 1, '']);
  }
  return rows; // newest first
}

// ── Unit: validateCandles ─────────────────────────────────────────────────────
describe('validateCandles', () => {
  const mk = (ts: number, o = 100, h = 110, l = 90, c = 105, v = 10): Candle => ({ timestamp: ts, open: o, high: h, low: l, close: c, volume: v });

  it('empty array → NO_DATA', () => {
    const r = validateCandles([], 10);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_DATA');
  });

  it('insufficient candles → INSUFFICIENT_CANDLES', () => {
    const candles = Array.from({ length: 5 }, (_, i) => mk(i * 1000));
    const r = validateCandles(candles, 10);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_CANDLES');
  });

  it('exact minimum → ok', () => {
    const candles = Array.from({ length: 10 }, (_, i) => mk((i + 1) * 1000));
    expect(validateCandles(candles, 10).ok).toBe(true);
  });

  it('above minimum → ok', () => {
    const candles = Array.from({ length: 15 }, (_, i) => mk((i + 1) * 1000));
    expect(validateCandles(candles, 10).ok).toBe(true);
  });

  it('drops duplicate timestamps', () => {
    const candles = [mk(1000), mk(1000), mk(2000), mk(3000)];
    const r = validateCandles(candles, 3);
    expect(r.cleaned.length).toBe(3);
    expect(r.dropped).toBe(1);
  });

  it('drops invalid OHLC (high < low) and NaN', () => {
    const bad = mk(1000, 100, 90, 110, 105); // high < low
    const nan = { ...mk(2000), close: NaN };
    const good = mk(3000);
    const r = validateCandles([bad, nan, good], 1);
    expect(r.cleaned.length).toBe(1);
    expect(r.cleaned[0].timestamp).toBe(3000);
  });

  it('sorts ascending by timestamp', () => {
    const r = validateCandles([mk(3000), mk(1000), mk(2000)], 3);
    expect(r.cleaned.map((c) => c.timestamp)).toEqual([1000, 2000, 3000]);
  });
});

// ── Unit: dropFormingCandle ───────────────────────────────────────────────────
describe('dropFormingCandle', () => {
  const ms = TIMEFRAME_SPECS['1h'].ms;
  const now = Date.now();
  const closedTs = Math.floor(now / ms) * ms - ms; // previous closed hour
  const formingTs = Math.floor(now / ms) * ms; // current forming hour

  it('removes the forming candle but keeps closed ones (1h)', () => {
    const candles = [mk(closedTs - ms), mk(closedTs), mk(formingTs)];
    const out = dropFormingCandle(candles, ms, now);
    expect(out.map((c) => c.timestamp)).toEqual([closedTs - ms, closedTs]);
  });

  it('does not delete a closed candle by mistake (15m, 5m)', () => {
    for (const tf of ['15m', '5m'] as const) {
      const tfMs = TIMEFRAME_SPECS[tf].ms;
      const cTs = Math.floor(now / tfMs) * tfMs - tfMs;
      const fTs = Math.floor(now / tfMs) * tfMs;
      const out = dropFormingCandle([mk(cTs), mk(fTs)], tfMs, now);
      expect(out.length).toBe(1);
      expect(out[0].timestamp).toBe(cTs);
    }
  });
});

// ── Unit: isAlignedToTimeframe ───────────────────────────────────────────────
describe('isAlignedToTimeframe', () => {
  it('true when last timestamp aligns to grid', () => {
    const ms = TIMEFRAME_SPECS['1h'].ms;
    expect(isAlignedToTimeframe([mk(ms * 100)], ms)).toBe(true);
  });
  it('false when misaligned', () => {
    const ms = TIMEFRAME_SPECS['1h'].ms;
    expect(isAlignedToTimeframe([mk(ms * 100 + 12345)], ms)).toBe(false);
  });
});

function mk(ts: number, o = 100, h = 110, l = 90, c = 105, v = 10): Candle {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: v };
}

// ── Unit: fetchTimeframe (mocked fetch) ──────────────────────────────────────
describe('fetchTimeframe', () => {
  const ms = TIMEFRAME_SPECS['1h'].ms;
  const now = Date.now();
  const endTs = Math.floor(now / ms) * ms - ms; // last closed 1h candle open time

  beforeEach(() => clearMarketDataCache());
  afterEach(() => vi.unstubAllGlobals());

  it('uses Bybit LINEAR by default (matches futures bot)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('category=linear');
      return makeResponse(bybitKlineBody(buildBybitRows(endTs, ms, 240)));
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchTimeframe('BTCUSDT', '1h', { now, limit: 240 });
    expect(r.source).toBe('bybit');
    expect(r.candles.length).toBe(240);
  });

  it('falls back to Binance when Bybit fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('bybit.com')) return makeResponse({ retCode: 10001, retMsg: 'Not supported symbols', result: { list: [] } }, 200, true);
      return makeResponse(buildBinanceRows(endTs, ms, 240));
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchTimeframe('NEOUSDT', '1h', { now, limit: 240 });
    expect(r.source).toBe('binance');
    expect(r.candles.length).toBe(240);
  });

  it('classifies both-source API failure as API_ERROR (not INSUFFICIENT_CANDLES)', async () => {
    const fetchMock = vi.fn(async () => makeResponse({ retCode: 500, retMsg: 'internal' }, 500, false));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchTimeframe('FAKEUSDT', '1h', { now, limit: 240 });
    expect(r.candles.length).toBe(0);
    expect(r.reason).toBe('API_ERROR');
  });

  it('classifies HTTP 429 as RATE_LIMIT', async () => {
    const fetchMock = vi.fn(async () => makeResponse('Too many requests', 429, false));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchTimeframe('FAKEUSDT', '1h', { now, limit: 240 });
    expect(r.reason).toBe('RATE_LIMIT');
  });

  it('classifies Bybit 10001 as SYMBOL_NOT_FOUND', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('bybit.com')) return makeResponse({ retCode: 10001, retMsg: 'Not supported symbols' }, 200, true);
      return makeResponse('symbol not found', 400, false);
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchTimeframe('FAKEUSDT', '1h', { now, limit: 240 });
    expect(r.reason).toBe('SYMBOL_NOT_FOUND');
  });

  it('reports INSUFFICIENT_CANDLES only when data was received but too few', async () => {
    // Bybit returns 50 candles (below 200 min) → genuine insufficiency
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('bybit.com')) return makeResponse(bybitKlineBody(buildBybitRows(endTs, ms, 50)));
      return makeResponse(buildBinanceRows(endTs, ms, 50));
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchTimeframe('BTCUSDT', '1h', { now, limit: 240 });
    expect(r.candles.length).toBe(0);
    expect(r.reason).toBe('INSUFFICIENT_CANDLES');
    expect(r.received).toBe(50);
  });
});

// ── Unit: getMultiTimeframeData telemetry ────────────────────────────────────
describe('getMultiTimeframeData telemetry', () => {
  const now = Date.now();
  afterEach(() => vi.unstubAllGlobals());

  it('populates reasons/telemetry and reports real cause on failure', async () => {
    const ms = TIMEFRAME_SPECS['1h'].ms;
    const endTs = Math.floor(now / ms) * ms - ms;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('bybit.com')) return makeResponse({ retCode: 10001, retMsg: 'Not supported symbols' }, 200, true);
      return makeResponse('symbol not found', 400, false);
    });
    vi.stubGlobal('fetch', fetchMock);
    const snap = await getMultiTimeframeData('FAKEUSDT', { now, force: true });
    expect(snap.status).toBe('NOT_READY');
    expect(snap.reasons['1h']).toBe('SYMBOL_NOT_FOUND');
    expect(snap.telemetry['1h'].received).toBe(0);
    expect(snap.telemetry['1h'].required).toBe(TIMEFRAME_SPECS['1h'].minCandles);
  });
});

// ── Integration: real APIs (gated) ───────────────────────────────────────────
const RUN_LIVE = process.env.RUN_LIVE_MARKET_TESTS === '1';
const maybe = RUN_LIVE ? describe : describe.skip;

maybe('LIVE integration: control + problematic symbols', () => {
  const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'TONUSDT', 'MATICUSDT', 'FTMUSDT', 'RNDRUSDT'];
  it('all three timeframes return READY for every symbol', async () => {
    for (const s of SYMS) {
      const snap = await getMultiTimeframeData(s, { force: true });
      expect(snap.status, `${s} status`).toBe('READY');
      for (const tf of ['1h', '15m', '5m'] as const) {
        expect(snap.counts[tf], `${s} ${tf} count`).toBeGreaterThanOrEqual(TIMEFRAME_SPECS[tf].minCandles);
      }
      console.log(`${s.padEnd(10)} 1h=${snap.counts['1h']} 15m=${snap.counts['15m']} 5m=${snap.counts['5m']} src=${snap.sources['5m']}`);
    }
  }, 120_000);
});

maybe('LIVE full universe', () => {
  it('every TARGET_SYMBOLS entry is READY', async () => {
    let ready = 0;
    const notReady: string[] = [];
    for (const s of TARGET_SYMBOLS) {
      const snap = await getMultiTimeframeData(s, { force: true });
      if (snap.status === 'READY') ready++;
      else notReady.push(`${s}:${snap.reason}`);
      await new Promise((r) => setTimeout(r, 30));
    }
    console.log(`FULL UNIVERSE READY=${ready}/${TARGET_SYMBOLS.length} NOT_READY=${notReady.length}`);
    if (notReady.length) console.log(notReady.join('\n'));
    expect(notReady.length, `not ready: ${notReady.join(', ')}`).toBe(0);
  }, 600_000);
});

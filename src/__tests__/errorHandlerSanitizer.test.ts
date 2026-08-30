import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AppError, APIError, NetworkError, TimeoutError, ValidationError,
  handleError, withErrorHandling, withFallback, isRetryable, fetchJson, readJson
} from '../utils/errorHandler';
import {
  contentSanitizer, safeParseJSON, readStoredJSON, writeStoredJSON,
  sanitizeURL, sanitizeSymbol, sanitizeNumber, escapeHTML
} from '../utils/sanitizer';

describe('handleError', () => {
  it('classifies by TYPE before sniffing the message', () => {
    // A price string containing "401" used to be read as an auth failure by
    // the old message-first implementation.
    expect(handleError(new Error('BTC moved to 401.5 today'))).toBe('BTC moved to 401.5 today');
    expect(handleError(new APIError('nope', 401))).toContain('הרשאה');
  });

  it('maps status families to the right sentence', () => {
    expect(handleError(new APIError('x', 429))).toContain('יותר מדי בקשות');
    expect(handleError(new APIError('x', 503))).toContain('אינו זמין');
    expect(handleError(new TimeoutError())).toContain('פג');
    expect(handleError(new NetworkError())).toContain('חיבור');
  });

  it('never returns empty for an unknown throwable', () => {
    expect(handleError('a string')).toBeTruthy();
    expect(handleError(null)).toBeTruthy();
  });
});

describe('isRetryable', () => {
  it('separates transient failures from permanent ones', () => {
    expect(isRetryable(new TimeoutError())).toBe(true);
    expect(isRetryable(new NetworkError())).toBe(true);
    expect(isRetryable(new APIError('x', 429))).toBe(true);
    expect(isRetryable(new APIError('x', 500))).toBe(true);
    expect(isRetryable(new APIError('x', 404))).toBe(false);
    expect(isRetryable(new ValidationError('x'))).toBe(false);
  });
});

describe('withErrorHandling', () => {
  it('accepts a TYPED function — the old signature made it uncallable', async () => {
    const typed = async (a: number, b: string): Promise<string> => `${a}${b}`;
    const wrapped = withErrorHandling(typed);
    await expect(wrapped(1, 'x')).resolves.toBe('1x');
  });

  it('converts a throw into an AppError with a readable message', async () => {
    const wrapped = withErrorHandling(async () => { throw new Error('boom'); });
    await expect(wrapped()).rejects.toBeInstanceOf(AppError);
  });

  it('passes an existing AppError through unchanged', async () => {
    const original = new APIError('kept', 404);
    const wrapped = withErrorHandling(async () => { throw original; });
    await expect(wrapped()).rejects.toBe(original);
  });
});

describe('withFallback', () => {
  it('returns the fallback instead of throwing', async () => {
    await expect(withFallback(async () => { throw new Error('x'); }, 42)).resolves.toBe(42);
  });
});

describe('fetchJson / readJson', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('returns a typed body on success', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ value: 7 }), { status: 200 })) as never;
    await expect(fetchJson<{ value: number }>('https://x.test/a')).resolves.toEqual({ value: 7 });
  });

  it('throws APIError carrying the status on a non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 429 })) as never;
    await expect(fetchJson('https://x.test/a')).rejects.toMatchObject({ statusCode: 429, code: 'API_ERROR' });
  });

  it('throws NetworkError when fetch itself rejects', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as never;
    await expect(fetchJson('https://x.test/a')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws ValidationError on a non-JSON body', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>', { status: 200 })) as never;
    await expect(fetchJson('https://x.test/a')).rejects.toBeInstanceOf(ValidationError);
  });

  it('readJson applies the same rules to a Response the caller already holds', async () => {
    await expect(readJson(new Response('{"a":1}', { status: 200 }), 'x')).resolves.toEqual({ a: 1 });
    await expect(readJson(new Response('', { status: 500 }), 'x')).rejects.toBeInstanceOf(APIError);
  });
});

describe('sanitizer — untrusted values', () => {
  it('escapes rather than filters', () => {
    expect(escapeHTML('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('rejects dangerous URL schemes and accepts real ones', () => {
    expect(sanitizeURL('javascript:alert(1)')).toBe('');
    expect(sanitizeURL('data:text/html,<script>')).toBe('');
    expect(sanitizeURL('https://api.binance.com/x')).toBe('https://api.binance.com/x');
    expect(sanitizeURL('/local/path')).toBe('/local/path');
  });

  it('normalizes symbols and numbers coming back from storage', () => {
    expect(sanitizeSymbol(' btc/usdt ')).toBe('BTCUSDT');
    expect(sanitizeNumber('12.5')).toBe(12.5);
    expect(sanitizeNumber(NaN)).toBe(0);
    expect(sanitizeNumber(Infinity, 3)).toBe(3);
    expect(sanitizeNumber(undefined, 5)).toBe(5);
  });

  it('drops prototype-polluting keys', () => {
    const dirty = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
    const clean = contentSanitizer.sanitizeObject<Record<string, unknown>>(dirty);
    expect(clean.ok).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(clean, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('replaces non-finite numbers inside a parsed structure', () => {
    const clean = contentSanitizer.sanitizeObject<{ n: number }>({ n: Number.NaN });
    expect(clean.n).toBe(0);
  });
});

describe('safeParseJSON', () => {
  it('never throws on malformed JSON', () => {
    const r = safeParseJSON('{"items":[', { items: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('malformed-json');
    expect(r.value).toEqual({ items: [] });
  });

  it('rejects a structurally wrong payload via the guard', () => {
    const r = safeParseJSON<{ items: unknown[] }>(
      '{"items":"not-an-array"}',
      { items: [] },
      v => Array.isArray((v as { items: unknown }).items)
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('failed-guard');
  });

  it('accepts a valid payload', () => {
    const r = safeParseJSON<{ items: number[] }>('{"items":[1,2]}', { items: [] });
    expect(r.ok).toBe(true);
    expect(r.value.items).toEqual([1, 2]);
  });
});

describe('readStoredJSON / writeStoredJSON', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips a value', () => {
    expect(writeStoredJSON('k', { a: 1 })).toBe(true);
    expect(readStoredJSON('k', { a: 0 }).value).toEqual({ a: 1 });
  });

  it('survives a corrupt stored value instead of throwing', () => {
    store.set('k', 'not json at all');
    const r = readStoredJSON('k', { a: 0 });
    expect(r.ok).toBe(false);
    expect(r.value).toEqual({ a: 0 });
  });

  it('survives storage being unavailable entirely', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); }
    });
    expect(readStoredJSON('k', 'fallback').value).toBe('fallback');
    expect(writeStoredJSON('k', 1)).toBe(false);
  });
});

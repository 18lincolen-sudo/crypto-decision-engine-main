/**
 * Error handling — one place that turns anything thrown anywhere into a typed
 * error and a sentence a user can read.
 *
 * This module is also the project's ONLY typed JSON-fetch entry point, and
 * that is deliberate: `Response.json()` returns `unknown`, so every service
 * that called it either had to cast or ended up with a compile error (that is
 * exactly where the `unknown` type errors in fearGreedApi / binancePublicApi /
 * backtestRunner / kvStore came from). Routing a request through `fetchJson<T>`
 * gives the caller a typed body AND consistent timeout/status/network
 * classification in the same step, instead of each service re-inventing both.
 */

export class AppError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
    /** The original throwable, kept for logs — never shown to the user. */
    public cause?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NetworkError extends AppError {
  constructor(message = 'שגיאת רשת', cause?: unknown) {
    super(message, 'NETWORK_ERROR', 0, cause);
    this.name = 'NetworkError';
  }
}

export class TimeoutError extends AppError {
  constructor(message = 'הבקשה חרגה מזמן ההמתנה', cause?: unknown) {
    super(message, 'TIMEOUT_ERROR', 0, cause);
    this.name = 'TimeoutError';
  }
}

export class APIError extends AppError {
  constructor(message: string, statusCode?: number, cause?: unknown) {
    super(message, 'API_ERROR', statusCode, cause);
    this.name = 'APIError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, cause);
    this.name = 'ValidationError';
  }
}

/** True when the failure is worth retrying (transient), false when retrying
 *  will fail the same way. Callers use it to decide backoff vs. give up. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof TimeoutError || error instanceof NetworkError) return true;
  if (error instanceof AppError && typeof error.statusCode === 'number') {
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

/**
 * Anything → a Hebrew sentence for the UI.
 *
 * Order matters: typed errors are matched by TYPE first and only unknown
 * throwables fall through to message-sniffing. The previous version checked
 * `message.includes('401')`, which also matched a price string containing
 * "401" — message text is the last resort, not the first test.
 */
export const handleError = (error: unknown): string => {
  console.error('Error occurred:', error);

  if (error instanceof TimeoutError) return 'החיבור לשרת פג. אנא נסה שוב.';
  if (error instanceof NetworkError) return 'שגיאת חיבור לשרת. אנא בדוק את החיבור לאינטרנט.';

  if (error instanceof AppError) {
    switch (error.statusCode) {
      case 401:
      case 403:
        return 'שגיאת הרשאה. אנא בדוק את פרטי ה-API.';
      case 429:
        return 'יותר מדי בקשות. אנא המתן מספר דקות ונסה שוב.';
      default:
        if (typeof error.statusCode === 'number' && error.statusCode >= 500) {
          return 'השרת אינו זמין כרגע. אנא נסה שוב בעוד מספר רגעים.';
        }
        return error.message;
    }
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'החיבור לשרת פג. אנא נסה שוב.';
  }

  if (error instanceof Error) {
    const m = error.message;
    if (/\bfailed to fetch\b|\bnetworkerror\b/i.test(m)) return 'שגיאת חיבור לשרת. אנא בדוק את החיבור לאינטרנט.';
    if (/\btimeout\b|\baborted\b/i.test(m)) return 'החיבור לשרת פג. אנא נסה שוב.';
    return m;
  }

  return 'אירעה שגיאה לא צפויה. אנא נסה שוב.';
};

/**
 * Wraps an async function so every failure leaves it as an AppError carrying a
 * user-readable message.
 *
 * The old signature constrained the argument to `(...args: unknown[]) => ...`,
 * which no real function satisfies — passing a typed function was an error, so
 * the helper could not actually be used anywhere. Inferring the arg tuple and
 * the return type separately is what makes it callable.
 */
export function withErrorHandling<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(handleError(error), 'WRAPPED_ERROR', undefined, error);
    }
  };
}

/** Runs an async function and returns a fallback instead of throwing. Use for
 *  non-critical reads where a stale/empty value beats breaking the render. */
export async function withFallback<R>(fn: () => Promise<R>, fallback: R, label?: string): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[${label ?? 'withFallback'}]`, handleError(error));
    return fallback;
  }
}

// ── Typed fetch ───────────────────────────────────────────────────────────────

export interface FetchJsonOptions extends RequestInit {
  /** Abort after this many ms. Default 8000. */
  timeoutMs?: number;
  /** Label used in error messages/logs. Defaults to the URL. */
  label?: string;
}

/**
 * Fetch + parse JSON with one timeout, one status check and one typed result.
 *
 * `T` is an assertion about the wire format, not a guarantee — pass the body
 * through a validator (or `sanitizer.safeParseJSON`'s guard) when the source is
 * not fully trusted. What this DOES guarantee is that a non-2xx, a network
 * failure and a timeout each arrive as their own error class rather than as an
 * untyped `unknown` the caller has to re-sniff.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 8000, label = url, headers, ...rest } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = rest.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(headers ?? {}) }
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TimeoutError(`${label}: חרג מ-${timeoutMs}ms`, error);
    }
    throw new NetworkError(`${label}: הבקשה נכשלה`, error);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new APIError(`${label}: HTTP ${response.status} ${response.statusText}`.trim(), response.status);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ValidationError(`${label}: גוף התשובה אינו JSON תקין`, error);
  }
}

/** fetchJson that returns a fallback instead of throwing. */
export async function safeFetchJson<T>(url: string, fallback: T, options: FetchJsonOptions = {}): Promise<T> {
  return withFallback(() => fetchJson<T>(url, options), fallback, options.label ?? url);
}

/** Types the body of a Response a caller already holds (e.g. one produced by a
 *  service's own retry/backoff layer), with the same error classification. */
export async function readJson<T>(response: Response, label = response.url): Promise<T> {
  if (!response.ok) {
    throw new APIError(`${label}: HTTP ${response.status} ${response.statusText}`.trim(), response.status);
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ValidationError(`${label}: גוף התשובה אינו JSON תקין`, error);
  }
}

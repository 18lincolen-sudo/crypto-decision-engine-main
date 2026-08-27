/**
 * Shared polling hook with client-side exponential backoff.
 *
 * When the server returns 429 (Too Many Requests) or a network error occurs,
 * the interval doubles on each consecutive failure up to `maxInterval`.
 * On the next successful response the interval resets to `baseInterval`.
 *
 * This prevents the "thundering herd" problem where multiple frontend tabs
 * keep hammering an already rate-limited backend.
 *
 * ── FIX (runaway polling, Aug 2026) ────────────────────────────────────────
 * Previously the scheduling effect depended on [poll, currentInterval] where
 * `poll` was a useCallback over [pollFn, ...]. Every caller passes an INLINE
 * `pollFn` (new identity each render), and each poll's own setState calls
 * trigger that render → new pollFn identity → new `poll` identity → the
 * effect re-ran on EVERY render: cleanup + an IMMEDIATE poll(), bypassing
 * the backoff entirely. With 4-5 components polling concurrently (the three
 * sim contexts are mounted app-wide), the worker's 120 req/min per-IP rate
 * limit was exceeded and responses came back 429.
 *
 * Now `pollFn` is read through a ref: renders never re-run the scheduling
 * effect. The initial-poll effect runs once per mount, and the interval
 * timer is re-created ONLY when the backoff interval actually changes
 * (without firing an immediate poll on that transition).
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseApiPollingOptions {
  /** Base polling interval in ms (default: 5000) */
  baseInterval?: number;
  /** Maximum backoff interval in ms (default: 30000) */
  maxInterval?: number;
  /** Backoff multiplier per consecutive failure (default: 2) */
  backoffMultiplier?: number;
}

export interface UseApiPollingResult<T> {
  data: T | null;
  error: string | null;
  /** Alias of `error` — the name the app's contexts already destructure. */
  syncError: string | null;
  syncStatus: 'synced' | 'local-only' | 'connecting';
  currentInterval: number;
  consecutiveFailures: number;
  refresh: () => Promise<void>;
}

export function useApiPolling<T>(
  pollFn: () => Promise<T>,
  opts: UseApiPollingOptions = {}
): UseApiPollingResult<T> {
  const {
    baseInterval = 5000,
    maxInterval = 30000,
    backoffMultiplier = 2,
  } = opts;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'local-only' | 'connecting'>('connecting');
  const [currentInterval, setCurrentInterval] = useState(baseInterval);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  // Latest-closure ref: renders update it without changing identity, so the
  // effects below never re-run just because an inline pollFn was passed.
  const pollFnRef = useRef(pollFn);
  pollFnRef.current = pollFn;

  const cancelledRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const intervalIdRef = useRef<number | null>(null);
  const failuresRef = useRef(0);

  const poll = useCallback(async () => {
    // Cancel any in-flight request
    if (inFlightRef.current) {
      // We can't truly abort fetch without AbortController, but we can
      // ignore its result if a newer poll has started.
      inFlightRef.current = null;
    }

    const promise = (async () => {
      if (cancelledRef.current) return;
      try {
        const result = await pollFnRef.current();
        if (cancelledRef.current) return;
        failuresRef.current = 0;
        setData(result);
        setError(null);
        setSyncStatus('synced');
        setConsecutiveFailures(0);
        setCurrentInterval(baseInterval);
      } catch (e) {
        if (cancelledRef.current) return;
        const msg = e instanceof Error ? e.message : 'שגיאת סנכרון';
        failuresRef.current += 1;
        setError(msg);
        setSyncStatus('local-only');
        setConsecutiveFailures(failuresRef.current);
        setCurrentInterval(Math.min(baseInterval * Math.pow(backoffMultiplier, failuresRef.current), maxInterval));
      }
    })();

    inFlightRef.current = promise;
    await promise;
  }, [baseInterval, maxInterval, backoffMultiplier]);

  // Initial poll — mount/unmount only (poll identity is stable, and the
  // inline pollFn is read via pollFnRef, so renders never re-run this).
  useEffect(() => {
    cancelledRef.current = false;
    void poll();
    return () => {
      cancelledRef.current = true;
    };
  }, [poll]);

  // Interval cadence — re-created ONLY when the backoff interval changes.
  // No immediate poll on that transition (next tick is one full interval away).
  useEffect(() => {
    if (intervalIdRef.current !== null) {
      clearInterval(intervalIdRef.current);
    }
    intervalIdRef.current = window.setInterval(() => {
      void poll();
    }, currentInterval);
    return () => {
      if (intervalIdRef.current !== null) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
    };
  }, [poll, currentInterval]);

  const refresh = useCallback(async () => {
    // Reset backoff on manual refresh
    failuresRef.current = 0;
    setConsecutiveFailures(0);
    setCurrentInterval(baseInterval);
    await poll();
  }, [poll, baseInterval]);

  return {
    data,
    error,
    syncError: error,
    syncStatus,
    currentInterval,
    consecutiveFailures,
    refresh,
  };
}

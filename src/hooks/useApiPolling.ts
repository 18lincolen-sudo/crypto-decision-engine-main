/**
 * Shared polling hook with client-side exponential backoff.
 *
 * When the server returns 429 (Too Many Requests) or a network error occurs,
 * the interval doubles on each consecutive failure up to `maxInterval`.
 * On the next successful response the interval resets to `baseInterval`.
 *
 * This prevents the "thundering herd" problem where multiple frontend tabs
 * keep hammering an already rate-limited backend.
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

  const cancelledRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const intervalIdRef = useRef<number | null>(null);

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
        const result = await pollFn();
        if (cancelledRef.current) return;
        setData(result);
        setError(null);
        setSyncStatus('synced');
        setConsecutiveFailures(0);
        setCurrentInterval(baseInterval);
      } catch (e) {
        if (cancelledRef.current) return;
        const msg = e instanceof Error ? e.message : 'שגיאת סנכרון';
        setError(msg);
        setSyncStatus('local-only');
        setConsecutiveFailures((prev) => {
          const next = prev + 1;
          const newInterval = Math.min(baseInterval * Math.pow(backoffMultiplier, next), maxInterval);
          setCurrentInterval(newInterval);
          return next;
        });
      }
    })();

    inFlightRef.current = promise;
    await promise;
  }, [pollFn, baseInterval, maxInterval, backoffMultiplier]);

  useEffect(() => {
    cancelledRef.current = false;

    // Initial poll
    poll();

    // Clear any existing interval
    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current);
    }

    intervalIdRef.current = window.setInterval(() => {
      poll();
    }, currentInterval);

    return () => {
      cancelledRef.current = true;
      if (intervalIdRef.current) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
    };
  }, [poll, currentInterval]);

  const refresh = useCallback(async () => {
    // Reset backoff on manual refresh
    setCurrentInterval(baseInterval);
    setConsecutiveFailures(0);
    await poll();
  }, [poll, baseInterval]);

  return {
    data,
    error,
    syncStatus,
    currentInterval,
    consecutiveFailures,
    refresh,
  };
}

import { useEffect, useRef, useCallback } from 'react';

interface UseBackgroundWorkerOptions {
  intervalMs?: number;
  enabled?: boolean;
  onTick: (timestamp: number) => void;
}

export function useBackgroundWorker({
  intervalMs = 4000,
  enabled = true,
  onTick
}: UseBackgroundWorkerOptions) {
  const workerRef = useRef<Worker | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const start = useCallback(() => {
    if (typeof Worker !== 'undefined') {
      try {
        if (!workerRef.current) {
          workerRef.current = new Worker(
            new URL('../workers/tradingWorker.ts', import.meta.url),
            { type: 'module' }
          );

          workerRef.current.onmessage = (e: MessageEvent) => {
            if (e.data?.type === 'TICK') {
              onTickRef.current(e.data.timestamp);
            }
          };
        }

        workerRef.current.postMessage({ action: 'START', interval: intervalMs });
        return;
      } catch {
        // Fall back to standard setInterval
      }
    }

    // Standard fallback
    if (fallbackTimerRef.current !== null) clearInterval(fallbackTimerRef.current);
    fallbackTimerRef.current = window.setInterval(() => {
      onTickRef.current(Date.now());
    }, intervalMs);
  }, [intervalMs]);

  const stop = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ action: 'STOP' });
    }
    if (fallbackTimerRef.current !== null) {
      clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      start();
    } else {
      stop();
    }

    return () => {
      stop();
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [enabled, start, stop]);

  return { start, stop };
}

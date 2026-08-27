import { useEffect, useRef, useCallback } from 'react';

interface UseBackgroundWorkerOptions {
  intervalMs?: number;
  enabled?: boolean;
  onTick: (timestamp: number) => void;
}

const TIMER_WORKER_SCRIPT = `
let timerId = null;
self.onmessage = function(e) {
  if (e.data && e.data.action === 'START') {
    if (timerId) clearInterval(timerId);
    const interval = e.data.interval || 5000;
    timerId = setInterval(function() {
      self.postMessage({ type: 'TICK', timestamp: Date.now() });
    }, interval);
  } else if (e.data && e.data.action === 'STOP') {
    if (timerId) clearInterval(timerId);
    timerId = null;
  }
};
`;

export function useBackgroundWorker({
  intervalMs = 5000,
  enabled = true,
  onTick
}: UseBackgroundWorkerOptions) {
  const workerRef = useRef<Worker | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const start = useCallback(() => {
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        if (!workerRef.current) {
          const blob = new Blob([TIMER_WORKER_SCRIPT], { type: 'application/javascript' });
          const blobUrl = URL.createObjectURL(blob);
          workerRef.current = new Worker(blobUrl);

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
    if (typeof window !== 'undefined') {
      if (fallbackTimerRef.current !== null) clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = window.setInterval(() => {
        onTickRef.current(Date.now());
      }, intervalMs);
    }
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
    return () => stop();
  }, [enabled, start, stop]);

  return { isRunning: enabled, start, stop };
}

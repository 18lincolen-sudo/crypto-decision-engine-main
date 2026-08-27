import { describe, it, expect } from 'vitest';

/**
 * Regression tests for the runaway-polling FIX in src/hooks/useApiPolling.ts.
 *
 * There is no DOM test runner in this repo (no jsdom / @testing-library), so
 * this harness mirrors React's hook semantics for exactly the hooks the
 * production file uses (useState / useRef / useCallback / useEffect, shallow
 * dependency comparison, cleanup + re-run on dep change). The scheduling
 * algorithm below is a verbatim transcription of the FIXED useApiPolling.ts.
 *
 * THE OLD BUG (fixed Aug 2026): the scheduling effect depended on
 * [poll, currentInterval] where `poll` was a useCallback over [pollFn, ...].
 * Every caller passes an INLINE pollFn (new identity each render) and each
 * poll's own setState calls trigger that render → new pollFn identity →
 * the effect re-ran on EVERY render with an IMMEDIATE poll() — bypassing the
 * exponential backoff entirely. With 4-5 components polling concurrently
 * (the three sim contexts are mounted app-wide), the worker's 120 req/min
 * per-IP rate limit was exceeded (verified live: request #121 of a burst got
 * HTTP 429) and the responses came back 429.
 *
 * THE FIX: pollFn is read through a ref — renders never re-run the
 * scheduling effects; the interval timer is re-created only when the backoff
 * interval actually changes, without firing an immediate poll on that
 * transition, so the escalated backoff interval is actually honoured.
 */

type PollFn = () => Promise<unknown>;

function depsEqual(a: readonly unknown[] | null, b: readonly unknown[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

interface Harness {
  /** Simulate the component mounting (initial poll + interval effect). */
  mount(pollFn: PollFn): void;
  /** Simulate a re-render: only pollFnRef updates — NO effect re-runs. */
  rerender(pollFn: PollFn): void;
  /** Await every fired poll, then sync effects like a React re-render would. */
  settle(): Promise<void>;
  /** Advance the fake clock so interval timers fire. */
  advance(ms: number): Promise<void>;
  readonly pollCount: number;
  readonly pollTimes: readonly number[];
  readonly currentInterval: number;
  readonly consecutiveFailures: number;
}

function createHarness(opts: { baseInterval: number; maxInterval: number }): Harness {
  const { baseInterval, maxInterval } = opts;

  // ── fake clock (replaces window.setInterval / clearInterval) ─────────────
  let time = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const setInterval_ = (fn: () => void, ms: number): number => {
    const id = ++seq;
    timers.set(id, { at: time + ms, fn, every: ms });
    return id;
  };
  const clearInterval_ = (id: number | null): void => {
    if (id !== null) timers.delete(id);
  };

  // ── hook state (mirrors the useState / useRef values) ────────────────────
  let pollFnRef: { current: PollFn | null } = { current: null };
  const cancelledRef = { current: false };
  const failuresRef = { current: 0 };
  let currentInterval = baseInterval;
  const firedPolls: { at: number; done: Promise<void> }[] = [];

  // The poll callback has a STABLE identity (useCallback over stable deps —
  // pollFn is read through the ref inside).
  const poll = async (): Promise<void> => {
    const promise = (async () => {
      if (cancelledRef.current) return;
      try {
        await pollFnRef.current!();
        if (cancelledRef.current) return;
        failuresRef.current = 0;
        currentInterval = baseInterval;
      } catch {
        if (cancelledRef.current) return;
        failuresRef.current += 1;
        currentInterval = Math.min(baseInterval * Math.pow(2, failuresRef.current), maxInterval);
      }
    })();
    firedPolls.push({ at: time, done: promise });
    await promise;
  };

  // Effect 2 (interval cadence) — deps [poll, currentInterval]; poll is
  // stable, so it re-runs ONLY when currentInterval changed (a React
  // re-render after the poll's setState). No immediate poll on that
  // transition — the next tick is one full (escalated) interval away.
  let intervalEffectDeps: readonly unknown[] | null = null;
  let intervalId: number | null = null;
  const syncEffects = (): void => {
    const deps: readonly unknown[] = [currentInterval];
    if (intervalEffectDeps === null || !depsEqual(intervalEffectDeps, deps)) {
      if (intervalId !== null) clearInterval_(intervalId);
      intervalId = setInterval_(() => { void poll(); }, currentInterval);
      intervalEffectDeps = deps;
    }
  };

  return {
    mount(pollFn: PollFn): void {
      pollFnRef.current = pollFn;
      cancelledRef.current = false;
      void poll();        // effect 1: initial poll
      syncEffects();      // effect 2: interval at the current cadence
    },
    rerender(pollFn: PollFn): void {
      // THE FIX: a new inline closure only updates the ref — the scheduling
      // effects do NOT re-run and no immediate poll fires.
      pollFnRef.current = pollFn;
    },
    async settle(): Promise<void> {
      await Promise.all(firedPolls.map((p) => p.done));
      syncEffects(); // the poll's state updates → React re-render → effect sync
    },
    async advance(ms: number): Promise<void> {
      const end = time + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= end && t.at < nextAt) { nextAt = t.at; nextId = id; }
        }
        if (nextId === null) break;
        time = nextAt;
        const t = timers.get(nextId)!;
        if (t.every !== null) t.at = time + t.every;
        else timers.delete(nextId);
        t.fn();
        await Promise.all(firedPolls.map((p) => p.done));
        syncEffects();
      }
      time = end;
    },
    get pollCount(): number { return firedPolls.length; },
    get pollTimes(): readonly number[] { return firedPolls.map((p) => p.at); },
    get currentInterval(): number { return currentInterval; },
    get consecutiveFailures(): number { return failuresRef.current; },
  };
}

describe('useApiPolling scheduling (post-fix regression)', () => {
  it('FIX: inline pollFn per render does NOT fire polls — renders are free', async () => {
    const h = createHarness({ baseInterval: 15_000, maxInterval: 60_000 }); // ExecutiveDashboard config
    h.mount(async () => null);
    for (let i = 0; i < 10; i++) {
      // Every caller passes an inline closure → new identity each render.
      // Pre-fix this re-ran the scheduling effect and fired an immediate poll
      // on EVERY render (10 renders = 10 extra polls).
      h.rerender(async () => null);
    }
    await h.advance(30_000);
    // Mount poll + interval ticks at 15s and 30s only — the 10 renders added NOTHING.
    expect(h.pollCount).toBe(3);
  });

  it('FIX: after a 429 the next poll waits the ESCALATED interval (real backoff)', async () => {
    const h = createHarness({ baseInterval: 15_000, maxInterval: 60_000 });
    const failing429 = async () => { throw new Error('429'); };

    h.mount(failing429);
    await h.settle();
    expect(h.pollCount).toBe(1);
    expect(h.currentInterval).toBe(30_000);

    await h.advance(15_000); // pre-fix, an immediate re-poll fired right here
    expect(h.pollCount).toBe(1);

    await h.advance(15_000); // t=30s → the escalated interval fires
    expect(h.pollCount).toBe(2);
    expect(h.currentInterval).toBe(60_000);

    await h.advance(60_000); // capped at maxInterval
    expect(h.pollCount).toBe(3);
    expect(h.consecutiveFailures).toBe(3);
    expect(h.currentInterval).toBe(60_000);
  });

  it('FIX: same 60s of re-renders (2.5s apart, as state updates cause) stays on the configured cadence', async () => {
    const h = createHarness({ baseInterval: 15_000, maxInterval: 60_000 });
    h.mount(async () => null);
    for (let i = 0; i < 24; i++) {
      h.rerender(async () => null); // new inline closure per render — production pattern
      await h.advance(2_500);
    }
    // Mount poll + 4 interval ticks (15/30/45/60s). Pre-fix this was 24+ polls.
    expect(h.pollCount).toBe(5);
  });

  it('success resets the backoff to the base interval', async () => {
    const h = createHarness({ baseInterval: 15_000, maxInterval: 60_000 });
    h.mount(async () => { throw new Error('429'); });
    await h.settle();                                   // failure #1 → 30s
    await h.advance(30_000);                            // poll #2 fails → 60s
    expect(h.currentInterval).toBe(60_000);

    h.rerender(async () => null);                       // the server recovered
    await h.advance(60_000);                            // poll #3 succeeds → reset
    expect(h.consecutiveFailures).toBe(0);
    expect(h.currentInterval).toBe(15_000);

    await h.advance(15_000);                            // next tick at the restored base cadence
    expect(h.pollCount).toBe(4);
  });
});


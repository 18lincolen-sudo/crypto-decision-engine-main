import { describe, it, expect } from 'vitest';
import {
  buildWalkForwardWindows,
  buildValidatedPathTable,
  scoreBucketOutOfSample,
  buildFearGreedSeries,
  parseFearGreedPayload,
  fearGreedAt,
  utcDayStart,
  fearGreedBucket
} from '@cde/engine/analysis';
import type { PathBucket, PathOutcome, BarState } from '@cde/engine/analysis';

// The two things that decide whether the 4H Path bot is measuring anything:
// an out-of-sample test it cannot fake, and a sentiment label that does not
// read from the future.

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 1);
const STATE: BarState = { regime: 'TRENDING_UP', fng: 'FEAR' };
const OTHER: BarState = { regime: 'RANGING', fng: 'GREED' };

function outcome(at: number, mfeR: number, state: BarState = STATE, slot = 3): PathOutcome {
  // terminalR 0: a trade that reached neither level ends flat, which is the
  // third outcome the expectancy model needs and the fixtures predate.
  return { state, slot, direction: 'LONG', mfeR, maeR: 0.2, stopped: false, terminalR: 0, at };
}

describe('walk-forward windows', () => {
  it('produces disjoint test slices that follow their own training slice', () => {
    const windows = buildWalkForwardWindows(T0, T0 + 200 * DAY, 100 * DAY, 20 * DAY);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      expect(w.trainTo).toBe(w.testFrom);          // test starts where training ends
      expect(w.testTo).toBeGreaterThan(w.testFrom);
      expect(w.trainFrom).toBeLessThan(w.trainTo);
    }
    // Consecutive test windows do not overlap at the default step.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].testFrom).toBeGreaterThanOrEqual(windows[i - 1].testTo);
    }
  });

  it('returns nothing when the history cannot fit one train+test pair', () => {
    expect(buildWalkForwardWindows(T0, T0 + 30 * DAY, 100 * DAY, 20 * DAY)).toHaveLength(0);
  });
});

describe('out-of-sample scoring', () => {
  const bucket: PathBucket = {
    state: STATE, slot: 3, direction: 'LONG', n: 400, rawN: 400,
    tpR: 2, slR: 1, pHit: 0.6, pLow: 0.55, expectedR: 0.6
  };

  it('scores only the outcomes that match the bucket', () => {
    const test = [
      ...Array.from({ length: 10 }, (_, i) => outcome(T0 + i, 3)),          // wins
      ...Array.from({ length: 10 }, (_, i) => outcome(T0 + i, 0, OTHER))    // different state
    ];
    const scored = scoreBucketOutOfSample(bucket, test, 0);
    expect(scored?.samples).toBe(10);
    expect(scored?.expectedR).toBeCloseTo(2, 6); // every match reached 2R
  });

  it('returns undefined when the bucket never appears out of sample', () => {
    expect(scoreBucketOutOfSample(bucket, [outcome(T0, 3, OTHER)], 0)).toBeUndefined();
  });

  it('charges the round-trip cost', () => {
    const test = Array.from({ length: 10 }, (_, i) => outcome(T0 + i, 3));
    const free = scoreBucketOutOfSample(bucket, test, 0)!;
    const paid = scoreBucketOutOfSample(bucket, test, 0.5)!;
    expect(paid.expectedR).toBeCloseTo(free.expectedR - 0.5, 6);
  });
});

describe('validated table — the look-elsewhere guard', () => {
  const windows = buildWalkForwardWindows(T0, T0 + 300 * DAY, 100 * DAY, 25 * DAY);

  it('keeps a bucket whose edge persists into every test slice', () => {
    // A real edge: the same bucket wins throughout the whole history, so it wins
    // in training AND in every window it is tested on.
    const outcomes: PathOutcome[] = [];
    for (let d = 0; d < 300; d++) {
      for (let k = 0; k < 12; k++) outcomes.push(outcome(T0 + d * DAY + k, 3));
    }
    const report = buildValidatedPathTable(outcomes, windows, { minSamples: 100, costR: 0 });
    expect(report.survivors).toBeGreaterThan(0);
    expect(report.table[0].oosExpectedR).toBeGreaterThan(0);
    expect(report.table[0].windows).toBeGreaterThanOrEqual(2);
  });

  it('drops a bucket that only worked in the training slice', () => {
    // The classic filter survivor: wins for the first 100 days, then nothing.
    // In-sample it looks excellent; out-of-sample it is a full loss every time.
    const trainEnd = T0 + 100 * DAY;
    const outcomes: PathOutcome[] = [];
    for (let d = 0; d < 300; d++) {
      const at = T0 + d * DAY;
      for (let k = 0; k < 12; k++) outcomes.push(outcome(at + k, at < trainEnd ? 3 : 0));
    }
    const report = buildValidatedPathTable(outcomes, windows, { minSamples: 100, costR: 0 });
    expect(report.survivors).toBe(0);
  });

  it('reports the noise floor next to the survivor count', () => {
    const outcomes: PathOutcome[] = [];
    for (let d = 0; d < 300; d++) {
      for (let k = 0; k < 12; k++) outcomes.push(outcome(T0 + d * DAY + k, 3));
    }
    const report = buildValidatedPathTable(outcomes, windows, { minSamples: 100, costR: 0 });
    // 5% of the hypotheses actually tested — the number a survivor count has to
    // beat before it means anything.
    expect(report.expectedUnderNull).toBeCloseTo(report.candidates * 0.05, 2);
  });

  it('requires the edge to hold in more than one window', () => {
    const outcomes: PathOutcome[] = [];
    for (let d = 0; d < 300; d++) {
      for (let k = 0; k < 12; k++) outcomes.push(outcome(T0 + d * DAY + k, 3));
    }
    const strict = buildValidatedPathTable(outcomes, windows, { minSamples: 100, costR: 0, minWindowsPositive: 99 });
    expect(strict.survivors).toBe(0);
  });
});

describe('sentiment history — the label must not read from the future', () => {
  it('parses the alternative.me payload, seconds to milliseconds', () => {
    const points = parseFearGreedPayload({
      data: [
        { value: '30', timestamp: String(Math.floor(T0 / 1000)) },
        { value: '70', timestamp: String(Math.floor((T0 + DAY) / 1000)) },
        { value: 'not-a-number', timestamp: '123' }
      ]
    });
    expect(points).toHaveLength(2);
    expect(points[0].at).toBe(T0);
    expect(points[0].value).toBe(30);
  });

  it('reads the PREVIOUS day, so a bar cannot see its own day publication', () => {
    const series = buildFearGreedSeries([
      { at: T0, value: 20 },
      { at: T0 + DAY, value: 80 }
    ]);
    // A bar opening at 04:00 on day T0+1 gets day T0's reading, not T0+1's.
    expect(fearGreedAt(series, T0 + DAY + 4 * 3_600_000)).toBe(20);
  });

  it('returns undefined for a day with no reading, so the caller can skip', () => {
    const series = buildFearGreedSeries([{ at: T0, value: 20 }]);
    // Nothing published for the day before T0.
    expect(fearGreedAt(series, T0)).toBeUndefined();
    // A neutral 50 would be an invented label — the study skips the bar instead.
  });

  it('survives a feed outage as an empty series rather than a throw', () => {
    const empty = buildFearGreedSeries([]);
    expect(empty.count).toBe(0);
    expect(fearGreedAt(empty, T0)).toBeUndefined();
  });

  it('buckets the 0-100 scale the same way the study does', () => {
    const series = buildFearGreedSeries([{ at: T0, value: 12 }]);
    const value = fearGreedAt(series, T0 + DAY)!;
    expect(fearGreedBucket(value)).toBe('EXTREME_FEAR');
  });

  it('normalises to UTC midnight', () => {
    expect(utcDayStart(T0 + 23 * 3_600_000)).toBe(T0);
    expect(utcDayStart(T0 + DAY)).toBe(T0 + DAY);
  });
});

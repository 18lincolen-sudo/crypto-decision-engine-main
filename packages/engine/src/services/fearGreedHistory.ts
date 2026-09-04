// Historical Fear & Greed series — the value that was PUBLISHED on a given day,
// not the value showing now.
//
// This exists because of a leak that is invisible at the call site. labelBarState
// takes `fearGreedIndex: number` and cannot know where the caller got it. Feeding
// today's reading in while labelling a bar from March 2025 puts information from
// the future into the label, and the code looks completely clean while doing it —
// the study would then "discover" that certain sentiment regimes predict certain
// intra-bar paths, when what it actually discovered is that it was told the
// answer.
//
// alternative.me publishes one value per day at 00:00 UTC. `limit=0` returns the
// entire series in a single request, so the whole history costs one call.

const FNG_URL = 'https://api.alternative.me/fng/?limit=0&format=json';

/** One published reading. `at` is the UTC midnight the value belongs to. */
export interface FearGreedPoint {
  at: number;
  value: number;
}

const DAY_MS = 86_400_000;

/** UTC midnight of the day a timestamp falls in — the key the daily series is
 *  indexed by. */
export function utcDayStart(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

export interface FearGreedSeries {
  /** UTC-midnight → value, for O(1) lookup while walking bars. */
  byDay: Map<number, number>;
  from: number;
  to: number;
  count: number;
}

export function buildFearGreedSeries(points: FearGreedPoint[]): FearGreedSeries {
  const byDay = new Map<number, number>();
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const point of points) {
    if (!Number.isFinite(point.value) || !Number.isFinite(point.at)) continue;
    const day = utcDayStart(point.at);
    byDay.set(day, point.value);
    if (day < from) from = day;
    if (day > to) to = day;
  }
  return { byDay, from: byDay.size ? from : 0, to, count: byDay.size };
}

/**
 * The reading available at `timestamp`.
 *
 * Deliberately reads the PREVIOUS day, not the current one. alternative.me
 * stamps a value with the day it describes and publishes it at that day's
 * 00:00 UTC, so a bar opening at 04:00 on day D can legitimately see day D's
 * value — but only if the publisher's clock and ours agree exactly, and they do
 * not always. Reading D-1 costs at most one day of freshness and removes the
 * question entirely. A study that needs same-day resolution should say so
 * explicitly rather than inherit it by accident.
 *
 * Returns undefined when the series has no reading for that day, so a caller can
 * skip the bar instead of silently substituting a neutral 50.
 */
export function fearGreedAt(series: FearGreedSeries, timestamp: number): number | undefined {
  const previousDay = utcDayStart(timestamp) - DAY_MS;
  return series.byDay.get(previousDay);
}

/** Parses the alternative.me payload. Exported so the fetch and the parse can be
 *  tested apart from the network. */
export function parseFearGreedPayload(payload: unknown): FearGreedPoint[] {
  const data = (payload as { data?: { value?: string; timestamp?: string }[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: FearGreedPoint[] = [];
  for (const row of data) {
    const value = Number(row?.value);
    // The API returns a UNIX timestamp in SECONDS as a string.
    const seconds = Number(row?.timestamp);
    if (!Number.isFinite(value) || !Number.isFinite(seconds)) continue;
    out.push({ at: seconds * 1000, value });
  }
  return out;
}

/**
 * Downloads the full daily history in one request.
 *
 * Never throws: a sentiment feed outage should cost a study its sentiment split,
 * not its ability to run. An empty series makes every `fearGreedAt` lookup
 * undefined, and the study skips those bars rather than mislabelling them.
 */
export async function fetchFearGreedHistory(fetchImpl: typeof fetch = fetch): Promise<FearGreedSeries> {
  try {
    const res = await fetchImpl(FNG_URL);
    if (!res.ok) throw new Error(`fng HTTP ${res.status}`);
    return buildFearGreedSeries(parseFearGreedPayload(await res.json()));
  } catch {
    return buildFearGreedSeries([]);
  }
}

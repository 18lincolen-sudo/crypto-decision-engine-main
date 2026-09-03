import { describe, it, expect } from 'vitest';
import {
  evaluateFundingGate,
  annualisedFundingPct,
  FUNDING_CROWDED_ANNUAL_PCT,
  FUNDING_EXTREME_ANNUAL_PCT,
  FUNDING_MIN_SIZE_MULTIPLIER,
  FUNDING_MAX_AGE_MS,
  FUNDING_PERIODS_PER_YEAR
} from '@cde/engine/analysis';
import { DecisionEngine, ProAdapter } from '@cde/engine';

/**
 * The funding gate is the codebase's one non-price factor. These tests pin the
 * three properties that make it safe to add to a live pipeline:
 *
 *   1. It abstains rather than blocking whenever data is missing or stale — a
 *      feed outage must cost an opinion, not the ability to trade.
 *   2. It is asymmetric: it penalises the CROWDED side only, and is never a
 *      reason to take the other one.
 *   3. When it does block, it reports a real gate and reason (the
 *      "[UNKNOWN] / Blocked" defect must not come back through a new stage).
 */

const NOW = 1_800_000_000_000;
/** Funding per 8h period that annualises to the given percent. */
const rateForAnnual = (annualPct: number) => annualPct / 100 / FUNDING_PERIODS_PER_YEAR;
const snap = (annualPct: number, at = NOW) => ({ lastFundingRate: rateForAnnual(annualPct), at });

describe('funding gate abstains instead of blocking', () => {
  it('abstains when there is no funding data at all', () => {
    const v = evaluateFundingGate(undefined, 'LONG', NOW);
    expect(v.kind).toBe('abstain');
  });

  it('abstains on a non-finite rate rather than propagating NaN into sizing', () => {
    const v = evaluateFundingGate({ lastFundingRate: NaN, at: NOW }, 'LONG', NOW);
    expect(v.kind).toBe('abstain');
  });

  it('abstains once the reading is older than one funding cycle', () => {
    const stale = snap(500, NOW - FUNDING_MAX_AGE_MS - 1);
    // 500%/yr would otherwise be an emphatic veto — staleness must win.
    expect(evaluateFundingGate(stale, 'LONG', NOW).kind).toBe('abstain');
    const fresh = snap(500, NOW - 1000);
    expect(evaluateFundingGate(fresh, 'LONG', NOW).kind).toBe('veto');
  });
});

describe('funding gate penalises only the crowded side', () => {
  it('vetoes a LONG into extreme positive funding but allows the SHORT', () => {
    const crowdedLongs = snap(FUNDING_EXTREME_ANNUAL_PCT + 20);
    expect(evaluateFundingGate(crowdedLongs, 'LONG', NOW).kind).toBe('veto');
    expect(evaluateFundingGate(crowdedLongs, 'SHORT', NOW).kind).toBe('allow');
  });

  it('vetoes a SHORT into extreme negative funding but allows the LONG', () => {
    const crowdedShorts = snap(-(FUNDING_EXTREME_ANNUAL_PCT + 20));
    expect(evaluateFundingGate(crowdedShorts, 'SHORT', NOW).kind).toBe('veto');
    expect(evaluateFundingGate(crowdedShorts, 'LONG', NOW).kind).toBe('allow');
  });

  it('leaves ordinary contango alone', () => {
    // Binance's 0.01%/8h baseline is ~11%/yr and means nothing.
    const v = evaluateFundingGate({ lastFundingRate: 0.0001, at: NOW }, 'LONG', NOW);
    expect(v.kind).toBe('allow');
    expect(annualisedFundingPct(0.0001)).toBeCloseTo(10.95, 2);
  });
});

describe('the size penalty is continuous, not a cliff', () => {
  it('tapers from full size at the crowded threshold to the floor at extreme', () => {
    const justCrowded = evaluateFundingGate(snap(FUNDING_CROWDED_ANNUAL_PCT), 'LONG', NOW);
    expect(justCrowded.kind).toBe('trim');
    expect(justCrowded.kind === 'trim' && justCrowded.sizeMultiplier).toBeCloseTo(1, 6);

    const midway = evaluateFundingGate(
      snap((FUNDING_CROWDED_ANNUAL_PCT + FUNDING_EXTREME_ANNUAL_PCT) / 2), 'LONG', NOW
    );
    expect(midway.kind === 'trim' && midway.sizeMultiplier)
      .toBeCloseTo((1 + FUNDING_MIN_SIZE_MULTIPLIER) / 2, 6);
  });

  it('never trims below the floor — the veto is what stops a trade', () => {
    for (const pct of [55, 70, 85, 99]) {
      const v = evaluateFundingGate(snap(pct), 'LONG', NOW);
      if (v.kind === 'trim') {
        expect(v.sizeMultiplier).toBeGreaterThanOrEqual(FUNDING_MIN_SIZE_MULTIPLIER);
        expect(v.sizeMultiplier).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every verdict carries a non-empty reason', () => {
    const cases = [
      evaluateFundingGate(undefined, 'LONG', NOW),
      evaluateFundingGate(snap(5), 'LONG', NOW),
      evaluateFundingGate(snap(70), 'LONG', NOW),
      evaluateFundingGate(snap(200), 'LONG', NOW)
    ];
    for (const v of cases) expect(v.reason.trim().length).toBeGreaterThan(0);
  });
});

describe('the gate integrates without breaking the pipeline', () => {
  function candles(n: number, base: number, vol: number, t0: number, stepMs: number) {
    const out: { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
    let p = base;
    for (let i = 0; i < n; i++) {
      const o = p;
      p = p * (1 + vol * Math.sin(i / 11) + vol * 0.3 * Math.cos(i / 3));
      out.push({ timestamp: t0 + i * stepMs, open: o, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, close: p, volume: 900 + (i % 7) * 80 });
    }
    return out;
  }
  const T = 1_700_000_000_000;

  // Mirrors the fixture proven to reach a routable Pro signal in
  // decisionEngineRegression.test.ts: a short, sharp final-candle move crosses
  // EMA20 over EMA50 exactly now, which the smooth 240-candle oscillation on
  // its own never does. currentPrice stays at the series base, as there.
  const strongH1 = () => {
    const out = candles(240, 100, 0.004, T, 3_600_000);
    const last = out[out.length - 1];
    const jumped = last.close * 1.035;
    out[out.length - 1] = { ...last, close: jumped, high: jumped * 1.01, volume: last.volume * 2 };
    return out;
  };

  const contextWith = (symbol: string, funding?: { lastFundingRate: number; at: number }) => ({
    symbol,
    candles: {
      h1: strongH1(),
      m15: candles(320, 100, 0.002, T, 900_000),
      m5: candles(520, 100, 0.001, T, 300_000)
    },
    currentPrice: 100,
    portfolio: {
      portfolioValue: 10_000, initialAmount: 10_000,
      dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0,
      openPositionsCount: 0, openFuturesPositionsCount: 0, totalLeveragedExposureUsd: 0
    },
    openPositions: [],
    marketData: { livePrice: 100, priceChange24h: 1, funding },
    params: {},
    now: Date.now(),
    closedTrades: []
  }) as never;

  const engineFor = () => {
    const e = new DecisionEngine({ verbose: false });
    e.registerAdapter(new ProAdapter());
    return e;
  };

  it('a decision with no funding data is identical to one before the gate existed', () => {
    // Distinct symbols: ProAdapter memoizes on symbol + last candle timestamp.
    const withNone = engineFor().evaluate(contextWith('FUNDNONE'));
    expect(withNone.gate).not.toBe('FUNDING');
    expect(withNone.gate).not.toBe('ERROR');
  });

  it('extreme funding blocks with a real gate label and reason, never "Blocked"', () => {
    const crowded = { lastFundingRate: rateForAnnual(400), at: Date.now() };
    const r = engineFor().evaluate(contextWith('FUNDCROWD', crowded));
    // The fixture routes LONG, so extreme positive funding must stop it.
    if (r.outcome !== 'SIGNAL') {
      expect(r.gate).toBeTruthy();
      expect(r.gate).not.toBe('UNKNOWN');
      expect(r.reasoning?.[0] ?? '').not.toBe('Blocked');
    }
    expect(r.gate).toBe('FUNDING');
    expect(r.reasoning?.[0] ?? '').toContain('FUNDING_GATE');
  });

  it('benign funding does not change the outcome', () => {
    const benign = { lastFundingRate: 0.0001, at: Date.now() };
    const withBenign = engineFor().evaluate(contextWith('FUNDBENIGN', benign));
    const withNone = engineFor().evaluate(contextWith('FUNDBENIGN2'));
    expect(withBenign.outcome).toBe(withNone.outcome);
    expect(withBenign.gate).toBe(withNone.gate);
  });
});

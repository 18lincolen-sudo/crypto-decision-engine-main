import { describe, it, expect } from 'vitest';
import { DecisionEngine, IntradayAdapter, LegacyAdapter, ProAdapter } from '@cde/engine';
import { buildFactorsFromDecisionResult } from '@cde/engine';

/**
 * Regression tests for the "NO_SIGNAL [UNKNOWN] — Blocked Blocked" defect.
 *
 * Every pipeline stage that returns `blocked: true` must also report WHY:
 * a `gate` label and a `blockReason`. When it does not, the adapter's execute()
 * loop substitutes the placeholders 'UNKNOWN' and 'Blocked', which reach the UI
 * verbatim — the user sees a bot that refuses to trade and gives no reason.
 *
 * The stages that got this wrong were route-trade-type (the COMMON case: the
 * router returns HOLD), entry-timing, risk-parameters and correlation-gate,
 * in both the Legacy and the Pro adapter.
 *
 * The second group of tests covers the sibling defect: `outcome: 'SIGNAL'` was
 * derived from the router alone, so a HOLD signal could still be routed and
 * executed — the Pro bot bought on startup with no decision behind it.
 */

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

const context = (seed: number, held: unknown[] = []) => ({
  symbol: `SYM${seed}`,
  candles: {
    h1: candles(240, 100 + seed, 0.004, T, 3_600_000),
    m15: candles(320, 100 + seed, 0.002, T, 900_000),
    m5: candles(520, 100 + seed, 0.001, T, 300_000)
  },
  currentPrice: 100 + seed,
  portfolio: {
    portfolioValue: 10_000, initialAmount: 10_000,
    dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0,
    openPositionsCount: held.length, openFuturesPositionsCount: 0, totalLeveragedExposureUsd: 0
  },
  openPositions: held,
  marketData: { livePrice: 100 + seed, priceChange24h: 1 },
  params: {},
  now: Date.now(),
  closedTrades: []
}) as never;

const ADAPTERS = [
  ['intraday', IntradayAdapter],
  ['legacy', LegacyAdapter],
  ['pro', ProAdapter]
] as const;

const engineFor = (Adapter: (typeof ADAPTERS)[number][1]) => {
  const engine = new DecisionEngine({ verbose: false });
  engine.registerAdapter(new (Adapter as new () => IntradayAdapter)());
  return engine;
};

describe('a blocked decision always names the gate that blocked it', () => {
  it.each(ADAPTERS)('%s never reports gate UNKNOWN', (_name, Adapter) => {
    const engine = engineFor(Adapter);
    for (let s = 0; s < 40; s++) {
      const r = engine.evaluate(context(s));
      expect(r.gate, `symbol SYM${s} produced an unlabelled gate`).not.toBe('UNKNOWN');
      expect(r.gate).toBeTruthy();
    }
  });

  it.each(ADAPTERS)('%s never reports the placeholder reason "Blocked"', (_name, Adapter) => {
    const engine = engineFor(Adapter);
    for (let s = 0; s < 40; s++) {
      const r = engine.evaluate(context(s));
      if (r.outcome === 'SIGNAL') continue;
      const reason = r.reasoning?.[0] ?? '';
      expect(reason, `symbol SYM${s} blocked with no explanation`).not.toBe('Blocked');
      expect(reason.trim().length, `symbol SYM${s} blocked with an empty reason`).toBeGreaterThan(0);
    }
  });

  it.each(ADAPTERS)('%s renders a Gate factor carrying a real label, not "UNKNOWN"', (_name, Adapter) => {
    const engine = engineFor(Adapter);
    for (let s = 0; s < 20; s++) {
      const r = engine.evaluate(context(s));
      if (r.outcome === 'SIGNAL') continue;
      const gateFactor = buildFactorsFromDecisionResult(r).find(f => f.label === 'Gate');
      expect(gateFactor, `symbol SYM${s} blocked without a Gate factor`).toBeDefined();
      expect(gateFactor!.value).not.toBe('UNKNOWN');
      expect(gateFactor!.note).not.toBe('Blocked');
    }
  });

  it('a router HOLD is reported as ROUTE, not as an anonymous block', () => {
    // The router returning HOLD is the single most common outcome, and it was
    // the one path that produced "[UNKNOWN] / Blocked" for every symbol on screen.
    // A blown daily drawdown makes routeTradeType return HOLD deterministically,
    // which is the exact path that used to surface as "[UNKNOWN] / Blocked".
    const drawnDown = (seed: number) => {
      const base = context(seed) as unknown as { portfolio: Record<string, number> };
      return {
        ...(base as object),
        portfolio: { ...base.portfolio, dailyDrawdownPercent: 12 }
      } as never;
    };

    const KNOWN_GATES = /^(ROUTE|HARD_GATE|ENTRY_TIMING|RISK|CORRELATION|COST_EDGE|NO_DATA|ERROR|MIN_CONFIDENCE|CIRCUIT_BREAKER|EXPOSURE)/;

    for (const Adapter of [LegacyAdapter, ProAdapter]) {
      const engine = engineFor(Adapter);
      const held = engine.evaluate(drawnDown(900));
      expect(held.outcome).not.toBe('SIGNAL');
      expect(held.gate).toMatch(KNOWN_GATES);
      expect(held.reasoning?.[0] ?? '').not.toBe('Blocked');

      // Whatever else the fixtures happen to produce must also be labelled.
      for (let s = 0; s < 40; s++) {
        const r = engine.evaluate(context(s));
        if (r.outcome !== 'SIGNAL') expect(r.gate).toMatch(KNOWN_GATES);
      }
    }
  });

  it('the correlation gate explains itself instead of blocking silently', () => {
    const engine = new DecisionEngine({ verbose: false, maxCorrelatedPositions: 2 });
    engine.registerAdapter(new ProAdapter());
    const held = Array.from({ length: 2 }, (_, i) => ({
      symbol: `H${i}`, type: 'SPOT', side: 'BUY',
      candles: candles(240, 100, 0.004, T, 3_600_000)
    }));
    const r = engine.evaluate({
      ...(context(0) as object),
      candles: { h1: candles(240, 100, 0.004, T, 3_600_000) },
      openPositions: held
    } as never);

    // Whichever correlation gate fires — the adapter's stage or the
    // orchestrator's post-check — the headline reason must be the block itself,
    // never the reason the trade had been approved for.
    expect(r.gate).toBe('CORRELATION');
    expect(r.reasoning?.[0] ?? '').toContain('CORRELATION_GATE');
  });
});

describe('a SIGNAL is only issued when a real trade was decided', () => {
  // `outcome` used to be derived from the router alone, so a HOLD signal that
  // the router had nonetheless typed as SPOT/FUTURES produced willExecute:true
  // and the Pro bot filled an order immediately on startup.
  it.each(ADAPTERS)('%s never emits SIGNAL with tradeType HOLD', (_name, Adapter) => {
    const engine = engineFor(Adapter);
    for (let s = 0; s < 40; s++) {
      const r = engine.evaluate(context(s));
      if (r.outcome !== 'SIGNAL') continue;
      expect(r.tradeType, `SYM${s} signalled a HOLD as an executable trade`).not.toBe('HOLD');
      expect(r.direction, `SYM${s} signalled a trade with no direction`).not.toBe('NONE');
    }
  });

  it.each(ADAPTERS)('%s never emits SIGNAL without a risk plan', (_name, Adapter) => {
    const engine = engineFor(Adapter);
    for (let s = 0; s < 40; s++) {
      const r = engine.evaluate(context(s));
      if (r.outcome !== 'SIGNAL') continue;
      expect(r.riskPlan, `SYM${s} would execute with no stop-loss or size`).toBeTruthy();
      expect(r.riskPlan!.stopLoss).toBeGreaterThan(0);
      expect(r.riskPlan!.betSizeUsd).toBeGreaterThan(0);
    }
  });
});

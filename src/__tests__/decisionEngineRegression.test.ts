import { describe, it, expect } from 'vitest';
import { DecisionEngine, IntradayAdapter, LegacyAdapter, ProAdapter } from '@cde/engine';
import { evaluateIntradayDecision } from '@cde/engine/analysis';
import { DEFAULT_INTRADAY_PARAMS } from '@cde/engine';

/**
 * Regression tests for four defects that the existing suite could not catch,
 * because every assertion it made ("outcome is one of SIGNAL/NO_SIGNAL/NO_DATA")
 * held just as well when the engine was fed undefined parameters or when a
 * cross-cutting gate threw and was swallowed into gate:'ERROR'.
 *
 * Each test below fails on the specific bug and on nothing else.
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
const H1 = candles(240, 100, 0.004, T, 3_600_000);
const clone = () => H1.map(c => ({ ...c }));

const intradayInput = (params: unknown, dailyDrawdownPercent = 0) => ({
  symbol: 'BTC',
  h1: clone(),
  m15: candles(320, 100, 0.002, T, 900_000),
  m5: candles(520, 100, 0.001, T, 300_000),
  livePrice: 100,
  portfolio: {
    portfolioValue: 10_000, initialAmount: 10_000,
    dailyDrawdownPercent, weeklyDrawdownPercent: 0,
    openPositionsCount: 0, openFuturesPositionsCount: 0, totalLeveragedExposureUsd: 0
  },
  openPositions: [],
  params,
  now: Date.now()
}) as never;

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

describe('intraday params must MERGE with defaults, not replace them', () => {
  // The adapter passes context.params, which is never empty (the orchestrator
  // writes its own bookkeeping keys into it). `input.params ?? DEFAULT` therefore
  // never fell back, and the engine ran with every threshold undefined.
  it('a partial params object produces the same decision as the full defaults', () => {
    const full = evaluateIntradayDecision(intradayInput(DEFAULT_INTRADAY_PARAMS));
    const partial = evaluateIntradayDecision(intradayInput({}));
    expect(partial.gate).toBe(full.gate);
    expect(partial.outcome).toBe(full.outcome);
  });

  it('the drawdown circuit breaker still fires when params are partial', () => {
    // The sharpest symptom: `50 >= undefined` is false, so the breaker was
    // silently skipped and the engine kept evaluating entries in a blown account.
    expect(evaluateIntradayDecision(intradayInput({}, 50)).gate).toBe('CIRCUIT_BREAKER');
  });
});

describe('no cross-cutting gate may throw into gate:ERROR', () => {
  // The orchestrator wraps the pipeline in try/catch and reports failures as
  // gate 'ERROR'. A value imported through the types barrel resolved to
  // undefined at runtime, so every evaluation with an open position crashed
  // there and the bot silently stopped trading after its first fill.
  it.each([
    ['intraday', IntradayAdapter],
    ['legacy', LegacyAdapter],
    ['pro', ProAdapter]
  ])('%s adapter never reports ERROR across a batch of symbols', (_name, Adapter) => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new (Adapter as new () => IntradayAdapter)());
    for (let s = 0; s < 20; s++) {
      expect(engine.evaluate(context(s)).gate).not.toBe('ERROR');
    }
  });

  it('an evaluation with open positions does not crash the correlation gate', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new ProAdapter());
    const held = [{ symbol: 'H0', type: 'SPOT', side: 'BUY', candles: clone() }];
    expect(engine.evaluate(context(0, held)).gate).not.toBe('ERROR');
  });
});

describe('correlation gate actually blocks', () => {
  // It needs the CANDIDATE's own series in the map, not only the held ones —
  // evaluateCorrelationGate looks itself up by symbol and abstains otherwise.
  it('allows below the cap and refuses at it', () => {
    const engine = new DecisionEngine({ verbose: false, maxCorrelatedPositions: 2 });
    engine.registerAdapter(new ProAdapter());
    const held = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ symbol: `H${i}`, type: 'SPOT', side: 'BUY', candles: clone() }));

    const under = engine.evaluate({ ...(context(0) as object), candles: { h1: clone() }, openPositions: held(1) } as never);
    const at = engine.evaluate({ ...(context(0) as object), candles: { h1: clone() }, openPositions: held(2) } as never);

    expect(under.gate).not.toBe('CORRELATION');
    expect(at.gate).toBe('CORRELATION');
  });
});

describe('adapter selection', () => {
  it('an explicit engineId is never silently served by another engine', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new IntradayAdapter());
    engine.registerAdapter(new LegacyAdapter());
    engine.registerAdapter(new ProAdapter());
    for (const id of ['intraday', 'legacy', 'pro'] as const) {
      expect(engine.evaluate(context(1), id).engineId).toBe(id);
    }
  });

  it('insufficient data reports NO_DATA on the requested engine', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new IntradayAdapter());
    engine.registerAdapter(new LegacyAdapter());
    const undersized = { ...(context(1) as object), candles: { h1: candles(60, 100, 0.003, T, 3_600_000) } } as never;
    expect(engine.evaluate(undersized, 'intraday').gate).toBe('NO_DATA');
  });
});

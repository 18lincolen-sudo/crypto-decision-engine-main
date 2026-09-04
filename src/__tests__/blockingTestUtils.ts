/** Shared test utilities for blocking command tests. */
import { DecisionEngine, IntradayAdapter, LegacyAdapter, ProAdapter, PathAdapter } from '@cde/engine';
import type { DecisionContext, PortfolioRiskStats } from '@cde/engine';

export function makeCandles(n: number, base: number, vol: number, t0: number, stepMs: number, trend: 'up' | 'down' | 'flat' = 'flat') {
  const out: { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const o = p;
    const trendBias = trend === 'up' ? 0.002 : trend === 'down' ? -0.002 : 0;
    p = p * (1 + vol * Math.sin(i / 11) + vol * 0.3 * Math.cos(i / 3) + trendBias);
    out.push({ timestamp: t0 + i * stepMs, open: o, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, close: p, volume: 900 + (i % 7) * 80 });
  }
  return out;
}

export const T = 1_700_000_000_000;

export function makePortfolio(overrides: Partial<PortfolioRiskStats> = {}): PortfolioRiskStats {
  return { portfolioValue: 10_000, initialAmount: 10_000, dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0, openPositionsCount: 0, openFuturesPositionsCount: 0, totalLeveragedExposureUsd: 0, existingExposureByAsset: {}, systemLocked: false, ...overrides };
}

export function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    symbol: 'BTC',
    candles: { h1: makeCandles(240, 100, 0.004, T, 3_600_000), m15: makeCandles(320, 100, 0.002, T, 900_000), m5: makeCandles(520, 100, 0.001, T, 300_000) },
    currentPrice: 100, portfolio: makePortfolio(), openPositions: [],
    marketData: { priceChange24h: 1, spreadPercent: 0.05, quoteVolume24h: 50_000_000, quoteVolume24hSpot: 50_000_000 },
    params: {}, now: Date.now(), closedTrades: [],
    config: { minConfidenceOverride: undefined, maxPositions: 7, maxFuturesPositions: 2 },
    ...overrides
  } as DecisionContext;
}

/** A DecisionEngine with exactly one adapter registered.
 *
 *  Static import, not require(): this package is ESM, so require is not defined
 *  at runtime here — and the type annotation needs the class as a VALUE import
 *  anyway (`DecisionEngine` used as a type only resolves once it is imported as
 *  one, which is what TS2749 was pointing at). */
export function makeEngine(adapter: 'intraday' | 'legacy' | 'pro' | 'path'): DecisionEngine {
  const engine = new DecisionEngine({ verbose: false });
  if (adapter === 'intraday') engine.registerAdapter(new IntradayAdapter());
  else if (adapter === 'legacy') engine.registerAdapter(new LegacyAdapter());
  else if (adapter === 'pro') engine.registerAdapter(new ProAdapter());
  else engine.registerAdapter(new PathAdapter());
  return engine;
}
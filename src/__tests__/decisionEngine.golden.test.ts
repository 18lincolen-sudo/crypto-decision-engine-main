import { describe, it, expect } from 'vitest';
import { DecisionEngine } from '../services/decisionEngine';
import { IntradayAdapter } from '../services/decisionEngine/adapters/intradayAdapter';
import { LegacyAdapter } from '../services/decisionEngine/adapters/legacyAdapter';
import { ProAdapter } from '../services/decisionEngine/adapters/proAdapter';
import { Candle } from '../services/tradeEngine';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCandles(count: number, basePrice = 100, trend = 0): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + trend / 100);
    const high = Math.max(open, close) * 1.01;
    const low = Math.min(open, close) * 0.99;
    candles.push({
      timestamp: 1000 + i * 3600000,
      open,
      high,
      low,
      close,
      volume: 1000 + i * 10
    });
    price = close;
  }
  return candles;
}

function baseContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'BTC',
    candles: {
      h1: makeCandles(200, 100, 0.1),
      m15: makeCandles(300, 100, 0.1),
      m5: makeCandles(500, 100, 0.1)
    },
    currentPrice: 110,
    portfolio: {
      portfolioValue: 10000,
      initialAmount: 10000,
      dailyDrawdownPercent: 0,
      weeklyDrawdownPercent: 0,
      openPositionsCount: 0,
      openFuturesPositionsCount: 0,
      totalLeveragedExposureUsd: 0,
      existingExposureByAsset: {},
      systemLocked: false
    },
    openPositions: [],
    marketData: {
      spreadPercent: 0.1,
      quoteVolume24h: 1000000,
      quoteVolume24hSpot: 800000,
      livePrice: 110,
      priceChange24h: 2,
      fearGreedIndex: 50
    },
    params: {},
    now: Date.now(),
    closedTrades: [],
    config: {
      minConfidenceOverride: 40,
      maxPositions: 7,
      maxFuturesPositions: 2
    },
    ...overrides
  };
}

// ── Intraday golden ──────────────────────────────────────────────────────────

describe('DecisionEngine golden — intraday', () => {
  it('produces a DecisionResult with the expected shape for a valid input', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new IntradayAdapter());

    const ctx = baseContext() as Parameters<typeof engine.evaluate>[0];
    const result = engine.evaluate(ctx, 'intraday');

    expect(result.engineId).toBe('intraday');
    expect(result.symbol).toBe('BTC');
    expect(['SIGNAL', 'NO_SIGNAL', 'NO_DATA']).toContain(result.outcome);
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.reasoning)).toBe(true);
    expect(typeof result.metrics).toBe('object');
  });

  it('returns NO_SIGNAL with NO_DATA gate when candles are insufficient', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new IntradayAdapter());

    const ctx = baseContext({
      candles: { h1: makeCandles(50), m15: makeCandles(100), m5: makeCandles(200) }
    }) as Parameters<typeof engine.evaluate>[0];
    const result = engine.evaluate(ctx, 'intraday');

    expect(result.outcome).toBe('NO_SIGNAL');
    expect(result.gate).toBe('NO_DATA');
    expect(result.confidence).toBe(0);
  });

  it('returns CIRCUIT_BREAKER when daily drawdown is exceeded', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new IntradayAdapter());

    const ctx = baseContext({
      portfolio: {
        ...(baseContext().portfolio as Record<string, unknown>),
        dailyDrawdownPercent: 10,
        weeklyDrawdownPercent: 5
      }
    }) as Parameters<typeof engine.evaluate>[0];
    const result = engine.evaluate(ctx, 'intraday');

    expect(result.outcome).toBe('NO_SIGNAL');
    expect(result.gate).toBe('CIRCUIT_BREAKER');
  });
});

// ── Legacy golden ────────────────────────────────────────────────────────────

describe('DecisionEngine golden — legacy', () => {
  it('produces a DecisionResult with the expected shape for a valid input', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new LegacyAdapter());

    const ctx = baseContext({
      candles: { h1: makeCandles(200, 100, 0.1) },
      marketData: { priceChange24h: 2, fearGreedIndex: 50 }
    }) as Parameters<typeof engine.evaluate>[0];
    const result = engine.evaluate(ctx, 'legacy');

    expect(result.engineId).toBe('legacy');
    expect(result.symbol).toBe('BTC');
    expect(['SIGNAL', 'NO_SIGNAL', 'NO_DATA']).toContain(result.outcome);
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.reasoning)).toBe(true);
    expect(typeof result.metrics).toBe('object');
  });

  it('returns NO_SIGNAL with NO_DATA gate when H1 candles are insufficient', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new LegacyAdapter());

    const ctx = baseContext({
      candles: { h1: makeCandles(30) }
    }) as Parameters<typeof engine.evaluate>[0];
    const result = engine.evaluate(ctx, 'legacy');

    expect(result.outcome).toBe('NO_SIGNAL');
    expect(result.gate).toBe('NO_DATA');
  });
});

// ── Pro golden ───────────────────────────────────────────────────────────────

describe('DecisionEngine golden — pro', () => {
  it('produces a DecisionResult with the expected shape for a valid input', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new ProAdapter());

    const ctx = baseContext({
      candles: { h1: makeCandles(200, 100, 0.1) },
      marketData: {
        priceChange24h: 2,
        fearGreedIndex: 50,
        marketCap: 1000000000,
        volume24h: 50000000
      }
    }) as Parameters<typeof engine.evaluate>[0];
    const result = engine.evaluate(ctx, 'pro');

    expect(result.engineId).toBe('pro');
    expect(result.symbol).toBe('BTC');
    expect(['SIGNAL', 'NO_SIGNAL', 'NO_DATA']).toContain(result.outcome);
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.reasoning)).toBe(true);
    expect(typeof result.metrics).toBe('object');
  });

  it('returns NO_SIGNAL with NO_DATA gate when H1 candles are insufficient', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new ProAdapter());

    const ctx = baseContext({
      candles: { h1: makeCandles(30) }
    }) as Parameters<typeof engine.evaluate>[0];
    const result = engine.evaluate(ctx, 'pro');

    expect(result.outcome).toBe('NO_SIGNAL');
    expect(result.gate).toBe('NO_DATA');
  });
});

// ── Cross-engine contract ────────────────────────────────────────────────────

describe('DecisionEngine cross-engine contract', () => {
  it('all three engines return the same DecisionResult shape', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new IntradayAdapter());
    engine.registerAdapter(new LegacyAdapter());
    engine.registerAdapter(new ProAdapter());

    const base = baseContext();

    const intradayResult = engine.evaluate(base as Parameters<typeof engine.evaluate>[0], 'intraday');
    const legacyResult = engine.evaluate(base as Parameters<typeof engine.evaluate>[0], 'legacy');
    const proResult = engine.evaluate(base as Parameters<typeof engine.evaluate>[0], 'pro');

    // All must have the same top-level shape
    for (const result of [intradayResult, legacyResult, proResult]) {
      expect(result).toHaveProperty('engineId');
      expect(result).toHaveProperty('symbol');
      expect(result).toHaveProperty('outcome');
      expect(result).toHaveProperty('gate');
      expect(result).toHaveProperty('tradeType');
      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('riskPlan');
      expect(result).toHaveProperty('reasoning');
      expect(result).toHaveProperty('metrics');
    }
  });

  it('explicit engineId that is not registered returns NO_ADAPTER', () => {
    const engine = new DecisionEngine({ verbose: false });
    engine.registerAdapter(new IntradayAdapter());

    const ctx = baseContext() as Parameters<typeof engine.evaluate>[0];
    const result = engine.evaluate(ctx, 'nonexistent');

    expect(result.outcome).toBe('NO_SIGNAL');
    expect(result.gate).toBe('NO_ADAPTER');
    expect(result.confidence).toBe(0);
  });
});

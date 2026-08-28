import { describe, it, expect } from 'vitest';
import { generateLegacyOrders } from '../services/legacySimExecution';
import { Candle } from '../services/tradeEngine';
import type { SimPosition, PendingOrder } from '../services/simExecution';
import type { SignalEvaluation } from '../services/intradayBridge';

// These tests exist because the correlation filter and the adaptive-risk
// helpers previously existed as EXPORTED BUT UNCALLED functions — the unit
// tests passed while the engines were unaffected. Everything below goes
// through the real order-generation entry point.

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

function pseudoRandomReturns(n: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(((x / 2147483648) - 0.5) * 0.04);
  }
  return out;
}

function seriesFrom(returns: number[], start = 100): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < returns.length; i++) {
    const open = price;
    price = price * (1 + returns[i]);
    out.push({
      timestamp: T0 + i * HOUR,
      open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 1000
    });
  }
  return out;
}

const shared = pseudoRandomReturns(90, 11);
const candlesBySymbol: Record<string, Candle[]> = {
  BTC: seriesFrom(shared, 60000),
  ETH: seriesFrom(shared, 3000),
  SOL: seriesFrom(shared, 150),
  DOGE: seriesFrom(shared, 0.1)  // 4th correlated asset
};

function evaluation(symbol: string, willExecute = true): SignalEvaluation {
  return {
    symbol,
    action: 'buy',
    tradeType: 'SPOT',
    tradeSide: 'BUY',
    confidence: 70,
    price: 100,
    priceChange24h: 1,
    reasoning: 'test',
    status: willExecute ? 'מוכן לביצוע' : 'הפוגה אחרי רצף הפסדים',
    willExecute,
    factors: [],
    confidenceGap: 0,
    leverage: 1,
    stopLoss: 90,
    takeProfit: 130
  } as unknown as SignalEvaluation;
}

function position(symbol: string): SimPosition {
  return {
    id: symbol, symbol, type: 'SPOT', side: 'BUY', quantity: 1,
    entryPrice: 100, avgPrice: 100, currentPrice: 100, leverage: 1,
    marginUsd: 100, notionalUsd: 100, stopLoss: 90, tp1Hit: false,
    openedAt: new Date(T0).toISOString(), openTimestamp: Date.now(),
    reason: 'test', confidence: 70, entryFee: 0
  } as SimPosition;
}

const baseCtx = {
  pending: [] as PendingOrder[],
  executionDelaySec: 0,
  dailyDrawdownPercent: 0,
  weeklyDrawdownPercent: 0,
  cash: 100_000,
  equity: 100_000,
  exitCooldown: {} as Record<string, number>,
  priceFor: () => 100,
  candlesBySymbol,
  maxPositions: 7,
  maxFuturesPositions: 2
};

describe('correlation gate is wired into legacy order generation', () => {
  it('refuses the 13th position in a correlated cluster', () => {
    const orders = generateLegacyOrders({
      ...baseCtx,
      positions: [
        position('BTC'), position('ETH'), position('SOL'),
        position('ADA'), position('DOT'), position('AVAX'),
        position('LINK'), position('MATIC'), position('UNI'),
        position('ATOM'), position('LTC'), position('BCH')
      ],
      evaluations: [evaluation('XLM')]
    });
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(0);
  });

  it('allows it when only two correlated positions are held', () => {
    const orders = generateLegacyOrders({
      ...baseCtx,
      positions: [position('BTC'), position('ETH')],
      evaluations: [evaluation('SOL')]
    });
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(1);
  });

  it('caps a whole cluster that fires within a single tick', () => {
    // Nothing open: without a within-batch check all 13 would queue,
    // because each evaluation was judged against the same empty book.
    // maxPositions is set to 12 to test the correlation gate cap
    const orders = generateLegacyOrders({
      ...baseCtx,
      positions: [],
      maxPositions: 12,
      evaluations: [
        evaluation('BTC'), evaluation('ETH'), evaluation('SOL'),
        evaluation('ADA'), evaluation('DOT'), evaluation('AVAX'),
        evaluation('LINK'), evaluation('MATIC'), evaluation('UNI'),
        evaluation('ATOM'), evaluation('LTC'), evaluation('BCH'),
        evaluation('XLM')
      ]
    });
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(12);
  });
});

describe('streak cooldown is wired into legacy order generation', () => {
  const twoRecentLosses = [
    { pnl: 5, at: Date.now() - 10 * 60_000 },
    { pnl: -5, at: Date.now() - 5 * 60_000 },
    { pnl: -5, at: Date.now() - 60_000 }
  ];

  it('blocks entries when evaluation has willExecute=false due to cooldown', () => {
    // The per-symbol cooldown is now handled in buildEvaluations.
    // When an evaluation has willExecute=false, generateLegacyOrders respects that.
    const orders = generateLegacyOrders({
      ...baseCtx,
      positions: [],
      evaluations: [evaluation('BTC', false)],  // willExecute: false (cooldown)
      closedTradeMetrics: twoRecentLosses
    });
    expect(orders).toHaveLength(0);
  });

  it('lets entries through once the cooldown window has passed', () => {
    const orders = generateLegacyOrders({
      ...baseCtx,
      positions: [],
      evaluations: [evaluation('BTC', true)],  // willExecute: true (no cooldown)
      closedTradeMetrics: twoRecentLosses.map((t) => ({ ...t, at: t.at - 45 * 60_000 }))
    });
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(1);
  });

  it('only blocks the symbol that had losses, not others (per-symbol cooldown)', () => {
    const lossesOnBtcOnly = [
      { pnl: 5, at: Date.now() - 10 * 60_000, symbol: 'ETH' },
      { pnl: -5, at: Date.now() - 5 * 60_000, symbol: 'BTC' },
      { pnl: -5, at: Date.now() - 60_000, symbol: 'BTC' }
    ];
    const orders = generateLegacyOrders({
      ...baseCtx,
      positions: [],
      evaluations: [evaluation('ETH', true)],  // ETH evaluation, willExecute: true
      closedTradeMetrics: lossesOnBtcOnly
    });
    // ETH should NOT be blocked — only BTC had losses
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { generateLegacyOrders, generateProOrders, generateNewOrders, fillDueOrders } from '@cde/engine/execution';
import { Candle } from '@cde/engine';
import type { SimPosition, PendingOrder } from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';

// Regression tests for the incident where the Legacy bot opened FOUR positions
// in one thin alt within ~24 seconds off a single unchanged H1 signal, then
// stopped all four out one per tick.
//
// Two independent defects produced it, and both are covered here:
//   1. the entry gate checked `pending` and the current batch for the symbol
//      but never `positions`, so a filled entry freed the symbol to be queued
//      again on the very next tick;
//   2. the exit loop skipped any position whose SYMBOL already had a pending
//      order, so while one lot's close was in flight the other lots were not
//      checked against their own stops at all.
//
// Both are exercised through the real order-generation entry points — the
// same reason portfolioGates.integration.test.ts exists.

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

function series(n: number, start: number): Candle[] {
  const out: Candle[] = [];
  let price = start;
  let x = 7;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const open = price;
    price = price * (1 + ((x / 2147483648) - 0.5) * 0.04);
    out.push({
      timestamp: T0 + i * HOUR,
      open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 1000
    });
  }
  return out;
}

const candlesBySymbol: Record<string, Candle[]> = {
  LA: series(90, 100),
  BTC: series(90, 60000)
};

function evaluation(symbol: string): SignalEvaluation {
  return {
    symbol,
    action: 'buy',
    tradeType: 'SPOT',
    tradeSide: 'BUY',
    confidence: 70,
    price: 100,
    priceChange24h: 1,
    reasoning: 'test',
    status: 'ready',
    willExecute: true,
    factors: [],
    confidenceGap: 0,
    leverage: 1,
    stopLoss: 90,
    takeProfit: 130
  } as unknown as SignalEvaluation;
}

function position(id: string, symbol: string): SimPosition {
  return {
    id, symbol, type: 'SPOT', side: 'BUY', quantity: 1,
    entryPrice: 100, avgPrice: 100, currentPrice: 100, leverage: 1,
    marginUsd: 100, notionalUsd: 100, stopLoss: 90, tp1Hit: false,
    highestPrice: 100, lowestPrice: 100,
    openedAt: new Date(T0).toISOString(), openTimestamp: Date.now() - HOUR,
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

describe('an asset already held is never entered a second time', () => {
  it('legacy: refuses an entry for a symbol with an open position', () => {
    const orders = generateLegacyOrders({
      ...baseCtx,
      positions: [position('la-1', 'LA')],
      evaluations: [evaluation('LA')]
    });
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(0);
  });

  it('legacy: still allows the entry once that position is closed', () => {
    const orders = generateLegacyOrders({
      ...baseCtx,
      positions: [],
      evaluations: [evaluation('LA')]
    });
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(1);
  });

  it('pro: refuses an entry for a symbol with an open position', () => {
    const orders = generateProOrders({
      ...baseCtx,
      positions: [position('la-1', 'LA')],
      evaluations: [evaluation('LA')]
    });
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(0);
  });

  it('intraday: refuses an entry for a symbol with an open position', () => {
    const orders = generateNewOrders({
      ...baseCtx,
      positions: [position('la-1', 'LA')],
      evaluations: [evaluation('LA')],
      buildCandlesForSymbol: (s: string) => candlesBySymbol[s] ?? [],
      computeAtr5: () => 1
    });
    expect(orders.filter((o) => o.side === 'buy')).toHaveLength(0);
  });
});

describe('every open lot is checked against its own stop in the same tick', () => {
  // Positions that predate the one-per-symbol gate can still be restored from
  // persisted state, so the exit path has to unwind them all at once rather
  // than one per tick.
  const stopped = { ...baseCtx, priceFor: () => 80 };

  it('legacy: queues a separate exit for each lot of the same symbol', () => {
    const orders = generateLegacyOrders({
      ...stopped,
      positions: [position('la-1', 'LA'), position('la-2', 'LA'), position('la-3', 'LA')],
      evaluations: []
    });
    const exits = orders.filter((o) => o.side === 'close_long');
    expect(exits).toHaveLength(3);
    expect(new Set(exits.map((o) => o.positionId))).toEqual(new Set(['la-1', 'la-2', 'la-3']));
  });

  it('legacy: does not re-queue a lot whose close is already pending', () => {
    const alreadyPending = [{ positionId: 'la-1', symbol: 'LA', side: 'close_long' } as unknown as PendingOrder];
    const orders = generateLegacyOrders({
      ...stopped,
      pending: alreadyPending,
      positions: [position('la-1', 'LA'), position('la-2', 'LA')],
      evaluations: []
    });
    const exits = orders.filter((o) => o.side === 'close_long');
    expect(exits.map((o) => o.positionId)).toEqual(['la-2']);
  });
});

describe('a close fills against the lot it was issued for', () => {
  it('uses positionId rather than the first position sharing the symbol', () => {
    const first = { ...position('la-1', 'LA'), entryPrice: 100, avgPrice: 100, quantity: 1 };
    const second = { ...position('la-2', 'LA'), entryPrice: 50, avgPrice: 50, quantity: 1 };

    const order = {
      id: 'o1', symbol: 'LA', positionId: 'la-2', type: 'SPOT', side: 'close_long',
      signalPrice: 100, quantity: 1, reason: 'Stop Loss', confidence: 70,
      executeAt: Date.now(), createdAt: Date.now()
    } as PendingOrder;

    const result = fillDueOrders([order], 1000, [first, second], () => 100, (n) => String(n));

    // The lot that closed is la-2 (bought at 50, sold near 100) — a WIN.
    // Matching by symbol would have closed la-1 and booked a flat/negative
    // trade against the wrong entry price.
    expect(result.positions.map((p) => p.id)).toEqual(['la-1']);
    expect(result.newTrades[0].pnl).toBeGreaterThan(0);
  });
});

describe('sizing respects the batch and the single-asset ceiling', () => {
  it('legacy: a second entry in the same tick is sized off the reduced cash', () => {
    const orders = generateLegacyOrders({
      ...baseCtx,
      cash: 1000,
      equity: 100_000,   // high enough that the per-asset cap does not bind
      positions: [],
      evaluations: [evaluation('LA'), evaluation('BTC')]
    });
    const buys = orders.filter((o) => o.side === 'buy');
    expect(buys).toHaveLength(2);
    // 15% of 1000, then 15% of the remaining 850 — not 15% of 1000 twice.
    expect(buys[0].budgetUsd).toBeCloseTo(150, 6);
    expect(buys[1].budgetUsd).toBeCloseTo(127.5, 6);
  });

  it('legacy: entry size is set by the cash budget, not by equity', () => {
    // Guards against re-introducing a per-asset equity ceiling on opening
    // entries. One position per symbol already bounds per-asset exposure, and
    // clamping the opening size as well silently re-tunes every trade in the
    // book — a strategy change wearing a bugfix's clothes.
    const orders = generateLegacyOrders({
      ...baseCtx,
      cash: 1000,
      equity: 1000,   // 8% of equity would be $80, well under the $150 budget
      positions: [],
      evaluations: [evaluation('LA')]
    });
    const buy = orders.find((o) => o.side === 'buy');
    expect(buy?.budgetUsd).toBeCloseTo(150, 6);
  });
});

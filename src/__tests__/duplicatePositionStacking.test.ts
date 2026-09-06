import { describe, it, expect } from 'vitest';
import { generateProOrders, generateNewOrders, fillDueOrders, applyProEntryGates, type ProGateContext } from '@cde/engine/execution';
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
// same reason portfolioGates.integration.test.ts exists. (The Legacy engine
// itself is gone; the surviving Pro engine shares both behaviors.)

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
  it('pro: refuses an entry for a symbol with an open position', () => {
    const orders = generateProOrders({
      ...baseCtx,
      positions: [position('la-1', 'LA')],
      evaluations: [evaluation('LA')],
      signalsBySymbol: {},
      minConfidence: 40
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
  // than one per tick. At 80 against a 100 entry every lot is -20% — far past
  // §5's fixed -4.2% stop — so the exit fires regardless of the live signal.
  const stopped = { ...baseCtx, priceFor: () => 80 };

  it('pro: queues a separate exit for each lot of the same symbol', () => {
    const orders = generateProOrders({
      ...stopped,
      positions: [position('la-1', 'LA'), position('la-2', 'LA'), position('la-3', 'LA')],
      evaluations: [],
      signalsBySymbol: {},
      minConfidence: 40
    });
    const exits = orders.filter((o) => o.side === 'close_long');
    expect(exits).toHaveLength(3);
    expect(new Set(exits.map((o) => o.positionId))).toEqual(new Set(['la-1', 'la-2', 'la-3']));
  });

  it('pro: does not re-queue a lot whose close is already pending', () => {
    const alreadyPending = [{ positionId: 'la-1', symbol: 'LA', side: 'close_long' } as unknown as PendingOrder];
    const orders = generateProOrders({
      ...stopped,
      pending: alreadyPending,
      positions: [position('la-1', 'LA'), position('la-2', 'LA')],
      evaluations: [],
      signalsBySymbol: {},
      minConfidence: 40
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

describe('sizing respects the batch: §4 gate 7 allocates against projected cash', () => {
  const gateCtx = (over: Partial<ProGateContext> = {}): ProGateContext => ({
    positions: [], pending: [], cash: 10_000, equity: 10_000, initialAmount: 10_000, maxPositions: 7, riskLevel: 'low', ...over
  });

  it('pro: a later entry in the batch is capped by the projected equity §4 leaves', () => {
    // confidence 70 → 10% × 10_000 = 1000 per entry. With 1650 in equity: the first take
    // gets min(1000, 1650) = 1000 (the allocation caps, not the equity) and the
    // projected equity drops to 650; the second gets min(1000, 650) = 650 —
    // sized off the projected equity §4 leaves.
    const gated = applyProEntryGates([evaluation('LA'), evaluation('BTC')], gateCtx({ cash: 1650, equity: 1650 }));
    expect(gated.find((e) => e.symbol === 'LA')?.budgetUsd).toBeCloseTo(1000, 6);
    expect(gated.find((e) => e.symbol === 'BTC')?.budgetUsd).toBeCloseTo(650, 6);
  });

  it('pro: the strongest confidence is allocated first (§4)', () => {
    const weak = evaluation('LA');
    weak.confidence = 60; // below the 70 entry bar
    const strong = evaluation('BTC');
    strong.confidence = 80;
    const gated = applyProEntryGates([weak, strong], gateCtx({ cash: 200, maxPositions: 1 }));
    // The batch is walked confidence-descending: BTC (80) clears the bar and
    // takes the one slot; LA (60) is refused at the threshold — regardless of
    // the order the caller listed them in.
    expect(gated[0].symbol).toBe('BTC');
    expect(gated[0].willExecute).toBe(true);
    const la = gated.find((e) => e.symbol === 'LA');
    expect(la?.status).toBe('NO_SIGNAL [BELOW_THRESHOLD]');
    expect(la?.willExecute).toBe(false);
  });
});

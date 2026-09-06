import { describe, it, expect } from 'vitest';
import { generatePathOrders } from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';

// Regression: evaluatePathDecision sets entryPrice to input.livePrice itself
// (pathEngine.ts) — a "trade now, at this price" value, not a discount below
// it the way Pro's calculateOptimalEntryPrice is. Left unmarked, fillDueOrders
// defaults any entry order to a resting LIMIT (crossed only once price falls
// back to signalPrice or below), which would hold the order open waiting for
// the very reversal that invalidates the specific 15-minute slot the bucket's
// statistics armed it for — evaluatePathDecision's OUT_OF_WINDOW gate only
// allows a signal during that one slot in the first place, so a fill minutes
// later after price reverses is not a late version of the same trade.

function buyEval(symbol: string): SignalEvaluation {
  return {
    symbol,
    action: 'buy',
    tradeType: 'SPOT',
    tradeSide: 'BUY',
    confidence: 60,
    price: 100,
    priceChange24h: 1,
    reasoning: 'test',
    status: 'ready',
    willExecute: true,
    factors: [],
    confidenceGap: 0,
    stopLoss: 98,
    takeProfit: 103,
    decision: { bucket: { direction: 'LONG', slot: 3, tpR: 1.5, slR: 1, pLow: 0.5 } } as unknown
  } as unknown as SignalEvaluation;
}

const baseCtx = {
  positions: [],
  pending: [],
  executionDelaySec: 0,
  dailyDrawdownPercent: 0,
  weeklyDrawdownPercent: 0,
  cash: 10_000,
  equity: 10_000,
  exitCooldown: {} as Record<string, number>,
  priceFor: () => 100,
  candlesBySymbol: {},
  maxPositions: 7,
  maxFuturesPositions: 0
};

describe('Path entries fire as market orders, not a resting limit', () => {
  it('marks the new BUY order fill:"market"', () => {
    const orders = generatePathOrders({ ...baseCtx, evaluations: [buyEval('LA')] });
    const buy = orders.find((o) => o.side === 'buy');
    expect(buy).toBeDefined();
    expect(buy?.fill).toBe('market');
  });
});

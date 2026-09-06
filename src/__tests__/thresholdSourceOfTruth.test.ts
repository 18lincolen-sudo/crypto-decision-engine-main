import { describe, it, expect } from 'vitest';
import {
  applyProEntryGates,
  buildProEvaluation,
  type ProGateContext,
  type PendingOrder
} from '@cde/engine/execution';
import {
  evaluateProExit,
  proMinConfidence,
  PRO_CONFIDENCE_BY_RISK,
  PRO_ALLOCATION_BY_RISK,
  PRO_STOP_LOSS_PERCENT,
  PRO_TAKE_PROFIT_PERCENT,
  type ProSignalResult
} from '@cde/engine/analysis';
import type { Candle, SignalEvaluation } from '@cde/engine';

// Three §3/§4/§5 contracts, all of the same family — a number with two
// definitions that could disagree. This file used to test the PREVIOUS Pro
// engine's routing/adapter thresholds and the Legacy engine's dynamic floors;
// both are gone. What it covers now is the alg.md engine that replaced them:
//
//   §3 — the confidence floor comes from ONE place: the risk-level table,
//        with `minConfidenceOverride > 0` replacing it entirely.
//   §4 — the SignalEvaluation is the single source of truth: the gates run on
//        it, in the doc's order, over a confidence-descending batch.
//   §5 — the fixed-percentage exits (−4.2% / +3%) precede every signal, and
//        the flip-to-SELL exit is confidence-gated by the SAME §3 number.

// ── §3 — the threshold table is the single definition ────────────────────────

describe('§3 — minConfidence comes from the risk table, or from a real override', () => {
  it('uses the table when no override is set', () => {
    expect(proMinConfidence('low')).toBe(PRO_CONFIDENCE_BY_RISK.low);
    expect(proMinConfidence('medium')).toBe(PRO_CONFIDENCE_BY_RISK.medium);
    expect(proMinConfidence('high')).toBe(PRO_CONFIDENCE_BY_RISK.high);
    expect(PRO_CONFIDENCE_BY_RISK).toEqual({ low: 55, medium: 40, high: 25 });
  });

  it('a positive override replaces the table entirely', () => {
    expect(proMinConfidence('low', 70)).toBe(70);
    expect(proMinConfidence('high', 70)).toBe(70);
  });

  it('a zero or negative override is not an override — the table stands', () => {
    expect(proMinConfidence('medium', 0)).toBe(40);
    expect(proMinConfidence('medium', -3)).toBe(40);
    expect(proMinConfidence('medium', undefined)).toBe(40);
  });

  it('the §3 allocation travels with the same risk level', () => {
    expect(PRO_ALLOCATION_BY_RISK).toEqual({ low: 0.15, medium: 0.25, high: 0.40 });
  });
});

// ── §4 — the gates, in the doc's order, on the evaluation itself ─────────────

function buyEval(symbol: string, confidence: number): SignalEvaluation {
  return {
    symbol,
    action: 'buy',
    tradeType: 'SPOT',
    tradeSide: 'BUY',
    confidence,
    price: 100,
    priceChange24h: 1,
    reasoning: 'test',
    status: '',
    willExecute: false,
    factors: [],
    confidenceGap: 0
  } as SignalEvaluation;
}

function sellEval(symbol: string, confidence: number): SignalEvaluation {
  // buildProEvaluation stamps this status on every SELL — Spot never shorts —
  // and the gate pass leaves an unheld SELL untouched (§4: no action).
  return {
    ...buyEval(symbol, confidence),
    action: 'sell',
    tradeSide: 'SELL',
    status: 'NO_SIGNAL [SPOT_SELL_UNSUPPORTED]'
  } as SignalEvaluation;
}

const queuedOrder = (symbol: string): PendingOrder =>
  ({ id: `o-${symbol}`, symbol, side: 'buy' } as unknown as PendingOrder);

const gateCtx = (over: Partial<ProGateContext> = {}): ProGateContext => ({
  positions: [],
  pending: [],
  cash: 10_000,
  initialAmount: 10_000,
  maxPositions: 3,
  riskLevel: 'medium',
  ...over
});

describe('§4 — the gate sequence runs in the doc\'s order, on the evaluation', () => {
  it('a queued order precedes the threshold check — "פקודה בתור ביצוע"', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 90)], gateCtx({ pending: [queuedOrder('LA')] }));
    expect(ev.status).toBe('NO_SIGNAL [ORDER_QUEUED]');
    expect(ev.reasoning).toBe('פקודה בתור ביצוע');
    expect(ev.willExecute).toBe(false);
  });

  it('held precedes the threshold check — "כבר מוחזק בתיק"', () => {
    const held = { id: 'p1', symbol: 'LA' } as never;
    const [ev] = applyProEntryGates([buyEval('LA', 30)], gateCtx({ positions: [held] }));
    expect(ev.status).toBe('NO_SIGNAL [ALREADY_HELD]');
    expect(ev.reasoning).toBe('כבר מוחזק בתיק');
  });

  it('below the §3 floor is refused, with the gap reported', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 30)], gateCtx());
    expect(ev.status).toBe('NO_SIGNAL [BELOW_THRESHOLD]');
    expect(ev.willExecute).toBe(false);
    expect(ev.confidenceGap).toBeCloseTo(10, 6); // 40 − 30
  });

  it('no free slot → NO_SLOTS (queued buys occupy slots too)', () => {
    const held = { id: 'p1', symbol: 'HELD' } as never;
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({
      positions: [held],
      pending: [queuedOrder('OTHER')],
      maxPositions: 2
    }));
    expect(ev.status).toBe('NO_SIGNAL [NO_SLOTS]');
  });

  it('cash below the $5 floor → NO_BUDGET', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 4 }));
    expect(ev.status).toBe('NO_SIGNAL [NO_BUDGET]');
  });

  it('every gate passed → willExecute, "מבצע קנייה", and the allocated budget', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx());
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
    expect(ev.budgetUsd).toBeCloseTo(10_000 * 0.25, 6); // medium → 25%
  });
});

describe('§4 — the sell logic: Spot never shorts, a held symbol closes whole', () => {
  it('a SELL with no position stays display-only', () => {
    const [ev] = applyProEntryGates([sellEval('LA', 90)], gateCtx());
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toBe('NO_SIGNAL [SPOT_SELL_UNSUPPORTED]');
  });

  it('a SELL on a held symbol above the threshold is a full-position close signal', () => {
    const held = { id: 'p1', symbol: 'LA' } as never;
    const [ev] = applyProEntryGates([sellEval('LA', 80)], gateCtx({ positions: [held] }));
    expect(ev.status).toBe('SIGNAL SPOT SELL');
    expect(ev.willExecute).toBe(true);
  });

  it('a SELL flip below the threshold leaves the position to §5\'s SL/TP', () => {
    const held = { id: 'p1', symbol: 'LA' } as never;
    const [ev] = applyProEntryGates([sellEval('LA', 20)], gateCtx({ positions: [held] }));
    expect(ev.status).toBe('NO_SIGNAL [BELOW_THRESHOLD]');
    expect(ev.willExecute).toBe(false);
    expect(ev.reasoning).toContain('SL/TP');
  });
});

// ── §5 — the fixed exits precede everything, and use the §3 number ───────────

const stubSignal = (action: 'BUY' | 'SELL' | 'HOLD', confidence: number): ProSignalResult => ({
  action,
  buyScore: 0,
  sellScore: 0,
  holdScore: 0,
  totalWeight: 105,
  confidence,
  signals: [],
  indicators: {} as ProSignalResult['indicators']
});

describe('§5 — fixed-percentage exits, independent of the recommendation', () => {
  const minConfidence = proMinConfidence('medium'); // 40

  it(`closes at −${PRO_STOP_LOSS_PERCENT}% — "Stop Loss"`, () => {
    const d = evaluateProExit({ entryPrice: 100 }, 100 - PRO_STOP_LOSS_PERCENT, stubSignal('BUY', 90), minConfidence);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toContain('Stop Loss');
  });

  it(`closes at +${PRO_TAKE_PROFIT_PERCENT}% — "Take Profit"`, () => {
    const d = evaluateProExit({ entryPrice: 100 }, 100 + PRO_TAKE_PROFIT_PERCENT, stubSignal('BUY', 90), minConfidence);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toContain('Take Profit');
  });

  it('holds inside the band even while the recommendation is still buy', () => {
    const d = evaluateProExit({ entryPrice: 100 }, 100.5, stubSignal('BUY', 90), minConfidence);
    expect(d.shouldExit).toBe(false);
  });

  it('the flip-to-SELL exit is gated by the same §3 number', () => {
    const below = evaluateProExit({ entryPrice: 100 }, 99, stubSignal('SELL', 30), minConfidence);
    expect(below.shouldExit).toBe(false);
    const above = evaluateProExit({ entryPrice: 100 }, 99, stubSignal('SELL', 45), minConfidence);
    expect(above.shouldExit).toBe(true);
  });
});

// ── warm-up floor ─────────────────────────────────────────────────────────────

describe('buildProEvaluation — the warm-up floor is honest about it', () => {
  it('reports NO_DATA before the candle floor, never a signal', () => {
    const candles: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const ev = buildProEvaluation('LA', candles, 100, 0, 'medium', undefined);
    expect(ev.status).toBe('NO_SIGNAL [NO_DATA]');
    expect(ev.willExecute).toBe(false);
  });
});
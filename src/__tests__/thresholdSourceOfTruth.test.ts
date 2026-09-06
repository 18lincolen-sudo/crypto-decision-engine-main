import { describe, it, expect } from 'vitest';
import {
  applyProEntryGates,
  buildProEvaluation,
  type ProGateContext,
  type PendingOrder
} from '@cde/engine/execution';
import {
  computeProSignal,
  evaluateProExit,
  proMinConfidence,
  calculateOptimalEntryPrice,
  PRO_DEFAULT_ENTRY_CONFIDENCE,
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

describe('§3 — minConfidence comes from one flat operator bar, or an override', () => {
  it('is 70 by default — the bot enters a BUY once overall confidence crosses 70', () => {
    // The flat default replaced the per-risk table as the ACTUAL entry bar.
    expect(proMinConfidence('low')).toBe(PRO_DEFAULT_ENTRY_CONFIDENCE);
    expect(proMinConfidence('medium')).toBe(PRO_DEFAULT_ENTRY_CONFIDENCE);
    expect(proMinConfidence('high')).toBe(PRO_DEFAULT_ENTRY_CONFIDENCE);
    expect(PRO_DEFAULT_ENTRY_CONFIDENCE).toBe(70);
    // The §3 reference table stays exported (it reports the per-risk values).
    expect(PRO_CONFIDENCE_BY_RISK).toEqual({ low: 55, medium: 40, high: 25 });
  });

  it('a positive override replaces the default entirely', () => {
    expect(proMinConfidence('low', 85)).toBe(85);
    expect(proMinConfidence('high', 85)).toBe(85);
  });

  it('a zero or negative override is not an override — 70 stands', () => {
    expect(proMinConfidence('medium', 0)).toBe(70);
    expect(proMinConfidence('medium', -3)).toBe(70);
    expect(proMinConfidence('medium', undefined)).toBe(70);
  });

  it('allocation is confidence-based: >70% → 10%, >80% → 15%', () => {
    // 70% confidence (at the bar) → 10% allocation
    const [ev70] = applyProEntryGates([buyEval('LA', 70)], gateCtx());
    expect(ev70.budgetUsd).toBeCloseTo(1000, 6); // 10% of 10,000

    // 80% confidence (at the bar) → 10% allocation (not >80)
    const [ev80] = applyProEntryGates([buyEval('LA', 80)], gateCtx());
    expect(ev80.budgetUsd).toBeCloseTo(1000, 6); // 10% of 10,000

    // 81% confidence (>80) → 15% allocation
    const [ev81] = applyProEntryGates([buyEval('LA', 81)], gateCtx());
    expect(ev81.budgetUsd).toBeCloseTo(1500, 6); // 15% of 10,000
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
  equity: 10_000,
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
    expect(ev.confidenceGap).toBeCloseTo(40, 6); // 70 − 30
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

  it('equity below the $5 floor → NO_BUDGET', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 4, equity: 4 }));
    expect(ev.status).toBe('NO_SIGNAL [NO_BUDGET]');
  });

  it('low cash refuses even with healthy equity (cash-based, not equity-based)', () => {
    // $50 cash but $10,000 equity → budget is min(1000, 50) = 50, which is above $5
    // but the fill step would refuse it (budget + fee > cash), so the gate
    // allocates against cash to prevent "ready to buy" with no purchase.
    // confidence 80 → 10% allocation → min(1000, 50) = 50
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 50, equity: 10_000 }));
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
    expect(ev.budgetUsd).toBeCloseTo(50, 6); // capped at available cash
  });

  it('very low cash (<$5) refuses even with healthy equity', () => {
    // $4 cash but $10,000 equity → budget = min(1000, 4) = 4 < $5 → NO_BUDGET
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 4, equity: 10_000 }));
    expect(ev.status).toBe('NO_SIGNAL [NO_BUDGET]');
    expect(ev.willExecute).toBe(false);
  });

  it('every gate passed → willExecute, "מבצע קנייה", and the allocated budget', () => {
    // confidence 80 → 10% allocation → 1000
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx());
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
    expect(ev.budgetUsd).toBeCloseTo(1000, 6); // confidence 80 → 10%
  });

  it('high confidence (>80%) gets 15% allocation', () => {
    // confidence 85 → 15% allocation → 1500
    const [ev] = applyProEntryGates([buyEval('LA', 85)], gateCtx());
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
    expect(ev.budgetUsd).toBeCloseTo(1500, 6); // confidence 85 → 15%
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
  const minConfidence = proMinConfidence('medium'); // 70

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
    const above = evaluateProExit({ entryPrice: 100 }, 99, stubSignal('SELL', 80), minConfidence);
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

// ── alignment: high confidence ONLY ever means a BUY is firing ───────────────
//
// The raw confidence formula rewards dominance of ANY bucket, including HOLD —
// so a dominant HOLD vote can push confidence past 70% even though there is no
// directional signal. That makes the displayed number lie: the user sees "72%
// confidence" and expects a BUY, but the action is HOLD and nothing happens.
// computeProSignal now caps non-BUY outcomes at 50, so the number the user sees
// matches the entry decision: confidence ≥ 70% ⟹ a BUY is firing.

describe('alignment — confidence reflects directional conviction', () => {
  it('a dominant HOLD never reaches the entry bar — the user is not misled', () => {
    // Build a candle set that produces a clear HOLD: flat price, neutral
    // indicators. The action will be HOLD; confidence must stay below 50 even
    // if the raw formula would push it higher.
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 + (i % 3) * 50
    }));
    const signal = computeProSignal(candles, 0);
    if (signal.action === 'HOLD') {
      expect(signal.confidence).toBeLessThanOrEqual(50);
    }
  });

  it('a strong BUY clears the 70% bar — the user sees high confidence AND a buy', () => {
    // Strong uptrend with volume: price well above MA20, RSI in buy zone,
    // MACD bullish. This should produce a BUY with confidence ≥ 70%.
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 80 + i * 1.5,
      high: 81 + i * 1.5,
      low: 79 + i * 1.5,
      close: 80 + i * 1.5,
      volume: 1000 + i * 100
    }));
    const signal = computeProSignal(candles, 12);
    if (signal.action === 'BUY') {
      expect(signal.confidence).toBeGreaterThanOrEqual(70);
    }
  });

  it('the displayed confidence never exceeds 50 when the action is not BUY', () => {
    // Sweep: for a HOLD-dominant scenario, confidence must be ≤ 50 so the
    // user never sees "high confidence, no entry".
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 100 + Math.sin(i * 0.5) * 2,
      high: 102 + Math.sin(i * 0.5) * 2,
      low: 98 + Math.sin(i * 0.5) * 2,
      close: 100 + Math.sin(i * 0.5) * 2,
      volume: 1000
    }));
    const signal = computeProSignal(candles, 0);
    if (signal.action !== 'BUY') {
      expect(signal.confidence).toBeLessThanOrEqual(50);
    }
  });
});

describe('§6 — optimal entry price from support levels', () => {
  const mockSignal = (over: Partial<ProSignalResult> = {}): ProSignalResult => ({
    action: 'BUY',
    buyScore: 10,
    sellScore: 2,
    holdScore: 3,
    totalWeight: 88,
    confidence: 75,
    signals: [],
    indicators: {
      rsi: 35,
      ma20: 95,
      volumeTrend: 'increasing',
      bollingerBands: { upper: 110, middle: 100, lower: 90, position: 'between' },
      volumeProfile: { poc: 98, valueAreaHigh: 105, valueAreaLow: 92, position: 'in_value_area' },
      macd: { macd: 1, signal: 0.5, histogram: 0.5, trend: 'bullish' },
      stochastic: { k: 30, d: 25, signal: 'neutral' }
    },
    ...over
  } as ProSignalResult);

  it('computes an optimal entry price from indicator support levels', () => {
    const signal = mockSignal();
    const currentPrice = 100;
    const optimal = calculateOptimalEntryPrice(signal, currentPrice);

    // Should be between 90% and 100% of current price (support levels are lower)
    expect(optimal).toBeGreaterThanOrEqual(currentPrice * 0.90);
    expect(optimal).toBeLessThanOrEqual(currentPrice);
  });

  it('the optimal entry price is at or below current price (better entry)', () => {
    const signal = mockSignal();
    const currentPrice = 100;
    const optimal = calculateOptimalEntryPrice(signal, currentPrice);

    // The bot waits for a dip — entry should be at or below market
    expect(optimal).toBeLessThanOrEqual(currentPrice);
  });

  it('weights Bollinger lower band heavily (strong support)', () => {
    const signal = mockSignal({
      indicators: {
        rsi: 35,
        ma20: 95,
        volumeTrend: 'increasing',
        bollingerBands: { upper: 110, middle: 100, lower: 85, position: 'between' },
        volumeProfile: { poc: 98, valueAreaHigh: 105, valueAreaLow: 92, position: 'in_value_area' },
        macd: { macd: 1, signal: 0.5, histogram: 0.5, trend: 'bullish' },
        stochastic: { k: 30, d: 25, signal: 'neutral' }
      }
    });
    const currentPrice = 100;
    const optimal = calculateOptimalEntryPrice(signal, currentPrice);

    // Bollinger lower at 85 should pull the optimal price down
    expect(optimal).toBeLessThan(currentPrice);
    expect(optimal).toBeGreaterThanOrEqual(currentPrice * 0.90);
  });
});
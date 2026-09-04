import { describe, it, expect } from 'vitest';
import {
  routeTradeType,
  dynamicConfidenceThreshold,
  LEGACY_SPOT_BASE_THRESHOLD,
  LEGACY_FUTURES_BASE_THRESHOLD
} from '@cde/engine/execution';
import {
  routeProTradeType,
  proDynamicConfidenceThreshold,
  PRO_SPOT_BASE_THRESHOLD,
  PRO_FUTURES_BASE_THRESHOLD
} from '@cde/engine/analysis';
import type { ProSignalResult, ProMarketRegimeResult } from '@cde/engine/analysis';
import { ProAdapter } from '@cde/engine';
import type { MarketRegimeResult, SignalEngineResult, DecisionContext } from '@cde/engine';

// Three defects these cover, all of the same family — a threshold with two
// definitions that disagree:
//
//   1. Legacy Spot was a hard-coded 58 while Legacy Futures ramped with ATR, so
//      volatility tightened one leg and left the other where it was.
//   2. Legacy Futures used 72 while the routing comment directly above it
//      already documented "base 70".
//   3. Pro routed on rawConfidence while the adapter gated on the post-penalty
//      confidence, and then printed the post-penalty number in the approval
//      string for a decision the raw number had made.

function regime(over: Partial<MarketRegimeResult> = {}): MarketRegimeResult {
  return {
    regime: 'TRENDING',
    volatility: 'NORMAL',
    direction: 'BULL',
    adx: 30,
    atrPercent: 2,
    atr: 100,
    ...over
  } as MarketRegimeResult;
}

function signal(over: Partial<SignalEngineResult> = {}): SignalEngineResult {
  return {
    action: 'BUY',
    signalScore: 65,
    buyScore: 65,
    sellScore: 20,
    confidence: 65,
    signals: [],
    ...over
  } as SignalEngineResult;
}

describe('Test 7 — Legacy Spot threshold is dynamic, not a fixed 58', () => {
  it('sits at the base when volatility is calm', () => {
    // 58 is enough at 2% ATR: below it the score is refused, at it approved.
    const calm = regime({ regime: 'RANGING', adx: 15, atrPercent: 2 });
    expect(routeTradeType(signal({ signalScore: 57, confidence: 57 }), calm).type).toBe('HOLD');
    expect(routeTradeType(signal({ signalScore: 58, confidence: 58 }), calm).type).toBe('SPOT');
  });

  it('rises with ATR — the same 58 no longer clears at 8% ATR', () => {
    const wild = regime({ regime: 'RANGING', adx: 15, atrPercent: 8 });
    // The regression: this used to route SPOT, because 58 was a constant.
    expect(routeTradeType(signal({ signalScore: 58, confidence: 58 }), wild).type).toBe('HOLD');
    // The ramp is +15 by 8% ATR, so 73 is the bar there.
    expect(dynamicConfidenceThreshold(LEGACY_SPOT_BASE_THRESHOLD, 8)).toBe(73);
    expect(routeTradeType(signal({ signalScore: 73, confidence: 73 }), wild).type).toBe('SPOT');
  });

  it('uses the SAME ramp as the Futures leg — one mechanism, two bases', () => {
    for (const atr of [2, 4, 5, 6, 8, 12]) {
      const spread = dynamicConfidenceThreshold(LEGACY_FUTURES_BASE_THRESHOLD, atr)
        - dynamicConfidenceThreshold(LEGACY_SPOT_BASE_THRESHOLD, atr);
      expect(spread).toBeCloseTo(LEGACY_FUTURES_BASE_THRESHOLD - LEGACY_SPOT_BASE_THRESHOLD, 10);
    }
  });
});

describe('Test 8 — Legacy Futures base is 70', () => {
  it('exports 70, not 72', () => {
    expect(LEGACY_FUTURES_BASE_THRESHOLD).toBe(70);
    expect(LEGACY_SPOT_BASE_THRESHOLD).toBe(58);
  });

  it('routes FUTURES at exactly 70 in calm volatility', () => {
    const calm = regime({ atrPercent: 2 });
    expect(routeTradeType(signal({ signalScore: 69, confidence: 69 }), calm).type).not.toBe('FUTURES');
    expect(routeTradeType(signal({ signalScore: 70, confidence: 70 }), calm).type).toBe('FUTURES');
  });

  it('70 is a BASE, not a ceiling: it still ramps to 85 at 8% ATR', () => {
    expect(dynamicConfidenceThreshold(LEGACY_FUTURES_BASE_THRESHOLD, 8)).toBe(85);
  });
});

// ── Pro ──────────────────────────────────────────────────────────────────────

function proRegime(over: Partial<ProMarketRegimeResult> = {}): ProMarketRegimeResult {
  return {
    regime: 'TRENDING',
    direction: 'BULL',
    volatility: 'NORMAL',
    adx: 30,
    atrPercent: 2,
    atr: 100,
    ...over
  } as ProMarketRegimeResult;
}

function proSignal(rawConfidence: number, confidence = rawConfidence): ProSignalResult {
  return {
    action: 'BUY',
    buyScore: rawConfidence,
    sellScore: 10,
    rawConfidence,
    confidence,
    signals: [],
    penalties: []
  };
}

describe('Test 9 — Pro routes on the post-penalty confidence', () => {
  it('blocks a trade whose penalties took it below the Spot bar', () => {
    // raw 74 clears both bars; the penalties leave 55, which clears neither.
    const routed = routeProTradeType(proSignal(74, 55), proRegime());
    expect(routed.type).toBe('HOLD');
    // And the reason quotes the number that was actually compared.
    expect(routed.reason).toContain('55');
    expect(routed.reason).not.toContain('74');
  });

  it('still routes when the penalties leave enough', () => {
    expect(routeProTradeType(proSignal(90, 75), proRegime()).type).toBe('FUTURES');
  });

  it('the approval string quotes the routing number, not a different one', () => {
    const routed = routeProTradeType(proSignal(90, 75), proRegime());
    expect(routed.reason).toContain('confidence 75');
  });

  it('an unpenalised signal is unchanged — this is not a new tax', () => {
    // Backward compatibility: when nothing was withdrawn, confidence ===
    // rawConfidence and every routing decision is exactly what it always was.
    for (const score of [55, 60, 65, 70, 72, 80]) {
      const before = routeProTradeType(proSignal(score), proRegime());
      expect(before.type).toBe(
        score >= proDynamicConfidenceThreshold(PRO_FUTURES_BASE_THRESHOLD, 2) ? 'FUTURES'
          : score >= proDynamicConfidenceThreshold(PRO_SPOT_BASE_THRESHOLD, 2) ? 'SPOT'
            : 'HOLD'
      );
    }
  });

  it('the SOFT_TREND carve-out reads the post-penalty score too', () => {
    // TRANSITIONAL is a hard block unless the trend is soft-confirmed; that
    // carve-out used to be reachable on a raw score the penalties had removed.
    const transitional = proRegime({ regime: 'TRANSITIONAL', adx: 18 });
    const routed = routeProTradeType(proSignal(85, 40), transitional);
    expect(routed.type).toBe('HOLD');
    expect(routed.blockReason).toBe('TRANSITIONAL_HARD_BLOCK');
  });
});

describe('Test 10 — Pro base thresholds are exported and owned by the engine', () => {
  it('exports 60 / 72, matching alg.md', () => {
    expect(PRO_SPOT_BASE_THRESHOLD).toBe(60);
    expect(PRO_FUTURES_BASE_THRESHOLD).toBe(72);
  });

  it('Legacy and Pro are allowed to disagree — but each has ONE definition', () => {
    expect(LEGACY_FUTURES_BASE_THRESHOLD).not.toBe(PRO_FUTURES_BASE_THRESHOLD);
    // What matters is that both ramp through the same function.
    expect(dynamicConfidenceThreshold(70, 6)).toBe(proDynamicConfidenceThreshold(70, 6));
  });
});

// ── Test 10 (continued) — the configuration must actually bite ───────────────
//
// minConfidenceOverride is applied in ProAdapter.normalize(), AFTER the router
// has approved a trade. That placement is what made the §11 mismatch dangerous
// rather than merely untidy: routing said yes on the raw score, and this veto
// said no on the post-penalty one, so the operator saw a signal appear and then
// be refused a stage later under a gate name that explained nothing. With
// routing moved onto the same number, the two now agree by construction and
// this veto only ever raises the bar.

describe('Test 10 — minConfidenceOverride changes trade eligibility', () => {
  const routed = {
    outcome: 'SIGNAL' as const,
    gate: 'COMPLETE',
    logs: [],
    summary: 'ok',
    regime: proRegime(),
    signal: proSignal(90, 75),
    router: { type: 'FUTURES' as const, side: 'LONG' as const, reason: 'ok' },
    risk: undefined
  };
  const ctx = (minConfidenceOverride?: number) =>
    ({ symbol: 'BTC', config: { minConfidenceOverride } }) as unknown as DecisionContext;

  it('lets a 75-confidence signal through when the floor is below it', () => {
    const out = new ProAdapter().normalize(routed, ctx(58));
    expect(out.outcome).toBe('SIGNAL');
    expect(out.confidence).toBe(75);
  });

  it('blocks the SAME signal when the floor is raised above it', () => {
    const out = new ProAdapter().normalize(routed, ctx(80));
    expect(out.outcome).toBe('NO_SIGNAL');
    expect(out.gate).toBe('MIN_CONFIDENCE');
  });

  it('gates on the post-penalty confidence, not the raw score', () => {
    // raw 90, post-penalty 75. A floor of 80 must block: the raw number is not
    // the one on the table.
    expect(new ProAdapter().normalize(routed, ctx(80)).outcome).toBe('NO_SIGNAL');
  });

  it('omitting the override leaves the decision exactly as the engine made it', () => {
    const out = new ProAdapter().normalize(routed, ctx(undefined));
    expect(out.outcome).toBe('SIGNAL');
    expect(out.gate).toBe('COMPLETE');
  });
});

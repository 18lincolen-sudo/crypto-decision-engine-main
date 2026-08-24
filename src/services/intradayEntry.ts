/**
 * Layer C — 5M ENTRY ENGINE (§22/§23/§24)
 * ============================================================================
 * A high SetupScore is NOT an entry. The 5M layer must see an actual trigger:
 *
 *   Pullback  : retrace → holds support → momentum turns → confirmation candle
 *   Breakout  : breakout → volume → retest / continuation
 *   Reversion : oversold → rejection → recovery
 *
 * The engine also refuses to chase: if price is already far beyond the trigger
 * level, the EntryScore is penalised and the trade is skipped.
 */

import { Candle, calculateATR, calculateEMA } from './tradeEngine';
import {
  macd as macdOf,
  rsiSeries,
  bollinger,
  sessionVwap,
  volumeStats,
  marketStructure,
  candleQuality,
  clamp,
  ramp,
  last,
  mean
} from './intradayIndicators';
import { Setup15M } from './intradaySetup';
import { DEFAULT_INTRADAY_PARAMS, EntryTrigger, IntradayParams } from './intradayParams';

export interface Entry5M {
  trigger: EntryTrigger;
  confirmed: boolean;
  entryScore: number;
  strong: boolean;
  /** Number of entry confirmations met (for funnel telemetry) */
  confirmationCount: number;
  entryPrice: number;
  orderType: 'LIMIT' | 'MARKET';
  triggerLevel: number | null;
  stopReference: number;
  targetReference: number | null;
  atr5: number;
  volumeTooLow: boolean;
  indicators: {
    vwap: number;
    vwapDeviationPercent: number;
    rsi: number;
    macdHistogram: number;
    relativeVolume: number;
    ema20: number;
    closePosition: number;
    bodyRatio: number;
  };
  components: {
    triggerQuality: number;
    momentum: number;
    volume: number;
    vwapAlignment: number;
    candle: number;
    chasePenalty: number;
  };
  reasons: string[];
  blockers: string[];
}

function emptyEntry(atr5: number, price: number, blockers: string[]): Entry5M {
  return {
    trigger: 'NONE',
    confirmed: false,
    entryScore: 0,
    strong: false,
    entryPrice: price,
    orderType: 'LIMIT',
    triggerLevel: null,
    stopReference: price,
    targetReference: null,
    atr5,
    volumeTooLow: false,
    indicators: {
      vwap: 0,
      vwapDeviationPercent: 0,
      rsi: 50,
      macdHistogram: 0,
      relativeVolume: 0,
      ema20: price,
      closePosition: 0.5,
      bodyRatio: 0
    },
    components: { triggerQuality: 0, momentum: 0, volume: 0, vwapAlignment: 0, candle: 0, chasePenalty: 0 },
    confirmationCount: 0,
    reasons: [],
    blockers
  };
}

export function confirmEntry5M(
  m5: Candle[],
  setup: Setup15M,
  params: IntradayParams = DEFAULT_INTRADAY_PARAMS
): Entry5M {
  const closes = m5.map((c) => c.close);
  const price = last(closes) ?? 0;
  const bb = bollinger(closes, 20, 2);
  const { atr } = calculateATR(m5, 14);
  const atr5 = atr > 0 ? atr : price * 0.001;

  if (setup.setupType === 'NONE' || setup.direction === 'NONE') {
    return emptyEntry(atr5, price, ['אין Setup פעיל ב-15M']);
  }

  const isLong = setup.direction === 'LONG';
  const s = isLong ? 1 : -1;

  const ema20Series = calculateEMA(closes, 20);
  const ema20 = last(ema20Series) ?? price;
  const rsiAll = rsiSeries(closes, 14);
  const rsi = last(rsiAll) ?? 50;
  const rsiPrev = last(rsiAll, 1) ?? rsi;
  const macd = macdOf(closes, 6, 13, 5);
  const vwap = sessionVwap(m5, atr5);
  const vol = volumeStats(m5, 20);
  const structure5 = marketStructure(m5, 2, 40);
  const q = candleQuality(m5);

  const reasons: string[] = [];
  const blockers: string[] = [];
  const subConditions: boolean[] = [];
  /** Per-setup core + confirmation gate (replaces the old hard-AND of all sub-conditions) */
  let gatesPassed = false;

  let trigger: EntryTrigger = 'NONE';
  let triggerLevel: number | null = null;
  let stopReference = isLong ? price - atr5 : price + atr5;
  let triggerVolumeRelative = vol.relative;

  const momentumTurn = (rsi - rsiPrev) * s > 0 && macd.histogramSlope * s > 0;
  const confirmationCandle = isLong
    ? (q.bullish && q.closePosition >= 0.55) || q.bullishRejection
    : (q.bearish && q.closePosition <= 0.45) || q.bearishRejection;

  if (setup.setupType === 'TREND_PULLBACK') {
    trigger = 'PULLBACK_HOLD';
    // Support/resistance to hold: the nearest structural level on the trade side.
    const candidates = [ema20, vwap.vwap, isLong ? structure5.lastSwingLow ?? -Infinity : structure5.lastSwingHigh ?? Infinity]
      .filter((v) => Number.isFinite(v))
      .filter((v) => (isLong ? v <= price : v >= price));
    const level = candidates.length
      ? isLong
        ? Math.max(...candidates)
        : Math.min(...candidates)
      : price - s * atr5;
    triggerLevel = level;

    const recent = m5.slice(-6);
    const dipExtreme = isLong ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));
    const dipped = isLong ? dipExtreme <= level + 0.3 * atr5 : dipExtreme >= level - 0.3 * atr5;
    const lastCandle = last(m5)!;
    const held = isLong
      ? lastCandle.low >= level - 0.55 * atr5 && lastCandle.close > level
      : lastCandle.high <= level + 0.55 * atr5 && lastCandle.close < level;

    // CORE: pullback into the zone + support/resistance held. CONFIRMATIONS: momentum
    // recovery and/or a confirmation candle. No single one is mandatory.
    const core = dipped && held;
    const confirmations: string[] = [];
    if (momentumTurn) confirmations.push('מומנטום 5M מתהפך (Momentum recovery)');
    if (confirmationCandle) confirmations.push('נר אישור (Confirmation candle)');
    subConditions.push(dipped, held, momentumTurn, confirmationCandle);
    if (!dipped) blockers.push('לא זוהתה נסיגה לאזור הכניסה ב-5M');
    if (!held) blockers.push('התמיכה/התנגדות לא החזיקה בנר הסגור האחרון');
    if (core && confirmations.length === 0) blockers.push('אין אישור מומנטום/נר אישור לכניסה (Confirmation)');
    if (dipped && held) reasons.push('נסיגה שהחזיקה את אזור התמיכה (Pullback + Hold)');
    if (momentumTurn) reasons.push('מומנטום 5M מתהפך לכיוון העסקה');
    gatesPassed = core && confirmations.length >= params.entryConfirmationsMin;

    stopReference = isLong
      ? Math.min(Math.min(...recent.map((c) => c.low)), level)
      : Math.max(Math.max(...recent.map((c) => c.high)), level);
  } else if (setup.setupType === 'BREAKOUT_RETEST') {
    trigger = 'BREAKOUT_RETEST';
    const level = setup.levels.breakoutLevel;
    if (level === null) {
      return emptyEntry(atr5, price, ['אין רמת פריצה מוגדרת מ-15M']);
    }
    triggerLevel = level;

    const window = m5.slice(-10);
    let breakoutIdx = -1;
    for (let i = 0; i < window.length; i++) {
      if ((window[i].close - level) * s > 0) {
        breakoutIdx = i;
        break;
      }
    }
    const brokeOut = breakoutIdx >= 0;
    const baselineVolume = mean(m5.slice(-30, -10).map((c) => c.volume)) || vol.average;
    const breakoutVolume = brokeOut && baselineVolume > 0 ? window[breakoutIdx].volume / baselineVolume : 0;
    triggerVolumeRelative = brokeOut ? breakoutVolume : vol.relative;
    const volumeExpansion = breakoutVolume >= 1.2;

    const afterBreak = brokeOut ? window.slice(breakoutIdx + 1) : [];
    const retestHeld = afterBreak.some((c) =>
      isLong ? c.low <= level + 0.4 * atr5 && c.close > level : c.high >= level - 0.4 * atr5 && c.close < level
    );
    const continuation =
      afterBreak.length >= 1 &&
      (isLong ? price > level : price < level) &&
      (isLong ? q.bullish : q.bearish) &&
      vol.relative >= 0.9;

    // CORE: breakout (closed candle) + volume expansion. CONFIRMATION: retest held
    // OR continuation. No forced confirmation candle.
    const core = brokeOut && volumeExpansion;
    const confirmations: string[] = [];
    if (retestHeld) confirmations.push('Retest של רמת הפריצה החזיק (Retest/hold)');
    if (continuation) confirmations.push('המשכיות מעל רמת הפריצה (Continuation)');
    subConditions.push(brokeOut, volumeExpansion, retestHeld || continuation, confirmationCandle || retestHeld);
    if (!brokeOut) blockers.push('אין פריצה בנר 5M סגור מעל/מתחת לרמה');
    if (!volumeExpansion) blockers.push(`פריצה ללא התרחבות נפח (${breakoutVolume.toFixed(2)}x) — NO TRADE (§18)`);
    if (core && confirmations.length === 0) blockers.push('אין Retest שהחזיק ואין המשכיות מאושרת');
    if (retestHeld) reasons.push('Retest של רמת הפריצה החזיק');
    if (continuation) reasons.push('המשכיות מעל רמת הפריצה');
    gatesPassed = core && confirmations.length >= params.entryConfirmationsMin;

    const sinceBreak = brokeOut ? window.slice(breakoutIdx) : m5.slice(-4);
    stopReference = isLong
      ? Math.min(level - 0.1 * atr5, Math.min(...sinceBreak.map((c) => c.low)))
      : Math.max(level + 0.1 * atr5, Math.max(...sinceBreak.map((c) => c.high)));
  } else {
    trigger = 'REVERSAL_RECOVERY';
    const recent = m5.slice(-6);
    const rsiWindow = rsiAll.slice(-5);
    const extremeRsi = isLong ? Math.min(...rsiWindow) : Math.max(...rsiWindow);
    // "Extreme" is flexible: RSI extreme OR Bollinger %B extreme OR VWAP deviation
    // extreme. We do NOT force a single RSI reading for every trade type.
    const rsiExtreme = isLong ? extremeRsi <= 32 : extremeRsi >= 68;
    const bbExtreme = isLong ? bb.percentB <= 0.12 : bb.percentB >= 0.88;
    const vwapExtreme = Math.abs(vwap.deviationAtr) >= params.meanReversionVwapAtr;
    const oversold = rsiExtreme || bbExtreme || vwapExtreme;

    const rejection = m5.slice(-3).some((_, i, arr) => {
      const idx = m5.length - arr.length + i;
      const slice = m5.slice(0, idx + 1);
      const cq = candleQuality(slice);
      return isLong ? cq.bullishRejection : cq.bearishRejection;
    });
    const recovery = (isLong ? q.bullish : q.bearish) && (rsi - rsiPrev) * s > 0;

    triggerLevel = isLong ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));

    // CORE: extreme + rejection + momentum recovery. CONFIRMATION: a confirmation candle.
    const core = oversold && rejection && recovery;
    const confirmations: string[] = [];
    if (rsiExtreme) confirmations.push('RSI קיצוני');
    else if (bbExtreme) confirmations.push('Bollinger קיצוני');
    else if (vwapExtreme) confirmations.push('VWAP קיצוני');
    if (confirmationCandle) confirmations.push('נר אישור (Confirmation candle)');
    subConditions.push(oversold, rejection, recovery, confirmationCandle);
    if (!oversold) blockers.push('5M לא הגיע לקיצון (RSI/Bollinger/VWAP)');
    if (!rejection) blockers.push('אין דחייה (Rejection) מהקיצון');
    if (!recovery) blockers.push('אין התאוששות מאושרת');
    if (oversold && rejection) reasons.push('קיצון + דחייה זוהו ב-5M');

    stopReference = isLong ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));
    gatesPassed = core;
  }

  // ── Scoring (§24) ──────────────────────────────────────────────────────────
  const triggerQuality = (subConditions.filter(Boolean).length / Math.max(1, subConditions.length)) * 100;
  const momentumScore =
    (((rsi - rsiPrev) * s > 0 ? 1 : 0) * 0.4 + (macd.histogramSlope * s > 0 ? 1 : 0) * 0.4 + (isLong ? (rsi < 78 ? 1 : 0) : rsi > 22 ? 1 : 0) * 0.2) * 100;
  const volumeScore = ramp(triggerVolumeRelative, params.minEntryRelativeVolume, 1.6);
  const vwapAligned = (price - vwap.vwap) * s > 0;
  const vwapScore = vwapAligned ? 100 : Math.abs(vwap.deviationPercent) < 0.1 ? 60 : 20;
  const candleScore = clamp((q.bodyRatio * 60 + (isLong ? q.closePosition : 1 - q.closePosition) * 40) * 100 / 100, 0, 100);

  const beyondLevelAtr = triggerLevel !== null ? ((price - triggerLevel) * s) / atr5 : 0;
  const chasePenalty = beyondLevelAtr > params.maxChaseAtr ? clamp((beyondLevelAtr - params.maxChaseAtr) * 25, 0, 30) : 0;
  if (chasePenalty > 0) blockers.push(`המחיר ${beyondLevelAtr.toFixed(2)} ATR מעל אזור הכניסה — רדיפה, ציון כניסה מופחת`);

  const rawScore =
    triggerQuality * 0.3 + momentumScore * 0.2 + volumeScore * 0.2 + vwapScore * 0.15 + candleScore * 0.15;
  const entryScore = Number(clamp(rawScore - chasePenalty, 0, 100).toFixed(1));

  const volumeTooLow = triggerVolumeRelative < params.minEntryRelativeVolume || vol.drying;
  if (volumeTooLow) blockers.push(`נפח 5M נמוך מדי (${triggerVolumeRelative.toFixed(2)}x) — NO TRADE (§27)`);

  const confirmed = gatesPassed && entryScore >= params.entryScoreMin && !volumeTooLow && chasePenalty === 0;

  if (!confirmed && entryScore < params.entryScoreMin) {
    blockers.push(`EntryScore ${entryScore} מתחת לסף ${params.entryScoreMin}`);
  }

  // Limit price: never on the wrong side of the trigger level, never so far that
  // it can't realistically fill inside the order TTL.
  const offset = params.entryLimitOffsetAtr * atr5;
  let entryPrice = price - s * offset;
  if (triggerLevel !== null) {
    entryPrice = isLong
      ? Math.max(Math.min(entryPrice, price), triggerLevel + 0.02 * atr5)
      : Math.min(Math.max(entryPrice, price), triggerLevel - 0.02 * atr5);
  }
  entryPrice = Number(Math.max(entryPrice, 1e-8).toFixed(8));

  return {
    trigger: confirmed ? trigger : trigger,
    confirmed,
    entryScore,
    strong: entryScore >= params.entryScoreStrong,
    confirmationCount: subConditions.filter(Boolean).length,
    entryPrice,
    orderType: 'LIMIT',
    triggerLevel,
    stopReference,
    targetReference: setup.levels.targetReference,
    atr5,
    volumeTooLow,
    indicators: {
      vwap: vwap.vwap,
      vwapDeviationPercent: vwap.deviationPercent,
      rsi: Number(rsi.toFixed(2)),
      macdHistogram: macd.histogram,
      relativeVolume: Number(triggerVolumeRelative.toFixed(2)),
      ema20,
      closePosition: Number(q.closePosition.toFixed(3)),
      bodyRatio: Number(q.bodyRatio.toFixed(3))
    },
    components: {
      triggerQuality: Number(triggerQuality.toFixed(1)),
      momentum: Number(momentumScore.toFixed(1)),
      volume: Number(volumeScore.toFixed(1)),
      vwapAlignment: Number(vwapScore.toFixed(1)),
      candle: Number(candleScore.toFixed(1)),
      chasePenalty: Number(chasePenalty.toFixed(1))
    },
    reasons,
    blockers
  };
}

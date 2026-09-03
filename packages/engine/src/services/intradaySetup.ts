/**
 * Layer B — 15M SETUP ENGINE (§11, §16-§21)
 * ============================================================================
 * Exactly three setup types are supported:
 *      1. TREND_PULLBACK   (needs an aligned 1H trend)
 *      2. BREAKOUT_RETEST  (needs compression → break → volume)
 *      3. MEAN_REVERSION   (only when 1H = RANGING, spot by default)
 *
 * A setup is NEVER produced from "MACD + EMA + RSI agree". It requires
 * setup type + direction + regime + structure to line up (§21).
 */

import { Candle } from './tradeEngine';
import {
  calculateEMA,
  calculateATR,
  calculateSupertrend,
  macd as macdOf,
  rsiSeries,
  bollinger,
  stochastic,
  sessionVwap,
  volumeStats,
  marketStructure,
  compression as compressionOf,
  last
} from './intradayIndicators';
import { Regime1H } from './intradayRegime';
import { DEFAULT_INTRADAY_PARAMS, Direction, IntradayParams, SetupType } from './intradayParams';
import {
  ScoreContext,
  scoreTrend,
  scoreMomentum,
  scoreLocation,
  scoreParticipation,
  scoreStructure,
  retracementAtr
} from './intradaySetupScores';

export interface SetupScores {
  trend: number;
  momentum: number;
  location: number;
  participation: number;
  structure: number;
}

export interface Setup15M {
  setupType: SetupType;
  direction: Direction;
  scores: SetupScores;
  setupScore: number;
  strong: boolean;
  /** Number of setup candidates that passed their core + confirmation gates */
  candidateCount: number;
  /** Mean reversion never auto-routes to futures (§19) */
  spotOnly: boolean;
  levels: {
    atr: number;
    ema20: number;
    ema50: number;
    vwap: number;
    breakoutLevel: number | null;
    boxHigh: number | null;
    boxLow: number | null;
    swingHigh: number | null;
    swingLow: number | null;
    recentHigh: number;
    recentLow: number;
    targetReference: number | null;
  };
  indicators: {
    rsi: number;
    macdHistogram: number;
    macdDirection: 'BULL' | 'BEAR' | 'FLAT';
    stochK: number;
    stochD: number;
    bbPercentB: number;
    bbBandwidth: number;
    vwapDeviationPercent: number;
    vwapDeviationAtr: number;
    relativeVolume: number;
    compressionPercentile: number;
    structureBias: string;
    retracementAtr: number;
  };
  reasons: string[];
  blockers: string[];
}

interface Candidate {
  setupType: Exclude<SetupType, 'NONE'>;
  direction: Exclude<Direction, 'NONE'>;
  /** Hard prerequisites that must ALL hold (e.g. 1H+15M alignment, breakout+volume) */
  corePassed: boolean;
  /** Soft confirmations (VWAP / Structure / Momentum / Volume / EMA) — need N of them */
  confirmations: string[];
  gatesPassed: boolean;
  blockers: string[];
  reasons: string[];
  breakoutLevel: number | null;
  targetReference: number | null;
}

const EMPTY_SCORES: SetupScores = { trend: 0, momentum: 0, location: 0, participation: 0, structure: 0 };

export function detectSetup15M(
  m15: Candle[],
  regime: Regime1H,
  params: IntradayParams = DEFAULT_INTRADAY_PARAMS
): Setup15M {
  const closes = m15.map((c) => c.close);
  const price = last(closes) ?? 0;
  const { atr } = calculateATR(m15, 14);
  const ema20Series = calculateEMA(closes, 20);
  const ema50Series = calculateEMA(closes, 50);
  const ema20 = last(ema20Series) ?? price;
  const ema50 = last(ema50Series) ?? price;
  const ema20Slope = ema20 - (ema20Series[ema20Series.length - 4] ?? ema20);
  const macd = macdOf(closes);
  const rsiAll = rsiSeries(closes, 14);
  const rsi = last(rsiAll) ?? 50;
  const rsiPrev = last(rsiAll, 1) ?? rsi;
  const bb = bollinger(closes, 20, 2);
  const stoch = stochastic(m15, 14, 3, 3);
  const vwap = sessionVwap(m15, atr);
  const volume = volumeStats(m15, 20);
  const structure = marketStructure(m15, 2, 60);
  const supertrend15 = calculateSupertrend(m15, 10, 3);

  // Consolidation box is measured on the candles BEFORE the last closed candle,
  // so a breakout is judged against a level that existed before the break.
  const priorCompression = compressionOf(m15.slice(0, -1), 12, atr, 120);
  const currentCompression = compressionOf(m15, 12, atr, 120);

  const candidates: Candidate[] = [];
  const globalBlockers: string[] = [];

  // TRANSITIONAL no longer hard-blocks setup generation: it blocks new FUTURES
  // and only allows an especially-quality SPOT setup (enforced in the engine).
  // Here we still generate RANGE-style setups (Breakout / Mean Reversion) so the
  // engine can route them to SPOT when the quality bar is met.

  // ── 1. TREND PULLBACK (§17) ───────────────────────────────────────────────
  // CORE: 1H regime + 15M EMA aligned in the same direction.
  // CONFIRMATIONS (need >= setupConfirmationsMin of 5): VWAP / Structure /
  // Momentum / Volume / EMA-proximity. No single indicator is mandatory.
  if (regime.trending) {
    const direction: Exclude<Direction, 'NONE'> = regime.regime === 'BULL_TREND' ? 'LONG' : 'SHORT';
    const s = direction === 'LONG' ? 1 : -1;
    const blockers: string[] = [];
    const reasons: string[] = [];
    const confirmations: string[] = [];

    const emaAligned15 = (ema20 - ema50) * s > 0; // CORE
    if (!emaAligned15) blockers.push('מגמת 15M לא מיושרת עם 1H (EMA20/50)');

    const retrace = retracementAtr(m15, direction, atr, 10);
    const distFromEmaAtr = Math.abs(price - ema20) / Math.max(atr, 1e-9);
    const pulledBack = retrace >= 0.4 || distFromEmaAtr <= params.pullbackMaxAtrFromEma;
    if (pulledBack) confirmations.push('נסיגה / קירבה ל-EMA20 (Pullback)');

    const structureOk = direction === 'LONG' ? structure.bias !== 'BEARISH' : structure.bias !== 'BULLISH';
    if (structureOk) confirmations.push('מבנה שוק 15M תומך (Structure)');

    const vwapOk = direction === 'LONG' ? vwap.deviationPercent > -0.35 : vwap.deviationPercent < 0.35;
    if (vwapOk) confirmations.push('צד נכון של VWAP');

    const momentumTurn = macd.histogramSlope * s > 0 || (rsi - rsiPrev) * s > 0;
    if (momentumTurn) confirmations.push('היפוך מומנטום (Momentum)');

    const volumeOk = !volume.drying && volume.relative >= 0.7;
    if (volumeOk) confirmations.push('נפח תומך (Volume)');

    if (emaAligned15) reasons.push('מגמת 15M מיושרת עם משטר 1H');
    if (pulledBack) reasons.push(`נסיגה של ${retrace.toFixed(2)} ATR מהשיא/שפל המקומי`);

    const gatesPassed = emaAligned15 && confirmations.length >= params.setupConfirmationsMin;
    if (!gatesPassed && emaAligned15) blockers.push(`אישורים חסרים: ${confirmations.length}/${params.setupConfirmationsMin} (VWAP/Structure/Momentum/Volume/EMA)`);

    candidates.push({
      setupType: 'TREND_PULLBACK',
      direction,
      corePassed: emaAligned15,
      confirmations,
      gatesPassed,
      blockers,
      reasons,
      breakoutLevel: null,
      targetReference: direction === 'LONG' ? structure.recentHigh : structure.recentLow
    });
  }

  // ── 2. BREAKOUT RETEST (§18) ──────────────────────────────────────────────
  // CORE: compression → breakout (closed candle) + volume confirmation.
  // CONFIRMATION: retest/hold OR continuation (need at least one).
  {
    const upLevel = priorCompression.boxHigh;
    const downLevel = priorCompression.boxLow;
    let direction: Exclude<Direction, 'NONE'> | null = null;
    let level = 0;
    if (regime.trending) {
      direction = regime.regime === 'BULL_TREND' ? 'LONG' : 'SHORT';
      level = direction === 'LONG' ? upLevel : downLevel;
    } else if (regime.regime === 'TRANSITIONAL') {
      // Derive direction from the breakout itself (no 1H trend bias available).
      if (price > upLevel) { direction = 'LONG'; level = upLevel; }
      else if (price < downLevel) { direction = 'SHORT'; level = downLevel; }
    }
    if (direction) {
      const s = direction === 'LONG' ? 1 : -1;
      const blockers: string[] = [];
      const reasons: string[] = [];
      const confirmations: string[] = [];

      const brokeOut = level > 0 && (price - level) * s > 0; // CORE
      const volumeOk = volume.relative >= params.breakoutVolumeMin || volume.shortTermRelative >= params.breakoutVolumeMin; // CORE
      if (!brokeOut) blockers.push('אין פריצה של גבול הקונסולידציה בנר סגור');
      if (!volumeOk) blockers.push(`נפח פריצה חלש (${volume.relative.toFixed(2)}x < ${params.breakoutVolumeMin}x) — פריצה ללא נפח (§18)`);

      const window = m15.slice(-10);
      let breakoutIdx = -1;
      for (let i = 0; i < window.length; i++) {
        if ((window[i].close - level) * s > 0) { breakoutIdx = i; break; }
      }
      const afterBreak = breakoutIdx >= 0 ? window.slice(breakoutIdx + 1) : [];
      const retestHeld = afterBreak.some((c) =>
        direction === 'LONG' ? c.low <= level + 0.4 * atr && c.close > level : c.high >= level - 0.4 * atr && c.close < level
      );
      const continuation =
        afterBreak.length >= 1 && (direction === 'LONG' ? price > level : price < level) && volume.relative >= 0.9;
      if (retestHeld) confirmations.push('Retest החזיק (Retest/hold)');
      if (continuation) confirmations.push('המשכיות מעל/מתחת לרמה (Continuation)');

      const vwapOk = direction === 'LONG' ? price >= vwap.vwap : price <= vwap.vwap;
      if (vwapOk) confirmations.push('צד נכון של VWAP');
      const structureOk = direction === 'LONG' ? structure.bias !== 'BEARISH' : structure.bias !== 'BULLISH';
      if (structureOk) confirmations.push('מבנה תומך (Structure)');

      if (priorCompression.isCompressed) reasons.push(`קונסולידציה 15M (range ${priorCompression.rangeAtr} ATR)`);
      if (brokeOut && volumeOk) reasons.push(`פריצה עם נפח ${volume.relative.toFixed(2)}x`);

      const gatesPassed = brokeOut && volumeOk && (retestHeld || continuation);
      if (!gatesPassed && brokeOut && volumeOk) blockers.push('אין Retest שהחזיק ואין המשכיות מאושרת');

      candidates.push({
        setupType: 'BREAKOUT_RETEST',
        direction,
        corePassed: brokeOut && volumeOk,
        confirmations,
        gatesPassed,
        blockers,
        reasons,
        breakoutLevel: level > 0 ? level : null,
        targetReference:
          direction === 'LONG'
            ? Math.max(structure.recentHigh, level + 2 * atr)
            : Math.min(structure.recentLow, level - 2 * atr)
      });
    }
  }

  // ── 3. MEAN REVERSION (§19) — RANGING (or TRANSITIONAL) only, spot by default ─
  // CORE: (VWAP deviation OR Bollinger extreme) AND momentum reversal.
  // Not every metric must be at its extreme simultaneously.
  if (regime.ranging || regime.regime === 'TRANSITIONAL') {
    const longSide = vwap.deviationAtr <= -params.meanReversionVwapAtr || bb.percentB <= 0.2;
    const shortSide = vwap.deviationAtr >= params.meanReversionVwapAtr || bb.percentB >= 0.8;
    const direction: Exclude<Direction, 'NONE'> | null = longSide ? 'LONG' : shortSide ? 'SHORT' : null;

    if (direction) {
      const s = direction === 'LONG' ? 1 : -1;
      const blockers: string[] = [];
      const reasons: string[] = [];
      const confirmations: string[] = [];

      const extreme =
        direction === 'LONG'
          ? vwap.deviationAtr <= -params.meanReversionVwapAtr || bb.percentB <= 0.2
          : vwap.deviationAtr >= params.meanReversionVwapAtr || bb.percentB >= 0.8;
      const momentumReversal = macd.histogramSlope * s > 0 || (direction === 'LONG' ? rsi > rsiPrev : rsi < rsiPrev);

      if (extreme) confirmations.push('סטייה מ-VWAP או קצה Bollinger (Extreme)');
      if (momentumReversal) confirmations.push('היפוך מומנטום (Momentum reversal)');
      const structureOk = direction === 'LONG' ? structure.bias !== 'BEARISH' : structure.bias !== 'BULLISH';
      if (structureOk) confirmations.push('מבנה לא נגד (Structure)');

      reasons.push(`מחיר ${Math.abs(vwap.deviationAtr).toFixed(2)} ATR מ-VWAP${regime.ranging ? ' בשוק דשדוש' : ' (TRANSITIONAL)'}`);
      if (momentumReversal) reasons.push('היפוך מומנטום התחיל');

      const gatesPassed = extreme && momentumReversal;
      if (!gatesPassed) blockers.push('חסר קיצון (VWAP/BB) או היפוך מומנטום — אין Mean Reversion');

      candidates.push({
        setupType: 'MEAN_REVERSION',
        direction,
        corePassed: extreme && momentumReversal,
        confirmations,
        gatesPassed,
        blockers,
        reasons,
        breakoutLevel: null,
        targetReference: vwap.vwap
      });
    } else {
      globalBlockers.push('שוק דשדוש/מעברי אך המחיר לא מרוחק מ-VWAP ולא בקצה Bollinger — אין Mean Reversion');
    }
  }

  const baseLevels = {
    atr,
    ema20,
    ema50,
    vwap: vwap.vwap,
    breakoutLevel: null as number | null,
    boxHigh: priorCompression.boxHigh || null,
    boxLow: priorCompression.boxLow || null,
    swingHigh: structure.lastSwingHigh,
    swingLow: structure.lastSwingLow,
    recentHigh: structure.recentHigh,
    recentLow: structure.recentLow,
    targetReference: null as number | null
  };

  const baseIndicators = {
    rsi: Number(rsi.toFixed(2)),
    macdHistogram: macd.histogram,
    macdDirection: macd.direction,
    stochK: Number(stoch.k.toFixed(2)),
    stochD: Number(stoch.d.toFixed(2)),
    bbPercentB: Number(bb.percentB.toFixed(3)),
    bbBandwidth: Number(bb.bandwidth.toFixed(5)),
    vwapDeviationPercent: vwap.deviationPercent,
    vwapDeviationAtr: Number(vwap.deviationAtr.toFixed(2)),
    relativeVolume: Number(volume.relative.toFixed(2)),
    compressionPercentile: currentCompression.bandwidthPercentile,
    structureBias: structure.bias,
    retracementAtr: 0
  };

  // ── Score every gate-passing candidate and keep the best ───────────────────
  let best: { candidate: Candidate; scores: SetupScores; score: number } | null = null;
  const evaluated: { candidate: Candidate; score: number }[] = [];

  for (const candidate of candidates) {
    if (!candidate.gatesPassed) continue;
    const ctx: ScoreContext = {
      direction: candidate.direction,
      setupType: candidate.setupType,
      candles: m15,
      price,
      atr,
      ema20,
      ema50,
      ema20Slope,
      macd,
      rsi,
      rsiPrev,
      bb,
      stoch,
      vwap,
      volume,
      structure,
      compression: priorCompression,
      regimeAlignment:
        candidate.setupType === 'MEAN_REVERSION'
          ? regime.ranging
            ? 1
            : 0.3
          : regime.bias === candidate.direction
          ? 1
          : 0,
      breakoutLevel: candidate.breakoutLevel
    };

    const scores: SetupScores = {
      trend: Number(scoreTrend(ctx).toFixed(1)),
      momentum: Number(scoreMomentum(ctx).toFixed(1)),
      location: Number(scoreLocation(ctx).toFixed(1)),
      participation: Number(scoreParticipation(ctx).toFixed(1)),
      structure: Number(scoreStructure(ctx).toFixed(1))
    };
    const w = params.setupWeights;
    const score = Number(
      (
        scores.trend * w.trend +
        scores.momentum * w.momentum +
        scores.location * w.location +
        scores.participation * w.participation +
        scores.structure * w.structure
      ).toFixed(1)
    );

    // Supertrend on 15M is a tie-breaker note, not an independent vote.
    if (
      (candidate.direction === 'LONG' && supertrend15.direction === 'BULL') ||
      (candidate.direction === 'SHORT' && supertrend15.direction === 'BEAR')
    ) {
      candidate.reasons.push(`Supertrend 15M תומך (${supertrend15.direction})`);
    }

    evaluated.push({ candidate, score });
    if (!best || score > best.score) best = { candidate, scores, score };
  }

  if (!best) {
    const blockers = [
      ...globalBlockers,
      ...candidates.filter((c) => !c.gatesPassed).flatMap((c) => c.blockers.map((b) => `${c.setupType}: ${b}`))
    ];
    return {
      setupType: 'NONE',
      direction: 'NONE',
      scores: EMPTY_SCORES,
      setupScore: 0,
      strong: false,
      candidateCount: 0,
      spotOnly: false,
      levels: baseLevels,
      indicators: { ...baseIndicators, retracementAtr: 0 },
      reasons: [],
      blockers: blockers.length ? blockers : ['לא זוהה Setup תקף ב-15M']
    };
  }

  const passesScore = best.score >= params.setupScoreMin;
  const blockers = passesScore
    ? []
    : [`SetupScore ${best.score} מתחת לסף ${params.setupScoreMin} (${best.candidate.setupType})`];

  return {
    setupType: passesScore ? best.candidate.setupType : 'NONE',
    direction: passesScore ? best.candidate.direction : 'NONE',
    scores: best.scores,
    setupScore: best.score,
    strong: best.score >= params.setupScoreStrong,
    candidateCount: candidates.filter((c) => c.gatesPassed).length,
    spotOnly: best.candidate.setupType === 'MEAN_REVERSION',
    levels: {
      ...baseLevels,
      breakoutLevel: best.candidate.breakoutLevel,
      targetReference: best.candidate.targetReference
    },
    indicators: {
      ...baseIndicators,
      retracementAtr: Number(retracementAtr(m15, best.candidate.direction, atr, 10).toFixed(2))
    },
    reasons: best.candidate.reasons,
    blockers
  };
}

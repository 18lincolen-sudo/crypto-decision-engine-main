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

  if (regime.regime === 'TRANSITIONAL') {
    globalBlockers.push('משטר 1H מעברי (TRANSITIONAL) — לא נפתחים Setups חדשים (§8/§34)');
  }

  // ── 1. TREND PULLBACK (§17) ───────────────────────────────────────────────
  if (regime.trending) {
    const direction: Exclude<Direction, 'NONE'> = regime.regime === 'BULL_TREND' ? 'LONG' : 'SHORT';
    const s = direction === 'LONG' ? 1 : -1;
    const blockers: string[] = [];
    const reasons: string[] = [];

    const emaAligned15 = (ema20 - ema50) * s > 0;
    if (!emaAligned15) blockers.push('מגמת 15M לא מיושרת עם 1H (EMA20/50)');

    const retrace = retracementAtr(m15, direction, atr, 10);
    const distFromEmaAtr = Math.abs(price - ema20) / Math.max(atr, 1e-9);
    const pulledBack = retrace >= 0.4 || distFromEmaAtr <= 0.7;
    if (!pulledBack) blockers.push('אין נסיגה — המחיר מורחק מהממוצע ללא Pullback (אין רדיפה אחרי מהלך)');
    if (distFromEmaAtr > params.pullbackMaxAtrFromEma) {
      blockers.push(`מרחק ${distFromEmaAtr.toFixed(2)} ATR מ-EMA20 מעל המותר (${params.pullbackMaxAtrFromEma})`);
    }

    const structureOk = direction === 'LONG' ? structure.bias !== 'BEARISH' : structure.bias !== 'BULLISH';
    if (!structureOk) blockers.push('מבנה שוק 15M נגד כיוון העסקה');

    const vwapOk = direction === 'LONG' ? vwap.deviationPercent > -0.35 : vwap.deviationPercent < 0.35;
    if (!vwapOk) blockers.push(`מחיר בצד הלא נכון של VWAP (${vwap.deviationPercent.toFixed(2)}%)`);

    if (emaAligned15) reasons.push('מגמת 15M מיושרת עם משטר 1H');
    if (pulledBack) reasons.push(`נסיגה של ${retrace.toFixed(2)} ATR מהשיא/שפל המקומי`);

    candidates.push({
      setupType: 'TREND_PULLBACK',
      direction,
      gatesPassed: blockers.length === 0,
      blockers,
      reasons,
      breakoutLevel: null,
      targetReference: direction === 'LONG' ? structure.recentHigh : structure.recentLow
    });
  }

  // ── 2. BREAKOUT RETEST (§18) ──────────────────────────────────────────────
  if (regime.trending) {
    const direction: Exclude<Direction, 'NONE'> = regime.regime === 'BULL_TREND' ? 'LONG' : 'SHORT';
    const s = direction === 'LONG' ? 1 : -1;
    const blockers: string[] = [];
    const reasons: string[] = [];
    const level = direction === 'LONG' ? priorCompression.boxHigh : priorCompression.boxLow;

    if (!priorCompression.isCompressed) {
      blockers.push(`אין דחיסה/קונסולידציה לפני הפריצה (bandwidth pct ${priorCompression.bandwidthPercentile})`);
    }
    const brokeOut = level > 0 && (price - level) * s > 0;
    if (!brokeOut) blockers.push('אין פריצה של גבול הקונסולידציה בנר סגור');

    const volumeOk = volume.relative >= params.breakoutVolumeMin || volume.shortTermRelative >= params.breakoutVolumeMin;
    if (!volumeOk) blockers.push(`נפח פריצה חלש (${volume.relative.toFixed(2)}x < ${params.breakoutVolumeMin}x) — פריצה ללא נפח נפסלת (§18)`);

    const vwapOk = direction === 'LONG' ? price >= vwap.vwap : price <= vwap.vwap;
    if (!vwapOk) blockers.push('פריצה בצד הלא נכון של VWAP — נפסל (§18)');

    const beyondAtr = level > 0 ? ((price - level) * s) / Math.max(atr, 1e-9) : 99;
    if (beyondAtr > 2.0) blockers.push(`המחיר כבר ${beyondAtr.toFixed(2)} ATR מעל רמת הפריצה — רדיפה, ממתינים ל-Retest`);

    if (priorCompression.isCompressed) reasons.push(`קונסולידציה 15M (range ${priorCompression.rangeAtr} ATR)`);
    if (brokeOut && volumeOk) reasons.push(`פריצה עם נפח ${volume.relative.toFixed(2)}x`);

    candidates.push({
      setupType: 'BREAKOUT_RETEST',
      direction,
      gatesPassed: blockers.length === 0,
      blockers,
      reasons,
      breakoutLevel: level > 0 ? level : null,
      targetReference:
        direction === 'LONG'
          ? Math.max(structure.recentHigh, level + 2 * atr)
          : Math.min(structure.recentLow, level - 2 * atr)
    });
  }

  // ── 3. MEAN REVERSION (§19) — RANGING only, spot by default ───────────────
  if (regime.ranging) {
    const longSide = vwap.deviationAtr <= -params.meanReversionVwapAtr && rsi <= params.meanReversionRsiMax;
    const shortSide = vwap.deviationAtr >= params.meanReversionVwapAtr && rsi >= params.meanReversionRsiMin;
    const direction: Exclude<Direction, 'NONE'> | null = longSide ? 'LONG' : shortSide ? 'SHORT' : null;

    if (direction) {
      const s = direction === 'LONG' ? 1 : -1;
      const blockers: string[] = [];
      const reasons: string[] = [];

      const percentB = direction === 'LONG' ? bb.percentB : 1 - bb.percentB;
      if (percentB > 0.2) blockers.push('המחיר לא בקרבת/מעבר לרצועת Bollinger הרלוונטית');

      const momentumReversal = macd.histogramSlope * s > 0 || (direction === 'LONG' ? rsi > rsiPrev : rsi < rsiPrev);
      if (!momentumReversal) blockers.push('אין היפוך מומנטום — ממתינים לאישור');

      const strongBreakdown =
        (direction === 'LONG' && structure.breakOfStructure === 'DOWN' && volume.relative > 1.8) ||
        (direction === 'SHORT' && structure.breakOfStructure === 'UP' && volume.relative > 1.8);
      if (strongBreakdown) blockers.push('שבירת מבנה חזקה נגד הכיוון עם נפח — לא Mean Reversion');

      reasons.push(`מחיר ${Math.abs(vwap.deviationAtr).toFixed(2)} ATR מ-VWAP בשוק דשדוש`);
      if (momentumReversal) reasons.push('היפוך מומנטום התחיל');

      candidates.push({
        setupType: 'MEAN_REVERSION',
        direction,
        gatesPassed: blockers.length === 0,
        blockers,
        reasons,
        breakoutLevel: null,
        targetReference: vwap.vwap
      });
    } else {
      globalBlockers.push('שוק דשדוש אך המחיר לא מרוחק מ-VWAP / RSI לא בקצה — אין Mean Reversion');
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

/**
 * Setup Scoring — grouped, capped contributions (§11/§12/§20)
 * ============================================================================
 * Each group returns 0..100. Groups are averaged over their own components so a
 * single group can never dominate the SetupScore just because four correlated
 * indicators agree (§12: "limit the contribution of the Trend group").
 */

import { Candle } from './tradeEngine';
import {
  MacdResult,
  BollingerResult,
  StochasticResult,
  VwapResult,
  VolumeStats,
  MarketStructureResult,
  CompressionResult,
  candleQuality,
  clamp,
  ramp,
  last
} from './intradayIndicators';
import { Direction, SetupType } from './intradayParams';

export interface ScoreContext {
  direction: Exclude<Direction, 'NONE'>;
  setupType: Exclude<SetupType, 'NONE'>;
  candles: Candle[];
  price: number;
  atr: number;
  ema20: number;
  ema50: number;
  ema20Slope: number;
  macd: MacdResult;
  rsi: number;
  rsiPrev: number;
  bb: BollingerResult;
  stoch: StochasticResult;
  vwap: VwapResult;
  volume: VolumeStats;
  structure: MarketStructureResult;
  compression: CompressionResult;
  /** Regime alignment: 1 = 1H agrees, 0.6 = neutral (ranging), 0 = conflicts */
  regimeAlignment: number;
  breakoutLevel: number | null;
}

const avg = (parts: number[]): number => (parts.length ? clamp(parts.reduce((a, b) => a + b, 0) / parts.length, 0, 1) * 100 : 0);

/** Signed helper: positive = favourable for the trade direction */
function dirSign(direction: Exclude<Direction, 'NONE'>): number {
  return direction === 'LONG' ? 1 : -1;
}

// ── Trend group (weight 25%) ────────────────────────────────────────────────
export function scoreTrend(ctx: ScoreContext): number {
  const s = dirSign(ctx.direction);
  const emaAligned = (ctx.ema20 - ctx.ema50) * s > 0;
  const emaSlopeOk = ctx.ema20Slope * s > 0;
  const macdAligned = (ctx.macd.macd - ctx.macd.signal) * s > 0;
  const structureAligned =
    ctx.direction === 'LONG' ? ctx.structure.bias !== 'BEARISH' : ctx.structure.bias !== 'BULLISH';

  if (ctx.setupType === 'MEAN_REVERSION') {
    // In a range, "trend" means: no strong trend fighting the reversion.
    return avg([
      ctx.structure.bias === 'RANGE' ? 1 : 0.4,
      Math.abs(ctx.ema20 - ctx.ema50) / Math.max(ctx.atr, 1e-9) < 1.2 ? 1 : 0.3,
      ctx.regimeAlignment,
      structureAligned ? 0.8 : 0.3
    ]);
  }

  return avg([
    emaAligned ? (emaSlopeOk ? 1 : 0.6) : 0,
    macdAligned ? 1 : 0.2,
    structureAligned ? 1 : 0,
    ctx.regimeAlignment
  ]);
}

// ── Momentum group (weight 20%) — acceleration / recovery / failure (§13) ────
export function scoreMomentum(ctx: ScoreContext): number {
  const s = dirSign(ctx.direction);
  const accelerating = ctx.macd.histogramSlope * s > 0;
  const rsiRising = (ctx.rsi - ctx.rsiPrev) * s > 0;
  const rsiForLong = ctx.direction === 'LONG' ? ctx.rsi : 100 - ctx.rsi;
  const stochK = ctx.direction === 'LONG' ? ctx.stoch.k : 100 - ctx.stoch.k;
  const stochTurning = ctx.direction === 'LONG' ? ctx.stoch.crossUp || ctx.stoch.k > ctx.stoch.prevK : ctx.stoch.crossDown || ctx.stoch.k < ctx.stoch.prevK;

  if (ctx.setupType === 'MEAN_REVERSION') {
    // Reversion needs an exhausted move that has just started to turn.
    return avg([
      rsiForLong <= 35 ? 1 : rsiForLong <= 42 ? 0.6 : 0.1,
      rsiRising ? 1 : 0.2,
      stochK <= 25 && stochTurning ? 1 : stochTurning ? 0.6 : 0.1,
      accelerating ? 0.9 : 0.3
    ]);
  }

  // Momentum failure guard: price direction and momentum disagree → weak setup.
  const failing = !accelerating && !rsiRising;
  if (failing) return avg([0.15, 0.15, stochTurning ? 0.4 : 0.1, 0.2]);

  const recovery = rsiForLong >= 40 && rsiForLong <= 68 ? 1 : rsiForLong > 68 ? 0.35 : rsiRising ? 0.65 : 0.2;

  return avg([
    accelerating ? 1 : 0.35,
    recovery,
    stochTurning && stochK < 82 ? 1 : 0.35,
    ctx.macd.histogram * s > 0 ? 1 : 0.4
  ]);
}

// ── Location group (weight 20%) — VWAP + bands + distance from value (§14) ──
export function scoreLocation(ctx: ScoreContext): number {
  const s = dirSign(ctx.direction);
  const atr = Math.max(ctx.atr, 1e-9);
  const vwapSideScore = ctx.vwap.deviationAtr * s > 0 ? 1 : Math.abs(ctx.vwap.deviationPercent) < 0.15 ? 0.6 : 0.15;
  const distVwapAtr = Math.abs(ctx.vwap.deviationAtr);
  const distEmaAtr = Math.abs(ctx.price - ctx.ema20) / atr;
  const percentB = ctx.direction === 'LONG' ? ctx.bb.percentB : 1 - ctx.bb.percentB;

  if (ctx.setupType === 'MEAN_REVERSION') {
    return avg([
      ctx.vwap.deviationAtr * s < 0 ? 1 : 0.1, // price on the far side of VWAP
      ramp(distVwapAtr, 0.6, 1.8) / 100,
      percentB <= 0.12 ? 1 : percentB <= 0.25 ? 0.6 : 0.1,
      distEmaAtr >= 0.8 ? 1 : 0.4
    ]);
  }

  if (ctx.setupType === 'BREAKOUT_RETEST') {
    const beyondLevelAtr = ctx.breakoutLevel ? ((ctx.price - ctx.breakoutLevel) * s) / atr : 0;
    return avg([
      vwapSideScore,
      beyondLevelAtr > 0 ? (beyondLevelAtr <= 1.0 ? 1 : beyondLevelAtr <= 2 ? 0.5 : 0.1) : 0.2,
      percentB >= 0.6 ? 1 : percentB >= 0.45 ? 0.6 : 0.2,
      distEmaAtr <= 2.2 ? 1 : 0.3
    ]);
  }

  // TREND_PULLBACK: we want price back near value, not extended.
  return avg([
    vwapSideScore,
    distVwapAtr <= 1.0 ? 1 : distVwapAtr <= 2.0 ? 0.55 : 0.15,
    percentB >= 0.3 && percentB <= 0.78 ? 1 : percentB > 0.95 ? 0.15 : 0.5,
    distEmaAtr <= 0.8 ? 1 : distEmaAtr <= 1.4 ? 0.6 : 0.15
  ]);
}

// ── Participation group (weight 15%) — volume quality (§27) ─────────────────
export function scoreParticipation(ctx: ScoreContext): number {
  const rel = ctx.volume.relative;
  const shortTerm = ctx.volume.shortTermRelative;
  const q = candleQuality(ctx.candles);
  const directionalVolume = ctx.direction === 'LONG' ? q.bullish : q.bearish;

  if (ctx.setupType === 'BREAKOUT_RETEST') {
    return avg([
      ramp(rel, 1.0, 1.8) / 100,
      ramp(shortTerm, 0.9, 1.5) / 100,
      directionalVolume ? 1 : 0.3,
      ctx.volume.drying ? 0 : 1
    ]);
  }

  if (ctx.setupType === 'MEAN_REVERSION') {
    // Reversion wants exhaustion volume, but not a violent breakdown against us.
    const violentAgainst = rel > 2.5 && !directionalVolume;
    return avg([
      ramp(rel, 0.6, 1.4) / 100,
      violentAgainst ? 0 : 1,
      ctx.volume.drying ? 0.3 : 1,
      directionalVolume ? 1 : 0.5
    ]);
  }

  return avg([
    ramp(rel, 0.7, 1.5) / 100,
    ramp(shortTerm, 0.7, 1.3) / 100,
    directionalVolume ? 1 : 0.35,
    ctx.volume.drying ? 0.1 : 1
  ]);
}

// ── Structure group (weight 20%) — market structure beats indicators (§15) ──
export function scoreStructure(ctx: ScoreContext): number {
  const s = dirSign(ctx.direction);
  const atr = Math.max(ctx.atr, 1e-9);
  const st = ctx.structure;
  const biasAligned = ctx.direction === 'LONG' ? st.bias === 'BULLISH' : st.bias === 'BEARISH';
  const swingsAligned = ctx.direction === 'LONG' ? st.higherLow : st.lowerHigh;
  const extremeAligned = ctx.direction === 'LONG' ? st.higherHigh : st.lowerLow;
  const bosAligned = ctx.direction === 'LONG' ? st.breakOfStructure === 'UP' : st.breakOfStructure === 'DOWN';
  const bosAgainst = ctx.direction === 'LONG' ? st.breakOfStructure === 'DOWN' : st.breakOfStructure === 'UP';

  const roomAtr = ctx.direction === 'LONG' ? (st.recentHigh - ctx.price) / atr : (ctx.price - st.recentLow) / atr;

  if (ctx.setupType === 'MEAN_REVERSION') {
    const roomToVwapAtr = Math.abs(ctx.vwap.vwap - ctx.price) / atr;
    return avg([
      st.bias === 'RANGE' ? 1 : biasAligned ? 0.7 : 0.25,
      bosAgainst ? 0 : 1,
      ramp(roomToVwapAtr, 0.5, 1.5) / 100,
      ctx.direction === 'LONG' ? (st.rangePosition <= 0.25 ? 1 : 0.3) : st.rangePosition >= 0.75 ? 1 : 0.3
    ]);
  }

  if (ctx.setupType === 'BREAKOUT_RETEST') {
    return avg([
      biasAligned ? 1 : st.bias === 'RANGE' ? 0.7 : 0.2,
      bosAligned ? 1 : 0.4,
      bosAgainst ? 0 : 1,
      ramp(roomAtr, 0.4, 1.6) / 100
    ]);
  }

  return avg([
    biasAligned ? 1 : st.bias === 'RANGE' ? 0.5 : 0,
    swingsAligned ? 1 : 0.3,
    extremeAligned ? 1 : 0.5,
    ramp(roomAtr, 0.8, 2.0) / 100
  ]);
}

/** Distance (in ATR) the last N candles retraced from the extreme — pullback proof */
export function retracementAtr(candles: Candle[], direction: Exclude<Direction, 'NONE'>, atr: number, lookback = 10): number {
  const win = candles.slice(-lookback);
  if (!win.length || atr <= 0) return 0;
  const price = last(win)!.close;
  if (direction === 'LONG') {
    const high = Math.max(...win.map((c) => c.high));
    return (high - price) / atr;
  }
  const low = Math.min(...win.map((c) => c.low));
  return (price - low) / atr;
}

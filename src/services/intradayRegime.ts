/**
 * Layer A — 1H MARKET REGIME (§8/§9/§10)
 * ============================================================================
 * The hourly timeframe decides WHAT KIND of market we are in. Nothing below it
 * is allowed to open a trade the regime does not support.
 *
 *   EMA20 > EMA50  AND  ADX > 25  AND  Supertrend = BULL   → BULL TREND
 *   EMA20 < EMA50  AND  ADX > 25  AND  Supertrend = BEAR   → BEAR TREND
 *   ADX < 20                                               → RANGING
 *   otherwise (incl. ADX <= 25 without alignment)          → TRANSITIONAL
 *
 * Volatility is graded against the asset's OWN ATR distribution, not a flat 5%.
 */

import { Candle } from './tradeEngine';
import {
  calculateEMA,
  calculateADX,
  calculateSupertrend,
  atrRegime,
  marketStructure,
  MarketStructureResult,
  VolatilityBucket,
  last
} from './intradayIndicators';
import { IntradayParams, Regime1HType, Direction, DEFAULT_INTRADAY_PARAMS } from './intradayParams';

export interface Regime1H {
  regime: Regime1HType;
  /** Directional bias implied by the regime */
  bias: Direction;
  ema20: number;
  ema50: number;
  adx: number;
  supertrend: { value: number; direction: 'BULL' | 'BEAR' };
  atr: number;
  atrPercent: number;
  atrPercentile: number;
  volatility: VolatilityBucket;
  structure: MarketStructureResult;
  price: number;
  /** Futures are only allowed in a real trend with acceptable volatility (§34) */
  futuresAllowed: boolean;
  /** EXTREME volatility → spot must clear a strictly higher bar (§10) */
  strictMode: boolean;
  trending: boolean;
  ranging: boolean;
  notes: string[];
}

export function detectRegime1H(h1: Candle[], params: IntradayParams = DEFAULT_INTRADAY_PARAMS): Regime1H {
  const closes = h1.map((c) => c.close);
  const price = last(closes) ?? 0;

  const ema20Series = calculateEMA(closes, 20);
  const ema50Series = calculateEMA(closes, 50);
  const ema20 = last(ema20Series) ?? price;
  const ema50 = last(ema50Series) ?? price;
  const adx = calculateADX(h1, 14);
  const supertrend = calculateSupertrend(h1, 10, 3);
  const atr = atrRegime(h1, 14, params.atrPercentileLookback, {
    low: params.atrPercentileLow,
    high: params.atrPercentileHigh,
    extreme: params.atrPercentileExtreme
  });
  const structure = marketStructure(h1, 2, 60);

  const notes: string[] = [];
  let regime: Regime1HType;

  if (adx > params.adxTrendMin && ema20 > ema50 && supertrend.direction === 'BULL') {
    regime = 'BULL_TREND';
  } else if (adx > params.adxTrendMin && ema20 < ema50 && supertrend.direction === 'BEAR') {
    regime = 'BEAR_TREND';
  } else if (adx < params.adxRangeMax) {
    regime = 'RANGING';
  } else {
    regime = 'TRANSITIONAL';
    notes.push(
      `ADX ${adx.toFixed(1)} ללא יישור EMA/Supertrend — משטר מעבר, לא נחשב מגמה (§8)`
    );
  }

  const trending = regime === 'BULL_TREND' || regime === 'BEAR_TREND';
  const ranging = regime === 'RANGING';
  const bias: Direction = regime === 'BULL_TREND' ? 'LONG' : regime === 'BEAR_TREND' ? 'SHORT' : 'NONE';

  const strictMode = atr.bucket === 'EXTREME';
  const futuresAllowed = trending && atr.bucket !== 'HIGH' && atr.bucket !== 'EXTREME';

  if (atr.bucket === 'EXTREME') {
    notes.push(`ATR percentile ${atr.atrPercentile} >= ${params.atrPercentileExtreme} — Futures חסום, Spot במצב מחמיר (§10)`);
  } else if (atr.bucket === 'HIGH') {
    notes.push(`ATR percentile ${atr.atrPercentile} > ${params.atrPercentileHigh} — תנודתיות גבוהה, Futures חסום (§34)`);
  } else if (atr.bucket === 'LOW') {
    notes.push(`ATR percentile ${atr.atrPercentile} < ${params.atrPercentileLow} — תנודתיות נמוכה ביחס לנכס עצמו`);
  }

  if (ranging) notes.push(`ADX ${adx.toFixed(1)} < ${params.adxRangeMax} — שוק דשדוש, אין Trend-Following (§8)`);

  return {
    regime,
    bias,
    ema20,
    ema50,
    adx,
    supertrend: { value: supertrend.value, direction: supertrend.direction },
    atr: atr.atr,
    atrPercent: atr.atrPercent,
    atrPercentile: atr.atrPercentile,
    volatility: atr.bucket,
    structure,
    price,
    futuresAllowed,
    strictMode,
    trending,
    ranging,
    notes
  };
}

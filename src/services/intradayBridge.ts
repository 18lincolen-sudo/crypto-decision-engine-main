/**
 * Intraday Bridge — adapter between the legacy simulation/live clients and the
 * new Intraday MTF engine (§8-§47).
 * ============================================================================
 * The legacy clients (useSimulationBot, simEngine, tradingWorker) used the old
 * single-timeframe tradeEngine (detectMarketRegime / evaluateSignals /
 * routeTradeType / calculateRiskParameters / evaluateExit). This module is the
 * single seam that maps their state into `evaluateIntradayDecision` /
 * `evaluateIntradayExit` and back into the UI-facing `SignalEvaluation` shape.
 *
 * Nothing here changes decision logic — it only translates data in and out.
 */

import { Candle, PortfolioRiskStats, calculateATR } from './tradeEngine';
import {
  evaluateIntradayDecision,
  IntradayDecision,
  TradeType
} from './intradayEngine';
import {
  evaluateIntradayExit,
  IntradayPositionView,
  IntradayExitContext,
  IntradayExitDecision
} from './intradayExit';
import { DEFAULT_INTRADAY_PARAMS, IntradayParams, Direction, SetupType } from './intradayParams';
import {
  getUniverseMarketData,
  getMultiTimeframeData,
  MultiTimeframeSnapshot,
  MarketDataStats
} from './marketDataService';
import { toBybitSymbol } from './assetUniverse';
import {
  MarketRegimeResult,
  MarketRegimeType,
  MarketDirectionType,
  VolatilityRegimeType
} from '../types/crypto';
import { Regime1H } from './intradayRegime';

export type { MultiTimeframeSnapshot } from './marketDataService';

export interface DecisionFactor {
  label: string;
  value: string;
  impact: 'positive' | 'negative' | 'neutral';
  note: string;
}

export interface SignalEvaluation {
  symbol: string;
  action: 'buy' | 'sell' | 'hold';
  tradeType: 'SPOT' | 'FUTURES' | 'HOLD';
  tradeSide: 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE';
  confidence: number;
  price: number;
  priceChange24h: number;
  reasoning: string;
  status: string;
  willExecute: boolean;
  factors: DecisionFactor[];
  confidenceGap: number;
  riskLevel?: 'low' | 'medium' | 'high';
  timeframe?: 'short' | 'medium' | 'long';
  regime?: MarketRegimeResult;
  leverage?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  /** Raw engine decision — used by the order generator for exact levels */
  decision?: IntradayDecision;
}

export interface PortfolioInput {
  portfolioValue: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  openPositionsCount: number;
  openFuturesPositionsCount: number;
  totalLeveragedExposureUsd: number;
  systemLocked?: boolean;
  lockReason?: string;
  lockedAt?: number;
}

export function buildPortfolioRiskStats(p: PortfolioInput): PortfolioRiskStats {
  return {
    portfolioValue: p.portfolioValue,
    initialAmount: p.initialAmount,
    dailyDrawdownPercent: p.dailyDrawdownPercent,
    weeklyDrawdownPercent: p.weeklyDrawdownPercent,
    openPositionsCount: p.openPositionsCount,
    openFuturesPositionsCount: p.openFuturesPositionsCount,
    totalLeveragedExposureUsd: p.totalLeveragedExposureUsd,
    systemLocked: p.systemLocked,
    lockReason: p.lockReason,
    lockedAt: p.lockedAt
  };
}

function mapRegimeToMarketRegimeResult(r: Regime1H): MarketRegimeResult {
  const regimeMap: Record<string, MarketRegimeType> = {
    BULL_TREND: 'TRENDING',
    BEAR_TREND: 'TRENDING',
    TRANSITIONAL: 'TRANSITIONAL',
    RANGING: 'RANGING'
  };
  const directionMap: Record<string, MarketDirectionType> = {
    BULL_TREND: 'BULL',
    BEAR_TREND: 'BEAR',
    TRANSITIONAL: 'NEUTRAL',
    RANGING: 'NEUTRAL'
  };
  const volMap: Record<string, VolatilityRegimeType> = {
    LOW: 'LOW',
    NORMAL: 'NORMAL',
    HIGH: 'HIGH',
    EXTREME: 'HIGH'
  };
  return {
    regime: regimeMap[r.regime] ?? 'TRANSITIONAL',
    direction: directionMap[r.regime] ?? 'NEUTRAL',
    volatility: volMap[r.volatility] ?? 'NORMAL',
    adx: r.adx,
    atr: r.atr,
    atrPercent: r.atrPercent,
    supertrend: { value: r.supertrend.value, direction: r.supertrend.direction }
  };
}

export function mapDecisionToSignalEvaluation(
  d: IntradayDecision,
  price: number,
  priceChange24h: number
): SignalEvaluation {
  const isSignal = d.outcome === 'SIGNAL';
  const tradeType = (d.tradeType ?? 'HOLD') as TradeType;
  const direction = d.direction;
  const action: 'buy' | 'sell' | 'hold' =
    direction === 'LONG' ? 'buy' : direction === 'SHORT' ? 'sell' : 'hold';
  const tradeSide: 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE' =
    direction === 'LONG' ? 'LONG' : direction === 'SHORT' ? 'SHORT' : tradeType === 'SPOT' ? 'BUY' : 'NONE';
  const confidence = isSignal ? Math.round((d.metrics.setupScore + d.metrics.entryScore) / 2) : 0;
  const priceOut = price || d.entry?.entryPrice || 0;

  const factors: DecisionFactor[] = [];
  if (d.regime) {
    factors.push({
      label: 'משטר שוק 1H (ADX 14)',
      value: `${d.regime.regime} (ADX ${d.regime.adx.toFixed(1)})`,
      impact: d.regime.trending ? 'positive' : d.regime.ranging ? 'neutral' : 'negative',
      note: d.regime.futuresAllowed ? 'מגמה מובהקת — Futures מותר' : 'ללא מגמה — Spot בלבד'
    });
    factors.push({
      label: 'תנודתיות (ATR%)',
      value: `${d.regime.volatility} (${d.regime.atrPercent.toFixed(2)}%)`,
      impact: d.regime.volatility === 'HIGH' || d.regime.volatility === 'EXTREME' ? 'negative' : 'positive',
      note: d.regime.strictMode ? 'EXTREME — סף מחמיר (§10)' : 'תנודתיות מתאימה'
    });
  }
  if (d.setup && d.setup.setupType !== 'NONE') {
    factors.push({
      label: 'Setup 15M',
      value: `${d.setup.setupType} ${d.setup.direction} (${d.setup.setupScore})`,
      impact: d.setup.strong ? 'positive' : 'neutral',
      note: d.setup.blockers?.length ? d.setup.blockers[0] : 'Setup תקין'
    });
  }
  if (d.entry && d.entry.entryScore) {
    factors.push({
      label: 'Entry 5M',
      value: `${d.entry.trigger} (${d.entry.entryScore})`,
      impact: d.entry.strong ? 'positive' : 'neutral',
      note: d.entry.blockers?.length ? d.entry.blockers[0] : 'אישור כניסה'
    });
  }
  if (d.cost) {
    factors.push({
      label: 'עלות/שוליים (Cost/Edge)',
      value: `R:R נטו ${d.cost.netRewardRisk} | edge ${d.cost.edgeRatio}`,
      impact: d.cost.approved ? 'positive' : 'negative',
      note: d.cost.reason
    });
  }
  if (d.risk && d.risk.approved) {
    factors.push({
      label: 'ניהול סיכונים (SL/TP/מינוף)',
      value: `SL ${d.risk.stopLoss} TP1 ${d.risk.takeProfit1} ${d.risk.leverage}x risk ${d.risk.riskPercentUsed}%`,
      impact: 'positive',
      note: `כמות ${d.risk.quantity}`
    });
  }
  factors.push({
    label: 'יומן החלטה',
    value: d.logs[d.logs.length - 1] ?? d.summary,
    impact: 'neutral',
    note: d.logs.join(' | ')
  });

  const status = isSignal
    ? `SIGNAL ${tradeType} ${direction} ${d.setupType}`
    : `NO_SIGNAL [${d.gate}] — ${d.logs[d.logs.length - 1] ?? d.summary}`;

  return {
    symbol: d.symbol,
    action,
    tradeType,
    tradeSide,
    confidence,
    price: priceOut,
    priceChange24h,
    reasoning: d.summary,
    status,
    willExecute: isSignal,
    factors,
    confidenceGap: 0,
    regime: d.regime ? mapRegimeToMarketRegimeResult(d.regime) : undefined,
    leverage: d.risk?.leverage,
    stopLoss: d.risk?.stopLoss,
    takeProfit1: d.risk?.takeProfit1,
    takeProfit2: d.risk?.takeProfit2,
    takeProfit: d.risk?.takeProfit1,
    decision: d
  };
}

export function evaluateSymbolFromSnapshot(
  snap: MultiTimeframeSnapshot,
  priceInfo: { price: number; priceChange24h: number },
  portfolio: PortfolioRiskStats,
  openPositions: { symbol: string; type: TradeType }[],
  params: IntradayParams = DEFAULT_INTRADAY_PARAMS,
  now?: number
): SignalEvaluation {
  const decision = evaluateIntradayDecision({
    symbol: snap.symbol,
    h1: snap.h1,
    m15: snap.m15,
    m5: snap.m5,
    spreadPercent: snap.liquidity?.spreadPercent ?? 0,
    quoteVolume24h: snap.liquidity?.quoteVolume24h ?? 0,
    livePrice: snap.liquidity?.lastPrice || priceInfo.price || snap.livePrice,
    portfolio,
    openPositions,
    params,
    now
  });
  return mapDecisionToSignalEvaluation(decision, priceInfo.price || snap.livePrice, priceInfo.priceChange24h);
}

export interface EvaluateUniverseOptions {
  now?: number;
  force?: boolean;
  log?: boolean;
  concurrency?: number;
}

export async function evaluateUniverse(
  symbols: string[],
  priceMap: Record<string, { price: number; priceChange24h: number }>,
  portfolio: PortfolioRiskStats,
  openPositions: { symbol: string; type: TradeType }[],
  params: IntradayParams = DEFAULT_INTRADAY_PARAMS,
  opts: EvaluateUniverseOptions = {}
): Promise<{ evaluations: SignalEvaluation[]; stats: MarketDataStats }> {
  const { snapshots, stats } = await getUniverseMarketData(symbols, {
    now: opts.now,
    force: opts.force,
    log: opts.log,
    concurrency: opts.concurrency
  });

  const evaluations: SignalEvaluation[] = [];
  for (const symbol of symbols) {
    const snap = snapshots.get(toBybitSymbol(symbol));
    if (!snap || snap.status !== 'READY') continue;
    const info = priceMap[symbol.toUpperCase()] ?? { price: snap.livePrice, priceChange24h: 0 };
    evaluations.push(evaluateSymbolFromSnapshot(snap, info, portfolio, openPositions, params, opts.now));
  }
  return { evaluations, stats };
}

export async function fetchSymbolSnapshot(
  symbol: string,
  opts: { now?: number; force?: boolean; log?: boolean } = {}
): Promise<MultiTimeframeSnapshot> {
  return getMultiTimeframeData(symbol, opts);
}

export function computeAtr5(candles: Candle[], period = 14): number {
  if (!candles || candles.length < period) return 0;
  return calculateATR(candles, period).atr;
}

export interface ExitPositionInput {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'LONG' | 'SHORT' | 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  tp1Hit?: boolean;
  openTimestamp: number;
  setupType?: SetupType;
  plannedStopDistance?: number;
  highestPrice?: number;
  lowestPrice?: number;
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
}

export function buildExitView(pos: ExitPositionInput): IntradayPositionView {
  return {
    symbol: pos.symbol,
    type: pos.type,
    side: pos.side,
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
    stopLoss: pos.stopLoss,
    takeProfit1: pos.takeProfit1,
    takeProfit2: pos.takeProfit2,
    tp1Hit: pos.tp1Hit,
    openTimestamp: pos.openTimestamp,
    setupType: pos.setupType,
    plannedStopDistance: pos.plannedStopDistance,
    highestPrice: pos.highestPrice,
    lowestPrice: pos.lowestPrice,
    highestPriceSinceTP1: pos.highestPriceSinceTP1,
    lowestPriceSinceTP1: pos.lowestPriceSinceTP1
  };
}

export interface ExitPortfolioInput {
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  systemLocked?: boolean;
}

export function evaluatePositionExit(
  pos: ExitPositionInput,
  price: number,
  atr5: number,
  portfolio: ExitPortfolioInput,
  reversal?: { direction: Direction; setupScore: number; entryConfirmed: boolean },
  params?: IntradayParams
): IntradayExitDecision {
  const view = buildExitView(pos);
  const ctx: IntradayExitContext = {
    price,
    now: Date.now(),
    atr5,
    params,
    portfolio: {
      dailyDrawdownPercent: portfolio.dailyDrawdownPercent,
      weeklyDrawdownPercent: portfolio.weeklyDrawdownPercent,
      systemLocked: portfolio.systemLocked
    },
    reversalSignal: reversal
  };
  return evaluateIntradayExit(view, ctx);
}

/**
 * Intraday Engine — shared decision orchestrator (§8-§47)
 * ============================================================================
 * Synchronous, pure, side-effect free. It takes already-fetched, validated,
 * CLOSED candles for 1H/15M/5M and produces ONE IntradayDecision.
 *
 * The same function is used by:
 *   - the live worker (tradingWorker.ts)  → candles from getMultiTimeframeData
 *   - the browser simulation (useSimulationBot.ts)
 *   - the server sim (simEngine.ts)
 *   - the backtest harness (intradayBacktest.ts) over historical 5M candles
 *
 * Gate order (§55) — the FIRST failing gate is reported as the block reason:
 *   NO_DATA → CIRCUIT_BREAKER → EXPOSURE → NO_REGIME → VOLATILITY →
 *   LIQUIDITY → SPREAD → NO_SETUP → NO_ENTRY → COST → RISK
 */

import { Candle, PortfolioRiskStats, formatDynamicPrice } from './tradeEngine';
import { detectRegime1H, Regime1H } from './intradayRegime';
import { detectSetup15M, Setup15M } from './intradaySetup';
import { confirmEntry5M, Entry5M } from './intradayEntry';
import { evaluateCostEdge, CostAnalysis, buildRiskPlan, RiskPlan } from './intradayRisk';
import { DEFAULT_INTRADAY_PARAMS, DecisionGate, Direction, IntradayParams, SetupType } from './intradayParams';

export type TradeType = 'SPOT' | 'FUTURES';
export type DecisionOutcome = 'SIGNAL' | 'NO_SIGNAL' | 'NO_DATA';

export interface IntradayDecisionInput {
  symbol: string;
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
  /** Live spread / 24h turnover snapshot (optional for backtest) */
  spreadPercent?: number;
  /** 24h quote turnover on the LINEAR (futures) market */
  quoteVolume24h?: number;
  /** 24h quote turnover on the SPOT market — many assets are far more liquid
   *  here than on futures, so a SPOT trade must be gated by this, not the
   *  futures number (§26) */
  quoteVolume24hSpot?: number;
  livePrice?: number;
  portfolio: PortfolioRiskStats;
  /** Open positions of the SAME account, for same-asset Spot/Futures exclusion (§36) */
  openPositions: { symbol: string; type: TradeType }[];
  params?: IntradayParams;
  now?: number;
  /** Current notional exposure per asset for per-asset cap checks */
  existingExposureByAsset?: Record<string, number>;
}

export interface IntradayDecision {
  symbol: string;
  timestamp: number;
  outcome: DecisionOutcome;
  /** First failing gate, or 'RISK' when a trade is approved */
  gate: DecisionGate;
  decision: DecisionOutcome;
  tradeType: TradeType | null;
  direction: Direction;
  setupType: SetupType;
  regime: Regime1H;
  setup: Setup15M;
  entry: Entry5M;
  cost: CostAnalysis | null;
  risk: RiskPlan | null;
  /** Human-readable log lines (Hebrew) for §44/§45/§46 */
  logs: string[];
  /** One-line summary for the evaluation list */
  summary: string;
  /** Structured telemetry for the UI / backtest */
  metrics: {
    setupScore: number;
    entryScore: number;
    edgeRatio: number;
    netRewardRisk: number;
    riskPercent: number;
    atrPercentile: number;
    volatility: string;
  };
  /** Per-window funnel telemetry (§10) */
  funnel: {
    evaluated: true;
    regimePassed: boolean;
    setupCandidates: number;
    entryCandidates: number;
    costBlocked: boolean;
    riskBlocked: boolean;
    approved: boolean;
    executed: boolean;
  };
}

function emptyDecision(symbol: string, gate: DecisionGate, outcome: DecisionOutcome, logs: string[]): IntradayDecision {
  return {
    symbol,
    timestamp: Date.now(),
    outcome,
    gate,
    decision: outcome,
    tradeType: null,
    direction: 'NONE',
    setupType: 'NONE',
    regime: null as unknown as Regime1H,
    setup: null as unknown as Setup15M,
    entry: null as unknown as Entry5M,
    cost: null,
    risk: null,
    logs,
    summary: logs[logs.length - 1] ?? 'NO_DATA',
    metrics: { setupScore: 0, entryScore: 0, edgeRatio: 0, netRewardRisk: 0, riskPercent: 0, atrPercentile: 0, volatility: 'NONE' },
    funnel: { evaluated: true, regimePassed: false, setupCandidates: 0, entryCandidates: 0, costBlocked: false, riskBlocked: false, approved: false, executed: false }
  };
}

export function evaluateIntradayDecision(input: IntradayDecisionInput): IntradayDecision {
  const params = input.params ?? DEFAULT_INTRADAY_PARAMS;
  const now = input.now ?? Date.now();
  const logs: string[] = [];
  const symbol = input.symbol;

  // ── GATE 1: NO_DATA ─────────────────────────────────────────────────────────
  const min1h = 200;
  const min15m = 300;
  const min5m = 500;
  if (input.h1.length < min1h || input.m15.length < min15m || input.m5.length < min5m) {
    logs.push(`[${symbol}] NO_DATA — חסרים נרות: 1h=${input.h1.length} 15m=${input.m15.length} 5m=${input.m5.length}`);
    return emptyDecision(symbol, 'NO_DATA', 'NO_DATA', logs);
  }

  // ── GATE 2: CIRCUIT BREAKER (§38) ───────────────────────────────────────────
  const p = input.portfolio;
  if (p.systemLocked) {
    logs.push(`[${symbol}] CIRCUIT_BREAKER — מערכת נעולה (${p.lockReason ?? 'unknown'})`);
    return emptyDecision(symbol, 'CIRCUIT_BREAKER', 'NO_SIGNAL', logs);
  }
  if (p.dailyDrawdownPercent >= params.dailyDrawdownBlockPercent) {
    logs.push(`[${symbol}] CIRCUIT_BREAKER — Drawdown יומי ${p.dailyDrawdownPercent.toFixed(1)}% >= ${params.dailyDrawdownBlockPercent}%`);
    return emptyDecision(symbol, 'CIRCUIT_BREAKER', 'NO_SIGNAL', logs);
  }
  if (p.weeklyDrawdownPercent >= params.weeklyDrawdownLockPercent) {
    logs.push(`[${symbol}] CIRCUIT_BREAKER — Drawdown שבועי ${p.weeklyDrawdownPercent.toFixed(1)}% >= ${params.weeklyDrawdownLockPercent}% (נעילה)`);
    return emptyDecision(symbol, 'CIRCUIT_BREAKER', 'NO_SIGNAL', logs);
  }

  // ── GATE 3: EXPOSURE + same-asset Spot/Futures exclusion (§36) ──────────────
  if (p.openPositionsCount >= params.maxOpenPositions) {
    logs.push(`[${symbol}] EXPOSURE — ${p.openPositionsCount} פוזיציות פתוחות (מקס ${params.maxOpenPositions})`);
    return emptyDecision(symbol, 'EXPOSURE', 'NO_SIGNAL', logs);
  }
  const sameAsset = input.openPositions.find((o) => o.symbol === symbol);
  if (sameAsset) {
    logs.push(`[${symbol}] EXPOSURE — נכס כבר פתוח (${sameAsset.type}); אין כפילות Spot/Futures (§36)`);
    return emptyDecision(symbol, 'EXPOSURE', 'NO_SIGNAL', logs);
  }

  // ── LAYER A: 1H REGIME ──────────────────────────────────────────────────────
  const regime = detectRegime1H(input.h1, params);
  logs.push(`[${symbol}] 1H=${regime.regime} bias=${regime.bias} ADX=${regime.adx.toFixed(1)} ATR%=${regime.atrPercent.toFixed(2)} vol=${regime.volatility} futuresAllowed=${regime.futuresAllowed}`);

  const transitional = regime.regime === 'TRANSITIONAL';
  const softTrend = regime.regime === 'SOFT_TREND';
  // TRANSITIONAL no longer hard-blocks: new FUTURES are blocked, but an especially
  // quality SPOT setup is still allowed (enforced at trade-type routing below).
  // SOFT_TREND is similar: Futures blocked, Spot allowed with an even higher
  // quality bar (Setup+Entry both strong + good ATR percentile).
  if (transitional) {
    logs.push(`[${symbol}] TRANSITIONAL — Futures חסום; Spot רק עבור Setup איכותי במיוחד (§8/§34)`);
  }
  if (softTrend) {
    logs.push(`[${symbol}] SOFT_TREND — Futures חסום עד אישור מגמה מלאה; Spot מותר עם סף איכותי מוגבר (§8)`);
  }

  const regimePassed = regime.regime !== 'TRANSITIONAL' && regime.regime !== 'SOFT_TREND';
  const mkFunnel = (
    gate: DecisionGate,
    outcome: DecisionOutcome,
    setup: Setup15M | null,
    entry: Entry5M | null
  ): IntradayDecision['funnel'] => ({
    evaluated: true,
    regimePassed,
    setupCandidates: setup ? setup.candidateCount : 0,
    entryCandidates: entry ? entry.confirmationCount : 0,
    costBlocked: gate === 'COST' || gate === 'SPREAD',
    riskBlocked: gate === 'RISK' && outcome === 'NO_SIGNAL',
    approved: outcome === 'SIGNAL',
    executed: false
  });

  // ── GATE 5: VOLATILITY (strict bar in EXTREME) ──────────────────────────────
  const strictMode = regime.strictMode;
  if (regime.volatility === 'EXTREME' && !regime.futuresAllowed) {
    logs.push(`[${symbol}] VOLATILITY — EXTREME; Futures חסום, Spot רק במסלול מחמיר (§10)`);
  }

  // ── LAYER B: 15M SETUP ──────────────────────────────────────────────────────
  const setup = detectSetup15M(input.m15, regime, params);
  if (setup.setupType === 'NONE') {
    logs.push(`[${symbol}] NO_SETUP — ${setup.blockers[0] ?? 'אין Setup'}`);
    return finalize(symbol, 'NO_SETUP', 'NO_SIGNAL', regime, setup, null, null, null, logs, params, now, mkFunnel('NO_SETUP', 'NO_SIGNAL', setup, null), null);
  }
  logs.push(`[${symbol}] 15M=${setup.setupType} dir=${setup.direction} SetupScore=${setup.setupScore} (strong=${setup.strong})`);

  // ── LAYER C: 5M ENTRY ───────────────────────────────────────────────────────
  let entry = confirmEntry5M(input.m5, setup, params);
  const setupScore = setup.setupScore;
  const entryScore = entry.entryScore;
  const confidence = Math.round((setupScore + entryScore) / 2);
  if (!entry.confirmed && confidence < 72) {
    logs.push(`[${symbol}] NO_ENTRY — EntryScore=${entry.entryScore} | ${entry.blockers[0] ?? ''}`);
    return finalize(symbol, 'NO_ENTRY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('NO_ENTRY', 'NO_SIGNAL', setup, entry), null);
  }
  if (!entry.confirmed && confidence >= 72) {
    logs.push(`[${symbol}] NO_ENTRY BYPASS — EntryScore=${entry.entryScore} | ${entry.blockers[0] ?? ''} (confidence ${confidence} >= 72)`);
    entry = { ...entry, confirmed: true, blockers: [] };
  }
  logs.push(`[${symbol}] 5M=${entry.trigger} EntryScore=${entry.entryScore} price=${formatDynamicPrice(entry.entryPrice)}`);

  // ── TRADE TYPE ROUTING (§19/§34) ────────────────────────────────────────────
  let tradeType: TradeType;
  if (setup.spotOnly) {
    tradeType = 'SPOT';
  } else if (regime.futuresAllowed) {
    tradeType = 'FUTURES';
  } else if (
    params.allowShortDuringHighVolatility &&
    regime.trending &&
    regime.volatility === 'HIGH' &&
    (setup.direction === 'SHORT' || setup.direction === 'LONG')
  ) {
    // Deliberate carve-out for BOTH directions in HIGH volatility:
    // - SHORT: regime.futuresAllowed is direction-agnostic and blocks FUTURES
    //   outright in HIGH volatility, which normally disables the bot's only
    //   tool for profiting from a sharp down-move exactly when the down-move
    //   is sharpest (allowShortDuringHighVolatility, off by default).
    // - LONG: the same blockage in HIGH volatility stops trend-following
    //   longs on sharp up-moves. Symmetric carve-out: a trending market in
    //   HIGH volatility may trade the direction the trend points. EXTREME
    //   volatility stays blocked for both (see below) — liquidation risk at
    //   EXTREME + leverage is judged too high either way.
    tradeType = 'FUTURES';
  } else {
    tradeType = 'SPOT';
  }
  // EXTREME volatility forces spot even for trends (§10) — applies regardless
  // of direction or allowShortDuringHighVolatility: liquidation risk at
  // EXTREME + leverage is judged too high either way.
  if (regime.volatility === 'EXTREME') tradeType = 'SPOT';

  // ── TRANSITIONAL / SOFT_TREND quality gate (§8/§34) ─────────────────────────
  // In a transitional (no-clean-regime) market, new FUTURES are blocked and only
  // an especially high-quality SPOT setup is permitted (Setup + Entry both strong).
  // SOFT_TRAND gets an even higher bar: both strong + ATR percentile below 70
  // (not in extreme volatility).
  if (transitional || softTrend) {
    tradeType = 'SPOT';
    const isSoftTrend = softTrend;
    const atrOk = !regime.strictMode && (regime.atrPercentile ?? 50) < (isSoftTrend ? 70 : 80);
    const highQuality = setup.strong && entry.strong && atrOk;
    if (!highQuality) {
      const reason = isSoftTrend
        ? `SOFT_TREND דורש Setup+Entry חזקים + ATR percentile < 70 (נחשב ${regime.atrPercentile?.toFixed(0) ?? 'N/A'}) — נחסם (§8)`
        : `TRANSITIONAL דורש Setup+Entry חזקים (strong); נחסם (§8/§34)`;
      logs.push(`[${symbol}] NO_REGIME — ${reason}`);
      return finalize(symbol, 'NO_REGIME', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('NO_REGIME', 'NO_SIGNAL', setup, entry), null);
    }
    logs.push(`[${symbol}] ${isSoftTrend ? 'SOFT_TREND' : 'TRANSITIONAL'} — Spot איכותי מאושר (Setup+Entry strong${isSoftTrend ? ' + ATR ok' : ''})`);
  }

  // ── GATE 6/7: LIQUIDITY + SPREAD (§26/§27) ─────────────────────────────────
  const spreadPercent = input.spreadPercent ?? 0;
  // Gate on the liquidity of the market the trade will actually execute on —
  // a SPOT setup must not be blocked by thin FUTURES turnover and vice versa (§26).
  const quoteVolume = tradeType === 'SPOT' ? (input.quoteVolume24hSpot ?? 0) : (input.quoteVolume24h ?? 0);
  if (quoteVolume > 0 && quoteVolume < params.minQuoteVolume24h) {
    logs.push(`[${symbol}] LIQUIDITY — מחזור 24h ${quoteVolume.toFixed(0)}$ < ${params.minQuoteVolume24h}$`);
    return finalize(symbol, 'LIQUIDITY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('LIQUIDITY', 'NO_SIGNAL', setup, entry), tradeType);
  }
  if (spreadPercent > params.maxSpreadPercent) {
    logs.push(`[${symbol}] SPREAD — ${spreadPercent.toFixed(3)}% > ${params.maxSpreadPercent}% (נזילות נמוכה)`);
    return finalize(symbol, 'SPREAD', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('SPREAD', 'NO_SIGNAL', setup, entry), tradeType);
  }

  // ── GATE 5b: strict bar in EXTREME volatility ──────────────────────────────
  if (strictMode && (!setup.strong || !entry.strong)) {
    logs.push(`[${symbol}] VOLATILITY — EXTREME דורש SetupScore/EntryScore חזקים (strong); נחסם (§10)`);
    return finalize(symbol, 'VOLATILITY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('VOLATILITY', 'NO_SIGNAL', setup, entry), tradeType);
  }

  // ── COST / EDGE (§25) ───────────────────────────────────────────────────────
  const cost = evaluateCostEdge({
    tradeType,
    entryPrice: entry.entryPrice,
    stopLoss: entry.stopReference,
    takeProfit1: entry.targetReference ?? entry.entryPrice + (entry.entryPrice - entry.stopReference) * params.tp1RewardRisk,
    spreadPercent,
    atrPercentile: regime.atrPercentile,
    entryIsLimit: true,
    params
  });
  if (!cost.approved && confidence < 72) {
    logs.push(`[${symbol}] COST — ${cost.reason}`);
    return finalize(symbol, 'COST', 'NO_SIGNAL', regime, setup, entry, cost, null, logs, params, now, mkFunnel('COST', 'NO_SIGNAL', setup, entry), tradeType);
  }
  if (!cost.approved && confidence >= 72) {
    logs.push(`[${symbol}] COST BYPASS — ${cost.reason} (confidence ${confidence} >= 72)`);
  }
  logs.push(`[${symbol}] COST OK — ${cost.reason}`);

  // ── RISK PLAN (§30-§35) ─────────────────────────────────────────────────────
  const risk = buildRiskPlan({
    symbol,
    direction: setup.direction as Exclude<Direction, 'NONE'>,
    tradeType,
    setupType: setup.setupType as Exclude<SetupType, 'NONE'>,
    entryPrice: entry.entryPrice,
    stopReference: entry.stopReference,
    targetReference: entry.targetReference,
    atr5: entry.atr5,
    atr15: setup.levels.atr,
    equity: p.portfolioValue,
    openPositions: p.openPositionsCount,
    openFutures: p.openFuturesPositionsCount,
    currentLeveragedExposureUsd: p.totalLeveragedExposureUsd,
    existingExposureByAsset: input.existingExposureByAsset ?? p.existingExposureByAsset ?? {},
    riskPercent: params.riskPerTradePercent,
    confidence,
    params
  });

  // High-confidence bypass: if buildRiskPlan rejected but confidence >= 72,
  // use a minimal fallback with fixed 1.8% SL / 3% TP.
  const effectiveRisk = risk.approved ? risk : (confidence >= 72 && tradeType !== null
    ? buildFallbackIntradayRisk(entry.entryPrice, setup.direction as Exclude<Direction, 'NONE'>, tradeType)
    : null);

  if (!effectiveRisk) {
    logs.push(`[${symbol}] RISK — ${risk.blockReason ?? 'נפסל'}`);
    return finalize(symbol, 'RISK', 'NO_SIGNAL', regime, setup, entry, cost, risk, logs, params, now, mkFunnel('RISK', 'NO_SIGNAL', setup, entry), tradeType);
  }

  logs.push(
    `[${symbol}] SIGNAL ${tradeType} ${setup.direction} ${setup.setupType} | SL=${formatDynamicPrice(effectiveRisk.stopLoss)} TP1=${formatDynamicPrice(effectiveRisk.takeProfit1)} lev=${effectiveRisk.leverage}x risk=${effectiveRisk.riskPercentUsed}% qty=${effectiveRisk.quantity}`
  );

  return finalize(symbol, 'RISK', 'SIGNAL', regime, setup, entry, cost, effectiveRisk, logs, params, now, mkFunnel('RISK', 'SIGNAL', setup, entry), tradeType);
}

function finalize(
  symbol: string,
  gate: DecisionGate,
  outcome: DecisionOutcome,
  regime: Regime1H,
  setup: Setup15M | null,
  entry: Entry5M | null,
  cost: CostAnalysis | null,
  risk: RiskPlan | null,
  logs: string[],
  params: IntradayParams,
  now: number,
  funnel: IntradayDecision['funnel'],
  tradeType: TradeType | null
): IntradayDecision {
  const setupScore = setup?.setupScore ?? 0;
  const entryScore = entry?.entryScore ?? 0;
  const direction: Direction = setup?.direction ?? 'NONE';
  const setupType: SetupType = setup?.setupType ?? 'NONE';

  const summary =
    outcome === 'SIGNAL'
      ? `SIGNAL ${tradeType} ${direction} ${setupType} (SS=${setupScore} ES=${entryScore})`
      : outcome === 'NO_DATA'
      ? 'NO_DATA'
      : `NO_SIGNAL [${gate}]`;

  return {
    symbol,
    timestamp: now,
    outcome,
    gate,
    decision: outcome,
    tradeType,
    direction,
    setupType,
    regime,
    setup: setup as Setup15M,
    entry: entry as Entry5M,
    cost,
    risk,
    logs,
    summary,
    metrics: {
      setupScore,
      entryScore,
      edgeRatio: cost?.edgeRatio ?? 0,
      netRewardRisk: cost?.netRewardRisk ?? 0,
      riskPercent: risk?.riskPercentUsed ?? 0,
      atrPercentile: regime?.atrPercentile ?? 0,
      volatility: regime?.volatility ?? 'NONE'
    },
    funnel
  };
}

/** Builds a minimal fallback risk plan for high-confidence intraday signals
 *  that were rejected by buildRiskPlan. Uses fixed 1.8% SL / 3% TP. */
function buildFallbackIntradayRisk(entryPrice: number, direction: Exclude<Direction, 'NONE'>, tradeType: TradeType): RiskPlan {
  const slPercent = 1.8;
  const tpPercent = 3.0;
  const isLong = direction === 'LONG';
  const stopLoss = isLong ? entryPrice * (1 - slPercent / 100) : entryPrice * (1 + slPercent / 100);
  const takeProfit1 = isLong ? entryPrice * (1 + tpPercent / 100) : entryPrice * (1 - tpPercent / 100);
  const takeProfit2 = isLong ? entryPrice * (1 + tpPercent * 1.5 / 100) : entryPrice * (1 - tpPercent * 1.5 / 100);
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const rewardRisk1 = Math.abs(takeProfit1 - entryPrice) / stopDistance;
  const rewardRisk2 = Math.abs(takeProfit2 - entryPrice) / stopDistance;
  return {
    approved: true,
    blockReason: undefined,
    stopLoss: Number(stopLoss.toFixed(8)),
    takeProfit1: Number(takeProfit1.toFixed(8)),
    takeProfit2: Number(takeProfit2.toFixed(8)),
    stopDistance: Number(stopDistance.toFixed(8)),
    stopDistancePercent: Number((slPercent).toFixed(4)),
    riskUsd: 5,
    quantity: 5 / stopDistance,
    notionalUsd: (5 / stopDistance) * entryPrice,
    marginUsd: tradeType === 'FUTURES' ? 5 : (5 / stopDistance) * entryPrice,
    leverage: 1,
    rewardRisk1: Number(rewardRisk1.toFixed(2)),
    rewardRisk2: Number(rewardRisk2.toFixed(2)),
    maxHoldMs: 60 * 60_000,
    timeStopMs: Math.round(60 * 60_000 * 0.45),
    positionPercentOfEquity: 0,
    riskPercentUsed: 0.5
  };
}

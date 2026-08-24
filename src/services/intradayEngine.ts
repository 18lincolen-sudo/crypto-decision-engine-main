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
  quoteVolume24h?: number;
  livePrice?: number;
  portfolio: PortfolioRiskStats;
  /** Open positions of the SAME account, for same-asset Spot/Futures exclusion (§36) */
  openPositions: { symbol: string; type: TradeType }[];
  params?: IntradayParams;
  now?: number;
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
    metrics: { setupScore: 0, entryScore: 0, edgeRatio: 0, netRewardRisk: 0, riskPercent: 0, atrPercentile: 0, volatility: 'NONE' }
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

  // ── GATE 4: NO_REGIME ───────────────────────────────────────────────────────
  if (regime.regime === 'TRANSITIONAL') {
    logs.push(`[${symbol}] NO_REGIME — משטר מעברי (TRANSITIONAL), לא נפתחות עסקאות (§8/§34)`);
    return finalize(symbol, 'NO_REGIME', 'NO_SIGNAL', regime, null, null, null, null, logs, params, now);
  }

  // ── GATE 5: VOLATILITY (strict bar in EXTREME) ──────────────────────────────
  const strictMode = regime.strictMode;
  if (regime.volatility === 'EXTREME' && !regime.futuresAllowed) {
    logs.push(`[${symbol}] VOLATILITY — EXTREME; Futures חסום, Spot רק במסלול מחמיר (§10)`);
  }

  // ── LAYER B: 15M SETUP ──────────────────────────────────────────────────────
  const setup = detectSetup15M(input.m15, regime, params);
  if (setup.setupType === 'NONE') {
    logs.push(`[${symbol}] NO_SETUP — ${setup.blockers[0] ?? 'אין Setup'}`);
    return finalize(symbol, 'NO_SETUP', 'NO_SIGNAL', regime, setup, null, null, null, logs, params, now);
  }
  logs.push(`[${symbol}] 15M=${setup.setupType} dir=${setup.direction} SetupScore=${setup.setupScore} (strong=${setup.strong})`);

  // ── LAYER C: 5M ENTRY ───────────────────────────────────────────────────────
  const entry = confirmEntry5M(input.m5, setup, params);
  if (!entry.confirmed) {
    logs.push(`[${symbol}] NO_ENTRY — EntryScore=${entry.entryScore} | ${entry.blockers[0] ?? ''}`);
    return finalize(symbol, 'NO_ENTRY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now);
  }
  logs.push(`[${symbol}] 5M=${entry.trigger} EntryScore=${entry.entryScore} price=${formatDynamicPrice(entry.entryPrice)}`);

  // ── TRADE TYPE ROUTING (§19/§34) ────────────────────────────────────────────
  let tradeType: TradeType;
  if (setup.spotOnly) {
    tradeType = 'SPOT';
  } else if (regime.futuresAllowed) {
    tradeType = 'FUTURES';
  } else {
    tradeType = 'SPOT';
  }
  // EXTREME volatility forces spot even for trends (§10).
  if (regime.volatility === 'EXTREME') tradeType = 'SPOT';

  // ── GATE 6/7: LIQUIDITY + SPREAD (§26/§27) ─────────────────────────────────
  const spreadPercent = input.spreadPercent ?? 0;
  const quoteVolume = input.quoteVolume24h ?? 0;
  if (quoteVolume > 0 && quoteVolume < params.minQuoteVolume24h) {
    logs.push(`[${symbol}] LIQUIDITY — מחזור 24h ${quoteVolume.toFixed(0)}$ < ${params.minQuoteVolume24h}$`);
    return finalize(symbol, 'LIQUIDITY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now);
  }
  if (spreadPercent > params.maxSpreadPercent) {
    logs.push(`[${symbol}] SPREAD — ${spreadPercent.toFixed(3)}% > ${params.maxSpreadPercent}% (נזילות נמוכה)`);
    return finalize(symbol, 'SPREAD', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now);
  }

  // ── GATE 5b: strict bar in EXTREME volatility ──────────────────────────────
  if (strictMode && (!setup.strong || !entry.strong)) {
    logs.push(`[${symbol}] VOLATILITY — EXTREME דורש SetupScore/EntryScore חזקים (strong); נחסם (§10)`);
    return finalize(symbol, 'VOLATILITY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now);
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
  if (!cost.approved) {
    logs.push(`[${symbol}] COST — ${cost.reason}`);
    return finalize(symbol, 'COST', 'NO_SIGNAL', regime, setup, entry, cost, null, logs, params, now);
  }
  logs.push(`[${symbol}] COST OK — ${cost.reason}`);

  // ── RISK PLAN (§30-§35) ─────────────────────────────────────────────────────
  const risk = buildRiskPlan({
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
    riskPercent: params.riskPerTradePercent,
    params
  });
  if (!risk.approved) {
    logs.push(`[${symbol}] RISK — ${risk.blockReason ?? 'נפסל'}`);
    return finalize(symbol, 'RISK', 'NO_SIGNAL', regime, setup, entry, cost, risk, logs, params, now);
  }

  logs.push(
    `[${symbol}] SIGNAL ${tradeType} ${setup.direction} ${setup.setupType} | SL=${formatDynamicPrice(risk.stopLoss)} TP1=${formatDynamicPrice(risk.takeProfit1)} lev=${risk.leverage}x risk=${risk.riskPercentUsed}% qty=${risk.quantity}`
  );

  return finalize(symbol, 'RISK', 'SIGNAL', regime, setup, entry, cost, risk, logs, params, now);
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
  now: number
): IntradayDecision {
  const setupScore = setup?.setupScore ?? 0;
  const entryScore = entry?.entryScore ?? 0;
  const tradeType: TradeType | null = risk ? (risk.leverage > 1 ? 'FUTURES' : setup?.spotOnly ? 'SPOT' : 'SPOT') : null;
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
    }
  };
}

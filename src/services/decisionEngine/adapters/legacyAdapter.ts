/**
 * Legacy Adapter — wraps the Legacy H1 engine (tradeEngine.ts + legacySimExecution.ts)
 * ============================================================================
 * This adapter translates between the unified DecisionEngine types and the
 * legacy engine's specific types (SignalEngineResult, TradeRouterResult, etc.).
 *
 * The pipeline stages mirror the legacy engine's layer chain:
 *   REGIME → SIGNALS → ROUTE → ENTRY_TIMING → RISK → EXIT
 */

import type {
  EngineParams,
  DecisionContext,
  DecisionResult,
  EngineAdapter,
  PipelineStage,
  StageResult,
  EngineId,
  RiskPlan,
  TradeType,
  TradeDirection,
  DecisionOutcome,
  ClosedTradeRecord
} from '../types';
import {
  detectMarketRegime,
  evaluateSignals,
  routeTradeType,
  calculateOptimalEntry,
  calculateRiskParameters,
  evaluateExit,
  MIN_ENTRY_RELATIVE_VOLUME
} from '../../tradeEngine';
import type { Candle, EntryTimingResult, ExitDecision, ClosedTradeMetric } from '../../tradeEngine';
// These live in types/crypto.ts — tradeEngine only re-declares them locally,
// so importing them from there was a type error.
import type {
  MarketRegimeResult,
  SignalEngineResult,
  TradeRouterResult,
  RiskParametersResult,
  ActivePosition
} from '../../../types/crypto';
import { computeDrawdownFactor, computeSizingMultiplier, summarizeRecentPerformance, MIN_STOP_PERCENT, MAX_STOP_PERCENT, MIN_RISK_REWARD_RATIO } from '../../adaptiveRisk';
import { evaluateCorrelationGate, toPositionDirection, CorrelatedHolding, DEFAULT_CORRELATION_LOOKBACK, DEFAULT_CORRELATION_THRESHOLD, DEFAULT_MAX_CORRELATED } from '../../correlation';

// ── Type Mappings ─────────────────────────────────────────────────────────────

function mapTradeType(t: TradeRouterResult['type']): TradeType {
  if (t === 'SPOT') return 'SPOT';
  if (t === 'FUTURES') return 'FUTURES';
  return 'HOLD';
}

function mapDirection(side: TradeRouterResult['side']): TradeDirection {
  if (side === 'LONG') return 'LONG';
  if (side === 'SHORT') return 'SHORT';
  if (side === 'BUY') return 'BUY';
  if (side === 'SELL') return 'SELL';
  return 'NONE';
}

function mapRiskPlan(risk: RiskParametersResult | null): RiskPlan | null {
  if (!risk) return null;
  return {
    approved: true,
    stopLoss: risk.stopLoss,
    takeProfit1: risk.takeProfit1,
    takeProfit2: risk.takeProfit2,
    takeProfit: risk.takeProfit,
    leverage: risk.leverage,
    betSizeUsd: risk.betSizeUsd,
    positionPercentOfPortfolio: risk.positionPercentOfPortfolio,
    riskRewardRatio: risk.riskRewardRatio,
    kellyFraction: risk.kellyFraction,
    maxRiskAmountUsd: risk.maxRiskAmountUsd,
    stopDistanceUsd: risk.stopDistanceUsd
  };
}

// ── Pipeline Context ──────────────────────────────────────────────────────────

interface LegacyPipelineContext extends DecisionContext {
  layer0?: MarketRegimeResult;
  layer1?: SignalEngineResult;
  layer2?: TradeRouterResult;
  layer3?: RiskParametersResult;
  entryTiming?: EntryTimingResult;
  exitDecision?: ExitDecision;
  sizingMultiplier?: number;
  blocked?: boolean;
  blockReason?: string;
  gate?: string;
}

// ── Pipeline Stages ───────────────────────────────────────────────────────────

const legacyResultCache = new Map<string, { result: unknown; h1Last: number }>();

class DetectRegimeStage implements PipelineStage<LegacyPipelineContext> {
  name = 'detect-regime';

  execute(context: LegacyPipelineContext): StageResult<LegacyPipelineContext> {
    const candles = context.candles.h1;
    if (!candles || candles.length < 60) {
      return {
        context,
        blocked: true,
        blockReason: `NO_DATA — insufficient H1 candles: ${candles?.length ?? 0}`,
        gate: 'NO_DATA'
      };
    }

    const layer0 = detectMarketRegime(candles, context.currentPrice);
    return { context: { ...context, layer0 }, blocked: false };
  }
}

class EvaluateSignalsStage implements PipelineStage<LegacyPipelineContext> {
  name = 'evaluate-signals';

  execute(context: LegacyPipelineContext): StageResult<LegacyPipelineContext> {
    if (!context.layer0) {
      return { context, blocked: true, blockReason: 'Missing layer0', gate: 'ERROR' };
    }

    const candles = context.candles.h1;
    const layer1 = evaluateSignals(
      candles,
      context.currentPrice,
      context.marketData.priceChange24h ?? 0,
      context.layer0,
      context.marketData.fearGreedIndex ?? 50
    );

    return { context: { ...context, layer1 }, blocked: false };
  }
}

class RouteTradeTypeStage implements PipelineStage<LegacyPipelineContext> {
  name = 'route-trade-type';

  execute(context: LegacyPipelineContext): StageResult<LegacyPipelineContext> {
    if (!context.layer0 || !context.layer1) {
      return { context, blocked: true, blockReason: 'Missing layer0 or layer1', gate: 'ERROR' };
    }

    const hasExistingFutures = context.openPositions.some(p => p.type === 'FUTURES' && p.symbol === context.symbol);
    const hasExistingSpot = context.openPositions.some(p => p.type === 'SPOT' && p.symbol === context.symbol);

    const layer2 = routeTradeType(context.layer1, context.layer0, {
      hasExistingFutures,
      hasExistingSpot,
      isDailyBlocked: context.portfolio.dailyDrawdownPercent >= 8,
      isWeeklyLocked: context.portfolio.weeklyDrawdownPercent >= 15
    });

    return { context: { ...context, layer2 }, blocked: layer2.type === 'HOLD' };
  }
}

class EntryTimingStage implements PipelineStage<LegacyPipelineContext> {
  name = 'entry-timing';

  execute(context: LegacyPipelineContext): StageResult<LegacyPipelineContext> {
    if (!context.layer2 || !context.layer0 || !context.layer1) {
      return { context, blocked: false };
    }

    if (context.layer2.type === 'HOLD' || context.layer2.side === 'NONE') {
      return { context, blocked: false };
    }

    const entryTiming = calculateOptimalEntry(
      context.currentPrice,
      context.layer0.atr,
      context.layer2.side,
      context.candles.h1,
      0.35,
      context.layer0.atrPercent,
      MIN_ENTRY_RELATIVE_VOLUME,
      context.layer1.confidence
    );

    return { context: { ...context, entryTiming }, blocked: !entryTiming.shouldEnterNow };
  }
}

class RiskParametersStage implements PipelineStage<LegacyPipelineContext> {
  name = 'risk-parameters';

  execute(context: LegacyPipelineContext): StageResult<LegacyPipelineContext> {
    if (!context.layer2 || !context.layer0 || !context.layer1) {
      return { context, blocked: false };
    }

    if (context.layer2.type === 'HOLD' || context.layer2.side === 'NONE') {
      return { context, blocked: false };
    }

    const entryPrice = context.entryTiming?.entryPrice ?? context.currentPrice;
    const futuresCount = context.openPositions.filter(p => p.type === 'FUTURES').length;

    const layer3 = calculateRiskParameters(
      entryPrice,
      context.layer2.type,
      context.layer2.side,
      context.layer0.atr,
      context.layer0.volatility,
      context.layer1.signalScore,
      context.portfolio.portfolioValue,
      (context.closedTrades ?? []) as ClosedTradeMetric[],
      context.portfolio.openPositionsCount,
      futuresCount,
      context.portfolio.totalLeveragedExposureUsd,
      undefined,
      context.sizingMultiplier ?? 1,
      undefined,
      context.config?.maxPositions ?? 7,
      context.config?.maxFuturesPositions ?? 2
    );

    return { context: { ...context, layer3: layer3 ?? undefined }, blocked: !layer3 };
  }
}

class CorrelationGateStage implements PipelineStage<LegacyPipelineContext> {
  name = 'correlation-gate';

  execute(context: LegacyPipelineContext): StageResult<LegacyPipelineContext> {
    if (!context.layer2 || context.layer2.type === 'HOLD') {
      return { context, blocked: false };
    }

    const held: CorrelatedHolding[] = context.openPositions.map(p => ({
      symbol: p.symbol,
      direction: toPositionDirection(p.side)
    }));

    const gate = evaluateCorrelationGate({
      symbol: context.symbol,
      direction: toPositionDirection(context.layer2.side),
      held,
      candlesBySymbol: { [context.symbol]: context.candles.h1 as Candle[] },
      threshold: DEFAULT_CORRELATION_THRESHOLD,
      maxCorrelated: DEFAULT_MAX_CORRELATED,
      lookback: DEFAULT_CORRELATION_LOOKBACK
    });

    return { context, blocked: !gate.allowed };
  }
}

class CostEdgeGateStage implements PipelineStage<LegacyPipelineContext> {
  name = 'cost-edge-gate';

  execute(context: LegacyPipelineContext): StageResult<LegacyPipelineContext> {
    if (!context.layer3) {
      return { context, blocked: false };
    }

    if (context.layer3.riskRewardRatio < MIN_RISK_REWARD_RATIO) {
      return {
        context,
        blocked: true,
        blockReason: `Risk-reward ratio ${context.layer3.riskRewardRatio.toFixed(2)} < ${MIN_RISK_REWARD_RATIO}`,
        gate: 'COST_EDGE'
      };
    }

    return { context, blocked: false };
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class LegacyAdapter implements EngineAdapter<LegacyPipelineContext> {
  id: EngineId = 'legacy';
  name = 'Legacy H1';
  params: EngineParams = {};

  private stages: PipelineStage<LegacyPipelineContext>[] = [
    new DetectRegimeStage(),
    new EvaluateSignalsStage(),
    new RouteTradeTypeStage(),
    new EntryTimingStage(),
    new RiskParametersStage(),
    new CorrelationGateStage(),
    new CostEdgeGateStage()
  ];

  canHandle(input: Partial<DecisionContext>): boolean {
    // Legacy needs at least H1 candles
    return !!(
      input.candles?.h1 && input.candles.h1.length >= 60
    );
  }

  execute(context: DecisionContext): unknown {
    const h1Last = context.candles.h1?.length ? context.candles.h1[context.candles.h1.length - 1].timestamp : 0;
    const p = context.portfolio;
    const portfolioKey = `${p.dailyDrawdownPercent.toFixed(2)}|${p.weeklyDrawdownPercent.toFixed(2)}|${p.openPositionsCount}|${p.openFuturesPositionsCount}|${p.totalLeveragedExposureUsd.toFixed(2)}|${Object.entries(p.existingExposureByAsset || {}).sort().map(([k,v]) => `${k}=${v.toFixed(2)}`).join(',')}`;
    const closedTradesKey = (context.closedTrades || []).map(t => `${t.pnl.toFixed(2)}:${t.at}:${t.symbol}`).join(',');
    const configKey = `${context.config?.minConfidenceOverride ?? 'default'}|${context.config?.maxPositions ?? 'default'}|${context.config?.maxFuturesPositions ?? 'default'}`;
    const cacheKey = `${context.symbol}|${h1Last}|${portfolioKey}|${closedTradesKey}|${configKey}`;
    const cached = legacyResultCache.get(cacheKey);
    if (cached) return cached.result;

    const result = (() => {
      const orchestratorMult = (context.params as Record<string, unknown> | undefined)?._adaptiveMultiplier as number | undefined;
      const closedTrades = (context.closedTrades ?? []) as ClosedTradeMetric[];
      let sizingMultiplier = orchestratorMult ?? 1;
      if (sizingMultiplier === 1 && closedTrades.length >= 5) {
        const perf = summarizeRecentPerformance(closedTrades);
        sizingMultiplier = computeSizingMultiplier(perf, context.portfolio.dailyDrawdownPercent);
      }

      let current: LegacyPipelineContext = { ...context, sizingMultiplier };

      for (const stage of this.stages) {
        const stageResult = stage.execute(current);
        current = stageResult.context as LegacyPipelineContext;
        if (stageResult.blocked) {
          return {
            outcome: 'NO_SIGNAL' as DecisionOutcome,
            gate: stageResult.gate ?? 'UNKNOWN',
            logs: [stageResult.blockReason ?? 'Blocked'],
            summary: stageResult.blockReason ?? 'Blocked',
            layer0: current.layer0,
            layer1: current.layer1,
            layer2: current.layer2,
            layer3: current.layer3
          };
        }
      }

      return {
        outcome: !current.layer1 || current.layer1.action === 'hold' || current.layer2?.type === 'HOLD' ? 'NO_SIGNAL' as DecisionOutcome : 'SIGNAL' as DecisionOutcome,
        gate: current.layer3 ? 'RISK' : current.layer2?.type === 'HOLD' ? (current.layer2.blockReason ?? 'ROUTE') : 'RISK',
        logs: current.layer1?.penalties ?? [],
        summary: current.layer2?.reason ?? 'No signal',
        layer0: current.layer0,
        layer1: current.layer1,
        layer2: current.layer2,
        layer3: current.layer3,
        entryTiming: current.entryTiming
      };
    })();

    legacyResultCache.set(cacheKey, { result, h1Last });
    if (legacyResultCache.size > 200) {
      const first = legacyResultCache.keys().next().value;
      if (first) legacyResultCache.delete(first);
    }
    return result;
  }

  normalize(output: unknown, context: DecisionContext): DecisionResult {
    const result = output as {
      outcome: DecisionOutcome;
      gate: string;
      logs: string[];
      summary: string;
      layer0?: MarketRegimeResult;
      layer1?: SignalEngineResult;
      layer2?: TradeRouterResult;
      layer3?: RiskParametersResult;
      entryTiming?: EntryTimingResult;
    };

    const confidence = result.layer1?.confidence ?? 0;
    const tradeType = result.layer2 ? mapTradeType(result.layer2.type) : 'HOLD';
    const direction = result.layer2 ? mapDirection(result.layer2.side) : 'NONE';
    const minConf = (context.config?.minConfidenceOverride ?? (context.params as Record<string, unknown> | undefined)?.minConfidenceOverride) as number | undefined;
    const blockedByConfidence = typeof minConf === 'number' && result.outcome === 'SIGNAL' && confidence < minConf;

    return {
      engineId: this.id,
      symbol: context.symbol,
      outcome: blockedByConfidence ? 'NO_SIGNAL' : result.outcome,
      gate: blockedByConfidence ? 'MIN_CONFIDENCE' : result.gate,
      tradeType,
      direction,
      confidence,
      riskPlan: mapRiskPlan(result.layer3 ?? null),
      reasoning: [result.summary, ...result.logs],
      metrics: {
        adx: result.layer0?.adx ?? 0,
        atrPercent: result.layer0?.atrPercent ?? 0,
        buyScore: result.layer1?.buyScore ?? 0,
        sellScore: result.layer1?.sellScore ?? 0,
        signalScore: result.layer1?.signalScore ?? 0,
        confidence
      },
      volatilityBand: result.layer0?.volatility ?? 'NONE',
      raw: result
    };
  }
}

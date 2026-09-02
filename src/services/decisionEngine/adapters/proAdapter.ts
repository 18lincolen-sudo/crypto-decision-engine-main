/**
 * Pro Adapter — wraps the Pro alg.md engine (proAlgEngine.ts + proSimExecution.ts)
 * ============================================================================
 * This adapter translates between the unified DecisionEngine types and the
 * Pro engine's specific types (ProSignalResult, ProRouterResult, etc.).
 *
 * The pipeline stages mirror the Pro engine's layer chain:
 *   REGIME → SIGNALS → ROUTE → ENTRY_TIMING → RISK → EXIT
 */

import type {
  EngineParams,
  ClosedTradeRecord,
  DecisionContext,
  DecisionResult,
  EngineAdapter,
  PipelineStage,
  StageResult,
  EngineId,
  RiskPlan,
  TradeType,
  TradeDirection,
  DecisionOutcome
} from '../types';
import {
  detectProRegime,
  evaluateProSignals,
  routeProTradeType,
  calculateProOptimalEntry,
  calculateProRisk,
  evaluateProExit,
  ProMarketRegimeResult,
  ProSignalResult,
  ProRouterResult,
  ProRiskResult,
  ProActivePosition,
  ProExitDecision,
  ProEntryTimingResult,
  dynamicConfidenceThreshold
} from '../../proAlgEngine';
import type { Candle } from '../../tradeEngine';
import { computeProAdvancedAnalysis } from '../../proAdvancedAnalysis';
import { computeDrawdownFactor, computeSizingMultiplier, summarizeRecentPerformance, MIN_STOP_PERCENT, MAX_STOP_PERCENT, MIN_RISK_REWARD_RATIO } from '../../adaptiveRisk';
import { evaluateCorrelationGate, toPositionDirection, CorrelatedHolding, DEFAULT_CORRELATION_LOOKBACK, DEFAULT_CORRELATION_THRESHOLD, DEFAULT_MAX_CORRELATED } from '../../correlation';

// ── Type Mappings ─────────────────────────────────────────────────────────────

function mapTradeType(t: ProRouterResult['type']): TradeType {
  if (t === 'SPOT') return 'SPOT';
  if (t === 'FUTURES') return 'FUTURES';
  return 'HOLD';
}

function mapDirection(side: ProRouterResult['side']): TradeDirection {
  if (side === 'LONG') return 'LONG';
  if (side === 'SHORT') return 'SHORT';
  if (side === 'BUY') return 'BUY';
  if (side === 'SELL') return 'SELL';
  return 'NONE';
}

function mapRiskPlan(risk: ProRiskResult | null): RiskPlan | null {
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
    blockReason: undefined
  };
}

// ── Pipeline Context ──────────────────────────────────────────────────────────

interface ProPipelineContext extends DecisionContext {
  regime?: ProMarketRegimeResult;
  signal?: ProSignalResult;
  router?: ProRouterResult;
  risk?: ProRiskResult;
  entryTiming?: ProEntryTimingResult;
  exitDecision?: ProExitDecision;
  advancedAnalysis?: ReturnType<typeof computeProAdvancedAnalysis>;
  sizingMultiplier?: number;
  blocked?: boolean;
  blockReason?: string;
  gate?: string;
}

// ── Pipeline Stages ───────────────────────────────────────────────────────────

const proResultCache = new Map<string, { result: unknown; h1Last: number }>();

class DetectRegimeStage implements PipelineStage<ProPipelineContext> {
  name = 'detect-regime';

  execute(context: ProPipelineContext): StageResult<ProPipelineContext> {
    const candles = context.candles.h1;
    if (!candles || candles.length < 60) {
      return {
        context,
        blocked: true,
        blockReason: `NO_DATA — insufficient H1 candles: ${candles?.length ?? 0}`,
        gate: 'NO_DATA'
      };
    }

    const regime = detectProRegime(candles, context.currentPrice);
    return { context: { ...context, regime }, blocked: false };
  }
}

class AdvancedAnalysisStage implements PipelineStage<ProPipelineContext> {
  name = 'advanced-analysis';

  execute(context: ProPipelineContext): StageResult<ProPipelineContext> {
    if (!context.regime) {
      return { context, blocked: true, blockReason: 'Missing regime', gate: 'ERROR' };
    }

    // Use Advanced Analysis as the signal source (per approved product decision)
    const adv = computeProAdvancedAnalysis({
      candles: context.candles.h1,
      currentPrice: context.currentPrice,
      priceChange24h: context.marketData.priceChange24h ?? 0,
      fearGreedIndex: context.marketData.fearGreedIndex ?? 50,
      marketCap: context.marketData.marketCap ?? 0,
      volume24h: context.marketData.volume24h ?? 0,
      symbol: context.symbol
    });

    const signal: ProSignalResult = {
      action: adv.action,
      buyScore: adv.action === 'BUY' ? adv.confidence : adv.action === 'SELL' ? 0 : 50,
      sellScore: adv.action === 'SELL' ? adv.confidence : adv.action === 'BUY' ? 0 : 50,
      rawConfidence: adv.confidence,
      confidence: adv.confidence,
      signals: adv.signals as ProSignalResult['signals'],
      penalties: adv.penalties
    };

    return { context: { ...context, signal, advancedAnalysis: adv }, blocked: false };
  }
}

class RouteTradeTypeStage implements PipelineStage<ProPipelineContext> {
  name = 'route-trade-type';

  execute(context: ProPipelineContext): StageResult<ProPipelineContext> {
    if (!context.signal || !context.regime) {
      return { context, blocked: true, blockReason: 'Missing signal or regime', gate: 'ERROR' };
    }

    const hasExistingFutures = context.openPositions.some(p => p.type === 'FUTURES' && p.symbol === context.symbol);

    const router = routeProTradeType(context.signal, context.regime, {
      hasExistingFutures,
      isDailyBlocked: context.portfolio.dailyDrawdownPercent >= 8,
      isWeeklyLocked: context.portfolio.weeklyDrawdownPercent >= 15
    });

    return { context: { ...context, router }, blocked: router.type === 'HOLD' || !!router.hardGateBlocked };
  }
}

class EntryTimingStage implements PipelineStage<ProPipelineContext> {
  name = 'entry-timing';

  execute(context: ProPipelineContext): StageResult<ProPipelineContext> {
    if (!context.router || !context.regime || !context.signal) {
      return { context, blocked: false };
    }

    if (context.router.type === 'HOLD' || context.router.hardGateBlocked || context.signal.action === 'HOLD') {
      return { context, blocked: false };
    }

    const timing = calculateProOptimalEntry(
      context.currentPrice,
      context.regime.atr,
      context.signal.action,
      context.candles.h1 as Candle[],
      context.signal.rawConfidence
    );

    return { context: { ...context, entryTiming: timing }, blocked: !timing.shouldEnter };
  }
}

class RiskParametersStage implements PipelineStage<ProPipelineContext> {
  name = 'risk-parameters';

  execute(context: ProPipelineContext): StageResult<ProPipelineContext> {
    if (!context.router || !context.regime || !context.signal) {
      return { context, blocked: false };
    }

    if (context.router.type === 'HOLD' || context.router.hardGateBlocked) {
      return { context, blocked: false };
    }

    const entryPrice = context.entryTiming?.entryPrice ?? context.currentPrice;
    const futuresCount = context.openPositions.filter(p => p.type === 'FUTURES').length;

    // Combine entry timing size reduction with adaptive multiplier
    const entrySizeMultiplier = context.entryTiming?.sizeMultiplier ?? 1.0;
    const adaptiveMult = context.sizingMultiplier ?? 1.0;
    const combinedMultiplier = Math.max(0, adaptiveMult * entrySizeMultiplier);

    const risk = calculateProRisk(
      entryPrice,
      context.router.type,
      context.router.side,
      context.regime.atr,
      context.regime.volatility,
      context.signal.rawConfidence,
      context.portfolio.portfolioValue,
      (context.closedTrades ?? []) as ClosedTradeRecord[],
      context.portfolio.openPositionsCount,
      futuresCount,
      context.portfolio.totalLeveragedExposureUsd,
      context.portfolio.dailyDrawdownPercent,
      combinedMultiplier,
      undefined,
      context.config?.maxPositions ?? 7,
      context.config?.maxFuturesPositions ?? 2
    );

    return { context: { ...context, risk: risk ?? undefined }, blocked: !risk };
  }
}

class CorrelationGateStage implements PipelineStage<ProPipelineContext> {
  name = 'correlation-gate';

  execute(context: ProPipelineContext): StageResult<ProPipelineContext> {
    if (!context.router || context.router.type === 'HOLD') {
      return { context, blocked: false };
    }

    const held: CorrelatedHolding[] = context.openPositions.map(p => ({
      symbol: p.symbol,
      direction: toPositionDirection(p.side)
    }));

    const gate = evaluateCorrelationGate({
      symbol: context.symbol,
      direction: toPositionDirection(context.router.side),
      held,
      candlesBySymbol: { [context.symbol]: context.candles.h1 as Candle[] },
      threshold: DEFAULT_CORRELATION_THRESHOLD,
      maxCorrelated: DEFAULT_MAX_CORRELATED,
      lookback: DEFAULT_CORRELATION_LOOKBACK
    });

    return { context, blocked: !gate.allowed };
  }
}

class CostEdgeGateStage implements PipelineStage<ProPipelineContext> {
  name = 'cost-edge-gate';

  execute(context: ProPipelineContext): StageResult<ProPipelineContext> {
    if (!context.risk) {
      return { context, blocked: false };
    }

    if (context.risk.riskRewardRatio < MIN_RISK_REWARD_RATIO) {
      return {
        context,
        blocked: true,
        blockReason: `Risk-reward ratio ${context.risk.riskRewardRatio.toFixed(2)} < ${MIN_RISK_REWARD_RATIO}`,
        gate: 'COST_EDGE'
      };
    }

    return { context, blocked: false };
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class ProAdapter implements EngineAdapter<ProPipelineContext> {
  id: EngineId = 'pro';
  name = 'Pro alg.md';
  params: EngineParams = {};

  private stages: PipelineStage<ProPipelineContext>[] = [
    new DetectRegimeStage(),
    new AdvancedAnalysisStage(),
    new RouteTradeTypeStage(),
    new EntryTimingStage(),
    new RiskParametersStage(),
    new CorrelationGateStage(),
    new CostEdgeGateStage()
  ];

  canHandle(input: Partial<DecisionContext>): boolean {
    // Pro needs at least H1 candles
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
    const cached = proResultCache.get(cacheKey);
    if (cached) return cached.result;

    const result = (() => {
      const orchestratorMult = (context.params as Record<string, unknown> | undefined)?._adaptiveMultiplier as number | undefined;
      const closedTrades = (context.closedTrades ?? []) as ClosedTradeRecord[];
      let sizingMultiplier = orchestratorMult ?? 1;
      if (sizingMultiplier === 1 && closedTrades.length >= 5) {
        const perf = summarizeRecentPerformance(closedTrades);
        sizingMultiplier = computeSizingMultiplier(perf, context.portfolio.dailyDrawdownPercent);
      }

      let current: ProPipelineContext = { ...context, sizingMultiplier };

      for (const stage of this.stages) {
        const stageResult = stage.execute(current);
        current = stageResult.context as ProPipelineContext;
        if (stageResult.blocked) {
          return {
            outcome: 'NO_SIGNAL' as DecisionOutcome,
            gate: stageResult.gate ?? 'UNKNOWN',
            logs: [stageResult.blockReason ?? 'Blocked'],
            summary: stageResult.blockReason ?? 'Blocked',
            regime: current.regime,
            signal: current.signal,
            router: current.router,
            risk: current.risk
          };
        }
      }

      return {
        outcome: current.router?.type === 'HOLD' ? 'NO_SIGNAL' as DecisionOutcome : 'SIGNAL' as DecisionOutcome,
        gate: current.risk ? 'RISK' : current.router?.type === 'HOLD' ? (current.router.blockReason ?? 'ROUTE') : 'RISK',
        logs: current.signal?.penalties ?? [],
        summary: current.router?.reason ?? 'No signal',
        regime: current.regime,
        signal: current.signal,
        router: current.router,
        risk: current.risk,
        advancedAnalysis: current.advancedAnalysis
      };
    })();

    proResultCache.set(cacheKey, { result, h1Last });
    if (proResultCache.size > 200) {
      const first = proResultCache.keys().next().value;
      if (first) proResultCache.delete(first);
    }
    return result;
  }

  normalize(output: unknown, context: DecisionContext): DecisionResult {
    const result = output as {
      outcome: DecisionOutcome;
      gate: string;
      logs: string[];
      summary: string;
      regime?: ProMarketRegimeResult;
      signal?: ProSignalResult;
      router?: ProRouterResult;
      risk?: ProRiskResult;
      advancedAnalysis?: ReturnType<typeof computeProAdvancedAnalysis>;
    };

    const confidence = result.signal?.confidence ?? 0;
    const tradeType = result.router ? mapTradeType(result.router.type) : 'HOLD';
    const direction = result.router ? mapDirection(result.router.side) : 'NONE';
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
      riskPlan: mapRiskPlan(result.risk ?? null),
      reasoning: [result.summary, ...result.logs],
      metrics: {
        adx: result.regime?.adx ?? 0,
        atrPercent: result.regime?.atrPercent ?? 0,
        buyScore: result.signal?.buyScore ?? 0,
        sellScore: result.signal?.sellScore ?? 0,
        confidence
      },
      volatilityBand: result.regime?.volatility ?? 'NONE',
      raw: result
    };
  }
}

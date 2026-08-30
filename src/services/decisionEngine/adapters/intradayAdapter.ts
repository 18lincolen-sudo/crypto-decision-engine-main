/**
 * Intraday Adapter — wraps the Intraday MTF engine (evaluateIntradayDecision)
 * ============================================================================
 * This adapter translates between the unified DecisionEngine types and the
 * intraday engine's specific types (IntradayDecisionInput, IntradayDecision).
 *
 * The pipeline stages mirror the engine's gate chain:
 *   NO_DATA → CIRCUIT_BREAKER → EXPOSURE → REGIME → SETUP → ENTRY →
 *   TRADE_TYPE → LIQUIDITY → SPREAD → COST → RISK
 */

import {
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
  MultiTimeframeCandles
} from './types';
import {
  evaluateIntradayDecision,
  IntradayDecisionInput,
  IntradayDecision,
  TradeType as IntradayTradeType,
  Direction as IntradayDirection,
  DecisionGate as IntradayDecisionGate,
  DecisionOutcome as IntradayDecisionOutcome,
  SetupType as IntradaySetupType
} from '../intradayEngine';
import { DEFAULT_INTRADAY_PARAMS, IntradayParams, DecisionGate, Direction, SetupType } from '../intradayParams';
import { Candle, PortfolioRiskStats, formatDynamicPrice } from '../tradeEngine';

// ── Type Mappings ─────────────────────────────────────────────────────────────

function mapTradeType(t: IntradayTradeType | null): TradeType {
  if (t === 'SPOT') return 'SPOT';
  if (t === 'FUTURES') return 'FUTURES';
  return 'HOLD';
}

function mapDirection(d: IntradayDirection): TradeDirection {
  if (d === 'LONG') return 'LONG';
  if (d === 'SHORT') return 'SHORT';
  return 'NONE';
}

function mapOutcome(o: IntradayDecisionOutcome): DecisionOutcome {
  if (o === 'SIGNAL') return 'SIGNAL';
  if (o === 'NO_DATA') return 'NO_DATA';
  return 'NO_SIGNAL';
}

function mapRiskPlan(risk: IntradayDecision['risk']): RiskPlan | null {
  if (!risk || !risk.approved) return null;
  return {
    approved: risk.approved,
    stopLoss: risk.stopLoss,
    takeProfit1: risk.takeProfit1,
    takeProfit2: risk.takeProfit2,
    takeProfit: risk.takeProfit1,
    leverage: risk.leverage,
    betSizeUsd: risk.notionalUsd,
    positionPercentOfPortfolio: risk.positionPercentOfEquity,
    riskRewardRatio: risk.rewardRisk1,
    kellyFraction: 0,
    maxRiskAmountUsd: risk.riskUsd,
    stopDistanceUsd: risk.stopDistance,
    blockReason: risk.blockReason
  };
}

// ── Pipeline Stages ───────────────────────────────────────────────────────────

class ValidateInputStage implements PipelineStage<DecisionContext> {
  name = 'validate-input';

  execute(context: DecisionContext): StageResult<DecisionContext> {
    const candles = context.candles;
    const min1h = 200;
    const min15m = 300;
    const min5m = 500;

    if (!candles.h1 || candles.h1.length < min1h ||
        !candles.m15 || candles.m15.length < min15m ||
        !candles.m5 || candles.m5.length < min5m) {
      return {
        context,
        blocked: true,
        blockReason: `NO_DATA — insufficient candles: 1h=${candles.h1?.length ?? 0}, 15m=${candles.m15?.length ?? 0}, 5m=${candles.m5?.length ?? 0}`,
        gate: 'NO_DATA'
      };
    }

    return { context, blocked: false };
  }
}

class CircuitBreakerStage implements PipelineStage<DecisionContext> {
  name = 'circuit-breaker';

  execute(context: DecisionContext): StageResult<DecisionContext> {
    const p = context.portfolio;
    const params = context.params as Partial<IntradayParams> ?? {};

    if (p.systemLocked) {
      return {
        context,
        blocked: true,
        blockReason: `CIRCUIT_BREAKER — system locked: ${p.lockReason ?? 'unknown'}`,
        gate: 'CIRCUIT_BREAKER'
      };
    }

    const dailyBlock = params.dailyDrawdownBlockPercent ?? 8;
    const weeklyLock = params.weeklyDrawdownLockPercent ?? 15;

    if (p.dailyDrawdownPercent >= dailyBlock) {
      return {
        context,
        blocked: true,
        blockReason: `CIRCUIT_BREAKER — daily drawdown ${p.dailyDrawdownPercent.toFixed(1)}% >= ${dailyBlock}%`,
        gate: 'CIRCUIT_BREAKER'
      };
    }

    if (p.weeklyDrawdownPercent >= weeklyLock) {
      return {
        context,
        blocked: true,
        blockReason: `CIRCUIT_BREAKER — weekly drawdown ${p.weeklyDrawdownPercent.toFixed(1)}% >= ${weeklyLock}%`,
        gate: 'CIRCUIT_BREAKER'
      };
    }

    return { context, blocked: false };
  }
}

class ExposureStage implements PipelineStage<DecisionContext> {
  name = 'exposure';

  execute(context: DecisionContext): StageResult<DecisionContext> {
    const p = context.portfolio;
    const params = context.params as Partial<IntradayParams> ?? {};
    const maxPositions = params.maxOpenPositions ?? 7;

    if (p.openPositionsCount >= maxPositions) {
      return {
        context,
        blocked: true,
        blockReason: `EXPOSURE — ${p.openPositionsCount} open positions (max ${maxPositions})`,
        gate: 'EXPOSURE'
      };
    }

    const sameAsset = context.openPositions.find(o => o.symbol === context.symbol);
    if (sameAsset) {
      return {
        context,
        blocked: true,
        blockReason: `EXPOSURE — same asset already open (${sameAsset.type})`,
        gate: 'EXPOSURE'
      };
    }

    return { context, blocked: false };
  }
}

class RunEngineStage implements PipelineStage<DecisionContext> {
  name = 'run-engine';

  execute(context: DecisionContext): StageResult<DecisionContext> {
    // Convert unified types to intraday types
    const input: IntradayDecisionInput = {
      symbol: context.symbol,
      h1: context.candles.h1 as Candle[],
      m15: (context.candles.m15 ?? []) as Candle[],
      m5: (context.candles.m5 ?? []) as Candle[],
      spreadPercent: context.marketData.spreadPercent,
      quoteVolume24h: context.marketData.quoteVolume24h,
      quoteVolume24hSpot: context.marketData.quoteVolume24hSpot,
      livePrice: context.marketData.livePrice ?? context.currentPrice,
      portfolio: context.portfolio as PortfolioRiskStats,
      openPositions: context.openPositions,
      params: (context.params as Partial<IntradayParams>) ?? DEFAULT_INTRADAY_PARAMS,
      now: context.now,
      existingExposureByAsset: context.portfolio.existingExposureByAsset
    };

    const result = evaluateIntradayDecision(input);

    // Store the raw result in context for normalization
    (context as unknown as { _rawResult: IntradayDecision })._rawResult = result;

    if (result.outcome === 'SIGNAL') {
      return { context, blocked: false };
    }

    return {
      context,
      blocked: true,
      blockReason: result.logs[result.logs.length - 1] ?? result.summary,
      gate: result.gate
    };
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class IntradayAdapter implements EngineAdapter<DecisionContext> {
  id: EngineId = 'intraday';
  name = 'Intraday MTF';
  params: EngineParams = {};

  private stages: PipelineStage<DecisionContext>[] = [
    new ValidateInputStage(),
    new CircuitBreakerStage(),
    new ExposureStage(),
    new RunEngineStage()
  ];

  canHandle(input: Partial<DecisionContext>): boolean {
    // Intraday needs multi-timeframe data
    return !!(
      input.candles?.m15 && input.candles?.m5 &&
      input.candles.m15.length >= 300 && input.candles.m5.length >= 500
    );
  }

  execute(context: DecisionContext): unknown {
    // Run stages sequentially
    let current = context;
    for (const stage of this.stages) {
      const result = stage.execute(current);
      current = result.context;
      if (result.blocked) {
        // Return a blocked result
        return {
          outcome: 'NO_SIGNAL' as DecisionOutcome,
          gate: result.gate ?? 'UNKNOWN',
          logs: [result.blockReason ?? 'Blocked'],
          summary: result.blockReason ?? 'Blocked'
        };
      }
    }

    // Return the raw intraday result
    return (current as unknown as { _rawResult: IntradayDecision })._rawResult;
  }

  normalize(output: unknown, context: DecisionContext): DecisionResult {
    const result = output as IntradayDecision;

    return {
      engineId: this.id,
      symbol: result.symbol,
      outcome: mapOutcome(result.outcome),
      gate: result.gate,
      tradeType: mapTradeType(result.tradeType),
      direction: mapDirection(result.direction),
      confidence: result.entry
        ? Math.round(((result.setup?.setupScore ?? 0) + result.entry.entryScore) / 2)
        : result.setup
        ? Math.round(result.setup.setupScore)
        : 0,
      riskPlan: mapRiskPlan(result.risk),
      reasoning: result.logs,
      metrics: {
        setupScore: result.metrics.setupScore,
        entryScore: result.metrics.entryScore,
        edgeRatio: result.metrics.edgeRatio,
        netRewardRisk: result.metrics.netRewardRisk,
        riskPercent: result.metrics.riskPercent,
        atrPercentile: result.metrics.atrPercentile,
        volatility: result.metrics.volatility
      },
      raw: result
    };
  }
}

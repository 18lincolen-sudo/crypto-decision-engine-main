// DecisionEngine adapter for the 4H Path engine (bot 4).
//
// Thinner than the other three by design. Legacy, Pro and Intraday each run a
// multi-stage pipeline inside their adapter because their decision IS a
// sequence of scored judgements. This bot's decision is a table lookup plus a
// trigger, so the adapter's whole job is to hand the engine its inputs and
// translate one result shape into another.
//
// It is still an adapter rather than a direct call, for two reasons that matter
// operationally: the DecisionEngine is where every bot's result acquires the
// same `gate` / `reasoning` / `metrics` surface the UI and the decision log read,
// and routing through it means the fourth bot cannot quietly drift into a
// different result contract than the three it is being compared against.

import { evaluatePathDecision, pathKellyFraction } from '../../pathEngine';
import type { PathDecision } from '../../pathEngine';
import type { PathBucket } from '../../pathStudy';
import type {
  DecisionContext,
  DecisionResult,
  EngineAdapter,
  EngineId,
  EngineParams,
  RiskPlan
} from '../types';

/** Params this adapter reads off the DecisionContext. The table is passed in
 *  rather than imported: it is state that belongs to whoever ran the study, and
 *  an engine that reached for a module-level table would be untestable and
 *  impossible to run two of at different calibrations. */
export interface PathEngineParams extends EngineParams {
  pathTable?: PathBucket[];
  minExpectedR?: number;
}

export class PathAdapter implements EngineAdapter<DecisionContext> {
  id: EngineId = 'path';
  name = '4H Path';
  params: EngineParams = {};

  canHandle(input: Partial<DecisionContext>): boolean {
    // 244 H1 candles is what aggregateToH4 needs to produce 61 closed 4H bars,
    // and 61 is what labelBarState needs (60 prior + the one being labelled).
    return !!(input.candles?.h1 && input.candles.h1.length >= 244 && input.candles.m5?.length);
  }

  execute(context: DecisionContext): unknown {
    const params = (context.params ?? {}) as PathEngineParams;
    return evaluatePathDecision({
      symbol: context.symbol,
      h1: context.candles.h1,
      m15: context.candles.m15 ?? [],
      m5: context.candles.m5 ?? [],
      livePrice: context.currentPrice,
      fearGreedIndex: context.marketData?.fearGreedIndex ?? 50,
      table: params.pathTable ?? [],
      now: context.now ?? Date.now(),
      minExpectedR: params.minExpectedR
    });
  }

  normalize(raw: unknown, context: DecisionContext): DecisionResult {
    const decision = raw as PathDecision;
    const isSignal = decision.outcome === 'SIGNAL';
    const bucket = decision.bucket;

    // No risk plan without a bucket: the size is derived from the bucket's own
    // measured probability, so "approved but unsized" is not a state this engine
    // can be in.
    const riskPlan: RiskPlan | null = isSignal && bucket && decision.stopLoss !== undefined
      ? {
          approved: true,
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit,
          takeProfit1: decision.takeProfit,
          leverage: 1,
          betSizeUsd: Number((context.portfolio.portfolioValue * pathKellyFraction(bucket)).toFixed(2)),
          positionPercentOfPortfolio: Number((pathKellyFraction(bucket) * 100).toFixed(2)),
          riskRewardRatio: bucket.tpR / bucket.slR,
          kellyFraction: Number(pathKellyFraction(bucket).toFixed(4)),
          stopDistanceUsd: decision.riskUnit
        }
      : null;

    return {
      engineId: 'path',
      symbol: decision.symbol,
      outcome: isSignal ? 'SIGNAL' : 'NO_SIGNAL',
      gate: isSignal ? 'APPROVED' : decision.gate,
      tradeType: isSignal ? 'SPOT' : 'HOLD',
      tradeSide: isSignal ? 'BUY' : 'NONE',
      direction: isSignal ? (decision.direction as 'LONG' | 'SHORT') : 'NONE',
      confidence: decision.confidence,
      riskPlan,
      reasoning: decision.reasoning,
      metrics: {
        slot: decision.slot,
        armedSlot: decision.armedSlot ?? -1,
        expectedR: decision.expectedR ?? 0,
        pLow: bucket?.pLow ?? 0,
        tpR: bucket?.tpR ?? 0,
        samples: bucket?.rawN ?? 0
      },
      raw: decision
    } as DecisionResult;
  }
}

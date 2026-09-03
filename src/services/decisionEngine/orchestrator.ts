/**
 * DecisionEngine — unified orchestrator for all trading algorithms
 * ============================================================================
 * Runs any engine's pipeline through a common interface, handling:
 *   - Adapter selection
 *   - Pipeline execution with stage-level blocking
 *   - Cross-cutting concerns (correlation gate, adaptive risk)
 *   - Result normalization
 */

// Types from ./types, VALUES from the modules that own them. Importing values
// through the types barrel is what broke the worker's esbuild bundle and made
// toPositionDirection resolve to `undefined` at runtime.
import type {
  DecisionContext,
  DecisionResult,
  EngineAdapter,
  EngineId,
  ResultEngineId,
  RiskPlan,
  Candle,
  ClosedTradeRecord
} from './types';
import {
  evaluateCorrelationGate,
  toPositionDirection,
  DEFAULT_CORRELATION_LOOKBACK,
  DEFAULT_CORRELATION_THRESHOLD,
  DEFAULT_MAX_CORRELATED
} from '../correlation';
import type { CorrelatedHolding } from '../correlation';
import {
  summarizeRecentPerformance,
  computeSizingMultiplier,
  isInStreakCooldown,
  streakCooldownFromHistory
} from '../adaptiveRisk';

export interface DecisionEngineOptions {
  /** Enable adaptive risk (default: true) */
  adaptiveRisk?: boolean;
  /** Log all stage transitions (default: false) */
  verbose?: boolean;
  /** Run the cross-asset correlation gate on approved trades (default: true).
   *  It abstains harmlessly when open positions carry no candle history. */
  correlationGate?: boolean;
  /** |rho| at or above which two positions count as the same risk factor. */
  correlationThreshold?: number;
  /** How many correlated same-direction positions are tolerated. */
  maxCorrelatedPositions?: number;
  /** Bars of history used for the correlation estimate. */
  correlationLookback?: number;
}

export class DecisionEngine {
  private adapters: Map<EngineId, EngineAdapter<DecisionContext>> = new Map();
  private options: Required<DecisionEngineOptions>;

  constructor(options: DecisionEngineOptions = {}) {
    this.options = {
      adaptiveRisk: options.adaptiveRisk ?? true,
      verbose: options.verbose ?? false,
      correlationGate: options.correlationGate ?? true,
      correlationThreshold: options.correlationThreshold ?? DEFAULT_CORRELATION_THRESHOLD,
      maxCorrelatedPositions: options.maxCorrelatedPositions ?? DEFAULT_MAX_CORRELATED,
      correlationLookback: options.correlationLookback ?? DEFAULT_CORRELATION_LOOKBACK
    };
  }

  /** Register an engine adapter */
  registerAdapter(adapter: EngineAdapter<DecisionContext>): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** Get a registered adapter by ID */
  getAdapter(id: EngineId): EngineAdapter<DecisionContext> | undefined {
    return this.adapters.get(id);
  }

  /** List all registered engine IDs */
  getRegisteredEngines(): EngineId[] {
    return Array.from(this.adapters.keys());
  }

  /** Select the best adapter for the given input */
  selectAdapter(input: Partial<DecisionContext>, engineId?: EngineId): EngineAdapter<DecisionContext> | null {
    // If engineId is specified, return the exact adapter (caller explicitly requested it)
    if (engineId) {
      const explicit = this.adapters.get(engineId);
      if (explicit) {
        return explicit;
      }
      return null;
    }
    // Otherwise, try canHandle match in registration order
    for (const adapter of this.adapters.values()) {
      if (adapter.canHandle(input)) {
        return adapter;
      }
    }
    return null;
  }

  /**
   * Evaluate a symbol using the appropriate engine
   * This is the main entry point — callers don't need to know which engine is used.
   * Optionally pass engineId to explicitly select a specific engine.
   */
  evaluate(input: DecisionContext, engineId?: EngineId): DecisionResult {
    const adapter = this.selectAdapter(input, engineId);
    if (!adapter) {
      return this.noSignalResult(input, engineId ?? 'unknown', 'NO_ADAPTER', 'No engine can handle this input');
    }

    if (this.options.verbose) {
      console.log(`[DecisionEngine] Selected adapter: ${adapter.name} (${adapter.id})`);
    }

    // Compute adaptive risk multiplier if enabled
    let adaptiveMultiplier: number | undefined;
    if (this.options.adaptiveRisk && input.closedTrades && input.closedTrades.length > 0) {
      const perf = summarizeRecentPerformance(input.closedTrades as ClosedTradeRecord[]);
      if (perf.sampleSize >= 5) {
        adaptiveMultiplier = computeSizingMultiplier(perf, input.portfolio.dailyDrawdownPercent);
        if (this.options.verbose) {
          console.log(`[DecisionEngine] Adaptive multiplier: ${adaptiveMultiplier.toFixed(3)} (streak: ${perf.lossStreak}L/${perf.winStreak}W, winRate: ${(perf.winRate * 100).toFixed(1)}%)`);
        }
      }
    }

    // Check per-symbol streak cooldown
    if (input.closedTrades && input.closedTrades.length > 0) {
      const cooldownUntil = streakCooldownFromHistory(
        input.closedTrades as ClosedTradeRecord[],
        input.portfolio.portfolioValue,
        input.symbol
      );
      if (isInStreakCooldown(cooldownUntil, input.now)) {
        return this.noSignalResult(input, adapter.id, 'STREAK_COOLDOWN', `Symbol in streak cooldown until ${new Date(cooldownUntil!).toISOString()}`);
      }
    }

    // Run the pipeline
    const context = { ...input, params: { ...input.params, _adaptiveMultiplier: adaptiveMultiplier } } as DecisionContext & { params: Record<string, unknown> };

    try {
      const rawOutput = adapter.execute(context);

      // Normalize the result
      let result = adapter.normalize(rawOutput, context);

      // Apply correlation gate if enabled and trade is approved
      if (this.options.correlationGate && result.outcome === 'SIGNAL' && result.tradeType !== 'HOLD') {
        const gateResult = this.checkCorrelationGate(context, result);
        if (!gateResult.allowed) {
          result = {
            ...result,
            outcome: 'NO_SIGNAL',
            gate: 'CORRELATION',
            // The block reason must LEAD: the UI shows reasoning[0] as the
            // headline, so appending it left a rejected trade explaining itself
            // with the reason it had been approved.
            reasoning: [
              `CORRELATION_GATE — ${gateResult.reason ?? 'correlation threshold exceeded'}`,
              ...result.reasoning
            ]
          };
        }
      }

      return result;
    } catch (error) {
      console.error(`[DecisionEngine] Error in ${adapter.name}:`, error);
      return this.noSignalResult(input, adapter.id, 'ERROR', `Engine error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Check correlation gate for a candidate trade */
  private checkCorrelationGate(context: DecisionContext, result: DecisionResult): { allowed: boolean; reason?: string } {
    const held: CorrelatedHolding[] = context.openPositions
      .filter(p => p.symbol !== context.symbol)
      .map(p => ({
        symbol: p.symbol,
        direction: toPositionDirection(p.side)
      }));

    if (held.length === 0) {
      return { allowed: true };
    }

    // The candidate's OWN series has to be in the map too — evaluateCorrelationGate
    // looks itself up by `symbol` and abstains when it finds nothing, so a map
    // holding only the held positions made the gate a no-op that always allowed.
    const candlesBySymbol: Record<string, Candle[]> = {};
    if (context.candles?.h1?.length) {
      candlesBySymbol[context.symbol] = context.candles.h1;
    }
    for (const pos of context.openPositions) {
      if (pos.symbol !== context.symbol && pos.candles && pos.candles.length > 0) {
        candlesBySymbol[pos.symbol] = pos.candles;
      }
    }

    // Nothing to compare against: every held position lacks history. Abstain
    // loudly rather than silently approving as if the check had run.
    if (Object.keys(candlesBySymbol).length < 2) {
      if (this.options.verbose) {
        console.warn(`[DecisionEngine] correlation gate abstained for ${context.symbol}: open positions carry no candle history`);
      }
      return { allowed: true };
    }

    const gate = evaluateCorrelationGate({
      symbol: context.symbol,
      direction: toPositionDirection(result.direction),
      held,
      candlesBySymbol,
      threshold: this.options.correlationThreshold ?? DEFAULT_CORRELATION_THRESHOLD,
      maxCorrelated: this.options.maxCorrelatedPositions ?? DEFAULT_MAX_CORRELATED,
      lookback: this.options.correlationLookback ?? DEFAULT_CORRELATION_LOOKBACK
    });

    return { allowed: gate.allowed, reason: gate.reason };
  }

  /** Create a NO_SIGNAL result */
  private noSignalResult(context: DecisionContext, engineId: ResultEngineId, gate: string, reason: string): DecisionResult {
    return {
      engineId,
      symbol: context.symbol,
      outcome: 'NO_SIGNAL',
      gate,
      tradeType: 'HOLD',
      direction: 'NONE',
      confidence: 0,
      riskPlan: null,
      reasoning: [reason],
      metrics: {}
    };
  }
}

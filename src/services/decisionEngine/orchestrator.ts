/**
 * DecisionEngine — unified orchestrator for all trading algorithms
 * ============================================================================
 * Runs any engine's pipeline through a common interface, handling:
 *   - Adapter selection
 *   - Pipeline execution with stage-level blocking
 *   - Cross-cutting concerns (correlation gate, adaptive risk)
 *   - Result normalization
 */

import {
  DecisionContext,
  DecisionResult,
  EngineAdapter,
  PipelineStage,
  StageResult,
  EngineId,
  RiskPlan,
  ClosedTradeRecord,
  CorrelatedHolding,
  Candle,
  evaluateCorrelationGate,
  toPositionDirection,
  DEFAULT_CORRELATION_LOOKBACK,
  DEFAULT_CORRELATION_THRESHOLD,
  DEFAULT_MAX_CORRELATED,
  summarizeRecentPerformance,
  computeSizingMultiplier,
  sizingMultiplierFromHistory,
  isInStreakCooldown,
  streakCooldownFromHistory
} from './types';

export interface DecisionEngineOptions {
  /** Enable correlation gate (default: true) */
  correlationGate?: boolean;
  /** Correlation gate tuning */
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
  /** Enable adaptive risk (default: true) */
  adaptiveRisk?: boolean;
  /** Log all stage transitions (default: false) */
  verbose?: boolean;
}

export class DecisionEngine {
  private adapters: Map<EngineId, EngineAdapter<DecisionContext>> = new Map();
  private options: Required<DecisionEngineOptions>;

  constructor(options: DecisionEngineOptions = {}) {
    this.options = {
      correlationGate: options.correlationGate ?? true,
      correlationThreshold: options.correlationThreshold ?? DEFAULT_CORRELATION_THRESHOLD,
      maxCorrelatedPositions: options.maxCorrelatedPositions ?? DEFAULT_MAX_CORRELATED,
      correlationLookback: options.correlationLookback ?? DEFAULT_CORRELATION_LOOKBACK,
      adaptiveRisk: options.adaptiveRisk ?? true,
      verbose: options.verbose ?? false
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
    // If engineId is specified, try exact match first
    if (engineId) {
      const explicit = this.adapters.get(engineId);
      if (explicit && explicit.canHandle(input)) {
        return explicit;
      }
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
            reasoning: [...result.reasoning, `Correlation gate: ${gateResult.reason}`]
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

    const candlesBySymbol: Record<string, Candle[]> = {};
    for (const pos of context.openPositions) {
      if (pos.symbol !== context.symbol && pos.candles) {
        candlesBySymbol[pos.symbol] = pos.candles;
      }
    }

    const gate = evaluateCorrelationGate({
      symbol: context.symbol,
      direction: toPositionDirection(result.direction),
      held,
      candlesBySymbol,
      threshold: this.options.correlationThreshold,
      maxCorrelated: this.options.maxCorrelatedPositions,
      lookback: this.options.correlationLookback
    });

    return { allowed: gate.allowed, reason: gate.reason };
  }

  /** Create a NO_SIGNAL result */
  private noSignalResult(context: DecisionContext, engineId: EngineId, gate: string, reason: string): DecisionResult {
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

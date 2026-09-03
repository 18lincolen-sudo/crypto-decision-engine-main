/**
 * DecisionEngine — unified decision-making framework
 * ============================================================================
 * Public API for the DecisionEngine module.
 *
 * Usage:
 *   import { DecisionEngine, IntradayAdapter, LegacyAdapter, ProAdapter } from './decisionEngine';
 *
 *   const engine = new DecisionEngine();
 *   engine.registerAdapter(new IntradayAdapter());
 *   engine.registerAdapter(new LegacyAdapter());
 *   engine.registerAdapter(new ProAdapter());
 *
 *   const result = await engine.evaluate({
 *     symbol: 'BTCUSDT',
 *     candles: { h1: [...], m15: [...], m5: [...] },
 *     currentPrice: 67500,
 *     portfolio: { ... },
 *     openPositions: [],
 *     marketData: { ... },
 *     params: { ... }
 *   });
 */

export { DecisionEngine } from './orchestrator';
export type { DecisionEngineOptions } from './orchestrator';

export { IntradayAdapter } from './adapters/intradayAdapter';
export { LegacyAdapter } from './adapters/legacyAdapter';
export { ProAdapter } from './adapters/proAdapter';

export type {
  DecisionContext,
  DecisionResult,
  EngineAdapter,
  PipelineStage,
  StageResult,
  EngineId,
  RiskPlan,
  TradeDirection,
  TradeType,
  DecisionOutcome,
  EngineParams,
  MarketDataSnapshot,
  PortfolioRiskStats,
  OpenPosition,
  MultiTimeframeCandles,
  ClosedTradeRecord
} from './types';

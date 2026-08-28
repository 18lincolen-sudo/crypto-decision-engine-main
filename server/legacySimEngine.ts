// Server-side simulation engine for the LEGACY (original alg.md) algorithm —
// single-timeframe H1 regime + weighted-confidence scoring
// (legacySimExecution.ts, UNCHANGED by this refactor). All of the
// tick/market-data/persistence plumbing that used to be duplicated across
// this file, simEngine.ts and proSimEngine.ts now lives in
// server/simEngineFactory.ts — this file only supplies the legacy-specific
// evaluation/order-generation adapter.
import { buildLegacyEvaluations, generateLegacyOrders, MIN_LEGACY_CANDLES } from '../src/services/legacySimExecution';
import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '../src/services/simExecution';
export type LegacySimSnapshot = SimSnapshot;

const legacyStrategy: SimEngineStrategy = {
  id: 'legacy',
  logPrefix: '[legacy-sim-engine]',
  telegramTag: 'legacy-sim',
  telegramTitle: '🤖 מנוע מקורי · Confidence Score',
  statusFooterLabel: 'מצב כולל של הבוט (לגאסי)',
  minConfidence: 58,
  minCandlesForH1View: MIN_LEGACY_CANDLES,
  logCandleFetch: false,

  buildEvaluations(input: StrategyTickInput) {
    return buildLegacyEvaluations({
      cryptoData: input.cryptoData,
      candlesBySymbol: input.candlesBySymbol,
      positions: input.positions,
      pending: input.pending,
      config: input.config,
      equity: input.equity,
      totalLeveragedExposureUsd: input.totalLeveragedExposureUsd,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      fearGreedIndex: input.fearGreedIndex,
      closedTradeMetrics: input.closedTradeMetrics
    });
  },

  generateOrders(input: StrategyTickInput, evaluations) {
    return generateLegacyOrders({
      positions: input.positions,
      pending: input.pending,
      evaluations,
      equity: input.equity,
      executionDelaySec: input.config.executionDelaySec,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      cash: input.cash,
      exitCooldown: input.exitCooldown,
      priceFor: input.priceFor,
      candlesBySymbol: input.candlesBySymbol,
      maxPositions: input.maxPositions,
      maxFuturesPositions: input.maxFuturesPositions,
      closedTradeMetrics: input.closedTradeMetrics
    });
  }
};

export function createLegacySimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(legacyStrategy, getSymbols);
}

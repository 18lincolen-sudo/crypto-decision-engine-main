// Server-side simulation engine for "Bot Pro" — a literal implementation of
// ASSETS/alg.md (proSimExecution.ts, UNCHANGED by this refactor). All of the
// tick/market-data/persistence plumbing that used to be duplicated across
// this file, simEngine.ts and legacySimEngine.ts now lives in
// server/simEngineFactory.ts — this file only supplies the pro-specific
// evaluation/order-generation adapter.
import { buildProEvaluations, generateProOrders, MIN_PRO_CANDLES } from '../src/services/proSimExecution';
import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '../src/services/simExecution';
export type ProSimSnapshot = SimSnapshot;

const proStrategy: SimEngineStrategy = {
  id: 'pro',
  logPrefix: '[pro-sim-engine]',
  telegramTag: 'pro-sim',
  telegramTitle: '🤖 בוט פרו · alg.md',
  statusFooterLabel: 'מצב כולל של הבוט (פרו)',
  minConfidence: 58,
  minCandlesForH1View: MIN_PRO_CANDLES,
  logCandleFetch: false,

  buildEvaluations(input: StrategyTickInput) {
    return buildProEvaluations({
      cryptoData: input.cryptoData,
      candlesBySymbol: input.candlesBySymbol,
      positions: input.positions,
      pending: input.pending,
      config: input.config,
      equity: input.equity,
      cash: input.cash,
      totalLeveragedExposureUsd: input.totalLeveragedExposureUsd,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      fearGreedIndex: input.fearGreedIndex,
      closedTradeMetrics: input.closedTradeMetrics
    });
  },

  generateOrders(input: StrategyTickInput, evaluations) {
    return generateProOrders({
      positions: input.positions,
      pending: input.pending,
      evaluations,
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

export function createProSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(proStrategy, getSymbols);
}

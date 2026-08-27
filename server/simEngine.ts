// Server-side simulation engine — runs the SAME trade logic as the browser
// (useSimulationBot) but inside Node, so the shared bot advances 24/7 without
// any browser tab open. Reuses the real tradeEngine + market-data clients.
//
// The evaluation/order-generation/fill logic itself lives in
// src/services/simExecution.ts, shared with useSimulationBot.ts (UNCHANGED
// by this refactor). All of the tick/market-data/persistence plumbing that
// used to be duplicated across this file, legacySimEngine.ts and
// proSimEngine.ts now lives in server/simEngineFactory.ts — this file only
// supplies the intraday-specific evaluation/order-generation adapter.
import { buildEvaluations, generateNewOrders } from '../src/services/simExecution';
import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '../src/services/simExecution';
export type { SimSnapshot };

const intradayStrategy: SimEngineStrategy = {
  id: 'intraday',
  logPrefix: '[sim-engine]',
  telegramTag: 'sim',
  telegramTitle: '🤖 מנוע חדש · Multi-Timeframe',
  statusFooterLabel: 'מצב כולל של הבוט',
  minConfidence: 40,
  // Not H1-view based — reads m5/h1 straight off liveCandles via
  // buildCandlesForSymbol/correlationCandles instead. 0 = no gate.
  minCandlesForH1View: 0,
  logCandleFetch: true,

  buildEvaluations(input: StrategyTickInput) {
    return buildEvaluations({
      cryptoData: input.cryptoData,
      mtfData: input.liveCandles,
      positions: input.positions,
      pending: input.pending,
      config: input.config,
      equity: input.equity,
      initialAmount: input.initialAmount,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      totalLeveragedExposureUsd: input.totalLeveragedExposureUsd,
      closedTrades: input.closedTrades,
      toBase: input.toBase
    });
  },

  generateOrders(input: StrategyTickInput, evaluations) {
    return generateNewOrders({
      positions: input.positions,
      pending: input.pending,
      evaluations,
      executionDelaySec: input.config.executionDelaySec,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      cash: input.cash,
      exitCooldown: input.exitCooldown,
      priceFor: input.priceFor,
      buildCandlesForSymbol: input.buildCandlesForSymbol,
      computeAtr5: input.computeAtr5,
      maxPositions: input.maxPositions,
      maxFuturesPositions: input.maxFuturesPositions,
      closedTrades: input.closedTrades,
      correlationCandles: input.correlationCandles,
      toBase: input.toBase
    });
  }
};

export function createSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(intradayStrategy, getSymbols);
}

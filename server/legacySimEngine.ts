// Server-side simulation engine for the LEGACY (original alg.md) algorithm —
// single-timeframe H1 regime + weighted-confidence scoring.
//
// The evaluation logic now lives in the DecisionEngine (with the LegacyAdapter),
// providing a single entry point for all three engines. Order generation still
// uses the shared legacySimExecution.ts for fill/slippage/fee logic.

import { DecisionEngine, LegacyAdapter } from '../src/services/decisionEngine';
import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';
import { generateLegacyOrders, MIN_LEGACY_CANDLES } from '../src/services/legacySimExecution';
import { SignalEvaluation, DecisionFactor } from '../src/services/intradayBridge';
import { Candle, PortfolioRiskStats } from '../src/services/tradeEngine';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '../src/services/simExecution';
export type LegacySimSnapshot = SimSnapshot;

// Create the DecisionEngine with LegacyAdapter
const engine = new DecisionEngine({
  correlationGate: true,
  verbose: false
});
engine.registerAdapter(new LegacyAdapter());

const legacyStrategy: SimEngineStrategy = {
  id: 'legacy',
  logPrefix: '[legacy-sim-engine]',
  telegramTag: 'legacy-sim',
  telegramTitle: '🤖 מנוע מקורי · Confidence Score',
  statusFooterLabel: 'מצב כולל של הבוט (לגאסי)',
  minConfidence: 58,
  minCandlesForH1View: MIN_LEGACY_CANDLES,
  logCandleFetch: false,

  buildEvaluations(input: StrategyTickInput): SignalEvaluation[] {
    const results: SignalEvaluation[] = [];

    for (const crypto of input.cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;
      const candles = input.candlesBySymbol[symbol];
      if (!candles || candles.length < MIN_LEGACY_CANDLES) continue;

      // Build DecisionContext
      const context = {
        symbol,
        candles: { h1: candles },
        currentPrice,
        portfolio: {
          portfolioValue: input.equity,
          initialAmount: input.initialAmount,
          dailyDrawdownPercent: input.dailyDrawdownPercent,
          weeklyDrawdownPercent: input.weeklyDrawdownPercent,
          openPositionsCount: input.positions.length,
          openFuturesPositionsCount: input.positions.filter(p => p.type === 'FUTURES').length,
          totalLeveragedExposureUsd: input.totalLeveragedExposureUsd,
          existingExposureByAsset: {},
          systemLocked: false
        } as PortfolioRiskStats,
        openPositions: input.positions.map(p => ({
          symbol: p.symbol.replace(/USDT$/, '').replace(/BUSD$/, ''),
          type: p.type,
          side: p.side
        })),
        marketData: {
          priceChange24h,
          fearGreedIndex: input.fearGreedIndex
        },
        params: {},
        now: Date.now(),
        closedTrades: input.closedTradeMetrics?.map(t => ({ pnl: t.pnl, at: t.at, symbol: t.symbol })),
        config: {
          minConfidenceOverride: 58,
          maxPositions: input.config.maxPositions || 7,
          maxFuturesPositions: input.config.maxFuturesPositions || 2
        }
      };

      // Evaluate using DecisionEngine
      const result = engine.evaluate(context);

      // Convert to SignalEvaluation for order generation
      const evaluation = convertToSignalEvaluation(result, currentPrice, priceChange24h);
      results.push(evaluation);
    }

    return results;
  },

  generateOrders(input: StrategyTickInput, evaluations: SignalEvaluation[]) {
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

/** Convert DecisionResult to SignalEvaluation for order generation */
function convertToSignalEvaluation(
  result: ReturnType<DecisionEngine['evaluate']>,
  currentPrice: number,
  priceChange24h: number
): SignalEvaluation {
  const isSignal = result.outcome === 'SIGNAL';
  const tradeType = result.tradeType || 'HOLD';
  const action = result.direction === 'LONG' ? 'buy' : result.direction === 'SHORT' ? 'sell' : 'hold';
  const tradeSide = result.direction;

  const factors: DecisionFactor[] = [];
  if (result.reasoning.length > 0) {
    factors.push({
      label: 'יומן החלטה',
      value: result.reasoning[result.reasoning.length - 1] || result.gate,
      impact: isSignal ? 'positive' : 'neutral',
      note: result.reasoning.join(' | ')
    });
  }

  return {
    symbol: result.symbol,
    action: action as 'buy' | 'sell' | 'hold',
    tradeType: tradeType as 'SPOT' | 'FUTURES' | 'HOLD',
    tradeSide: tradeSide as 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE',
    confidence: result.confidence,
    price: currentPrice,
    priceChange24h,
    reasoning: result.reasoning.join('\n'),
    status: isSignal ? `SIGNAL ${tradeType} ${result.direction}` : `NO_SIGNAL [${result.gate}]`,
    willExecute: isSignal,
    factors,
    confidenceGap: 0,
    leverage: result.riskPlan?.leverage,
    stopLoss: result.riskPlan?.stopLoss,
    takeProfit1: result.riskPlan?.takeProfit1,
    takeProfit2: result.riskPlan?.takeProfit2,
    takeProfit: result.riskPlan?.takeProfit,
    decision: result.raw as never
  };
}

export function createLegacySimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(legacyStrategy, getSymbols);
}

// Server-side simulation engine for "Bot Pro" — a literal implementation of
// ASSETS/alg.md.
//
// The evaluation logic now lives in the DecisionEngine (with the ProAdapter),
// providing a single entry point for all three engines. Order generation still
// uses the shared proSimExecution.ts for fill/slippage/fee logic.

import { DecisionEngine, ProAdapter } from '@cde/engine';
import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';
import { generateProOrders, MIN_PRO_CANDLES } from '@cde/engine/execution';
import { SignalEvaluation, DecisionFactor } from '@cde/engine';
import { Candle, PortfolioRiskStats } from '@cde/engine';

/** Base asset for a position symbol, keyed the same way the candle maps and
 *  the exposure map are. */
function toBase(symbol: string): string {
  return symbol.replace(/USDT$/, '').replace(/BUSD$/, '');
}

/** Notional exposure per base asset — feeds the 8%-per-asset cap in the risk
 *  layer, which read a hardcoded {} before and so never saw existing holdings. */
function exposureByAsset(positions: { symbol: string; notionalUsd?: number }[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const p of positions) {
    const base = toBase(p.symbol);
    map[base] = (map[base] || 0) + (p.notionalUsd || 0);
  }
  return map;
}


export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '@cde/engine/execution';
export type ProSimSnapshot = SimSnapshot;

// Create the DecisionEngine with ProAdapter
const engine = new DecisionEngine({
  verbose: false
});
engine.registerAdapter(new ProAdapter());

const proStrategy: SimEngineStrategy = {
  id: 'pro',
  logPrefix: '[pro-sim-engine]',
  telegramTag: 'pro-sim',
  telegramTitle: '🤖 בוט פרו · alg.md',
  statusFooterLabel: 'מצב כולל של הבוט (פרו)',
  minConfidence: 58,
  minCandlesForH1View: MIN_PRO_CANDLES,
  logCandleFetch: false,

  buildEvaluations(input: StrategyTickInput): SignalEvaluation[] {
    const results: SignalEvaluation[] = [];

    for (const crypto of input.cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;
      const candles = input.candlesBySymbol[symbol];
      if (!candles || candles.length < MIN_PRO_CANDLES) continue;

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
          existingExposureByAsset: exposureByAsset(input.positions),
          systemLocked: false
        } as PortfolioRiskStats,
        // `candles` is what lets the correlation gate actually run — without a
        // series per held position it finds nothing and abstains.
        openPositions: input.positions.map(p => ({
          symbol: toBase(p.symbol),
          type: p.type,
          side: p.side,
          candles: input.candlesBySymbol[toBase(p.symbol)]
        })),
        marketData: {
          priceChange24h,
          fearGreedIndex: input.fearGreedIndex,
          marketCap: crypto.market_cap || 0,
          volume24h: crypto.total_volume || 0,
          // Binance keys perpetuals as BASE+USDT. A symbol with no perpetual
          // simply has no entry, and the funding gate abstains on it.
          funding: input.fundingBySymbol.get(`${toBase(crypto.symbol)}USDT`)
        },
        params: {},
        now: Date.now(),
        closedTrades: input.closedTradeMetrics?.map(t => ({ pnl: t.pnl, at: t.at, symbol: t.symbol, riskUsd: t.riskUsd })),
        config: {
          minConfidenceOverride: typeof input.config.minConfidenceOverride === 'number' ? input.config.minConfidenceOverride : 58,
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
    return generateProOrders({
      positions: input.positions,
      pending: input.pending,
      evaluations,
      executionDelaySec: input.config.executionDelaySec,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      cash: input.cash,
      equity: input.equity,
      positionPercent: input.config.positionPercent,
      riskLevel: input.config.riskLevel,
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

export function createProSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(proStrategy, getSymbols);
}

// Server-side simulation engine — runs the Intraday MTF algorithm through
// the unified DecisionEngine framework.
//
// The evaluation logic now lives in the DecisionEngine (with the IntradayAdapter),
// providing a single entry point for all three engines. Order generation still
// uses the shared simExecution.ts for fill/slippage/fee logic.

import { DecisionEngine, IntradayAdapter } from '@cde/engine';
import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';
import { generateNewOrders } from '@cde/engine/execution';
import { SignalEvaluation, DecisionFactor } from '@cde/engine';
import { Candle, PortfolioRiskStats } from '@cde/engine';
import { IntradayParams, DEFAULT_INTRADAY_PARAMS } from '@cde/engine';

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
export type { SimSnapshot };

// Create the DecisionEngine with IntradayAdapter
const engine = new DecisionEngine({
  verbose: false
});
engine.registerAdapter(new IntradayAdapter());

const intradayStrategy: SimEngineStrategy = {
  id: 'intraday',
  logPrefix: '[sim-engine]',
  telegramTag: 'sim',
  telegramTitle: '🤖 מנוע חדש · Multi-Timeframe',
  statusFooterLabel: 'מצב כולל של הבוט',
  minConfidence: 52,
  minCandlesForH1View: 0,
  logCandleFetch: true,

  buildEvaluations(input: StrategyTickInput): SignalEvaluation[] {
    const results: SignalEvaluation[] = [];
    const baseAssetToSymbol = new Map<string, string>();

    // Build symbol mapping
    for (const c of input.cryptoData) {
      const base = c.symbol.replace(/USDT$/, '').replace(/BUSD$/, '');
      baseAssetToSymbol.set(base, c.symbol);
    }

    for (const [baseAsset, snap] of Object.entries(input.liveCandles)) {
      if (!snap || snap.status !== 'READY') continue;
      if (!snap.h1 || snap.h1.length < 200 || !snap.m15 || snap.m15.length < 300 || !snap.m5 || snap.m5.length < 500) continue;

      const symbol = baseAssetToSymbol.get(baseAsset) || `${baseAsset}USDT`;
      const cryptoData = input.cryptoData.find(c => c.symbol === symbol) || input.cryptoData.find(c => c.symbol.replace(/USDT$/, '') === baseAsset);
      const currentPrice = snap.livePrice || cryptoData?.current_price || 0;
      const priceChange24h = cryptoData?.price_change_percentage_24h || 0;

      // Build DecisionContext
      const context = {
        symbol: baseAsset,
        candles: {
          h1: snap.h1,
          m15: snap.m15,
          m5: snap.m5
        },
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
          candles: input.correlationCandles[toBase(p.symbol)]
        })),
        marketData: {
          spreadPercent: snap.liquidity?.spreadPercent ?? 0,
          quoteVolume24h: snap.liquidity?.quoteVolume24h ?? 0,
          quoteVolume24hSpot: snap.liquidity?.quoteVolume24hSpot ?? 0,
          livePrice: snap.livePrice,
          priceChange24h
        },
        params: DEFAULT_INTRADAY_PARAMS as unknown as Record<string, unknown>,
        now: Date.now(),
        closedTrades: input.closedTrades,
        config: {
          // The server's configured floor comes from the persisted sim config
          // (DEFAULT_SIM_CONFIG.minConfidenceOverride = 52). The old hardcoded
          // 40 silently contradicted both the UI default and ALG_intraday.md.
          minConfidenceOverride: typeof input.config.minConfidenceOverride === 'number' ? input.config.minConfidenceOverride : 52,
          maxPositions: input.config.maxPositions || 7,
          maxFuturesPositions: input.config.maxFuturesPositions || 2
        }
      };

      // Evaluate using DecisionEngine
      const result = engine.evaluate(context);

      // Convert to SignalEvaluation for order generation
      const evaluation = convertToSignalEvaluation(result, currentPrice, priceChange24h, snap);
      results.push(evaluation);
    }

    return results;
  },

  generateOrders(input: StrategyTickInput, evaluations: SignalEvaluation[]) {
    return generateNewOrders({
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

/** Convert DecisionResult to SignalEvaluation for order generation */
function convertToSignalEvaluation(
  result: ReturnType<DecisionEngine['evaluate']>,
  currentPrice: number,
  priceChange24h: number,
  snap: { livePrice?: number; liquidity?: { spreadPercent?: number; quoteVolume24h?: number; quoteVolume24hSpot?: number } | null }
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
    betSizeUsd: result.riskPlan?.betSizeUsd,
    stopLoss: result.riskPlan?.stopLoss,
    takeProfit1: result.riskPlan?.takeProfit1,
    takeProfit2: result.riskPlan?.takeProfit2,
    takeProfit: result.riskPlan?.takeProfit,
    decision: result.raw as never
  };
}

export function createSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(intradayStrategy, getSymbols);
}

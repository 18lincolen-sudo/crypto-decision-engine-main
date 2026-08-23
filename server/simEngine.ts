// Server-side simulation engine — runs the SAME trade logic as the browser
// (useSimulationBot) but inside Node, so the shared bot advances 24/7 without
// any browser tab open. Reuses the real tradeEngine + market-data clients.
import {
  detectMarketRegime,
  evaluateSignals,
  routeTradeType,
  calculateRiskParameters,
  evaluateExit,
  calculateTradingFee,
  simulateSlippage,
  calculateATR,
  Candle
} from '../src/services/tradeEngine';
import { coinGeckoApi } from '../src/services/coinGeckoApi';
import { bybitApi } from '../src/services/bybitApi';
import { getAggregatedPrices, getAggregatedCandles } from '../src/services/cryptoPriceAggregator';
import { CryptoData, ActivePosition } from '../src/types/crypto';

interface SimEvaluationResult {
  symbol: string;
  action: 'buy' | 'sell' | 'hold';
  tradeType: 'SPOT' | 'FUTURES' | 'HOLD';
  tradeSide: string;
  confidence: number;
  price: number;
  priceChange24h: number;
  reasoning: string;
  status: string;
  willExecute: boolean;
  factors: unknown[];
  confidenceGap: number;
  regime: { regime: string; direction: string; volatility: string; adx: number; atr: number; atrPercent: number; supertrend: { value: number; direction: string } };
  leverage?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
}

interface SimEvaluateResult {
  results: SimEvaluationResult[];
  equity: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  totalLeveragedExposureUsd: number;
  futuresCount: number;
  maxTotalPositions: number;
  maxFutures: number;
}

interface SimSnapshot {
  cash: number;
  positions: SimPosition[];
  trades: SimTrade[];
  history: SimPoint[];
  hourlyHistory: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
  lastEvaluation: string;
}

interface SimPosition {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  avgPrice: number;
  currentPrice: number;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  trailingStopActive?: boolean;
  trailingStopPrice?: number;
  tp1Hit: boolean;
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
  highestPrice?: number;
  lowestPrice?: number;
  openedAt: string;
  openTimestamp: number;
  reason: string;
  confidence: number;
  entryFee: number;
}

interface SimTrade {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: string;
  price: number;
  requestedPrice: number;
  slippagePercent: number;
  fee: number;
  delayMs: number;
  quantity: number;
  usdValue: number;
  leverage: number;
  timestamp: string;
  at: number;
  reason: string;
  confidence: number;
  pnl?: number;
  pnlPercent?: number;
}

interface SimPoint {
  timestamp: string;
  at: number;
  portfolio: number;
}

interface PendingOrder {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'buy' | 'sell' | 'long' | 'short' | 'close_long' | 'close_short' | 'partial_tp1';
  signalPrice: number;
  quantity: number;
  budgetUsd?: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  reason: string;
  confidence: number;
  executeAt: number;
  createdAt: number;
}

interface SimBotConfig {
  riskLevel: 'low' | 'medium' | 'high';
  initialAmount: number;
  stopLoss: number;
  takeProfit: number;
  maxPositions: number;
  maxFuturesPositions?: number;
  feePercent: number;
  slippagePercent: number;
  executionDelaySec: number;
  minConfidenceOverride?: number;
  positionPercent?: number;
}

const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const TICK_MS = 4000;
const CRYPTO_REFRESH_MS = 60_000;  // 60s — Bybit/Binance are fast, no need to hammer CoinGecko
const CANDLE_REFRESH_MS = 5 * 60_000;
// CoinGecko fallback candles are cached; re-fetch at most this often. Daily
// candles don't change meaningfully within a day, and the free tier is shared
// with the primary price feed, so we must NOT hit it every candle cycle.
const COINGECKO_CANDLE_TTL = 6 * 60 * 60_000;

export function createSimEngine() {
  let cash = 10000;
  let positions: SimPosition[] = [];
  let trades: SimTrade[] = [];
  let history: SimPoint[] = [];
  let hourlyHistory: SimPoint[] = [];
  let pending: PendingOrder[] = [];
  let totalFees = 0;
  let totalSlippageCost = 0;
  let lastEvaluation = '';
  let lastEvaluations: SimEvaluationResult[] = [];

  let liveCandles: Record<string, Candle[]> = {};
  let cryptoData: CryptoData[] = [];
  const lastPrices: Record<string, number> = {};
  let cryptoRefreshAt = 0;
  let candleRefreshAt = 0;
  let candleRefreshing = false;
  let coinGeckoCandleRefreshAt = 0;
  let initialAmount = 10000;

  async function chunked<T>(items: T[], size: number, fn: (batch: T[]) => Promise<void>) {
    for (let i = 0; i < items.length; i += size) {
      await fn(items.slice(i, i + size));
    }
  }

  function priceFor(symbol: string): number | undefined {
    const up = symbol.toUpperCase();
    if (typeof lastPrices[up] === 'number') return lastPrices[up];
    const c = cryptoData.find((x) => x.symbol.toUpperCase() === up);
    return c?.current_price;
  }

  function buildCandlesForSymbol(symbol: string): Candle[] {
    const live = liveCandles[symbol.toUpperCase()];
    return live && live.length ? live : [];
  }

  function positionsValue(): number {
    return positions.reduce((sum, p) => {
      const live = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'SPOT') return sum + p.quantity * live;
      const pnl = p.side === 'LONG'
        ? (live - p.entryPrice) * p.quantity * p.leverage
        : (p.entryPrice - live) * p.quantity * p.leverage;
      return sum + Math.max(0, p.marginUsd + pnl);
    }, 0);
  }

  function equity(): number {
    return cash + positionsValue();
  }

  function drawdowns(eq: number): { dailyDrawdownPercent: number; weeklyDrawdownPercent: number } {
    const now = Date.now();
    const oneDay = now - 24 * 60 * 60 * 1000;
    const oneWeek = now - 7 * 24 * 60 * 60 * 1000;
    let peakDay = eq;
    let peakWeek = eq;
    for (const pt of history) {
      if (pt.at >= oneDay && pt.portfolio > peakDay) peakDay = pt.portfolio;
      if (pt.at >= oneWeek && pt.portfolio > peakWeek) peakWeek = pt.portfolio;
    }
    const daily = peakDay > 0 ? Math.max(0, ((peakDay - eq) / peakDay) * 100) : 0;
    const weekly = peakWeek > 0 ? Math.max(0, ((peakWeek - eq) / peakWeek) * 100) : 0;
    return {
      dailyDrawdownPercent: Number(daily.toFixed(2)),
      weeklyDrawdownPercent: Number(weekly.toFixed(2))
    };
  }

  function leveragedExposure(): number {
    return positions.reduce((sum, p) => {
      const live = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'FUTURES') return sum + p.quantity * live * p.leverage;
      return sum;
    }, 0);
  }

  async function refreshMarketData() {
    const now = Date.now();
    if (now - cryptoRefreshAt > CRYPTO_REFRESH_MS || cryptoData.length === 0) {
      try {
        // Use multi-source aggregator: Bybit → Binance → CoinGecko (rate-gated)
        const data = await getAggregatedPrices();
        if (data && data.length) {
          cryptoData = data;
          cryptoRefreshAt = now;
          for (const c of data) lastPrices[c.symbol.toUpperCase()] = c.current_price;
        }
      } catch {
        /* keep last-known-good prices */
      }
    }
    // Candle refresh is NON-BLOCKING: the tick must return a snapshot immediately
    // (so the bot shows as running and history grows) even before candles load.
    // Candles fill in the background; trading begins once they are available.
    if ((now - candleRefreshAt > CANDLE_REFRESH_MS || Object.keys(liveCandles).length === 0) && !candleRefreshing) {
      candleRefreshing = true;
      refreshCandles()
        .catch(() => {})
        .finally(() => {
          candleRefreshing = false;
          candleRefreshAt = Date.now();
        });
    }
  }

  async function refreshCandles() {
    if (!cryptoData.length) return;
    const symbols = cryptoData.map((c) => c.symbol.toUpperCase());
    const next: Record<string, Candle[]> = { ...liveCandles };

    // 1) Primary: Bybit klines (fast, no rate limit) in bounded concurrency.
    await chunked(symbols, 10, async (batch) => {
      await Promise.all(
        batch.map(async (symbol) => {
          try {
            const klines = await bybitApi.getKlineData(bybitApi.getBybitSymbol(symbol), 'D', 30);
            if (klines && klines.length > 0) {
              next[symbol] = klines.map((k) => ({
                timestamp: parseInt(k.openTime, 10),
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close),
                volume: parseFloat(k.volume)
              }));
            }
          } catch {
            /* keep last-known-good candles on Bybit failure */
          }
        })
      );
    });

    // 2) Binance klines for symbols Bybit could NOT serve (free, 1200 req/min — no rate limit concern)
    const afterBybit = symbols.filter((s) => !next[s] || next[s].length < 2);
    if (afterBybit.length > 0) {
      await chunked(afterBybit, 10, async (batch) => {
        await Promise.all(
          batch.map(async (symbol) => {
            try {
              const candles = await getAggregatedCandles(symbol, 60);
              if (candles && candles.length >= 2) {
                next[symbol] = candles;
              }
            } catch { /* keep last-known-good */ }
          })
        );
      });
    }

    // 3) Fallback: CoinGecko historical candles for symbols neither Bybit nor Binance
    // could serve (delisted / unsupported spot pairs like TON, NEO, MATIC→POL,
    // RNDR→RENDER, FTM→SONIC, etc.). This keeps all ~100 symbols tradeable
    // instead of silently dropping ~20 of them.
    //
    // CoinGecko's FREE tier is heavily rate-limited AND is shared with the
    // primary price feed (getCurrentPrices, min 2-min TTL). To avoid starving
    // that feed, this fallback is gated behind COINGECKO_CANDLE_TTL (runs at
    // most every 6h), fetched sequentially, and fails FAST on 429 so a
    // rate-limited cycle doesn't burn the shared budget with long backoff
    // waits. Daily candles are cached in liveCandles, so once fetched they
    // persist across cycles.
    const now = Date.now();
    const missing = symbols.filter((s) => !next[s] || next[s].length < 2);
    if (missing.length && now - coinGeckoCandleRefreshAt > COINGECKO_CANDLE_TTL) {
      coinGeckoCandleRefreshAt = now;
      await chunked(missing, 1, async (batch) => {
        await Promise.all(
          batch.map(async (symbol) => {
            try {
              const coinId = coinGeckoApi.getCoinId(symbol);
              const hist = await coinGeckoApi.getHistoricalPrices(coinId, 60, 0);
              if (hist && hist.length >= 2) {
                next[symbol] = hist.map((h, i) => {
                  const open = i === 0 ? h.price : hist[i - 1].price;
                  const close = h.price;
                  return {
                    timestamp: h.timestamp,
                    open,
                    high: Math.max(open, close),
                    low: Math.min(open, close),
                    close,
                    volume: h.volume
                  };
                });
              }
            } catch {
              /* keep last-known-good candles on CoinGecko failure */
            }
          })
        );
        // Gentle pause so we don't trip CoinGecko's free-tier rate limit.
        await new Promise((r) => setTimeout(r, 3000));
      });
    }

    liveCandles = next;
  }

  function evaluate(config: SimBotConfig, fearGreed: number) {
    const openPos = positions;
    const queued = pending;
    const maxTotalPositions = config.maxPositions || 5;
    const maxFutures = 2;
    const futuresCount = openPos.filter((p) => p.type === 'FUTURES').length;
    const eq = equity();
    const { dailyDrawdownPercent, weeklyDrawdownPercent } = drawdowns(eq);
    const totalLeveragedExposureUsd = leveragedExposure();

    const results: SimEvaluationResult[] = [];
    for (const crypto of cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;

      const candles = buildCandlesForSymbol(symbol);
      if (candles.length < 2) continue;

      const layer0 = detectMarketRegime(candles, currentPrice);
      const layer1 = evaluateSignals(candles, currentPrice, priceChange24h, layer0, fearGreed, config.riskLevel);
      const hasExistingFutures = openPos.some((p) => p.symbol === symbol && p.type === 'FUTURES');
      const layer2 = routeTradeType(layer1, layer0, hasExistingFutures, config.riskLevel);

      const isHeld = openPos.some((p) => p.symbol === symbol);
      const isQueued = queued.some((o) => o.symbol === symbol);

      const riskParams = calculateRiskParameters(
        currentPrice,
        layer2.type,
        layer2.side,
        layer0.atr,
        layer0.volatility,
        layer1.confidence,
        eq,
        trades.map((t) => ({ pnl: t.pnl || 0 })),
        openPos.length,
        futuresCount,
        totalLeveragedExposureUsd,
        typeof config.positionPercent === 'number' ? config.positionPercent / 100 : 0.03
      );

      let status = '';
      let willExecute = false;

      if (weeklyDrawdownPercent >= 15) status = 'הגנת תיק שבועית (הפסד >= 15%) — מושבת';
      else if (dailyDrawdownPercent >= 8) status = 'הגנת תיק יומית (הפסד >= 8%) — חסום';
      else if (isQueued) status = 'פקודה כבר נמצאת בתור ביצוע';
      else if (layer2.type === 'HOLD') status = `ביטחון נמוך מהסף (${layer1.confidence}%)`;
      else if (openPos.length >= maxTotalPositions) status = `הגעת למקסימום ${maxTotalPositions} פוזיציות פתוחות`;
      else if (layer2.type === 'FUTURES' && futuresCount >= maxFutures) status = `הגעת למקסימום ${maxFutures} פוזיציות Futures`;
      else if (layer2.type === 'FUTURES' && hasExistingFutures) status = 'קיימת כבר פוזיציית Futures פתוחה';
      else if (layer2.type === 'SPOT' && layer2.side === 'SELL' && !isHeld) status = 'מכירת Spot חשופה אסורה — אין החזקה בתיק';
      else if (layer2.type === 'SPOT' && isHeld && layer2.side === 'BUY') status = 'כבר מוחזק בתיק (Spot)';
      else if (layer0.atr <= 0 || currentPrice <= 0) status = 'אין נתוני מחיר/תנודתיות (ATR) — לא ניתן לחשב סיכון';
      else if (!riskParams) status = 'חריגת חשיפה ממונפת (מקס\' 20% מהתיק)';
      else if (riskParams.betSizeUsd < 5) status = 'הון נמוך מדי לפתיחת פוזיציה (מינימום $5)';
      else {
        willExecute = true;
        status = layer2.type === 'FUTURES'
          ? `מבצע Futures ${riskParams.leverage}x ${layer2.side} ($${riskParams.betSizeUsd})`
          : `מבצע Spot ${layer2.side} ($${riskParams.betSizeUsd})`;
      }

      // Build the 6-layer decision breakdown for UI transparency (the
      // "פירוט 6 שכבות החלטה" panel reads rec.factors).
      const factors: { label: string; value: string; impact: 'positive' | 'negative' | 'neutral'; note: string }[] = [
        {
          label: 'משטר שוק (ADX 14) — Layer 0',
          value: `${layer0.regime} (ADX ${layer0.adx})`,
          impact: layer0.regime === 'TRENDING' ? 'positive' : layer0.regime === 'RANGING' ? 'neutral' : 'negative',
          note: layer0.regime === 'TRENDING' ? 'שוק מגמתי מובהק — תומך ב-Futures' : layer0.regime === 'RANGING' ? 'שוק ציר/דשדוש — רק Spot' : 'משטר מעבר — חסום'
        },
        {
          label: 'תנודתיות (ATR%) — Layer 0',
          value: `${layer0.volatility} (${layer0.atrPercent}%)`,
          impact: layer0.volatility === 'HIGH' ? 'negative' : 'positive',
          note: layer0.volatility === 'HIGH' ? 'תנודתיות גבוהה מעל 5% — אסור לפתוח Futures' : 'תנודתיות מתאימה'
        },
        {
          label: 'Supertrend (10, 3) — Layer 0',
          value: `$${layer0.supertrend.value.toFixed(2)} (${layer0.supertrend.direction})`,
          impact: layer0.supertrend.direction === 'BULL' ? 'positive' : 'negative',
          note: `מגמת Supertrend: ${layer0.supertrend.direction}`
        }
      ];

      // Layer 1 — Signal engine indicators
      for (const sig of layer1.signals) {
        factors.push({
          label: sig.name,
          value: sig.value,
          impact: sig.signal === 'BUY' ? 'positive' : sig.signal === 'SELL' ? 'negative' : 'neutral',
          note: sig.reason
        });
      }
      for (const p of layer1.penalties) {
        factors.push({ label: 'התאמת ביטחון', value: p, impact: 'negative', note: 'ענישת פילטר' });
      }

      // Layer 2 — Trade type router
      factors.push({
        label: 'ניתוב עסקה (Spot/Futures) — Layer 2',
        value: layer2.type === 'HOLD' ? 'HOLD' : `${layer2.type} ${layer2.side}`,
        impact: layer2.type === 'HOLD' ? 'neutral' : 'positive',
        note: layer2.reason
      });

      // Layer 3 — Risk management (SL/TP/leverage/sizing)
      if (riskParams) {
        const tp = riskParams.takeProfit ?? riskParams.takeProfit1 ?? 0;
        factors.push({
          label: 'ניהול סיכונים (SL/TP/מינוף) — Layer 3',
          value: `SL $${riskParams.stopLoss} • TP $${tp} • ${riskParams.leverage}x • $${riskParams.betSizeUsd}`,
          impact: 'positive',
          note: `יחס סיכוי/סיכון ${riskParams.riskRewardRatio} • ${riskParams.positionPercentOfPortfolio}% מהתיק`
        });
      } else {
        factors.push({
          label: 'ניהול סיכונים (SL/TP/מינוף) — Layer 3',
          value: 'נחסם',
          impact: 'negative',
          note: 'חריגת חשיפה ממונפת (מקס\' 20%) או הון נמוך מדי (מינימום $5)'
        });
      }

      results.push({
        symbol,
        action: layer1.action === 'BUY' ? 'buy' : layer1.action === 'SELL' ? 'sell' : 'hold',
        tradeType: layer2.type,
        tradeSide: layer2.side,
        confidence: layer1.confidence,
        price: currentPrice,
        priceChange24h,
        reasoning: layer2.reason,
        status,
        willExecute,
        factors,
        confidenceGap: layer1.confidence - (layer2.type === 'FUTURES'
          ? (config.riskLevel === 'high' ? 42 : config.riskLevel === 'low' ? 56 : 46)
          : (config.riskLevel === 'high' ? 35 : config.riskLevel === 'low' ? 48 : 40)),
        regime: layer0,
        leverage: riskParams?.leverage,
        stopLoss: riskParams?.stopLoss,
        takeProfit1: riskParams?.takeProfit1,
        takeProfit2: riskParams?.takeProfit2,
        takeProfit: riskParams?.takeProfit
      });
    }

    return { results, equity: eq, dailyDrawdownPercent, weeklyDrawdownPercent, totalLeveragedExposureUsd, futuresCount, maxTotalPositions, maxFutures };
  }

  function generateOrders(evalResult: SimEvaluateResult, config: SimBotConfig) {
    const delayMs = Math.max(0, config.executionDelaySec) * 1000;
    const newOrders: PendingOrder[] = [];

    for (const pos of positions) {
      if (pending.some((o) => o.symbol === pos.symbol)) continue;
      const livePrice = priceFor(pos.symbol) ?? pos.currentPrice;
      const { atr } = calculateATR(buildCandlesForSymbol(pos.symbol), 14);
      const currentEval = evalResult.results.find((e: SimEvaluationResult) => e.symbol === pos.symbol);
      const buyConf = currentEval?.action === 'buy' ? currentEval.confidence : 0;
      const sellConf = currentEval?.action === 'sell' ? currentEval.confidence : 0;

      const exitCheck = evaluateExit(
        pos as ActivePosition,
        livePrice,
        atr,
        { buy: buyConf, sell: sellConf },
        { dailyDrawdownPercent: evalResult.dailyDrawdownPercent, weeklyDrawdownPercent: evalResult.weeklyDrawdownPercent }
      );

      if (exitCheck.shouldExit) {
        if (exitCheck.exitType === 'PARTIAL_50') {
          newOrders.push({
            id: uid(`${pos.symbol}-tp1-50`),
            symbol: pos.symbol,
            type: pos.type,
            side: 'partial_tp1',
            signalPrice: livePrice,
            quantity: pos.quantity * 0.5,
            reason: exitCheck.reason,
            confidence: pos.confidence,
            executeAt: Date.now() + delayMs,
            createdAt: Date.now()
          });
        } else {
          newOrders.push({
            id: uid(`${pos.symbol}-exit`),
            symbol: pos.symbol,
            type: pos.type,
            side: pos.side === 'LONG' || pos.side === 'BUY' ? 'close_long' : 'close_short',
            signalPrice: livePrice,
            quantity: pos.quantity,
            reason: exitCheck.reason,
            confidence: pos.confidence,
            executeAt: Date.now() + delayMs,
            createdAt: Date.now()
          });
        }
      }
    }

    for (const ev of evalResult.results) {
      if (!ev.willExecute || !ev.price || ev.tradeType === 'HOLD') continue;
      if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;

      const orderSide = ev.tradeType === 'FUTURES'
        ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
        : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

      const budget = ev.tradeType === 'FUTURES'
        ? cash * 0.05
        : Math.min(cash * 0.15, 1000);

      if (budget < 5) continue;

      newOrders.push({
        id: uid(`${ev.symbol}-${orderSide}`),
        symbol: ev.symbol,
        type: ev.tradeType,
        side: orderSide,
        signalPrice: ev.price,
        quantity: (budget * (ev.leverage || 1)) / ev.price,
        budgetUsd: budget,
        leverage: ev.leverage || 1,
        stopLoss: ev.stopLoss,
        takeProfit1: ev.takeProfit1,
        takeProfit2: ev.takeProfit2,
        takeProfit: ev.takeProfit,
        reason: ev.reasoning,
        confidence: ev.confidence,
        executeAt: Date.now() + delayMs,
        createdAt: Date.now()
      });
    }

    if (newOrders.length) pending = [...pending, ...newOrders];
  }

  function executeDueOrders() {
    const due = pending.filter((o) => Date.now() >= o.executeAt);
    if (!due.length) return;

    const now = new Date().toLocaleTimeString('he-IL');
    let workingCash = cash;
    let workingPositions = [...positions];
    const newTrades: SimTrade[] = [];
    let feesAdded = 0;
    let slipAdded = 0;

    for (const order of due) {
      const market = priceFor(order.symbol) ?? order.signalPrice;
      const sideForSlippage = order.side === 'buy' || order.side === 'long' ? 'BUY' : 'SELL';
      const { fillPrice, slippagePercent } = simulateSlippage(market, sideForSlippage);
      const delayMs = Date.now() - order.createdAt;

      if (order.side === 'buy' || order.side === 'long' || order.side === 'short') {
        const budget = Math.min(order.budgetUsd ?? 100, workingCash);
        if (budget < 5) continue;

        const isFutures = order.type === 'FUTURES';
        const leverage = order.leverage || 1;
        const notional = budget * leverage;
        const fee = calculateTradingFee(notional, order.type, true);
        const quantity = notional / fillPrice;

        workingCash -= budget;
        feesAdded += fee;
        slipAdded += Math.abs(fillPrice - market) * quantity;

        const newPos: SimPosition = {
          id: uid(order.symbol),
          symbol: order.symbol,
          type: order.type,
          side: order.side === 'long' ? 'LONG' : order.side === 'short' ? 'SHORT' : 'BUY',
          quantity,
          entryPrice: fillPrice,
          avgPrice: fillPrice,
          currentPrice: fillPrice,
          leverage,
          marginUsd: budget,
          notionalUsd: notional,
          stopLoss: order.stopLoss || (order.side === 'short' ? fillPrice * 1.05 : fillPrice * 0.95),
          takeProfit1: order.takeProfit1,
          takeProfit2: order.takeProfit2,
          takeProfit: order.takeProfit || fillPrice * 1.05,
          tp1Hit: false,
          highestPrice: fillPrice,
          lowestPrice: fillPrice,
          openedAt: now,
          openTimestamp: Date.now(),
          reason: order.reason,
          confidence: order.confidence,
          entryFee: fee
        };

        workingPositions.push(newPos);
        newTrades.push({
          id: order.id,
          symbol: order.symbol,
          type: order.type,
          side: order.side,
          price: fillPrice,
          requestedPrice: order.signalPrice,
          slippagePercent,
          fee,
          delayMs,
          quantity,
          usdValue: notional,
          leverage,
          timestamp: now,
          at: Date.now(),
          reason: order.reason,
          confidence: order.confidence
        });
      } else if (order.side === 'partial_tp1') {
        const posIdx = workingPositions.findIndex((p) => p.symbol === order.symbol && p.type === 'FUTURES');
        if (posIdx >= 0) {
          const pos = workingPositions[posIdx];
          const closeQty = pos.quantity * 0.5;
          const notional = closeQty * fillPrice;
          const fee = calculateTradingFee(notional, 'FUTURES', true);
          const pnl = pos.side === 'LONG'
            ? (fillPrice - pos.entryPrice) * closeQty * pos.leverage
            : (pos.entryPrice - fillPrice) * closeQty * pos.leverage;

          workingCash += pos.marginUsd * 0.5 + pnl - fee;
          feesAdded += fee;
          slipAdded += Math.abs(fillPrice - market) * closeQty;

          workingPositions[posIdx] = {
            ...pos,
            quantity: pos.quantity - closeQty,
            marginUsd: pos.marginUsd * 0.5,
            notionalUsd: (pos.quantity - closeQty) * fillPrice * pos.leverage,
            tp1Hit: true,
            highestPriceSinceTP1: fillPrice,
            lowestPriceSinceTP1: fillPrice
          };

          newTrades.push({
            id: order.id,
            symbol: order.symbol,
            type: 'FUTURES',
            side: 'partial_tp1',
            price: fillPrice,
            requestedPrice: order.signalPrice,
            slippagePercent,
            fee,
            delayMs,
            quantity: closeQty,
            usdValue: notional,
            leverage: pos.leverage,
            timestamp: now,
            at: Date.now(),
            reason: order.reason,
            confidence: order.confidence,
            pnl,
            pnlPercent: (pnl / (pos.marginUsd * 0.5)) * 100
          });
        }
      } else {
        const pos = workingPositions.find((p) => p.symbol === order.symbol);
        if (pos) {
          const notional = pos.quantity * fillPrice;
          const fee = calculateTradingFee(notional, pos.type, true);
          let pnl = 0;
          if (pos.type === 'SPOT') {
            const netProceeds = notional - fee;
            const costBasis = pos.quantity * pos.avgPrice;
            pnl = netProceeds - costBasis - pos.entryFee;
            workingCash += netProceeds;
          } else {
            pnl = pos.side === 'LONG'
              ? (fillPrice - pos.entryPrice) * pos.quantity * pos.leverage
              : (pos.entryPrice - fillPrice) * pos.quantity * pos.leverage;
            workingCash += pos.marginUsd + pnl - fee;
          }

          feesAdded += fee;
          slipAdded += Math.abs(market - fillPrice) * pos.quantity;
          workingPositions = workingPositions.filter((p) => p.id !== pos.id);

          newTrades.push({
            id: order.id,
            symbol: order.symbol,
            type: pos.type,
            side: order.side,
            price: fillPrice,
            requestedPrice: order.signalPrice,
            slippagePercent,
            fee,
            delayMs,
            quantity: pos.quantity,
            usdValue: notional,
            leverage: pos.leverage,
            timestamp: now,
            at: Date.now(),
            reason: order.reason,
            confidence: order.confidence,
            pnl,
            pnlPercent: pos.type === 'SPOT'
              ? (pnl / (pos.quantity * pos.avgPrice)) * 100
              : (pnl / pos.marginUsd) * 100
          });
        }
      }
    }

    const dueIds = new Set(due.map((o) => o.id));
    pending = pending.filter((o) => !dueIds.has(o.id));

    if (newTrades.length) {
      cash = workingCash;
      positions = workingPositions;
      trades = [...newTrades.reverse(), ...trades].slice(0, 100);
      totalFees += feesAdded;
      totalSlippageCost += slipAdded;
    }
  }

  function recordEquity() {
    const now = Date.now();
    const timeStr = new Date(now).toLocaleTimeString('he-IL');
    const eq = equity();
    history = [...history, { timestamp: timeStr, at: now, portfolio: eq }].slice(-720);
    const last = hourlyHistory[hourlyHistory.length - 1];
    const lastHour = last ? Math.floor(last.at / (60 * 60 * 1000)) : -1;
    const currentHour = Math.floor(now / (60 * 60 * 1000));
    if (currentHour > lastHour) {
      hourlyHistory = [...hourlyHistory, { timestamp: timeStr, at: now, portfolio: eq }].slice(-720);
    }
  }

  async function tick(config: SimBotConfig, fearGreed = 50) {
    initialAmount = config.initialAmount || 10000;
    if ((cash === 0 || !Number.isFinite(cash)) && positions.length === 0 && trades.length === 0) {
      cash = initialAmount;
    }
    await refreshMarketData();
    for (const c of cryptoData) lastPrices[c.symbol.toUpperCase()] = c.current_price;

    // Mark-to-market live price updates on each tick for open positions
    positions = positions.map((p) => {
      const live = priceFor(p.symbol) ?? p.currentPrice;
      return {
        ...p,
        currentPrice: live,
        highestPrice: Math.max(p.highestPrice || p.entryPrice, live),
        lowestPrice: Math.min(p.lowestPrice || p.entryPrice, live),
        highestPriceSinceTP1: p.tp1Hit ? Math.max(p.highestPriceSinceTP1 || live, live) : undefined,
        lowestPriceSinceTP1: p.tp1Hit ? Math.min(p.lowestPriceSinceTP1 || live, live) : undefined
      };
    });

    const evalResult = evaluate(config, fearGreed);
    lastEvaluations = evalResult.results;
    const we = evalResult.results.filter((r) => r.willExecute).length;
    console.log(`[sim-engine] evals=${evalResult.results.length} willExecute=${we} pending=${pending.length} pos=${positions.length} cash=${cash.toFixed(2)}`);
    generateOrders(evalResult, config);
    executeDueOrders();
    recordEquity();
    lastEvaluation = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    return getSnapshot();
  }

  function getSnapshot() {
    const eq = equity();
    const { dailyDrawdownPercent, weeklyDrawdownPercent } = drawdowns(eq);
    const closedTrades = trades.filter((t) => typeof t.pnl === 'number');
    const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : 0;
    return {
      cash,
      positions,
      positionsValue: positionsValue(),
      equity: eq,
      trades,
      history,
      pending,
      totalFees,
      totalSlippageCost,
      winRate,
      totalTrades: trades.length,
      closedTrades: closedTrades.length,
      lastEvaluation,
      evaluations: lastEvaluations,
      minConfidence: 40,
      hasSavedSession: trades.length > 0 || positions.length > 0,
      nextTickAt: Date.now() + TICK_MS,
      totalLeveragedExposureUsd: leveragedExposure(),
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      candleCount: Object.keys(liveCandles).length
    };
  }

  function hydrate(snapshot: SimSnapshot) {
    if (!snapshot || typeof snapshot.cash !== 'number') return;
    cash = snapshot.cash;
    positions = snapshot.positions ?? [];
    trades = snapshot.trades ?? [];
    history = snapshot.history ?? [];
    hourlyHistory = snapshot.hourlyHistory ?? [];
    pending = snapshot.pending ?? [];
    totalFees = snapshot.totalFees ?? 0;
    totalSlippageCost = snapshot.totalSlippageCost ?? 0;
    lastEvaluation = snapshot.lastEvaluation ?? '';
    initialAmount = snapshot.cash || 10000;
  }

  function reset(config: SimBotConfig) {
    cash = config.initialAmount;
    initialAmount = config.initialAmount;
    positions = [];
    trades = [];
    history = [];
    hourlyHistory = [];
    pending = [];
    totalFees = 0;
    totalSlippageCost = 0;
    lastEvaluation = '';
    lastEvaluations = [];
  }

  return { tick, getSnapshot, hydrate, reset };
}

export type { SimSnapshot, SimEvaluateResult, SimEvaluationResult };

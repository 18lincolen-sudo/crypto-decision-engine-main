// Server-side simulation engine — runs the SAME trade logic as the browser
// (useSimulationBot) but inside Node, so the shared bot advances 24/7 without
// any browser tab open. Reuses the real tradeEngine + market-data clients.
import {
  calculateTradingFee,
  simulateSlippage,
  formatDynamicPrice,
  Candle
} from '../src/services/tradeEngine';
import { getAggregatedPrices } from '../src/services/cryptoPriceAggregator';
import { CryptoData } from '../src/types/crypto';
import {
  evaluateSymbolFromSnapshot,
  buildPortfolioRiskStats,
  evaluatePositionExit,
  computeAtr5,
  MultiTimeframeSnapshot,
  SignalEvaluation
} from '../src/services/intradayBridge';
import { getUniverseMarketData } from '../src/services/marketDataService';
import type { IntradayDecision } from '../src/services/intradayEngine';
import { reanchorLevel, computeEntryBudget, isInEntryCooldown } from '../src/services/simExecution';

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
  decision?: IntradayDecision;
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
// Normalizes either a bare ("LIT") or suffixed ("LITUSDT") symbol to its base
// asset, so price lookups work regardless of which form the caller has.
const toBaseSymbol = (s: string) => (s.toUpperCase().endsWith('USDT') ? s.toUpperCase().slice(0, -4) : s.toUpperCase());
const TICK_MS = 4000;
const CRYPTO_REFRESH_MS = 60_000;  // 60s — Bybit/Binance are fast, no need to hammer CoinGecko
const CANDLE_REFRESH_MS = 5 * 60_000;

// Telegram notifications for the simulation bot (paper trades) — same
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars as the real bot's alerts,
// but this engine previously had NO Telegram integration at all: the sim
// bot's entries/exits were never announced, only the real (dry-run) bot's
// entries were. Never throws — a Telegram failure must not affect trading.
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
async function sendSimTelegramMessage(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message })
    });
  } catch {
    // ignore — notification failures must not affect the simulation
  }
}

export function createSimEngine(getSymbols?: () => string[]) {
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
  // Safety net against rapid re-entry churn: after a LOSING full exit, skip new
  // entries on that symbol for a cooldown window even if the signal still fires.
  const exitCooldown: Record<string, number> = {};

  let liveCandles: Record<string, MultiTimeframeSnapshot> = {};
  let cryptoData: CryptoData[] = [];
  const lastPrices: Record<string, number> = {};
  let cryptoRefreshAt = 0;
  let candleRefreshAt = 0;
  let candleRefreshing = false;
  let initialAmount = 10000;

  async function chunked<T>(items: T[], size: number, fn: (batch: T[]) => Promise<void>) {
    for (let i = 0; i < items.length; i += size) {
      await fn(items.slice(i, i + size));
    }
  }

  // Positions/orders always carry the SUFFIXED symbol ("LITUSDT", from the MTF
  // snapshot), but cryptoData/lastPrices are keyed by the BARE ticker symbol
  // ("lit", from the price aggregator) — comparing them directly never matched,
  // so priceFor() silently returned undefined for every open position and mark-
  // to-market prices (and therefore chart currentPrice) froze at the entry fill
  // price forever. Normalize both sides to the base asset before comparing.
  function priceFor(symbol: string): number | undefined {
    const base = toBaseSymbol(symbol);
    if (typeof lastPrices[base] === 'number') return lastPrices[base];
    const c = cryptoData.find((x) => toBaseSymbol(x.symbol) === base);
    return c?.current_price;
  }

  function buildCandlesForSymbol(symbol: string): Candle[] {
    const snap = liveCandles[toBaseSymbol(symbol)];
    return snap && snap.m5 && snap.m5.length ? snap.m5 : [];
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
        // Use multi-source aggregator: Bybit → Binance → CoinGecko (rate-gated).
        // Restrict to the SAME curated liquid universe the real bot trades —
        // without this filter, getAggregatedPrices() returns EVERY Bybit USDT
        // pair (400+), and refreshCandles() below then has to fetch 1H/15M/5M
        // klines for all of them every cycle. That starves the pipeline under
        // rate limits so only a handful of symbols ever reach READY status,
        // meaning most SIGNAL evaluations never get a chance to actually fill.
        const data = await getAggregatedPrices(getSymbols?.());
        if (data && data.length) {
          cryptoData = data;
          cryptoRefreshAt = now;
          for (const c of data) lastPrices[toBaseSymbol(c.symbol)] = c.current_price;
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
    try {
      const { snapshots } = await getUniverseMarketData(symbols, { log: true });
      const next: Record<string, MultiTimeframeSnapshot> = {};
      // getUniverseMarketData keys its Map by the SUFFIXED symbol (snap.symbol,
      // e.g. "LITUSDT"); liveCandles is looked up elsewhere with the bare ticker
      // symbol from cryptoData ("LIT"). Normalize to base-asset form here so
      // every reader/writer of liveCandles agrees on one key format.
      for (const [sym, snap] of snapshots) next[toBaseSymbol(sym)] = snap;
      liveCandles = next;
    } catch {
      /* keep last-known-good MTF data on failure */
    }
  }

  function evaluate(config: SimBotConfig, fearGreed: number) {
    const openPos = positions;
    const queued = pending;
    const maxTotalPositions = config.maxPositions || 7;
    const maxFutures = 2;
    const futuresCount = openPos.filter((p) => p.type === 'FUTURES').length;
    const eq = equity();
    const { dailyDrawdownPercent, weeklyDrawdownPercent } = drawdowns(eq);
    const totalLeveragedExposureUsd = leveragedExposure();

    const isCircuitBreakerDaily = dailyDrawdownPercent >= 8;
    const isCircuitBreakerWeekly = weeklyDrawdownPercent >= 15;

    const results: SimEvaluationResult[] = [];

    const portfolio = buildPortfolioRiskStats({
      portfolioValue: eq,
      initialAmount,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      openPositionsCount: openPos.length,
      openFuturesPositionsCount: futuresCount,
      totalLeveragedExposureUsd
    });

    const openPositionsForEngine = openPos.map((p) => ({ symbol: p.symbol, type: p.type as 'SPOT' | 'FUTURES' }));

    for (const crypto of cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;

      const snap = liveCandles[toBaseSymbol(symbol)];
      if (!snap || snap.status !== 'READY') continue;

      const ev = evaluateSymbolFromSnapshot(
        snap,
        { price: currentPrice, priceChange24h },
        portfolio,
        openPositionsForEngine
      );

      // `symbol` here is bare (from cryptoData); queued/openPos entries store
      // the SUFFIXED symbol (from ev.symbol → order.symbol → position.symbol).
      // Comparing them directly (as this used to) always returned false, so
      // the bot could never detect it already held or had queued a symbol —
      // same bare-vs-suffixed mismatch already fixed for pricing/candles.
      const isQueued = queued.some((o) => toBaseSymbol(o.symbol) === symbol);
      const isHeld = openPos.some((p) => toBaseSymbol(p.symbol) === symbol);
      const hasExistingFutures = openPos.some((p) => toBaseSymbol(p.symbol) === symbol && p.type === 'FUTURES');

      let status = ev.status;
      let willExecute = ev.willExecute;

      if (isCircuitBreakerWeekly) { status = 'נעילת מערכת שבועית (הפסד >= 15%) — מושבת'; willExecute = false; }
      else if (isCircuitBreakerDaily) { status = 'הגנת תיק יומית (הפסד >= 8%) — חסום'; willExecute = false; }
      else if (isQueued) { status = 'פקודה כבר נמצאת בתור ביצוע'; willExecute = false; }
      else if (openPos.length >= maxTotalPositions) { status = `הגעת למקסימום ${maxTotalPositions} פוזיציות פתוחות`; willExecute = false; }
      else if (ev.tradeType === 'FUTURES' && futuresCount >= maxFutures) { status = `הגעת למקסימום ${maxFutures} פוזיציות Futures`; willExecute = false; }
      else if (ev.tradeType === 'FUTURES' && hasExistingFutures) { status = 'קיימת כבר פוזיציית Futures פתוחה'; willExecute = false; }
      else if (ev.tradeType === 'SPOT' && ev.tradeSide === 'BUY' && isHeld) { status = 'כבר מוחזק בתיק (Spot)'; willExecute = false; }

      results.push({
        symbol: ev.symbol,
        action: ev.action,
        tradeType: ev.tradeType,
        tradeSide: ev.tradeSide,
        confidence: ev.confidence,
        price: ev.price,
        priceChange24h,
        reasoning: ev.reasoning,
        status,
        willExecute,
        factors: ev.factors,
        confidenceGap: ev.confidenceGap,
        regime: ev.regime as SimEvaluationResult['regime'],
        leverage: ev.leverage,
        stopLoss: ev.stopLoss,
        takeProfit1: ev.takeProfit1,
        takeProfit2: ev.takeProfit2,
        takeProfit: ev.takeProfit,
        decision: ev.decision
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
      const atr5 = computeAtr5(buildCandlesForSymbol(pos.symbol));
      const currentEval = evalResult.results.find((e: SimEvaluationResult) => e.symbol === pos.symbol);
      const decision = currentEval?.decision;
      const reversal = decision && decision.outcome === 'SIGNAL'
        ? { direction: decision.direction, setupScore: decision.metrics.setupScore, entryConfirmed: !!decision.entry?.confirmed }
        : undefined;

      const exitCheck = evaluatePositionExit(
        {
          symbol: pos.symbol,
          type: pos.type,
          side: pos.side,
          entryPrice: pos.entryPrice,
          quantity: pos.quantity,
          stopLoss: pos.stopLoss,
          takeProfit1: pos.takeProfit1,
          takeProfit2: pos.takeProfit2,
          tp1Hit: pos.tp1Hit,
          openTimestamp: pos.openTimestamp,
          plannedStopDistance: Math.abs(pos.entryPrice - pos.stopLoss),
          highestPrice: pos.highestPrice,
          lowestPrice: pos.lowestPrice,
          highestPriceSinceTP1: pos.highestPriceSinceTP1,
          lowestPriceSinceTP1: pos.lowestPriceSinceTP1
        },
        livePrice,
        atr5,
        { dailyDrawdownPercent: evalResult.dailyDrawdownPercent, weeklyDrawdownPercent: evalResult.weeklyDrawdownPercent },
        reversal
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

      if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;

      const orderSide = ev.tradeType === 'FUTURES'
        ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
        : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

      const budget = computeEntryBudget(cash, ev.tradeType === 'FUTURES' ? 'FUTURES' : 'SPOT');

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

        const reanchor = (level: number | undefined) => reanchorLevel(fillPrice, order.signalPrice, level);

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
          stopLoss: reanchor(order.stopLoss) ?? (order.side === 'short' ? fillPrice * 1.05 : fillPrice * 0.95),
          takeProfit1: reanchor(order.takeProfit1),
          takeProfit2: reanchor(order.takeProfit2),
          takeProfit: reanchor(order.takeProfit) ?? (order.side === 'short' ? fillPrice * 0.95 : fillPrice * 1.05),
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

        void sendSimTelegramMessage(
          `🟢 סימולציה — כניסה\n\n` +
          `סמל: ${order.symbol}\n` +
          `כיוון: ${newPos.side}${isFutures ? ` (${leverage}x)` : ''}\n` +
          `מחיר כניסה: $${formatDynamicPrice(fillPrice)}\n` +
          `SL: $${formatDynamicPrice(newPos.stopLoss)}\n` +
          (newPos.takeProfit1 ? `TP1: $${formatDynamicPrice(newPos.takeProfit1)}\n` : '') +
          (newPos.takeProfit2 ? `TP2: $${formatDynamicPrice(newPos.takeProfit2)}\n` : '') +
          `סיבה: ${order.reason || '-'}\n` +
          `זמן: ${now}`
        );
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

          const partialPnlPercent = (pnl / (pos.marginUsd * 0.5)) * 100;
          void sendSimTelegramMessage(
            `${pnl >= 0 ? '✅' : '🔴'} סימולציה — יציאה חלקית (TP1, 50%)\n\n` +
            `סמל: ${order.symbol}\n` +
            `כיוון: ${pos.side}\n` +
            `מחיר כניסה: $${formatDynamicPrice(pos.entryPrice)}\n` +
            `מחיר יציאה: $${formatDynamicPrice(fillPrice)}\n` +
            `רווח/הפסד (חלקי): ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${partialPnlPercent >= 0 ? '+' : ''}${partialPnlPercent.toFixed(2)}%)\n` +
            `זמן: ${now}`
          );
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
          if (pnl < 0) exitCooldown[pos.symbol] = Date.now();

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

          const pnlPercent = pos.type === 'SPOT'
            ? (pnl / (pos.quantity * pos.avgPrice)) * 100
            : (pnl / pos.marginUsd) * 100;
          void sendSimTelegramMessage(
            `${pnl >= 0 ? '✅' : '🔴'} סימולציה — יציאה\n\n` +
            `סמל: ${order.symbol}\n` +
            `כיוון: ${pos.side}\n` +
            `מחיר כניסה: $${formatDynamicPrice(pos.entryPrice)}\n` +
            `מחיר יציאה: $${formatDynamicPrice(fillPrice)}\n` +
            `רווח/הפסד: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
            `סיבה: ${order.reason || '-'}\n` +
            `זמן: ${now}`
          );
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
    for (const c of cryptoData) lastPrices[toBaseSymbol(c.symbol)] = c.current_price;

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

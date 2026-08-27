// Server-side simulation engine for "Bot Pro" — a literal implementation of
// ASSETS/alg.md, runs 24/7 in Node, same shape as server/legacySimEngine.ts
// and server/simEngine.ts. Same market data sources (getAggregatedPrices /
// getUniverseMarketData), same execution mechanics (fillDueOrders from
// simExecution.ts). The ONLY deliberate difference from the other two server
// engines is the decision algorithm: this one drives
// buildProEvaluations/generateProOrders (proSimExecution.ts / proAlgEngine.ts
// — see that file's header for the specific, verified differences from
// tradeEngine.ts, which is what the legacy bot actually runs).
import { formatDynamicPrice, Candle } from '../src/services/tradeEngine';
import { getAggregatedPrices } from '../src/services/cryptoPriceAggregator';
import { CryptoData } from '../src/types/crypto';
import { MultiTimeframeSnapshot } from '../src/services/intradayBridge';
import { getUniverseMarketData } from '../src/services/marketDataService';
import { toBaseAsset } from '../src/services/assetUniverse';
import { fillDueOrders, selectFillableOrders, SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '../src/services/simExecution';
import { buildProEvaluations, generateProOrders, MIN_PRO_CANDLES } from '../src/services/proSimExecution';
import type { SignalEvaluation } from '../src/services/intradayBridge';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig };

interface ProSimSnapshot {
  cash: number;
  positions: SimPosition[];
  trades: SimTrade[];
  history: SimPoint[];
  hourlyHistory: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
}

const TICK_MS = 4000;
const CRYPTO_REFRESH_MS = 60_000;
const CANDLE_REFRESH_MS = 5 * 60_000;

// Same Telegram wiring as the other two server engines — same env vars, own
// message stream (every bot's entries/exits are worth seeing separately).
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
async function sendProSimTelegramMessage(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[telegram] pro-sim sendMessage failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.warn('[telegram] pro-sim sendMessage threw:', e instanceof Error ? e.message : String(e));
  }
}

export function createProSimEngine(getSymbols?: () => string[]) {
  let cash = 10000;
  let positions: SimPosition[] = [];
  let trades: SimTrade[] = [];
  let history: SimPoint[] = [];
  let hourlyHistory: SimPoint[] = [];
  let pending: PendingOrder[] = [];
  let totalFees = 0;
  let totalSlippageCost = 0;
  let lastEvaluation = '';
  let lastEvaluations: SignalEvaluation[] = [];
  const exitCooldown: Record<string, number> = {};

  let liveCandles: Record<string, MultiTimeframeSnapshot> = {};
  let cryptoData: CryptoData[] = [];
  const lastPrices: Record<string, number> = {};
  let cryptoRefreshAt = 0;
  let candleRefreshAt = 0;
  let candleRefreshing = false;
  let initialAmount = 10000;

  function priceFor(symbol: string): number | undefined {
    const base = toBaseAsset(symbol);
    if (typeof lastPrices[base] === 'number') return lastPrices[base];
    const c = cryptoData.find((x) => toBaseAsset(x.symbol) === base);
    return c?.current_price;
  }

  // alg.md's algorithm is single-timeframe (H1) — reuses the SAME multi-
  // timeframe fetch as the other engines (identical data source/cache), just
  // reads the h1 series out of it, same as the legacy engine.
  function candlesBySymbolView(): Record<string, Candle[]> {
    const view: Record<string, Candle[]> = {};
    for (const key of Object.keys(liveCandles)) view[key] = buildCandlesForSymbol(key);
    return view;
  }

  function buildCandlesForSymbol(symbol: string): Candle[] {
    const snap = liveCandles[toBaseAsset(symbol)];
    return snap && snap.h1 && snap.h1.length >= MIN_PRO_CANDLES ? snap.h1 : [];
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
        const data = await getAggregatedPrices(getSymbols?.());
        if (data && data.length) {
          cryptoData = data;
          cryptoRefreshAt = now;
          for (const c of data) lastPrices[toBaseAsset(c.symbol)] = c.current_price;
        }
      } catch {
        /* keep last-known-good prices */
      }
    }
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
      const { snapshots } = await getUniverseMarketData(symbols, { log: false });
      const next: Record<string, MultiTimeframeSnapshot> = {};
      for (const [sym, snap] of snapshots) next[toBaseAsset(sym)] = snap;
      liveCandles = next;
    } catch {
      /* keep last-known-good MTF data on failure */
    }
  }

  async function tick(config: SimBotConfig, fearGreed = 50) {
    initialAmount = config.initialAmount || 10000;
    if ((cash === 0 || !Number.isFinite(cash)) && positions.length === 0 && trades.length === 0) {
      cash = initialAmount;
    }
    await refreshMarketData();
    for (const c of cryptoData) lastPrices[toBaseAsset(c.symbol)] = c.current_price;

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

    const eq = equity();
    const { dailyDrawdownPercent, weeklyDrawdownPercent } = drawdowns(eq);
    const totalLeveragedExposureUsd = leveragedExposure();
    const closedTradeMetrics = trades
      .filter((t) => typeof t.pnl === 'number')
      .map((t) => ({ pnl: t.pnl ?? 0, pnlPercent: t.pnlPercent ?? 0, at: t.at }));
    const candlesBySymbol = candlesBySymbolView();

    const evaluations = buildProEvaluations({
      cryptoData,
      candlesBySymbol,
      positions,
      pending,
      config,
      equity: eq,
      totalLeveragedExposureUsd,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      fearGreedIndex: fearGreed,
      closedTradeMetrics
    });
    lastEvaluations = evaluations;
    const we = evaluations.filter((r) => r.willExecute).length;
    console.log(`[pro-sim-engine] evals=${evaluations.length} willExecute=${we} pending=${pending.length} pos=${positions.length} cash=${cash.toFixed(2)}`);

    const newOrders = generateProOrders({
      positions,
      pending,
      evaluations,
      executionDelaySec: config.executionDelaySec,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      cash,
      exitCooldown,
      priceFor,
      candlesBySymbol,
      maxPositions: config.maxPositions || 7,
      maxFuturesPositions: config.maxFuturesPositions || 2,
      closedTradeMetrics
    });
    if (newOrders.length) pending = [...pending, ...newOrders];

    const { due, expired } = selectFillableOrders(pending, Date.now(), priceFor);
    if (expired.length) {
      const expiredIds = new Set(expired.map((o) => o.id));
      pending = pending.filter((o) => !expiredIds.has(o.id));
      for (const o of expired) console.log(`[pro-sim-engine] limit order expired unfilled: ${o.symbol} @ ${o.signalPrice}`);
    }
    if (due.length) {
      const result = fillDueOrders(due, cash, positions, priceFor, formatDynamicPrice);
      const dueIds = new Set(due.map((o) => o.id));
      pending = pending.filter((o) => !dueIds.has(o.id));
      if (result.newTrades.length) {
        cash = result.cash;
        positions = result.positions;
        trades = [...result.newTrades.reverse(), ...trades].slice(0, 100);
        totalFees += result.feesAdded;
        totalSlippageCost += result.slipAdded;
        Object.assign(exitCooldown, result.newCooldowns);
        const totalEq = equity();
        const totalPnl = totalEq - initialAmount;
        const totalPnlPercent = initialAmount > 0 ? (totalPnl / initialAmount) * 100 : 0;
        const statusFooter =
          `\n\n📊 מצב כולל של הבוט (פרו)\n` +
          `שווי נוכחי: $${totalEq.toFixed(2)}\n` +
          `רווח/הפסד כולל: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%)\n` +
          `פוזיציות פתוחות: ${positions.length}`;
        // Only notify on close — see the same change in simEngine.ts.
        for (const ev of result.events) {
          if (ev.kind === 'entry') continue;
          void sendProSimTelegramMessage(`🤖 בוט פרו · alg.md\n\n${ev.text}${statusFooter}`);
        }
      }
    }

    const now = Date.now();
    // Explicit timeZone: this runs on the server (Render defaults to UTC),
    // not in the user's browser — see the same fix in simExecution.ts.
    const timeStr = new Date(now).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    history = [...history, { timestamp: timeStr, at: now, portfolio: equity() }].slice(-720);
    const lastHourPt = hourlyHistory[hourlyHistory.length - 1];
    const lastHour = lastHourPt ? Math.floor(lastHourPt.at / (60 * 60 * 1000)) : -1;
    const currentHour = Math.floor(now / (60 * 60 * 1000));
    if (currentHour > lastHour) {
      hourlyHistory = [...hourlyHistory, { timestamp: timeStr, at: now, portfolio: equity() }].slice(-720);
    }

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
      minConfidence: 60,
      hasSavedSession: trades.length > 0 || positions.length > 0,
      nextTickAt: Date.now() + TICK_MS,
      totalLeveragedExposureUsd: leveragedExposure(),
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      candleCount: Object.keys(liveCandles).length
    };
  }

  function hydrate(snapshot: ProSimSnapshot) {
    if (!snapshot || typeof snapshot.cash !== 'number') return;
    cash = snapshot.cash;
    positions = snapshot.positions ?? [];
    trades = snapshot.trades ?? [];
    history = snapshot.history ?? [];
    hourlyHistory = snapshot.hourlyHistory ?? [];
    pending = snapshot.pending ?? [];
    totalFees = snapshot.totalFees ?? 0;
    totalSlippageCost = snapshot.totalSlippageCost ?? 0;
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

export type { ProSimSnapshot };

// Server-side simulation engine — runs the SAME trade logic as the browser
// (useSimulationBot) but inside Node, so the shared bot advances 24/7 without
// any browser tab open. Reuses the real tradeEngine + market-data clients.
//
// The evaluation/order-generation/fill logic itself lives in
// src/services/simExecution.ts, shared with useSimulationBot.ts — this file
// only owns the server's own state (plain closure variables instead of React
// state) and market-data refresh loop.
import { formatDynamicPrice } from '../src/services/tradeEngine';
import { getAggregatedPrices } from '../src/services/cryptoPriceAggregator';
import { CryptoData } from '../src/types/crypto';
import { computeAtr5, MultiTimeframeSnapshot, SignalEvaluation } from '../src/services/intradayBridge';
import { getUniverseMarketData } from '../src/services/marketDataService';
import { toBaseAsset } from '../src/services/assetUniverse';
import {
  buildEvaluations,
  generateNewOrders,
  fillDueOrders,
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig
} from '../src/services/simExecution';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig };

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

const TICK_MS = 4000;
const CRYPTO_REFRESH_MS = 60_000;  // 60s — Bybit/Binance are fast, no need to hammer CoinGecko
const CANDLE_REFRESH_MS = 5 * 60_000;

// Telegram notifications for the simulation bot (paper trades) — same
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars as the real bot's alerts.
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
async function sendSimTelegramMessage(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message })
    });
    // fetch() only rejects on network failure — a bad token/chat-id comes
    // back as a normal (non-2xx) response, which was previously never
    // inspected, so a misconfigured bot failed 100% silently.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[telegram] sim sendMessage failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (e) {
    // Never throw — a Telegram failure must not affect the simulation.
    console.warn('[telegram] sim sendMessage threw:', e instanceof Error ? e.message : String(e));
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
  let lastEvaluations: SignalEvaluation[] = [];
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

  // Positions/orders always carry the SUFFIXED symbol ("LITUSDT", from the MTF
  // snapshot), but cryptoData/lastPrices are keyed by the BARE ticker symbol
  // ("lit", from the price aggregator) — comparing them directly never matched,
  // so priceFor() silently returned undefined for every open position and mark-
  // to-market prices (and therefore chart currentPrice) froze at the entry fill
  // price forever. Normalize both sides to the base asset before comparing.
  function priceFor(symbol: string): number | undefined {
    const base = toBaseAsset(symbol);
    if (typeof lastPrices[base] === 'number') return lastPrices[base];
    const c = cryptoData.find((x) => toBaseAsset(x.symbol) === base);
    return c?.current_price;
  }

  function buildCandlesForSymbol(symbol: string) {
    const snap = liveCandles[toBaseAsset(symbol)];
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
          for (const c of data) lastPrices[toBaseAsset(c.symbol)] = c.current_price;
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

    const eq = equity();
    const { dailyDrawdownPercent, weeklyDrawdownPercent } = drawdowns(eq);
    const totalLeveragedExposureUsd = leveragedExposure();

    const evaluations = buildEvaluations({
      cryptoData,
      mtfData: liveCandles,
      positions,
      pending,
      config,
      equity: eq,
      initialAmount,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      totalLeveragedExposureUsd,
      toBase: (s) => toBaseAsset(s)
    });
    lastEvaluations = evaluations;
    const we = evaluations.filter((r) => r.willExecute).length;
    console.log(`[sim-engine] evals=${evaluations.length} willExecute=${we} pending=${pending.length} pos=${positions.length} cash=${cash.toFixed(2)}`);

    const newOrders = generateNewOrders({
      positions,
      pending,
      evaluations,
      executionDelaySec: config.executionDelaySec,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      cash,
      exitCooldown,
      priceFor,
      buildCandlesForSymbol,
      computeAtr5
    });
    if (newOrders.length) pending = [...pending, ...newOrders];

    const due = pending.filter((o) => Date.now() >= o.executeAt);
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
        // Overall bot status, computed AFTER applying this fill — appended
        // only to exit/partial-exit messages (not entries), per the ask that
        // a "position finished" notification show where the bot stands
        // overall, not just the one trade.
        const totalEq = equity();
        const totalPnl = totalEq - initialAmount;
        const totalPnlPercent = initialAmount > 0 ? (totalPnl / initialAmount) * 100 : 0;
        const statusFooter =
          `\n\n📊 מצב כולל של הבוט\n` +
          `שווי נוכחי: $${totalEq.toFixed(2)}\n` +
          `רווח/הפסד כולל: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%)\n` +
          `פוזיציות פתוחות: ${positions.length}`;
        for (const ev of result.events) {
          const text = ev.kind === 'entry' ? ev.text : ev.text + statusFooter;
          void sendSimTelegramMessage(text);
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

export type { SimSnapshot };

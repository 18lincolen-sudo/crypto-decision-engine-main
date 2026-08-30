// Shared server-side simulation engine — the tick/market-data/persistence
// plumbing used by ALL THREE sim bots (intraday multi-timeframe, legacy
// single-timeframe, pro/alg.md). This used to be copy-pasted three times
// (server/simEngine.ts, legacySimEngine.ts, proSimEngine.ts) with only the
// decision algorithm actually differing between them. That file has been
// deleted; this factory now owns everything that was duplicated, and each
// bot supplies a small `SimEngineStrategy` (see simEngine.ts /
// legacySimEngine.ts / proSimEngine.ts) that plugs its own
// evaluation/order-generation functions — from simExecution.ts /
// legacySimExecution.ts / proSimExecution.ts, all UNCHANGED — into this
// shared loop.
//
// Behavior is intended to be identical to the three original files for every
// field every strategy actually reads; the only intentional new behavior is
// that hydrate() now restores `lastEvaluation` for the legacy/pro bots too
// (the original legacy/pro hydrate() forgot to, even though their own
// getSnapshot() already persisted it — cosmetic only, affects nothing but the
// displayed "last evaluation" timestamp for the few seconds between a
// restart and the next tick).
import { formatDynamicPrice, Candle } from '../src/services/tradeEngine';
import { getAggregatedPrices } from '../src/services/cryptoPriceAggregator';
import { CryptoData } from '../src/types/crypto';
import { computeAtr5, MultiTimeframeSnapshot, SignalEvaluation } from '../src/services/intradayBridge';
import { getUniverseMarketData } from '../src/services/marketDataService';
import { toBaseAsset } from '../src/services/assetUniverse';
import {
  fillDueOrders,
  selectFillableOrders,
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig
} from '../src/services/simExecution';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig };

export interface SimSnapshot {
  cash: number;
  positions: SimPosition[];
  trades: SimTrade[];
  history: SimPoint[];
  hourlyHistory: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
  lastEvaluation?: string;
}

const TICK_MS = 4000;
const CRYPTO_REFRESH_MS = 60_000; // 60s — Bybit/Binance are fast, no need to hammer CoinGecko
const CANDLE_REFRESH_MS = 5 * 60_000;

/**
 * Everything a strategy's buildEvaluations/generateOrders might need for one
 * tick. A given strategy only reads the fields its own decision logic
 * actually uses (e.g. the intraday strategy ignores `candlesBySymbol`, the
 * legacy/pro strategies ignore `buildCandlesForSymbol`/`correlationCandles`)
 * — the unused fields cost only the (trivial, O(numSymbols)) computation to
 * build them, which is far cheaper than the three-engine duplication this
 * factory replaces.
 */
export interface StrategyTickInput {
  cryptoData: CryptoData[];
  liveCandles: Record<string, MultiTimeframeSnapshot>;
  /** H1 candles per symbol (keyed by BASE asset), gated by
   *  strategy.minCandlesForH1View. Used by the legacy/pro (single-timeframe)
   *  strategies. */
  candlesBySymbol: Record<string, Candle[]>;
  /** M5 candles for one symbol (empty array if not ready). Used by the
   *  intraday (multi-timeframe) strategy's order generation. */
  buildCandlesForSymbol: (symbol: string) => Candle[];
  /** H1 series per symbol (undefined if not available), keyed by BASE asset
   *  — used by the intraday strategy for the within-batch correlation gate. */
  correlationCandles: Record<string, Candle[] | undefined>;
  positions: SimPosition[];
  pending: PendingOrder[];
  config: SimBotConfig;
  equity: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  totalLeveragedExposureUsd: number;
  /** {pnl, at, symbol} — what the intraday strategy's evaluation/order-gen consume. */
  closedTrades: { pnl: number; at: number; symbol?: string }[];
  /** {pnl, pnlPercent, at, symbol} — what the legacy/pro strategies consume. */
  closedTradeMetrics: { pnl: number; pnlPercent: number; at: number; symbol?: string }[];
  fearGreedIndex: number;
  cash: number;
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  toBase: (symbol: string) => string;
  computeAtr5: typeof computeAtr5;
  maxPositions: number;
  maxFuturesPositions: number;
}

export interface SimEngineStrategy {
  /** Short id, used only for readability in this factory's own code. */
  id: string;
  /** Console log line prefix, e.g. "[sim-engine]". */
  logPrefix: string;
  /** Tag used in the telegram-failure warning, e.g. "sim". */
  telegramTag: string;
  /** Telegram message header for this bot's fill notifications. */
  telegramTitle: string;
  /** Hebrew label inserted into the "overall bot status" footer. */
  statusFooterLabel: string;
  /** Reported in getSnapshot() — the bot's configured confidence floor. */
  minConfidence: number;
  /** Minimum H1 candles required before candlesBySymbol exposes a symbol
   *  (MIN_LEGACY_CANDLES / MIN_PRO_CANDLES). Strategies that never read
   *  candlesBySymbol (the intraday one) can pass 0. */
  minCandlesForH1View: number;
  /** Passed to getUniverseMarketData({ log }) — only the intraday engine
   *  originally logged candle-fetch telemetry. */
  logCandleFetch: boolean;
  buildEvaluations: (input: StrategyTickInput) => SignalEvaluation[];
  generateOrders: (input: StrategyTickInput, evaluations: SignalEvaluation[]) => PendingOrder[];
}

async function sendSimTelegramMessage(tag: string, message: string): Promise<void> {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!telegramBotToken || !telegramChatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message })
    });
    // fetch() only rejects on network failure — a bad token/chat-id comes
    // back as a normal (non-2xx) response, which must still be inspected, or
    // a misconfigured bot fails 100% silently.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[telegram] ${tag} sendMessage failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (e) {
    // Never throw — a Telegram failure must not affect the simulation.
    console.warn(`[telegram] ${tag} sendMessage threw:`, e instanceof Error ? e.message : String(e));
  }
}

export function createGenericSimEngine(strategy: SimEngineStrategy, getSymbols?: () => string[]) {
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

  function buildM5CandlesForSymbol(symbol: string): Candle[] {
    const snap = liveCandles[toBaseAsset(symbol)];
    return snap && snap.m5 && snap.m5.length ? snap.m5 : [];
  }

  function buildH1CandlesForSymbol(symbol: string): Candle[] {
    const snap = liveCandles[toBaseAsset(symbol)];
    return snap && snap.h1 && snap.h1.length >= strategy.minCandlesForH1View ? snap.h1 : [];
  }

  function positionsValue(): number {
    return positions.reduce((sum, p) => {
      const live = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'SPOT') return sum + p.quantity * live;
      // Futures PnL: quantity already includes leverage (quantity = budget * leverage / fillPrice),
      // so we must NOT multiply by leverage again — doing so overstates PnL by leverage times.
      const pnl = p.side === 'LONG'
        ? (live - p.entryPrice) * p.quantity
        : (p.entryPrice - live) * p.quantity;
      // Report mark-to-market value honestly: margin + PnL, allowing negative
      // equity shocks below the margin floor. Clamping to 0 here masked an
      // underwater position's true damage from the drawdown/circuit-breaker
      // logic, which is exactly what must see it first.
      const value = p.marginUsd + pnl;
      return sum + (value >= 0 ? value : 0);
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
    // Use hourlyHistory for longer time windows (up to 30 days) — history only
    // covers ~48 minutes (720 points × 4s), which is insufficient for daily/weekly
    // drawdown calculation. Without this, circuit breakers only react to drawdowns
    // occurring within the last hour.
    const dayPoints = hourlyHistory.filter((pt) => pt.at >= oneDay);
    const weekPoints = hourlyHistory.filter((pt) => pt.at >= oneWeek);
    for (const pt of dayPoints) {
      if (pt.portfolio > peakDay) peakDay = pt.portfolio;
    }
    for (const pt of weekPoints) {
      if (pt.portfolio > peakWeek) peakWeek = pt.portfolio;
    }
    // Also check the most recent tick history for intra-hour precision
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
      // quantity already includes leverage for Futures, so notional = quantity * live
      if (p.type === 'FUTURES') return sum + p.quantity * live;
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
      const { snapshots } = await getUniverseMarketData(symbols, { log: strategy.logCandleFetch });
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

    // Closed-trade history drives adaptive sizing and the losing-streak
    // cooldown; `at` is what orders it (trades are kept newest-first).
    // `symbol` is the base asset — used for per-symbol cooldown tracking.
    const closedTrades = trades
      .filter((t) => typeof t.pnl === 'number')
      .map((t) => ({ pnl: t.pnl ?? 0, at: t.at, symbol: t.symbol }));
    const closedTradeMetrics = trades
      .filter((t) => typeof t.pnl === 'number')
      .map((t) => ({ pnl: t.pnl ?? 0, pnlPercent: t.pnlPercent ?? 0, at: t.at, symbol: t.symbol }));

    const candlesBySymbol: Record<string, Candle[]> = {};
    for (const key of Object.keys(liveCandles)) candlesBySymbol[key] = buildH1CandlesForSymbol(key);

    const correlationCandles: Record<string, Candle[] | undefined> = {};
    for (const key of Object.keys(liveCandles)) correlationCandles[key] = liveCandles[key]?.h1;

    const input: StrategyTickInput = {
      cryptoData,
      liveCandles,
      candlesBySymbol,
      buildCandlesForSymbol: buildM5CandlesForSymbol,
      correlationCandles,
      positions,
      pending,
      config,
      equity: eq,
      initialAmount,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      totalLeveragedExposureUsd,
      closedTrades,
      closedTradeMetrics,
      fearGreedIndex: fearGreed,
      cash,
      exitCooldown,
      priceFor,
      toBase: (s: string) => toBaseAsset(s),
      computeAtr5,
      maxPositions: config.maxPositions || 7,
      maxFuturesPositions: config.maxFuturesPositions || 2
    };

    const evaluations = strategy.buildEvaluations(input);
    lastEvaluations = evaluations;
    const we = evaluations.filter((r) => r.willExecute).length;
    console.log(`${strategy.logPrefix} evals=${evaluations.length} willExecute=${we} pending=${pending.length} pos=${positions.length} cash=${cash.toFixed(2)}`);

    const newOrders = strategy.generateOrders(input, evaluations);
    if (newOrders.length) pending = [...pending, ...newOrders];

    const { due, expired } = selectFillableOrders(pending, Date.now(), priceFor);
    if (expired.length) {
      const expiredIds = new Set(expired.map((o) => o.id));
      pending = pending.filter((o) => !expiredIds.has(o.id));
      for (const o of expired) console.log(`${strategy.logPrefix} limit order expired unfilled: ${o.symbol} @ ${o.signalPrice}`);
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
        // Overall bot status, computed AFTER applying this fill — appended
        // only to exit/partial-exit messages (not entries), per the ask that
        // a "position finished" notification show where the bot stands
        // overall, not just the one trade.
        const totalEq = equity();
        const totalPnl = totalEq - initialAmount;
        const totalPnlPercent = initialAmount > 0 ? (totalPnl / initialAmount) * 100 : 0;
        const statusFooter =
          `\n\n📊 ${strategy.statusFooterLabel}\n` +
          `שווי נוכחי: $${totalEq.toFixed(2)}\n` +
          `רווח/הפסד כולל: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%)\n` +
          `פוזיציות פתוחות: ${positions.length}`;
        // Only notify on close — the exit text already carries entry price,
        // exit price and P&L (see fillDueOrders in simExecution.ts), so a
        // single message on close already has the full picture. An entry-
        // time message is deliberately no longer sent.
        for (const ev of result.events) {
          if (ev.kind === 'entry') continue;
          void sendSimTelegramMessage(strategy.telegramTag, `${strategy.telegramTitle}\n\n${ev.text}${statusFooter}`);
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
      hourlyHistory,
      pending,
      totalFees,
      totalSlippageCost,
      winRate,
      totalTrades: trades.length,
      closedTrades: closedTrades.length,
      lastEvaluation,
      evaluations: lastEvaluations,
      minConfidence: strategy.minConfidence,
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


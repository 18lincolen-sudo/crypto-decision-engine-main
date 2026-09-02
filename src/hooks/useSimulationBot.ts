import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CryptoData, CryptoRecommendation, MarketRegimeResult } from '../types/crypto';
import { useBackgroundWorker } from './useBackgroundWorker';
import { Candle, formatDynamicPrice } from '../services/tradeEngine';
import {
  computeAtr5,
  MultiTimeframeSnapshot,
  SignalEvaluation,
  DecisionFactor,
  buildFactorsFromDecisionResult
} from '../services/intradayBridge';
import { getUniverseMarketData } from '../services/marketDataService';
import { toBaseAsset } from '../services/assetUniverse';
import {
  generateNewOrders,
  fillDueOrders,
  selectFillableOrders,
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig
} from '../services/simExecution';
import type { ClosedTradeRecord } from '../services/adaptiveRisk';
import { DecisionEngine, IntradayAdapter } from '../services/decisionEngine';
import type { DecisionResult, DecisionContext } from '../services/decisionEngine';

export type { SignalEvaluation, DecisionFactor } from '../services/intradayBridge';
export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '../services/simExecution';

// Convert DecisionEngine result to SignalEvaluation for backward compatibility
// with generateNewOrders and UI components.
function toSignalEvaluation(result: DecisionResult, currentPrice: number, priceChange24h: number): SignalEvaluation {
  const action = result.direction === 'LONG' ? 'buy' : result.direction === 'SHORT' ? 'sell' : 'hold';
  const tradeSide = result.direction;
  const isSignal = result.outcome === 'SIGNAL';

  return {
    symbol: result.symbol,
    action: action as 'buy' | 'sell' | 'hold',
    tradeType: result.tradeType as 'SPOT' | 'FUTURES' | 'HOLD',
    tradeSide: tradeSide as 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE',
    confidence: result.confidence,
    price: currentPrice,
    priceChange24h,
    reasoning: result.reasoning.join('\n'),
    status: isSignal ? `SIGNAL ${result.tradeType} ${result.direction}` : `NO_SIGNAL [${result.gate}]`,
    willExecute: isSignal,
    factors: buildFactorsFromDecisionResult(result),
    confidenceGap: 0,
    leverage: result.riskPlan?.leverage,
    stopLoss: result.riskPlan?.stopLoss,
    takeProfit1: result.riskPlan?.takeProfit1,
    takeProfit2: result.riskPlan?.takeProfit2,
    takeProfit: result.riskPlan?.takeProfit,
    decision: result.raw as never
  };
}

// A snapshot the engine can hydrate from (server-shared state may omit hourlyHistory).
interface HydratableSnapshot {
  cash: number;
  positions: SimPosition[];
  trades: SimTrade[];
  history: SimPoint[];
  hourlyHistory?: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
}

interface Params {
  config: SimBotConfig;
  isRunning: boolean;
  cryptoData?: CryptoData[];
  recommendations?: CryptoRecommendation[];
  fearGreedIndex?: number;
  // Server-backed shared state: hydrate from a shared snapshot.
  initialSnapshot?: HydratableSnapshot | null;
  persist?: (state: PersistedSimState) => void;
}

const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const SIM_BOT_STORAGE_KEY = 'simulation-bot-state-v2';

interface PersistedSimState {
  cash: number;
  positions: SimPosition[];
  trades: SimTrade[];
  history: SimPoint[];
  hourlyHistory: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
  savedAt: number;
}

const loadPersisted = (): PersistedSimState | null => {
  try {
    const raw = localStorage.getItem(SIM_BOT_STORAGE_KEY) || localStorage.getItem('simulation-bot-state-v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSimState;
    if (typeof parsed?.cash !== 'number') return null;
    
    // Backward compatibility formatting for old positions
    const migratedPositions = (parsed.positions || []).map((p: SimPosition) => ({
      id: p.id || uid(p.symbol),
      symbol: p.symbol,
      type: p.type || 'SPOT',
      side: p.side || 'BUY',
      quantity: p.quantity,
      entryPrice: p.entryPrice || p.avgPrice,
      avgPrice: p.avgPrice,
      currentPrice: p.currentPrice || p.avgPrice,
      leverage: p.leverage || 1,
      marginUsd: p.marginUsd || (p.quantity * p.avgPrice),
      notionalUsd: p.notionalUsd || (p.quantity * p.avgPrice * (p.leverage || 1)),
      stopLoss: p.stopLoss || (p.avgPrice * 0.95),
      takeProfit: p.takeProfit || (p.avgPrice * 1.05),
      tp1Hit: !!p.tp1Hit,
      openedAt: p.openedAt || new Date().toLocaleTimeString('he-IL'),
      openTimestamp: p.openTimestamp || Date.now(),
      reason: p.reason || '',
      confidence: p.confidence || 70,
      entryFee: p.entryFee || 0
    }));

    return {
      ...parsed,
      positions: migratedPositions
    };
  } catch {
    return null;
  }
};

export function useSimulationBot({ config, isRunning, cryptoData, recommendations, fearGreedIndex = 50, initialSnapshot, persist }: Params) {
  const [saved] = useState<HydratableSnapshot | PersistedSimState | null>(() => initialSnapshot ?? loadPersisted());
  const [cash, setCash] = useState(saved?.cash ?? config.initialAmount);
  const [positions, setPositions] = useState<SimPosition[]>(saved?.positions ?? []);
  const [trades, setTrades] = useState<SimTrade[]>(saved?.trades ?? []);
  const [history, setHistory] = useState<SimPoint[]>(saved?.history ?? []);
  const [hourlyHistory, setHourlyHistory] = useState<SimPoint[]>(saved?.hourlyHistory ?? []);
  const [pending, setPending] = useState<PendingOrder[]>(saved?.pending ?? []);
  const [totalFees, setTotalFees] = useState(saved?.totalFees ?? 0);
  const [totalSlippageCost, setTotalSlippageCost] = useState(saved?.totalSlippageCost ?? 0);
  const [lastEvaluation, setLastEvaluation] = useState<string>('');
  const [heartbeat, setHeartbeat] = useState(0);
  const [nextTickAt, setNextTickAt] = useState<number>(0);
  const [candleRefreshAt, setCandleRefreshAt] = useState<number>(0);
  const [candleSourceHealth, setCandleSourceHealth] = useState<{ bybit: number; binance: number; coingecko: number; failed: number }>({ bybit: 0, binance: 0, coingecko: 0, failed: 0 });

  const cashRef = useRef(cash);
  const positionsRef = useRef(positions);
  const pendingRef = useRef(pending);
  const cryptoRef = useRef(cryptoData);
  const configRef = useRef(config);
  const tradesRef = useRef(trades);
  const historyRef = useRef(history);
  // Cooldown after a losing exit — a stale/re-anchored SL can still legitimately
  // re-trigger seconds later in a fast-moving market; this stops the same
  // symbol from re-entering immediately and bleeding fees/slippage on repeat
  // near-instant round trips.
  const exitCooldownRef = useRef<Record<string, number>>({});

  cashRef.current = cash;
  positionsRef.current = positions;
  pendingRef.current = pending;
  cryptoRef.current = cryptoData;
  configRef.current = config;
  tradesRef.current = trades;
  historyRef.current = history;

  // Persist state via localStorage and optional callback (server-backed shared state when leader).
  useEffect(() => {
    // Never push a default/fresh state over real shared state.
    const meaningful = cash !== configRef.current.initialAmount || positions.length > 0 || trades.length > 0;
    if (!meaningful) return;
    const state: PersistedSimState = {
      cash,
      positions,
      trades,
      history,
      hourlyHistory,
      pending,
      totalFees,
      totalSlippageCost,
      savedAt: Date.now(),
    };

    try {
      localStorage.setItem(SIM_BOT_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }

    if (typeof persist === 'function') {
      persist(state);
    }
  }, [cash, positions, trades, history, hourlyHistory, pending, totalFees, totalSlippageCost, persist]);

  // Hydrate from a shared snapshot (server-backed) when one is provided.
  useEffect(() => {
    if (!initialSnapshot) return;
    setCash(initialSnapshot.cash);
    setPositions(initialSnapshot.positions);
    setTrades(initialSnapshot.trades);
    setHistory(initialSnapshot.history);
    setHourlyHistory(initialSnapshot.hourlyHistory ?? []);
    setPending(initialSnapshot.pending ?? []);
    setTotalFees(initialSnapshot.totalFees ?? 0);
    setTotalSlippageCost(initialSnapshot.totalSlippageCost ?? 0);
  }, [initialSnapshot]);

  const hasSavedSession = trades.length > 0 || positions.length > 0;

  // ═════════════════════════════════════════════════════
  // MULTI-TIMEFRAME MARKET DATA — 1H/15M/5M from Bybit/Binance (no mock data)
  // ═════════════════════════════════════════════════════
  const [mtfData, setMtfData] = useState<Record<string, MultiTimeframeSnapshot>>({});
  const mtfdRef = useRef<Record<string, MultiTimeframeSnapshot>>({});
  mtfdRef.current = mtfData;

  useEffect(() => {
    if (!cryptoData || cryptoData.length === 0) return;
    let cancelled = false;
    const symbols = cryptoData.map((c) => c.symbol.toUpperCase());

    const fetchMtf = async () => {
      try {
        const { snapshots, stats } = await getUniverseMarketData(symbols, { log: true });
        if (cancelled) return;
        const next: Record<string, MultiTimeframeSnapshot> = {};
        // Key by base asset (e.g. BTC) to match cryptoData.symbol, which is the
        // base asset returned by useCryptoData (fromBybitSymbol). The raw snapshot
        // key is the Bybit pair (BTCUSDT), so a direct lookup would always miss.
        for (const [sym, snap] of snapshots) next[toBaseAsset(sym)] = snap;
        setMtfData(next);
        setCandleSourceHealth({ bybit: 0, binance: 0, coingecko: 0, failed: stats.assetsSkipped });
        setCandleRefreshAt(Date.now());
      } catch {
        /* keep last-known-good MTF data on failure */
      }
    };

    fetchMtf();
    const interval = setInterval(fetchMtf, 5 * 60 * 1000); // refresh MTF data every 5 min
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cryptoData]);

  const reset = useCallback(() => {
    setCash(configRef.current.initialAmount);
    setPositions([]);
    setTrades([]);
    setHistory([]);
    setHourlyHistory([]);
    setPending([]);
    setTotalFees(0);
    setTotalSlippageCost(0);
    setLastEvaluation('');
    try {
      localStorage.removeItem(SIM_BOT_STORAGE_KEY);
      localStorage.removeItem('simulation-bot-state-v1');
    } catch {
      /* ignore */
    }
  }, []);

  // Normalize symbol to base asset for lookups — positions store suffixed symbols
  // (e.g. "LITUSDT") but cryptoData/mtfData are keyed by base asset (e.g. "LIT").
  // Without this normalization, priceFor() returns undefined for every open position
  // and mark-to-market prices freeze at the entry fill price.
  const priceFor = useCallback(
    (symbol: string) => {
      const base = toBaseAsset(symbol);
      const match = cryptoData?.find((c) => toBaseAsset(c.symbol) === base);
      return match?.current_price;
    },
    [cryptoData]
  );
  const priceForRef = useRef(priceFor);
  priceForRef.current = priceFor;

  // Build 5M candles from the LIVE multi-timeframe cache (no mock / random data)
  const buildCandlesForSymbol = useCallback((symbol: string): Candle[] => {
    const snap = mtfdRef.current[toBaseAsset(symbol)];
    return snap && snap.m5 && snap.m5.length > 0 ? snap.m5 : [];
  }, []);

  // Calculate current portfolio value and drawdowns
  const positionsValue = useMemo(() => {
    return positions.reduce((sum, p) => {
      const livePrice = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'SPOT') {
        return sum + p.quantity * livePrice;
      } else {
        // Futures PnL: quantity already includes leverage (quantity = budget * leverage / fillPrice),
        // so we must NOT multiply by leverage again — doing so overstates PnL by leverage times.
        const pnl = p.side === 'LONG'
          ? (livePrice - p.entryPrice) * p.quantity
          : (p.entryPrice - livePrice) * p.quantity;
        return sum + Math.max(0, p.marginUsd + pnl);
      }
    }, 0);
  }, [positions, priceFor]);

  const equity = cash + positionsValue;

  const totalLeveragedExposureUsd = useMemo(() => {
    return positions.reduce((sum, p) => {
      const livePrice = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'FUTURES') {
        return sum + p.quantity * livePrice;
      }
      return sum;
    }, 0);
  }, [positions, priceFor]);

  // Compute Drawdowns (Daily and Weekly)
  // Use hourlyHistory for longer time windows — history only covers ~1 hour
  // (720 points × 5s), which is insufficient for daily/weekly drawdown calculation.
  const { dailyDrawdownPercent, weeklyDrawdownPercent } = useMemo(() => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    let peakDay = equity;
    let peakWeek = equity;

    // Combine hourlyHistory (up to 168 hours = 7 days) with recent history
    const allPoints = [...hourlyHistory, ...history];
    for (const pt of allPoints) {
      if (pt.at >= oneDayAgo && pt.portfolio > peakDay) peakDay = pt.portfolio;
      if (pt.at >= oneWeekAgo && pt.portfolio > peakWeek) peakWeek = pt.portfolio;
    }

    const dailyDD = peakDay > 0 ? ((peakDay - equity) / peakDay) * 100 : 0;
    const weeklyDD = peakWeek > 0 ? ((peakWeek - equity) / peakWeek) * 100 : 0;

    return {
      dailyDrawdownPercent: Math.max(0, Number(dailyDD.toFixed(2))),
      weeklyDrawdownPercent: Math.max(0, Number(weeklyDD.toFixed(2)))
    };
  }, [equity, history, hourlyHistory]);

  // Closed-trade history feeding adaptive sizing and the losing-streak
  // cooldown. `trades` is kept NEWEST-FIRST for display; `at` travels with
  // each record so adaptiveRisk.ts orders it itself rather than trusting the
  // array order (reading it backwards is how the streak used to be computed
  // from the OLDEST trades in the window).
  // `symbol` is normalized to base asset (e.g. "BTCUSDT" → "BTC") for per-symbol
  // cooldown tracking — matching the bare symbol used in evaluations.
  const closedTradeRecords = useMemo<ClosedTradeRecord[]>(
    () => trades.filter((t) => typeof t.pnl === 'number').map((t) => ({ pnl: t.pnl ?? 0, at: t.at, symbol: toBaseAsset(t.symbol) })),
    [trades]
  );

  // H1 series per base asset for the correlation gate — same source the
  // decision engine already consumes, so no extra fetching.
  const correlationCandles = useMemo(() => {
    const out: Record<string, Candle[] | undefined> = {};
    for (const key of Object.keys(mtfData)) out[key] = mtfData[key]?.h1;
    return out;
  }, [mtfData]);

  // ═══════════════════════════════════════════════════════
  // Evaluation Engine (Single Source of Truth) — DecisionEngine
  // ═══════════════════════════════════════════════════════
  const engine = useMemo(() => {
    const eng = new DecisionEngine({ verbose: false });
    eng.registerAdapter(new IntradayAdapter());
    return eng;
  }, []);

  // Notional exposure per BASE asset, for the 8%-per-asset cap in the risk
  // layer. Derived from open positions so it can never drift from them.
  const exposureByAsset = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of positions) {
      const base = toBaseAsset(p.symbol);
      map[base] = (map[base] || 0) + (p.notionalUsd || 0);
    }
    return map;
  }, [positions]);

  const evaluations = useMemo<SignalEvaluation[]>(() => {
    if (!cryptoData?.length) return [];

    return cryptoData.map((crypto) => {
      const symbol = crypto.symbol.toUpperCase();
      const baseAsset = toBaseAsset(symbol);
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;
      const snap = mtfData[baseAsset];

      if (!snap || snap.status !== 'READY') {
        return {
          symbol: baseAsset,
          action: 'hold' as const,
          tradeType: 'HOLD' as const,
          tradeSide: 'NONE' as const,
          confidence: 0,
          price: currentPrice,
          priceChange24h,
          reasoning: 'NO_DATA — snapshot not ready',
          status: 'NO_SIGNAL [NO_DATA]',
          willExecute: false,
          factors: [],
          confidenceGap: 0
        };
      }

      const context: DecisionContext = {
        symbol: baseAsset,
        candles: {
          h1: snap.h1,
          m15: snap.m15 ?? [],
          m5: snap.m5 ?? []
        },
        currentPrice,
        portfolio: {
          portfolioValue: equity,
          initialAmount: config.initialAmount,
          dailyDrawdownPercent,
          weeklyDrawdownPercent,
          openPositionsCount: positions.length,
          openFuturesPositionsCount: positions.filter((p) => p.type === 'FUTURES').length,
          totalLeveragedExposureUsd,
          // Per-asset notional exposure, keyed the same way openPositions is.
        // Hardcoding {} here disabled the 8%-per-asset cap in intradayRisk.ts:
        // the cap read a current exposure of 0 for every asset, so it could
        // never see what was already held.
        existingExposureByAsset: exposureByAsset,
          systemLocked: false
        },
        // `candles` is what makes the correlation gate able to run at all —
        // without it evaluateCorrelationGate finds no series and abstains.
        openPositions: positions.map((p) => ({
          symbol: toBaseAsset(p.symbol),
          type: p.type,
          side: p.side,
          candles: correlationCandles[toBaseAsset(p.symbol)]
        })),
        marketData: {
          spreadPercent: snap.liquidity?.spreadPercent ?? 0,
          quoteVolume24h: snap.liquidity?.quoteVolume24h ?? 0,
          quoteVolume24hSpot: snap.liquidity?.quoteVolume24hSpot ?? 0,
          livePrice: snap.livePrice,
          priceChange24h
        },
        params: {},
        now: Date.now(),
        closedTrades: closedTradeRecords,
        config: {
          minConfidenceOverride: config.minConfidenceOverride,
          maxPositions: config.maxPositions || 7,
          maxFuturesPositions: config.maxFuturesPositions || 2
        }
      };

      const result = engine.evaluate(context, 'intraday');
      return toSignalEvaluation(result, currentPrice, priceChange24h);
    });
  }, [cryptoData, mtfData, positions, equity, config.initialAmount, config.maxPositions, config.maxFuturesPositions, config.minConfidenceOverride, dailyDrawdownPercent, weeklyDrawdownPercent, totalLeveragedExposureUsd, closedTradeRecords, engine, exposureByAsset, correlationCandles]);

  // Purely derived from evaluations — a useState+useEffect pair here previously
  // added an extra setState-triggered render on every evaluations change,
  // compounding the render cascade on mount (§ Maximum update depth warning).
  const activeMarketRegimes = useMemo(() => {
    const regimes: Record<string, MarketRegimeResult> = {};
    for (const ev of evaluations) {
      if (ev.regime) regimes[ev.symbol] = ev.regime;
    }
    return regimes;
  }, [evaluations]);

  // ═══════════════════════════════════════════════════════
  // 1. Order Generator & Exit Engine Tick
  // ═══════════════════════════════════════════════════════
  useEffect(() => {
    if (!isRunning) return;

    const newOrders = generateNewOrders({
      positions: positionsRef.current,
      pending: pendingRef.current,
      evaluations,
      executionDelaySec: config.executionDelaySec,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      cash: cashRef.current,
      exitCooldown: exitCooldownRef.current,
      priceFor: priceForRef.current,
      buildCandlesForSymbol,
      computeAtr5,
      maxPositions: config.maxPositions || 7,
      maxFuturesPositions: config.maxFuturesPositions || 2,
      closedTrades: closedTradeRecords,
      correlationCandles,
      toBase: (sym: string) => toBaseAsset(sym)
    });

    if (newOrders.length) {
      setPending((prev) => [...prev, ...newOrders]);
    }
    setLastEvaluation(new Date().toLocaleTimeString('he-IL'));
    setNextTickAt(Date.now() + 5000);
  }, [isRunning, evaluations, heartbeat, dailyDrawdownPercent, weeklyDrawdownPercent, buildCandlesForSymbol, mtfData, config.executionDelaySec, config.maxPositions, config.maxFuturesPositions, closedTradeRecords, correlationCandles]);

  // Heartbeat — reset countdown timer when bot starts/stops.
  // Equity recording is handled exclusively by the background worker below to avoid duplicates.
  useEffect(() => {
    if (!isRunning) return;
    setNextTickAt(Date.now() + 5000);
  }, [isRunning]);

  // Use background Web Worker to drive heartbeats even when browser tab is in the background
  useBackgroundWorker({
    enabled: isRunning,
    intervalMs: 5000,
    onTick: () => {
      setHeartbeat((h) => h + 1);
      setNextTickAt(Date.now() + 5000);

      // Record equity on every tick (single source of truth for history)
      const now = Date.now();
      const timeStr = new Date(now).toLocaleTimeString('he-IL');
      const equityNow = cashRef.current + positionsRef.current.reduce((sum, p) => {
        const live = priceForRef.current(p.symbol) ?? p.currentPrice;
        if (p.type === 'SPOT') return sum + p.quantity * live;
        // quantity already includes leverage, so do NOT multiply by leverage again.
        const pnl = p.side === 'LONG'
          ? (live - p.entryPrice) * p.quantity
          : (p.entryPrice - live) * p.quantity;
        return sum + Math.max(0, p.marginUsd + pnl);
      }, 0);

      // Minute-resolution portfolio history (720 points = 1 hour of ticks at 5s intervals)
      setHistory((prev) => {
        const next = [...prev, { timestamp: timeStr, at: now, portfolio: equityNow }];
        return next.length > 720 ? next.slice(-720) : next;
      });

      // Hourly snapshot history — capped at 168 entries (1 week)
      setHourlyHistory((prev) => {
        const last = prev[prev.length - 1];
        const lastHour = last ? Math.floor(last.at / (60 * 60 * 1000)) : -1;
        const currentHour = Math.floor(now / (60 * 60 * 1000));
        if (currentHour > lastHour) {
          const next = [...prev, { timestamp: timeStr, at: now, portfolio: equityNow }];
          return next.length > 168 ? next.slice(-168) : next;
        }
        return prev;
      });
    }
  });

  // ═══════════════════════════════════════════════════════
  // 2. Execution Engine (Realistic Slippage & Fees)
  // ═══════════════════════════════════════════════════════
  useEffect(() => {
    if (!isRunning) return;

    const tick = () => {
      const { due, expired } = selectFillableOrders(pendingRef.current, Date.now(), priceForRef.current);
      if (expired.length) {
        const expiredIds = new Set(expired.map((o) => o.id));
        setPending((prev) => prev.filter((o) => !expiredIds.has(o.id)));
      }
      if (!due.length) return;

      const result = fillDueOrders(due, cashRef.current, positionsRef.current, priceForRef.current, formatDynamicPrice);

      const dueIds = new Set(due.map((o) => o.id));
      setPending((prev) => prev.filter((o) => !dueIds.has(o.id)));

      if (result.newTrades.length) {
        setCash(result.cash);
        setPositions(result.positions);
        setTrades((prev) => [...result.newTrades.reverse(), ...prev].slice(0, 100));
        setTotalFees((f) => f + result.feesAdded);
        setTotalSlippageCost((s) => s + result.slipAdded);
        Object.assign(exitCooldownRef.current, result.newCooldowns);
        // Unlike the server engine, the browser sim has no Telegram wiring —
        // `result.events` (the same notification text the server sends) is
        // intentionally unused here.
      }
    };

    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  // Mark-to-market live price updates
  useEffect(() => {
    if (!cryptoData?.length) return;
    setPositions((prev) =>
      prev.map((p) => {
        const live = priceFor(p.symbol) ?? p.currentPrice;
        return {
          ...p,
          currentPrice: live,
          highestPrice: Math.max(p.highestPrice || p.entryPrice, live),
          lowestPrice: Math.min(p.lowestPrice || p.entryPrice, live),
          highestPriceSinceTP1: p.tp1Hit ? Math.max(p.highestPriceSinceTP1 || live, live) : undefined,
          lowestPriceSinceTP1: p.tp1Hit ? Math.min(p.lowestPriceSinceTP1 || live, live) : undefined
        };
      })
    );
  }, [cryptoData, priceFor]);

  const closedTrades = trades.filter((t) => typeof t.pnl === 'number');
  const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : 0;

  const displayHistory = useMemo(() => {
    const map = new Map<number, SimPoint>();
    // 1-minute buckets prevent hourly snapshots and frequent ticks from colliding
    [...hourlyHistory, ...history].forEach((p) => {
      const key = Math.floor(p.at / 60_000);
      map.set(key, p);
    });
    return Array.from(map.values()).sort((a, b) => a.at - b.at);
  }, [hourlyHistory, history]);

  return {
    cash,
    positions,
    positionsValue,
    equity,
    trades,
    history: displayHistory,
    pending,
    totalFees,
    totalSlippageCost,
    winRate,
    totalTrades: trades.length,
    closedTrades: closedTrades.length,
    lastEvaluation,
    evaluations,
    reset,
    minConfidence: 52,
    hasSavedSession,
    nextTickAt,
    totalLeveragedExposureUsd,
    dailyDrawdownPercent,
    weeklyDrawdownPercent,
    activeMarketRegimes,
    candleCount: Object.keys(mtfData).length,
    candleRefreshAt,
    candleSourceHealth
  };
}

// Parallel simulation engine running the ORIGINAL algorithm (alg.md Layers 0-5:
// single-timeframe regime detection + weighted-confidence signal scoring +
// 70%/58-62% confidence routing), side by side with the newer strict
// multi-timeframe engine driven by useSimulationBot.ts. Same position/portfolio
// mechanics (fees, slippage, execution delay) — only the decision logic differs.
//
// The evaluation/order-generation logic itself lives in
// src/services/legacySimExecution.ts, shared with server/legacySimEngine.ts
// (which now runs this same algorithm 24/7 server-side) — this hook only owns
// this runtime's own state (React state+refs) and market-data refresh loop,
// and serves as the LOCAL FALLBACK when the server isn't reachable, same role
// useSimulationBot.ts plays for the new engine.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CryptoData, MarketRegimeResult } from '@cde/engine';
import { useBackgroundWorker } from './useBackgroundWorker';
import type { Candle } from '@cde/engine';
import { SignalEvaluation, DecisionFactor, buildFactorsFromDecisionResult } from '@cde/engine';
import { getUniverseMarketData } from '@cde/engine/market-data';
import { toBaseAsset } from '@cde/engine/market-data';
import { fillDueOrders, selectFillableOrders } from '@cde/engine/execution';
import {
  generateLegacyOrders,
  activeLegacyMarketRegimesFrom as activeMarketRegimesFrom,
  MIN_LEGACY_CANDLES,
  formatDynamicPrice
} from '@cde/engine/execution';
import type { ClosedTradeMetric } from '@cde/engine/execution';
import type {
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig
} from './useSimulationBot';
import { DecisionEngine, LegacyAdapter } from '@cde/engine';
import type { DecisionResult, DecisionContext } from '@cde/engine';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from './useSimulationBot';

// Convert DecisionEngine result to SignalEvaluation for backward compatibility
// with generateLegacyOrders and UI components.
function toSignalEvaluation(result: DecisionResult, currentPrice: number, priceChange24h: number): SignalEvaluation {
  const action = result.direction === 'LONG' ? 'buy' : result.direction === 'SHORT' ? 'sell' : 'hold';
  const tradeSide = result.direction;
  const isSignal = result.outcome === 'SIGNAL';

  // Extract layer data from raw engine output (Legacy format: layer0-3)
  const raw = result.raw as unknown as {
    layer0?: MarketRegimeResult;
    layer1?: { confidence: number; buyScore: number; sellScore: number; signalScore: number };
    layer2?: { type: string; side: string; reason: string };
    layer3?: { stopLoss: number; takeProfit1: number; leverage: number };
  } | undefined;

  // Legacy uses MarketRegimeResult format directly
  const regime = raw?.layer0;

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
    regime,
    leverage: result.riskPlan ? result.riskPlan.leverage : undefined,
    stopLoss: result.riskPlan ? result.riskPlan.stopLoss : undefined,
    takeProfit1: result.riskPlan ? result.riskPlan.takeProfit1 : undefined,
    takeProfit2: result.riskPlan ? result.riskPlan.takeProfit2 : undefined,
    takeProfit: result.riskPlan ? result.riskPlan.takeProfit : undefined,
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
  fearGreedIndex?: number;
  // Server-backed shared state: hydrate from a shared snapshot.
  initialSnapshot?: HydratableSnapshot | null;
  persist?: (state: PersistedSimState) => void;
}

export const LEGACY_SIM_BOT_STORAGE_KEY = 'legacy-simulation-bot-state-v1';

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
    const raw = localStorage.getItem(LEGACY_SIM_BOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSimState;
    if (typeof parsed?.cash !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
};

export function useLegacySimulationBot({ config, isRunning, cryptoData, fearGreedIndex = 50, initialSnapshot, persist }: Params) {
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

  const cashRef = useRef(cash);
  const positionsRef = useRef(positions);
  const pendingRef = useRef(pending);
  const cryptoRef = useRef(cryptoData);
  const configRef = useRef(config);
  // Cooldown after a losing exit — see useSimulationBot.ts for full explanation.
  const exitCooldownRef = useRef<Record<string, number>>({});
  const tradesRef = useRef(trades);

  cashRef.current = cash;
  positionsRef.current = positions;
  pendingRef.current = pending;
  cryptoRef.current = cryptoData;
  configRef.current = config;
  tradesRef.current = trades;

  useEffect(() => {
    const meaningful = cash !== configRef.current.initialAmount || positions.length > 0 || trades.length > 0;
    if (!meaningful) return;
    const state: PersistedSimState = {
      cash, positions, trades, history, hourlyHistory, pending, totalFees, totalSlippageCost, savedAt: Date.now()
    };
    try {
      localStorage.setItem(LEGACY_SIM_BOT_STORAGE_KEY, JSON.stringify(state));
    } catch { /* ignore */ }
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

  // ═══════════════════════════════════════════════════════
  // MARKET DATA — reuse the same hourly candles the MTF cache already fetches
  // (h1 series), since the legacy algorithm is single-timeframe by design.
  // ═══════════════════════════════════════════════════════
  const [candlesBySymbol, setCandlesBySymbol] = useState<Record<string, Candle[]>>({});
  const candlesRef = useRef<Record<string, Candle[]>>({});
  candlesRef.current = candlesBySymbol;

  useEffect(() => {
    if (!cryptoData || cryptoData.length === 0) return;
    let cancelled = false;
    const symbols = cryptoData.map((c) => c.symbol.toUpperCase());

    const fetchCandles = async () => {
      try {
        const { snapshots } = await getUniverseMarketData(symbols, { log: false });
        if (cancelled) return;
        const next: Record<string, Candle[]> = {};
        for (const [sym, snap] of snapshots) {
          if (snap.h1 && snap.h1.length >= MIN_LEGACY_CANDLES) next[toBaseAsset(sym)] = snap.h1;
        }
        setCandlesBySymbol(next);
      } catch { /* keep last-known-good candles on failure */ }
    };

    fetchCandles();
    const interval = setInterval(fetchCandles, 5 * 60 * 1000);
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
      localStorage.removeItem(LEGACY_SIM_BOT_STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  const priceFor = useCallback(
    (symbol: string) => cryptoData?.find((c) => c.symbol.toUpperCase() === symbol.toUpperCase())?.current_price,
    [cryptoData]
  );
  const priceForRef = useRef(priceFor);
  priceForRef.current = priceFor;

  const positionsValue = useMemo(() => {
    return positions.reduce((sum, p) => {
      const livePrice = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'SPOT') return sum + p.quantity * livePrice;
      // quantity already includes leverage, so do NOT multiply by leverage again.
      const pnl = p.side === 'LONG'
        ? (livePrice - p.entryPrice) * p.quantity
        : (p.entryPrice - livePrice) * p.quantity;
      return sum + Math.max(0, p.marginUsd + pnl);
    }, 0);
  }, [positions, priceFor]);

  const equity = cash + positionsValue;

  const totalLeveragedExposureUsd = useMemo(() => {
    return positions.reduce((sum, p) => {
      const livePrice = priceFor(p.symbol) ?? p.currentPrice;
      return p.type === 'FUTURES' ? sum + p.quantity * livePrice : sum;
    }, 0);
  }, [positions, priceFor]);

  const { dailyDrawdownPercent, weeklyDrawdownPercent } = useMemo(() => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    // Use hourlyHistory for longer time windows — history only covers ~1 hour
    // (720 points × 5s), which is insufficient for daily/weekly drawdown calculation.
    const allPoints = [...hourlyHistory, ...history];
    let peakDay = equity;
    let peakWeek = equity;
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

  // Memoized on `trades` (not re-filtered every render) — evaluations below
  // depends on closedTradeMetrics, and an unstable reference here fed a
  // setState-in-useEffect loop (activeMarketRegimes) into an infinite render.
  // `symbol` is normalized to base asset for per-symbol cooldown tracking.
  const closedTrades = useMemo(() => trades.filter((t) => typeof t.pnl === 'number'), [trades]);
  const closedTradeMetrics = useMemo(
    () => closedTrades.map((t) => ({ pnl: t.pnl ?? 0, at: t.at, symbol: toBaseAsset(t.symbol) })),
    [closedTrades]
  );

  // ═══════════════════════════════════════════════════════
  // Evaluation Engine — Layers 0-3 of the ORIGINAL alg.md algorithm
  // ═══════════════════════════════════════════════════════
  const engine = useMemo(() => {
    const eng = new DecisionEngine({ verbose: false });
    eng.registerAdapter(new LegacyAdapter());
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
      const candles = candlesBySymbol[baseAsset];

      if (!candles || candles.length < MIN_LEGACY_CANDLES) {
        return {
          symbol: baseAsset,
          action: 'hold' as const,
          tradeType: 'HOLD' as const,
          tradeSide: 'NONE' as const,
          confidence: 0,
          price: currentPrice,
          priceChange24h,
          reasoning: 'NO_DATA — insufficient H1 candles',
          status: 'NO_SIGNAL [NO_DATA]',
          willExecute: false,
          factors: [],
          confidenceGap: 0
        };
      }

      const context: DecisionContext = {
        symbol: baseAsset,
        candles: { h1: candles },
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
          candles: candlesBySymbol[toBaseAsset(p.symbol)]
        })),
        marketData: {
          priceChange24h,
          fearGreedIndex
        },
        params: {},
        now: Date.now(),
        closedTrades: closedTradeMetrics,
        config: {
          minConfidenceOverride: config.minConfidenceOverride,
          maxPositions: config.maxPositions || 7,
          maxFuturesPositions: config.maxFuturesPositions || 2
        }
      };

      const result = engine.evaluate(context, 'legacy');
      return toSignalEvaluation(result, currentPrice, priceChange24h);
    });
  }, [cryptoData, candlesBySymbol, positions, equity, config.initialAmount, config.maxPositions, config.maxFuturesPositions, config.minConfidenceOverride, dailyDrawdownPercent, weeklyDrawdownPercent, totalLeveragedExposureUsd, fearGreedIndex, closedTradeMetrics, engine, exposureByAsset]);

  // Purely derived from evaluations — a useState+useEffect pair here previously
  // added an extra setState-triggered render on every evaluations change,
  // compounding the render cascade on mount (§ Maximum update depth warning).
  const activeMarketRegimes = useMemo<Record<string, MarketRegimeResult>>(
    () => activeMarketRegimesFrom(evaluations),
    [evaluations]
  );

  // ═══════════════════════════════════════════════════════
  // 1. Order Generator & Exit Engine Tick
  // ═══════════════════════════════════════════════════════
  useEffect(() => {
    if (!isRunning) return;

    const newOrders = generateLegacyOrders({
      positions: positionsRef.current,
      pending: pendingRef.current,
      evaluations,
      executionDelaySec: config.executionDelaySec,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      cash: cashRef.current,
      equity,
      exitCooldown: exitCooldownRef.current,
      priceFor: priceForRef.current,
      candlesBySymbol: candlesRef.current,
      maxPositions: config.maxPositions || 7,
      maxFuturesPositions: config.maxFuturesPositions || 2,
      closedTradeMetrics
    });

    if (newOrders.length) setPending((prev) => [...prev, ...newOrders]);
    setLastEvaluation(new Date().toLocaleTimeString('he-IL'));
    setNextTickAt(Date.now() + 5000);
  }, [isRunning, evaluations, heartbeat, dailyDrawdownPercent, weeklyDrawdownPercent, config, closedTradeMetrics, equity]);

  useEffect(() => {
    if (!isRunning) return;
    setNextTickAt(Date.now() + 5000);
  }, [isRunning]);

  useBackgroundWorker({
    enabled: isRunning,
    intervalMs: 5000,
    onTick: () => {
      setHeartbeat((h) => h + 1);
      setNextTickAt(Date.now() + 5000);

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

      setHistory((prev) => {
        const next = [...prev, { timestamp: timeStr, at: now, portfolio: equityNow }];
        return next.length > 720 ? next.slice(-720) : next;
      });

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
  // 2. Execution Engine (Realistic Slippage & Fees) — identical mechanics to
  // useSimulationBot.ts (fillDueOrders from simExecution.ts), only the orders
  // feeding it come from the legacy engine.
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
        // result.events is intentionally unused here.
      }
    };

    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

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

  const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : 0;

  const displayHistory = useMemo(() => {
    const map = new Map<number, SimPoint>();
    [...hourlyHistory, ...history].forEach((p) => {
      const key = Math.floor(p.at / 60_000);
      map.set(key, p);
    });
    return Array.from(map.values()).sort((a, b) => a.at - b.at);
  }, [hourlyHistory, history]);

  return {
    cash, positions, positionsValue, equity, trades, history: displayHistory, pending,
    totalFees, totalSlippageCost, winRate, totalTrades: trades.length, closedTrades: closedTrades.length,
    lastEvaluation, evaluations, reset, minConfidence: 58, hasSavedSession, nextTickAt,
    totalLeveragedExposureUsd, dailyDrawdownPercent, weeklyDrawdownPercent, activeMarketRegimes,
    candleCount: Object.keys(candlesBySymbol).length
  };
}

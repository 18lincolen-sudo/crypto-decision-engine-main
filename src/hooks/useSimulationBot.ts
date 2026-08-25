import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CryptoData, CryptoRecommendation, MarketRegimeResult, TradeType, TradeSide } from '../types/crypto';
import { useBackgroundWorker } from './useBackgroundWorker';
import {
  calculateTradingFee,
  simulateSlippage,
  Candle
} from '../services/tradeEngine';
import {
  evaluateSymbolFromSnapshot,
  buildPortfolioRiskStats,
  evaluatePositionExit,
  computeAtr5,
  MultiTimeframeSnapshot,
  SignalEvaluation,
  DecisionFactor
} from '../services/intradayBridge';
import { getUniverseMarketData } from '../services/marketDataService';
import { toBaseAsset } from '../services/assetUniverse';

export type { SignalEvaluation, DecisionFactor } from '../services/intradayBridge';

export interface SimPosition {
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

export interface SimTrade {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'buy' | 'sell' | 'long' | 'short' | 'close_long' | 'close_short' | 'partial_tp1';
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

export interface SimPoint {
  timestamp: string;
  at: number;
  portfolio: number;
}

export interface PendingOrder {
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

export interface SimBotConfig {
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

// A snapshot the engine can hydrate from (server-shared state may omit hourlyHistory).
interface HydratableSnapshot {
  cash: number;
  positions: any[];
  trades: any[];
  history: any[];
  hourlyHistory?: any[];
  pending: any[];
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
    const migratedPositions = (parsed.positions || []).map((p: any) => ({
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
  const ENTRY_COOLDOWN_MS = 2 * 60 * 1000;

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

  const priceFor = useCallback(
    (symbol: string) => {
      const match = cryptoData?.find((c) => c.symbol.toUpperCase() === symbol.toUpperCase());
      return match?.current_price;
    },
    [cryptoData]
  );
  const priceForRef = useRef(priceFor);
  priceForRef.current = priceFor;

  // Build 5M candles from the LIVE multi-timeframe cache (no mock / random data)
  const buildCandlesForSymbol = useCallback((symbol: string, _currentPrice: number): Candle[] => {
    const snap = mtfdRef.current[symbol.toUpperCase()];
    return snap && snap.m5 && snap.m5.length > 0 ? snap.m5 : [];
  }, []);

  // Calculate current portfolio value and drawdowns
  const positionsValue = useMemo(() => {
    return positions.reduce((sum, p) => {
      const livePrice = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'SPOT') {
        return sum + p.quantity * livePrice;
      } else {
        // Futures position equity = Margin + Unrealized PnL
        const pnl = p.side === 'LONG'
          ? (livePrice - p.entryPrice) * p.quantity * p.leverage
          : (p.entryPrice - livePrice) * p.quantity * p.leverage;
        return sum + Math.max(0, p.marginUsd + pnl);
      }
    }, 0);
  }, [positions, priceFor]);

  const equity = cash + positionsValue;

  const totalLeveragedExposureUsd = useMemo(() => {
    return positions.reduce((sum, p) => {
      const livePrice = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'FUTURES') {
        return sum + p.quantity * livePrice * p.leverage;
      }
      return sum;
    }, 0);
  }, [positions, priceFor]);

  // Compute Drawdowns (Daily and Weekly)
  const { dailyDrawdownPercent, weeklyDrawdownPercent } = useMemo(() => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    let peakDay = equity;
    let peakWeek = equity;

    for (const pt of history) {
      if (pt.at >= oneDayAgo && pt.portfolio > peakDay) peakDay = pt.portfolio;
      if (pt.at >= oneWeekAgo && pt.portfolio > peakWeek) peakWeek = pt.portfolio;
    }

    const dailyDD = peakDay > 0 ? ((peakDay - equity) / peakDay) * 100 : 0;
    const weeklyDD = peakWeek > 0 ? ((peakWeek - equity) / peakWeek) * 100 : 0;

    return {
      dailyDrawdownPercent: Math.max(0, Number(dailyDD.toFixed(2))),
      weeklyDrawdownPercent: Math.max(0, Number(weeklyDD.toFixed(2)))
    };
  }, [equity, history]);

  // ═══════════════════════════════════════════════════════
  // Evaluation Engine (Single Source of Truth)
  // ═══════════════════════════════════════════════════════
  const evaluations = useMemo<SignalEvaluation[]>(() => {
    if (!cryptoData?.length) return [];

    const openPos = positions;
    const queuedOrders = pending;
    const maxTotalPositions = config.maxPositions || 7;
    const maxFutures = 2;
    const futuresCount = openPos.filter(p => p.type === 'FUTURES').length;

    const portfolio = buildPortfolioRiskStats({
      portfolioValue: equity,
      initialAmount: config.initialAmount,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      openPositionsCount: openPos.length,
      openFuturesPositionsCount: futuresCount,
      totalLeveragedExposureUsd
    });

    const openPositionsForEngine = openPos.map(p => ({ symbol: p.symbol, type: p.type as 'SPOT' | 'FUTURES' }));

    const results: SignalEvaluation[] = [];

    // Scan all loaded crypto assets; evaluate only those with READY 1H/15M/5M data.
    for (const crypto of cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;

      const snap = mtfData[symbol];
      if (!snap || snap.status !== 'READY') continue;

      const ev = evaluateSymbolFromSnapshot(
        snap,
        { price: currentPrice, priceChange24h },
        portfolio,
        openPositionsForEngine
      );

      const isQueued = queuedOrders.some(o => o.symbol === symbol);
      const isHeld = openPos.some(p => p.symbol === symbol);
      const hasExistingFutures = openPos.some(p => p.symbol === symbol && p.type === 'FUTURES');

      let status = ev.status;
      let willExecute = ev.willExecute;

      if (!isRunning) {
        status = 'הבוט מושבת';
        willExecute = false;
      } else if (isQueued) {
        status = 'פקודה כבר נמצאת בתור ביצוע';
        willExecute = false;
      } else if (openPos.length >= maxTotalPositions) {
        status = `הגעת למקסימום ${maxTotalPositions} פוזיציות פתוחות`;
        willExecute = false;
      } else if (ev.tradeType === 'FUTURES' && futuresCount >= maxFutures) {
        status = `הגעת למקסימום ${maxFutures} פוזיציות Futures`;
        willExecute = false;
      } else if (ev.tradeType === 'FUTURES' && hasExistingFutures) {
        status = 'קיימת כבר פוזיציית Futures פתוחה';
        willExecute = false;
      } else if (ev.tradeType === 'SPOT' && ev.tradeSide === 'BUY' && isHeld) {
        status = 'כבר מוחזק בתיק (Spot)';
        willExecute = false;
      }

      results.push({ ...ev, status, willExecute });
    }

    return results;
  }, [cryptoData, positions, pending, isRunning, equity, totalLeveragedExposureUsd, dailyDrawdownPercent, weeklyDrawdownPercent, config, mtfData]);

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

    const delayMs = Math.max(0, config.executionDelaySec) * 1000;
    const openPos = positionsRef.current;
    const queued = pendingRef.current;
    const newOrders: PendingOrder[] = [];

    // Check Layer 4 Exits for all open positions
    for (const pos of openPos) {
      if (queued.some((o) => o.symbol === pos.symbol)) continue;

      const livePrice = priceForRef.current(pos.symbol) ?? pos.currentPrice;
      const atr5 = computeAtr5(buildCandlesForSymbol(pos.symbol, livePrice));

      // Find current decision for reversal check
      const currentEval = evaluations.find(e => e.symbol === pos.symbol);
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
        { dailyDrawdownPercent, weeklyDrawdownPercent },
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

    // Process new entry signals from evaluations
    for (const ev of evaluations) {
      if (!ev.willExecute || !ev.price || ev.tradeType === 'HOLD') continue;
      if (newOrders.some(o => o.symbol === ev.symbol) || queued.some(o => o.symbol === ev.symbol)) continue;
      const lastLoss = exitCooldownRef.current[ev.symbol];
      if (lastLoss && Date.now() - lastLoss < ENTRY_COOLDOWN_MS) continue;

      const orderSide = ev.tradeType === 'FUTURES'
        ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
        : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

      const budget = (ev.stopLoss && ev.tradeType === 'FUTURES')
        ? Math.min(cashRef.current * 0.05, 500)
        : Math.min(cashRef.current * 0.15, 1000);

      if (budget < 5) continue;

      newOrders.push({
        id: uid(`${ev.symbol}-${orderSide}`),
        symbol: ev.symbol,
        type: ev.tradeType as 'SPOT' | 'FUTURES',
        side: orderSide as any,
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

    if (newOrders.length) {
      setPending((prev) => [...prev, ...newOrders]);
    }
    setLastEvaluation(new Date().toLocaleTimeString('he-IL'));
    setNextTickAt(Date.now() + 5000);
  }, [isRunning, evaluations, heartbeat, dailyDrawdownPercent, weeklyDrawdownPercent, buildCandlesForSymbol, mtfData]);

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
        const pnl = p.side === 'LONG'
          ? (live - p.entryPrice) * p.quantity * p.leverage
          : (p.entryPrice - live) * p.quantity * p.leverage;
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
      const due = pendingRef.current.filter((o) => Date.now() >= o.executeAt);
      if (!due.length) return;

      const now = new Date().toLocaleTimeString('he-IL');
      let workingCash = cashRef.current;
      let workingPositions = [...positionsRef.current];
      const newTrades: SimTrade[] = [];
      let feesAdded = 0;
      let slipAdded = 0;

      for (const order of due) {
        const market = priceForRef.current(order.symbol) ?? order.signalPrice;
        
        // Realistic dynamic slippage (0.05% - 0.15%)
        const sideForSlippage = order.side === 'buy' || order.side === 'long' ? 'BUY' : 'SELL';
        const { fillPrice, slippagePercent } = simulateSlippage(market, sideForSlippage);
        const delayMs = Date.now() - order.createdAt;

        // Entry Orders (Spot Buy or Futures Long/Short)
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

          // SL/TP were computed relative to the SIGNAL price at evaluation time,
          // which can be seconds-to-minutes stale by the time the order actually
          // fills (execution delay + live price drift). Re-anchor them to the
          // ACTUAL fill price by preserving the intended risk DISTANCE instead of
          // reusing the absolute levels verbatim — otherwise a position can open
          // already past its own stop-loss, guaranteeing an instant stop-out on
          // the very next tick (seen as rapid entry/SL-exit/re-entry loops).
          const isLongSide = order.side === 'buy' || order.side === 'long';
          const reanchor = (level: number | undefined): number | undefined =>
            level === undefined ? undefined : fillPrice + (isLongSide ? -1 : 1) * Math.abs(order.signalPrice - level);

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
            stopLoss: reanchor(order.stopLoss) ?? (isLongSide ? fillPrice * 0.95 : fillPrice * 1.05),
            takeProfit1: reanchor(order.takeProfit1),
            takeProfit2: reanchor(order.takeProfit2),
            takeProfit: reanchor(order.takeProfit) ?? (isLongSide ? fillPrice * 1.05 : fillPrice * 0.95),
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
            side: order.side as any,
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
        }
        // Partial TP1 50% Exit for Futures
        else if (order.side === 'partial_tp1') {
          const posIdx = workingPositions.findIndex(p => p.symbol === order.symbol && p.type === 'FUTURES');
          if (posIdx >= 0) {
            const pos = workingPositions[posIdx];
            const closeQty = pos.quantity * 0.5;
            const notional = closeQty * fillPrice;
            const fee = calculateTradingFee(notional, 'FUTURES', true);

            const pnl = pos.side === 'LONG'
              ? (fillPrice - pos.entryPrice) * closeQty * pos.leverage
              : (pos.entryPrice - fillPrice) * closeQty * pos.leverage;

            workingCash += (pos.marginUsd * 0.5) + pnl - fee;
            feesAdded += fee;
            slipAdded += Math.abs(fillPrice - market) * closeQty;

            // Update remaining position
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
        }
        // Full Exits (Close Long / Close Short / Spot Sell)
        else {
          const pos = workingPositions.find(p => p.symbol === order.symbol);
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
            workingPositions = workingPositions.filter(p => p.id !== pos.id);
            if (pnl < 0) exitCooldownRef.current[order.symbol] = Date.now();

            newTrades.push({
              id: order.id,
              symbol: order.symbol,
              type: pos.type,
              side: order.side as any,
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
              pnlPercent: pos.type === 'SPOT' ? (pnl / (pos.quantity * pos.avgPrice)) * 100 : (pnl / pos.marginUsd) * 100
            });
          }
        }
      }

      const dueIds = new Set(due.map((o) => o.id));
      setPending((prev) => prev.filter((o) => !dueIds.has(o.id)));

      if (newTrades.length) {
        setCash(workingCash);
        setPositions(workingPositions);
        setTrades((prev) => [...newTrades.reverse(), ...prev].slice(0, 100));
        setTotalFees((f) => f + feesAdded);
        setTotalSlippageCost((s) => s + slipAdded);
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
    minConfidence: 40,
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

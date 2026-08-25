// Parallel simulation engine running the ORIGINAL algorithm (alg.md Layers 0-5:
// single-timeframe regime detection + weighted-confidence signal scoring +
// 70%/58-62% confidence routing), side by side with the newer strict
// multi-timeframe engine driven by useSimulationBot.ts. Same position/portfolio
// mechanics (fees, slippage, execution delay) — only the decision logic differs,
// so the two can be compared head-to-head on the same live market data.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CryptoData, MarketRegimeResult } from '../types/crypto';
import { useBackgroundWorker } from './useBackgroundWorker';
import {
  calculateTradingFee,
  simulateSlippage,
  detectMarketRegime,
  evaluateSignals,
  routeTradeType,
  calculateOptimalEntry,
  calculateRiskParameters,
  evaluateExit,
  Candle,
  ClosedTradeMetric
} from '../services/tradeEngine';
import type { SignalEvaluation, DecisionFactor } from '../services/intradayBridge';
import { getUniverseMarketData } from '../services/marketDataService';
import { toBaseAsset } from '../services/assetUniverse';
import { reanchorLevel, computeEntryBudget, isInEntryCooldown } from '../services/simExecution';
import type {
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig
} from './useSimulationBot';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from './useSimulationBot';

interface Params {
  config: SimBotConfig;
  isRunning: boolean;
  cryptoData?: CryptoData[];
  fearGreedIndex?: number;
}

const uid = (p: string) => `legacy-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

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

// Minimum candles needed for the legacy indicators (EMA50 warm-up + RSI14 + BB20 + ADX14).
const MIN_LEGACY_CANDLES = 60;

export function useLegacySimulationBot({ config, isRunning, cryptoData, fearGreedIndex = 50 }: Params) {
  const [saved] = useState<PersistedSimState | null>(() => loadPersisted());
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
  }, [cash, positions, trades, history, hourlyHistory, pending, totalFees, totalSlippageCost]);

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
      const pnl = p.side === 'LONG'
        ? (livePrice - p.entryPrice) * p.quantity * p.leverage
        : (p.entryPrice - livePrice) * p.quantity * p.leverage;
      return sum + Math.max(0, p.marginUsd + pnl);
    }, 0);
  }, [positions, priceFor]);

  const equity = cash + positionsValue;

  const totalLeveragedExposureUsd = useMemo(() => {
    return positions.reduce((sum, p) => {
      const livePrice = priceFor(p.symbol) ?? p.currentPrice;
      return p.type === 'FUTURES' ? sum + p.quantity * livePrice * p.leverage : sum;
    }, 0);
  }, [positions, priceFor]);

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

  // Memoized on `trades` (not re-filtered every render) — evaluations below
  // depends on closedTradeMetrics, and an unstable reference here fed a
  // setState-in-useEffect loop (activeMarketRegimes) into an infinite render.
  const closedTrades = useMemo(() => trades.filter((t) => typeof t.pnl === 'number'), [trades]);
  const closedTradeMetrics: ClosedTradeMetric[] = useMemo(
    () => closedTrades.map((t) => ({ pnl: t.pnl ?? 0, pnlPercent: t.pnlPercent ?? 0 })),
    [closedTrades]
  );

  // ═══════════════════════════════════════════════════════
  // Evaluation Engine — Layers 0-3 of the ORIGINAL alg.md algorithm
  // ═══════════════════════════════════════════════════════
  const evaluations = useMemo<SignalEvaluation[]>(() => {
    if (!cryptoData?.length) return [];

    const openPos = positions;
    const queuedOrders = pending;
    const maxTotalPositions = config.maxPositions || 7;
    const maxFutures = config.maxFuturesPositions || 2;
    const futuresCount = openPos.filter((p) => p.type === 'FUTURES').length;
    const isWeeklyLocked = weeklyDrawdownPercent >= 15;
    const isDailyBlocked = dailyDrawdownPercent >= 8;

    const results: SignalEvaluation[] = [];

    for (const crypto of cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;
      const candles = candlesBySymbol[symbol];
      if (!candles || candles.length < MIN_LEGACY_CANDLES) continue;

      const layer0 = detectMarketRegime(candles, currentPrice);
      const layer1 = evaluateSignals(candles, currentPrice, priceChange24h, layer0, fearGreedIndex);
      const hasExistingFutures = openPos.some((p) => p.symbol === symbol && p.type === 'FUTURES');
      const hasExistingSpot = openPos.some((p) => p.symbol === symbol && p.type === 'SPOT');
      const layer2 = routeTradeType(layer1, layer0, { hasExistingFutures, hasExistingSpot, isDailyBlocked, isWeeklyLocked });

      let entryPrice = currentPrice;
      let entryReason = '';
      if (layer2.type !== 'HOLD' && layer2.side !== 'NONE') {
        const entryTiming = calculateOptimalEntry(currentPrice, layer0.atr, layer2.side, candles);
        entryPrice = entryTiming.entryPrice;
        entryReason = entryTiming.reason;
      }

      const layer3 = layer2.type !== 'HOLD'
        ? calculateRiskParameters(
          entryPrice, layer2.type, layer2.side, layer0.atr, layer0.volatility,
          layer1.signalScore, equity, closedTradeMetrics, openPos.length, futuresCount, totalLeveragedExposureUsd
        )
        : null;

      const isQueued = queuedOrders.some((o) => o.symbol === symbol);
      const isHeld = openPos.some((p) => p.symbol === symbol);

      let willExecute = layer2.type !== 'HOLD' && !layer2.hardGateBlocked && !!layer3;
      let status = layer2.hardGateBlocked
        ? (layer2.blockReason ?? 'חסום')
        : layer2.type === 'HOLD'
        ? 'אין סיגנל (Layer 1/2)'
        : layer3
        ? 'מוכן לביצוע'
        : 'נפסל בניהול סיכונים (Layer 3)';

      if (!isRunning) {
        status = 'הבוט מושבת'; willExecute = false;
      } else if (isQueued) {
        status = 'פקודה כבר נמצאת בתור ביצוע'; willExecute = false;
      } else if (openPos.length >= maxTotalPositions) {
        status = `הגעת למקסימום ${maxTotalPositions} פוזיציות פתוחות`; willExecute = false;
      } else if (layer2.type === 'FUTURES' && futuresCount >= maxFutures) {
        status = `הגעת למקסימום ${maxFutures} פוזיציות Futures`; willExecute = false;
      } else if (layer2.type === 'SPOT' && layer2.side === 'BUY' && isHeld) {
        status = 'כבר מוחזק בתיק (Spot)'; willExecute = false;
      }

      const factors: DecisionFactor[] = [
        {
          label: 'משטר שוק (Layer 0)',
          value: `${layer0.regime} / ${layer0.direction} / ${layer0.volatility} (ADX ${layer0.adx.toFixed(1)})`,
          impact: layer0.regime === 'TRANSITIONAL' ? 'negative' : 'neutral',
          note: `ATR% ${layer0.atrPercent.toFixed(2)}`
        },
        {
          label: 'ציון ביטחון משוקלל (Layer 1)',
          value: `${layer1.action} — ${layer1.signalScore.toFixed(1)}%`,
          impact: layer1.action === 'HOLD' ? 'neutral' : layer1.action === 'BUY' ? 'positive' : 'negative',
          note: layer1.penalties.join(' | ') || layer1.signals.map((s) => `${s.name}:${s.signal}`).join(', ')
        },
        {
          label: 'ניתוב עסקה (Layer 2)',
          value: `${layer2.type} ${layer2.side}`,
          impact: layer2.type === 'HOLD' ? 'neutral' : 'positive',
          note: layer2.reason
        },
        ...(layer3 ? [{
          label: 'ניהול סיכונים (Layer 3)',
          value: `SL ${layer3.stopLoss.toFixed(4)} | R:R ${layer3.riskRewardRatio.toFixed(2)} | ${layer3.leverage}x`,
          impact: 'positive' as const,
          note: `Kelly ${(layer3.kellyFraction * 100).toFixed(1)}% | גודל $${layer3.betSizeUsd.toFixed(0)}`
        }] : [])
      ];

      results.push({
        symbol,
        action: layer1.action.toLowerCase() as 'buy' | 'sell' | 'hold',
        tradeType: layer2.type,
        tradeSide: layer2.side,
        confidence: layer1.signalScore,
        price: entryPrice,
        priceChange24h,
        reasoning: entryReason || layer2.reason,
        status,
        willExecute,
        factors,
        confidenceGap: 0,
        regime: layer0,
        leverage: layer3?.leverage,
        stopLoss: layer3?.stopLoss,
        takeProfit1: layer3?.takeProfit1,
        takeProfit2: layer3?.takeProfit2,
        takeProfit: layer3?.takeProfit
      });
    }

    return results;
  }, [cryptoData, positions, pending, isRunning, equity, totalLeveragedExposureUsd, dailyDrawdownPercent, weeklyDrawdownPercent, config, candlesBySymbol, fearGreedIndex, closedTradeMetrics]);

  // Purely derived from evaluations — a useState+useEffect pair here previously
  // added an extra setState-triggered render on every evaluations change,
  // compounding the render cascade on mount (§ Maximum update depth warning).
  const activeMarketRegimes = useMemo(() => {
    const regimes: Record<string, MarketRegimeResult> = {};
    for (const ev of evaluations) if (ev.regime) regimes[ev.symbol] = ev.regime;
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

    for (const pos of openPos) {
      if (queued.some((o) => o.symbol === pos.symbol)) continue;

      const livePrice = priceForRef.current(pos.symbol) ?? pos.currentPrice;
      const candles = candlesRef.current[pos.symbol];
      if (!candles || candles.length < MIN_LEGACY_CANDLES) continue;

      const layer0 = detectMarketRegime(candles, livePrice);
      const currentEval = evaluations.find((e) => e.symbol === pos.symbol);
      const scores = currentEval
        ? { buy: currentEval.action === 'buy' ? currentEval.confidence : 0, sell: currentEval.action === 'sell' ? currentEval.confidence : 0 }
        : { buy: 0, sell: 0 };

      const exitCheck = evaluateExit(
        {
          id: pos.id, symbol: pos.symbol, type: pos.type, side: pos.side,
          quantity: pos.quantity, entryPrice: pos.entryPrice, currentPrice: livePrice,
          avgPrice: pos.avgPrice, leverage: pos.leverage, marginUsd: pos.marginUsd,
          notionalUsd: pos.notionalUsd, stopLoss: pos.stopLoss, takeProfit1: pos.takeProfit1,
          takeProfit2: pos.takeProfit2, highestPriceSinceTP1: pos.highestPriceSinceTP1,
          lowestPriceSinceTP1: pos.lowestPriceSinceTP1, highestPrice: pos.highestPrice,
          lowestPrice: pos.lowestPrice, tp1Hit: pos.tp1Hit, openedAt: pos.openedAt,
          openTimestamp: pos.openTimestamp, entryFee: pos.entryFee, reason: pos.reason,
          confidence: pos.confidence
        },
        livePrice,
        layer0.atr,
        scores,
        { dailyDrawdownPercent, weeklyDrawdownPercent }
      );

      if (exitCheck.shouldExit) {
        if (exitCheck.exitType === 'PARTIAL_50') {
          newOrders.push({
            id: uid(`${pos.symbol}-tp1-50`), symbol: pos.symbol, type: pos.type, side: 'partial_tp1',
            signalPrice: livePrice, quantity: pos.quantity * 0.5, reason: exitCheck.reason,
            confidence: pos.confidence, executeAt: Date.now() + delayMs, createdAt: Date.now()
          });
        } else {
          newOrders.push({
            id: uid(`${pos.symbol}-exit`), symbol: pos.symbol, type: pos.type,
            side: pos.side === 'LONG' || pos.side === 'BUY' ? 'close_long' : 'close_short',
            signalPrice: livePrice, quantity: pos.quantity, reason: exitCheck.reason,
            confidence: pos.confidence, executeAt: Date.now() + delayMs, createdAt: Date.now()
          });
        }
      }
    }

    for (const ev of evaluations) {
      if (!ev.willExecute || !ev.price || ev.tradeType === 'HOLD') continue;
      if (newOrders.some((o) => o.symbol === ev.symbol) || queued.some((o) => o.symbol === ev.symbol)) continue;
      if (isInEntryCooldown(exitCooldownRef.current[ev.symbol])) continue;

      const orderSide = ev.tradeType === 'FUTURES'
        ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
        : (ev.tradeSide === 'BUY' ? 'buy' : 'sell');

      const budget = computeEntryBudget(cashRef.current, ev.tradeType === 'FUTURES' ? 'FUTURES' : 'SPOT');

      if (budget < 5) continue;

      newOrders.push({
        id: uid(`${ev.symbol}-${orderSide}`), symbol: ev.symbol, type: ev.tradeType as 'SPOT' | 'FUTURES',
        side: orderSide as PendingOrder['side'], signalPrice: ev.price, quantity: (budget * (ev.leverage || 1)) / ev.price,
        budgetUsd: budget, leverage: ev.leverage || 1, stopLoss: ev.stopLoss, takeProfit1: ev.takeProfit1,
        takeProfit2: ev.takeProfit2, takeProfit: ev.takeProfit, reason: ev.reasoning, confidence: ev.confidence,
        executeAt: Date.now() + delayMs, createdAt: Date.now()
      });
    }

    if (newOrders.length) setPending((prev) => [...prev, ...newOrders]);
    setLastEvaluation(new Date().toLocaleTimeString('he-IL'));
    setNextTickAt(Date.now() + 5000);
  }, [isRunning, evaluations, heartbeat, dailyDrawdownPercent, weeklyDrawdownPercent, config]);

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
        const pnl = p.side === 'LONG'
          ? (live - p.entryPrice) * p.quantity * p.leverage
          : (p.entryPrice - live) * p.quantity * p.leverage;
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
  // useSimulationBot.ts, only the orders feeding it come from the legacy engine.
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

          const isLongSide = order.side === 'buy' || order.side === 'long';
          const reanchor = (level: number | undefined) => reanchorLevel(fillPrice, order.signalPrice, level);

          const newPos: SimPosition = {
            id: uid(order.symbol), symbol: order.symbol, type: order.type,
            side: order.side === 'long' ? 'LONG' : order.side === 'short' ? 'SHORT' : 'BUY',
            quantity, entryPrice: fillPrice, avgPrice: fillPrice, currentPrice: fillPrice, leverage,
            marginUsd: budget, notionalUsd: notional,
            stopLoss: reanchor(order.stopLoss) ?? (isLongSide ? fillPrice * 0.95 : fillPrice * 1.05),
            takeProfit1: reanchor(order.takeProfit1), takeProfit2: reanchor(order.takeProfit2),
            takeProfit: reanchor(order.takeProfit) ?? (isLongSide ? fillPrice * 1.05 : fillPrice * 0.95), tp1Hit: false,
            highestPrice: fillPrice, lowestPrice: fillPrice, openedAt: now, openTimestamp: Date.now(),
            reason: order.reason, confidence: order.confidence, entryFee: fee
          };

          workingPositions.push(newPos);
          newTrades.push({
            id: order.id, symbol: order.symbol, type: order.type, side: order.side as SimTrade['side'],
            price: fillPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs, quantity,
            usdValue: notional, leverage, timestamp: now, at: Date.now(), reason: order.reason, confidence: order.confidence
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

            workingCash += (pos.marginUsd * 0.5) + pnl - fee;
            feesAdded += fee;
            slipAdded += Math.abs(fillPrice - market) * closeQty;

            workingPositions[posIdx] = {
              ...pos, quantity: pos.quantity - closeQty, marginUsd: pos.marginUsd * 0.5,
              notionalUsd: (pos.quantity - closeQty) * fillPrice * pos.leverage, tp1Hit: true,
              highestPriceSinceTP1: fillPrice, lowestPriceSinceTP1: fillPrice
            };

            newTrades.push({
              id: order.id, symbol: order.symbol, type: 'FUTURES', side: 'partial_tp1', price: fillPrice,
              requestedPrice: order.signalPrice, slippagePercent, fee, delayMs, quantity: closeQty,
              usdValue: notional, leverage: pos.leverage, timestamp: now, at: Date.now(),
              reason: order.reason, confidence: order.confidence, pnl, pnlPercent: (pnl / (pos.marginUsd * 0.5)) * 100
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
            if (pnl < 0) exitCooldownRef.current[order.symbol] = Date.now();

            newTrades.push({
              id: order.id, symbol: order.symbol, type: pos.type, side: order.side as SimTrade['side'],
              price: fillPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs,
              quantity: pos.quantity, usdValue: notional, leverage: pos.leverage, timestamp: now, at: Date.now(),
              reason: order.reason, confidence: order.confidence, pnl,
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

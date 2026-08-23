import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CryptoData, CryptoRecommendation, MarketRegimeResult, TradeType, TradeSide } from '../types/crypto';
import { useBackgroundWorker } from './useBackgroundWorker';
import { bybitApi } from '../services/bybitApi';
import { coinGeckoApi } from '../services/coinGeckoApi';
import { binancePublicApi } from '../services/binancePublicApi';
import {
  detectMarketRegime,
  evaluateSignals,
  routeTradeType,
  calculateRiskParameters,
  evaluateExit,
  calculateTradingFee,
  simulateSlippage,
  calculateOptimalEntry,
  calculateATR,
  Candle
} from '../services/tradeEngine';

export interface DecisionFactor {
  label: string;
  value: string;
  impact: 'positive' | 'negative' | 'neutral';
  note: string;
}

export interface SignalEvaluation {
  symbol: string;
  action: 'buy' | 'sell' | 'hold';
  tradeType: TradeType;
  tradeSide: TradeSide;
  confidence: number;
  price: number;
  priceChange24h: number;
  reasoning: string;
  status: string;
  willExecute: boolean;
  factors: DecisionFactor[];
  confidenceGap: number;
  riskLevel?: 'low' | 'medium' | 'high';
  timeframe?: 'short' | 'medium' | 'long';
  regime?: MarketRegimeResult;
  leverage?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
}

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
  const [activeMarketRegimes, setActiveMarketRegimes] = useState<Record<string, MarketRegimeResult>>({});
  const [candleRefreshAt, setCandleRefreshAt] = useState<number>(0);
  const [candleSourceHealth, setCandleSourceHealth] = useState<{ bybit: number; coingecko: number; failed: number }>({ bybit: 0, coingecko: 0, failed: 0 });

  const cashRef = useRef(cash);
  const positionsRef = useRef(positions);
  const pendingRef = useRef(pending);
  const cryptoRef = useRef(cryptoData);
  const configRef = useRef(config);
  const tradesRef = useRef(trades);
  const historyRef = useRef(history);

  cashRef.current = cash;
  positionsRef.current = positions;
  pendingRef.current = pending;
  cryptoRef.current = cryptoData;
  configRef.current = config;
  tradesRef.current = trades;
  historyRef.current = history;

  // Persist state via the provided callback (server-backed shared state when leader).
  useEffect(() => {
    if (!persist) return;
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
    persist(state);
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
  // LIVE KLINE CACHE — real candles from Bybit (no mock data)
  // ═════════════════════════════════════════════════════
  const [liveCandles, setLiveCandles] = useState<Record<string, Candle[]>>({});
  const liveCandlesRef = useRef<Record<string, Candle[]>>({});
  liveCandlesRef.current = liveCandles;

  useEffect(() => {
    if (!cryptoData || cryptoData.length === 0) return;
    let cancelled = false;

    // Live CoinGecko historical prices → real candles (no mock data).
    // Used ONLY as a fallback when Bybit klines are unavailable so the bot can still evaluate & trade.
    const buildFromCoinGecko = async (symbol: string, next: Record<string, Candle[]>) => {
      if (next[symbol] && next[symbol].length > 0) return; // already have candles from Bybit
      try {
        const coinId = coinGeckoApi.getCoinId(symbol);
        const hist = await coinGeckoApi.getHistoricalPrices(coinId, 30);
        if (hist && hist.length >= 2) {
          next[symbol] = hist.map((h, idx) => {
            const close = h.price;
            const open = idx > 0 ? hist[idx - 1].price : close;
            return {
              timestamp: h.timestamp,
              open,
              high: Math.max(open, close),
              low: Math.min(open, close),
              close,
              volume: h.volume || 0
            };
          });
        }
      } catch {
        /* skip symbol without live historical data */
      }
    };

    const fetchKlines = async () => {
      const symbols = cryptoData.map(c => c.symbol.toUpperCase());
      // Start from last-known-good candles so a transient source failure never wipes data.
      const next: Record<string, Candle[]> = { ...liveCandlesRef.current };
      const sources: Record<string, 'bybit' | 'binance' | 'coingecko'> = {};

      // 1) Primary: real Bybit OHLC klines (fast, includes volume). Always re-fetch on interval.
      await Promise.all(symbols.map(async (symbol) => {
        try {
          const bybitSymbol = bybitApi.getBybitSymbol(symbol);
          const klines = await bybitApi.getKlineData(bybitSymbol, 'D', 30);
          if (klines && klines.length > 0) {
            next[symbol] = klines.map(k => ({
              timestamp: parseInt(k.openTime),
              open: parseFloat(k.open),
              high: parseFloat(k.high),
              low: parseFloat(k.low),
              close: parseFloat(k.close),
              volume: parseFloat(k.volume)
            }));
            sources[symbol] = 'bybit';
          }
        } catch {
          /* keep last-known-good candles on Bybit failure */
        }
      }));

      // 2) Binance klines for symbols Bybit couldn't serve (free, 1200 req/min)
      const afterBybit = symbols.filter(s => !(next[s] && next[s].length > 0));
      if (afterBybit.length > 0) {
        await Promise.all(afterBybit.map(async (symbol) => {
          try {
            const bklines = await binancePublicApi.getKlines(symbol, '1d', 60);
            if (bklines && bklines.length > 0) {
              next[symbol] = bklines.map(k => ({
                timestamp: k.timestamp,
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
                volume: k.volume
              }));
              sources[symbol] = 'binance';
            }
          } catch { /* keep last-known-good */ }
        }));
        if (!cancelled) setLiveCandles({ ...next });
      }

      // 3) CoinGecko fallback — SEQUENTIAL, 1 at a time with 4s pause between each
      //    to avoid blowing the shared 30 req/min rate limit.
      const missing = symbols.filter(s => !(next[s] && next[s].length > 0));
      for (let i = 0; i < missing.length; i++) {
        if (cancelled) break;
        const symbol = missing[i];
        const before = next[symbol]?.length || 0;
        await buildFromCoinGecko(symbol, next);
        if ((next[symbol]?.length || 0) > before) sources[symbol] = 'coingecko';
        if (!cancelled) setLiveCandles({ ...next });
        // Pause between CoinGecko calls to respect rate limit
        if (i < missing.length - 1) {
          await new Promise(r => setTimeout(r, 4000));
        }
      }

      if (!cancelled) {
        setLiveCandles(next);
        const withCandles = symbols.filter(s => next[s] && next[s].length > 0).length;
        setCandleSourceHealth({
          bybit: Object.values(sources).filter(s => s === 'bybit').length,
          coingecko: Object.values(sources).filter(s => s === 'coingecko').length,
          failed: symbols.length - withCandles
        });
        setCandleRefreshAt(Date.now());
      }
    };

    fetchKlines();
    const interval = setInterval(fetchKlines, 5 * 60 * 1000); // refresh live candles every 5 min
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

  // Build candles from LIVE Bybit klines (no mock / random data)
  const buildCandlesForSymbol = useCallback((symbol: string, _currentPrice: number): Candle[] => {
    const live = liveCandlesRef.current[symbol.toUpperCase()];
    return live && live.length > 0 ? live : [];
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
    const isCircuitBreakerDaily = dailyDrawdownPercent >= 8;
    const isCircuitBreakerWeekly = weeklyDrawdownPercent >= 15;

    const results: SignalEvaluation[] = [];
    const updatedRegimes: Record<string, MarketRegimeResult> = {};

    // Scan all loaded crypto assets (up to 100) to find the best market setups
    for (const crypto of cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;

      const candles = buildCandlesForSymbol(symbol, currentPrice);
      // Skip symbols without live candle data — never evaluate on mock/fake data
      if (candles.length < 2) continue;
      const layer0 = detectMarketRegime(candles, currentPrice);
      updatedRegimes[symbol] = layer0;

      const layer1 = evaluateSignals(candles, currentPrice, priceChange24h, layer0, fearGreedIndex || 50, config.riskLevel);
      const hasExistingFutures = openPos.some(p => p.symbol === symbol && p.type === 'FUTURES');
      const hasExistingSpot = openPos.some(p => p.symbol === symbol && p.type === 'SPOT');
      const isHeld = openPos.some(p => p.symbol === symbol);
      const isQueued = queuedOrders.some(o => o.symbol === symbol);

      const layer2 = routeTradeType(layer1, layer0, {
        hasExistingFutures,
        hasExistingSpot,
        isDailyBlocked: isCircuitBreakerDaily,
        isWeeklyLocked: isCircuitBreakerWeekly
      });

      // Layer 3 Risk & Sizing calculation (Risk-First 0.75% portfolio risk)
      const riskParams = calculateRiskParameters(
        currentPrice,
        layer2.type,
        layer2.side,
        layer0.atr,
        layer0.volatility,
        layer1.signalScore,
        equity,
        trades.map(t => ({ pnl: t.pnl || 0 })),
        openPos.length,
        futuresCount,
        totalLeveragedExposureUsd
      );

      // Layer 3.5 Entry Timing Validator (Real Gate)
      const entryTiming = (layer2.type !== 'HOLD' && !layer2.hardGateBlocked)
        ? calculateOptimalEntry(currentPrice, layer0.atr, layer2.side as any, candles)
        : null;

      // Build Decision Factors for UI transparency
      const factors: DecisionFactor[] = [
        {
          label: 'משטר שוק (ADX 14)',
          value: `${layer0.regime} (${layer0.adx})`,
          impact: layer0.regime === 'TRENDING' ? 'positive' : layer0.regime === 'RANGING' ? 'neutral' : 'negative',
          note: layer0.regime === 'TRENDING' ? 'שוק מגמתי מובהק — תומך ב-Futures' : layer0.regime === 'RANGING' ? 'שוק דשדוש — רק Spot' : 'משטר מעבר — חסום הרמטית'
        },
        {
          label: 'תנודתיות (ATR%)',
          value: `${layer0.volatility} (${layer0.atrPercent}%)`,
          impact: layer0.volatility === 'HIGH' ? 'negative' : 'positive',
          note: layer0.volatility === 'HIGH' ? 'תנודתיות גבוהה מעל 5% — Futures חסום הרמטית' : 'תנודתיות מתאימה'
        },
        {
          label: 'Supertrend (10, 3)',
          value: `$${layer0.supertrend.value.toFixed(2)} (${layer0.supertrend.direction})`,
          impact: layer0.supertrend.direction === 'BULL' ? 'positive' : 'negative',
          note: `מגמת Supertrend: ${layer0.supertrend.direction}`
        }
      ];

      // Add indicator details from layer 1
      for (const sig of layer1.signals) {
        factors.push({
          label: sig.name,
          value: sig.value,
          impact: sig.signal === 'BUY' ? 'positive' : sig.signal === 'SELL' ? 'negative' : 'neutral',
          note: sig.reason
        });
      }

      for (const p of layer1.penalties) {
        factors.push({
          label: 'הערת משטר/סנטימנט',
          value: p,
          impact: 'negative',
          note: 'פילטר בטיחות'
        });
      }

      let status = '';
      let willExecute = false;

      if (!isRunning) {
        status = 'הבוט מושבת';
      } else if (isCircuitBreakerWeekly) {
        status = 'נעילת מערכת שבועית (הפסד >= 15%) — מושבת עד איפוס ידני';
      } else if (isCircuitBreakerDaily) {
        status = 'הגנת תיק יומית (הפסד >= 8%) — חסום לכניסות חדשות';
      } else if (isQueued) {
        status = 'פקודה כבר נמצאת בתור ביצוע';
      } else if (layer2.hardGateBlocked) {
        status = layer2.reason;
      } else if (layer2.type === 'HOLD') {
        status = layer2.reason;
      } else if (openPos.length >= maxTotalPositions) {
        status = `הגעת למקסימום ${maxTotalPositions} פוזיציות פתוחות`;
      } else if (layer2.type === 'FUTURES' && futuresCount >= maxFutures) {
        status = `הגעת למקסימום ${maxFutures} פוזיציות Futures`;
      } else if (layer2.type === 'FUTURES' && hasExistingFutures) {
        status = 'קיימת כבר פוזיציית Futures פתוחה';
      } else if (layer2.type === 'SPOT' && layer2.side === 'SELL' && !isHeld) {
        status = 'מכירת Spot חשופה אסורה — אין החזקה בתיק';
      } else if (layer2.type === 'SPOT' && isHeld && layer2.side === 'BUY') {
        status = 'כבר מוחזק בתיק (Spot)';
      } else if (!entryTiming || !entryTiming.shouldEnterNow) {
        status = `ממתין לתזמון כניסה אופטימלי: ${entryTiming?.reason || 'תנאי כניסה לא הבשילו'}`;
      } else if (!riskParams || riskParams.betSizeUsd < 5) {
        status = 'חריגת חשיפה ממונפת (מקס\' 20%) או תקציב סיכון מתחת ל-$5';
      } else {
        willExecute = true;
        status = layer2.type === 'FUTURES'
          ? `מבצע Futures ${riskParams.leverage}x ${layer2.side} ($${riskParams.betSizeUsd}) | Limit @ $${entryTiming.entryPrice}`
          : `מבצע Spot ${layer2.side} ($${riskParams.betSizeUsd}) | Limit @ $${entryTiming.entryPrice}`;
      }

      const requiredThreshold = layer2.type === 'FUTURES'
        ? 72
        : (layer0.volatility === 'HIGH' ? 68 : 60);

      results.push({
        symbol,
        action: layer1.action === 'BUY' ? 'buy' : layer1.action === 'SELL' ? 'sell' : 'hold',
        tradeType: layer2.type,
        tradeSide: layer2.side,
        confidence: layer1.signalScore,
        price: currentPrice,
        priceChange24h,
        reasoning: layer2.reason,
        status,
        willExecute,
        factors,
        confidenceGap: layer1.signalScore - requiredThreshold,
        regime: layer0,
        leverage: riskParams?.leverage,
        stopLoss: riskParams?.stopLoss,
        takeProfit1: riskParams?.takeProfit1,
        takeProfit2: riskParams?.takeProfit2,
        takeProfit: riskParams?.takeProfit
      });
    }

    return results;
  }, [cryptoData, positions, pending, isRunning, equity, trades, totalLeveragedExposureUsd, dailyDrawdownPercent, weeklyDrawdownPercent, buildCandlesForSymbol, liveCandles, fearGreedIndex, config]);

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
      const { atr } = calculateATR(buildCandlesForSymbol(pos.symbol, livePrice), 14);

      // Find current signal for reversal check
      const currentEval = evaluations.find(e => e.symbol === pos.symbol);
      const buyConf = currentEval?.action === 'buy' ? currentEval.confidence : 0;
      const sellConf = currentEval?.action === 'sell' ? currentEval.confidence : 0;

      const exitCheck = evaluateExit(
        pos,
        livePrice,
        atr,
        { buy: buyConf, sell: sellConf },
        { dailyDrawdownPercent, weeklyDrawdownPercent }
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
  }, [isRunning, evaluations, heartbeat, dailyDrawdownPercent, weeklyDrawdownPercent, buildCandlesForSymbol, liveCandles]);

  // Heartbeat & Portfolio record
  useEffect(() => {
    if (!isRunning) return;
    setNextTickAt(Date.now() + 5000);

    const recordEquity = () => {
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
          return next.length > 720 ? next.slice(-720) : next;
        }
        return prev;
      });
    };

    recordEquity();
  }, [isRunning]);

  // Use background Web Worker to drive heartbeats even when browser tab is in the background
  useBackgroundWorker({
    enabled: isRunning,
    intervalMs: 5000,
    onTick: () => {
      setHeartbeat((h) => h + 1);
      setNextTickAt(Date.now() + 5000);

      // Record equity on tick
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
    [...hourlyHistory, ...history].forEach((p) => {
      const key = Math.floor(p.at / 5000);
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
    candleCount: Object.keys(liveCandles).length,
    candleRefreshAt,
    candleSourceHealth
  };
}

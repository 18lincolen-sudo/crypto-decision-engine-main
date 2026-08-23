import RealBybitAPI, { BybitConfig, OrderParams, PositionInfo } from './realBybitApi';
import { bybitApi } from './bybitApi';
import { binancePublicApi } from './binancePublicApi';
import { fearGreedApi } from './fearGreedApi';
import { firebaseSync } from './firebaseSync';
import { CryptoRecommendation, MarketRegimeResult, ActivePosition } from '../types/crypto';
import {
  detectMarketRegime,
  evaluateSignals,
  routeTradeType,
  calculateRiskParameters,
  evaluateExit,
  calculateBreakEvenPrice,
  calculateATR,
  Candle
} from './tradeEngine';

export interface RiskManagementConfig {
  maxDailyLoss: number; // Maximum daily loss percentage (Circuit breaker 8%)
  maxPositionSize: number; // Maximum position size as % of portfolio
  stopLossPercent: number; // Stop loss percentage
  takeProfitPercent: number; // Take profit percentage
  maxOpenPositions: number; // Maximum number of open positions (Max 5)
  maxFuturesPositions: number; // Maximum Futures positions (Max 2)
  cooldownPeriod: number; // Minutes between trades for same symbol
  trailingStopEnabled: boolean;
  trailingStopPercent: number;
  dynamicPositionSizing: boolean;
  portfolioRebalancing: boolean;
  sentimentAnalysis: boolean;
  fearGreedThreshold: number;
  volumeAnalysis: boolean;
  marketConditionFilter: boolean;
}

export interface TradingMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  sharpeRatio: number;
  profitFactor: number;
  avgHoldTime: number;
  bestTrade: number;
  worstTrade: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  monthlyReturn: number;
  weeklyVolatility: number;
}

export interface Alert {
  id: string;
  timestamp: Date;
  type: 'success' | 'warning' | 'error' | 'info' | 'market' | 'sentiment';
  message: string;
  symbol?: string;
  price?: number;
  confidence?: number;
  importance?: 'low' | 'medium' | 'high' | 'critical';
}

export interface TradeHistory {
  id: string;
  timestamp: Date;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'Buy' | 'Sell' | 'Long' | 'Short';
  quantity: number;
  price: number;
  leverage: number;
  pnl: number;
  confidence: number;
  sentiment: number;
  fearGreedIndex: number;
  breakEvenPrice?: number;
}

export class AdvancedTradingService {
  private bybitApi: RealBybitAPI;
  private riskConfig: RiskManagementConfig;
  private metrics: TradingMetrics;
  private alerts: Alert[] = [];
  private lastTradeTime: Map<string, number> = new Map();
  private dailyPnL: number = 0;
  private weeklyDrawdown: number = 0;
  private isActive: boolean = false;
  private tradeHistory: TradeHistory[] = [];
  private fearGreedIndex: number = 50;
  private lastMarketRegime: Map<string, MarketRegimeResult> = new Map();

  constructor(config: BybitConfig, riskConfig: RiskManagementConfig) {
    this.bybitApi = new RealBybitAPI(config);
    this.riskConfig = {
      maxDailyLoss: 8, // Master protocol: 8% daily circuit breaker
      maxFuturesPositions: 2,
      ...riskConfig,
      maxOpenPositions: Math.min(5, riskConfig.maxOpenPositions || 5)
    };
    this.metrics = {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalPnL: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      profitFactor: 0,
      avgHoldTime: 0,
      bestTrade: 0,
      worstTrade: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      monthlyReturn: 0,
      weeklyVolatility: 0
    };
    this.loadState();
  }

  private addAlert(type: Alert['type'], message: string, symbol?: string, price?: number) {
    const alert: Alert = {
      id: Date.now().toString(),
      timestamp: new Date(),
      type,
      message,
      symbol,
      price
    };
    this.alerts.unshift(alert);
    if (this.alerts.length > 100) this.alerts = this.alerts.slice(0, 100);
    localStorage.setItem('tradingAlerts', JSON.stringify(this.alerts));
  }

  /**
   * Fetches real Kline candles from Bybit Public API, with Binance Public fallback.
   * Returns an empty array if no live data is available (no mock/synthetic data).
   */
  private async fetchLiveCandles(symbol: string, _currentPrice: number): Promise<Candle[]> {
    const bybitSymbol = `${symbol.toUpperCase()}USDT`;

    try {
      // 1. Try Bybit Public Kline (Primary - Zero Auth)
      const bybitKlines = await bybitApi.getKlineData(bybitSymbol, '1d', 30);
      if (bybitKlines && bybitKlines.length >= 10) {
        return bybitKlines.map(k => ({
          timestamp: parseInt(k.openTime),
          open: parseFloat(k.open),
          high: parseFloat(k.high),
          low: parseFloat(k.low),
          close: parseFloat(k.close),
          volume: parseFloat(k.volume)
        }));
      }
    } catch { /* proceed to fallback */ }

    try {
      // 2. Try Binance Public Kline (Secondary - Zero Auth)
      const binanceKlines = await binancePublicApi.getKlines(symbol, '1d', 30);
      if (binanceKlines && binanceKlines.length >= 10) {
        return binanceKlines;
      }
    } catch { /* proceed to fallback */ }

    // No live candle data available — return empty so the trade is skipped (no mock data)
    return [];
  }

  private async checkPortfolioRiskLimits(balance: number): Promise<boolean> {
    // 1. Weekly Drawdown Circuit Breaker (15%)
    if (this.weeklyDrawdown >= 15) {
      this.addAlert('critical' as any, 'הגנת תיק שבועית הופעלה (Drawdown >= 15%) — כיבוי בוט אוטומטי!');
      this.stopTrading();
      return false;
    }

    // 2. Daily Loss Limit (8%)
    if (this.dailyPnL <= -8) {
      this.addAlert('error', 'הגעת למגבלת הפסד יומית (8%) — פתיחת עמדות חדשות נחסמה!');
      return false;
    }

    // 3. Max Open Positions Check (Max 5 total, Max 2 Futures)
    const positions = await this.bybitApi.getPositions('linear');
    const openFutures = positions.filter(p => parseFloat(p.size) > 0);
    
    if (openFutures.length >= 2) {
      this.addAlert('warning', 'הגעת למספר המקסימלי של פוזיציות Futures פתוחות (2)');
    }

    return true;
  }

  async executeSmartTrade(recommendation: CryptoRecommendation): Promise<boolean> {
    if (!this.isActive) return false;

    const rawSymbol = recommendation.symbol.toUpperCase();
    const bybitSymbol = `${rawSymbol}USDT`;
    const now = Date.now();

    // Check cooldown
    const lastTrade = this.lastTradeTime.get(bybitSymbol) || 0;
    if (now - lastTrade < this.riskConfig.cooldownPeriod * 60 * 1000) {
      return false;
    }

    try {
      const connResult = await this.bybitApi.testConnection();
      if (!connResult.ok) {
        this.addAlert('error', `שגיאת חיבור ל-Bybit API v5: ${connResult.msg}`);
        return false;
      }

      const balanceList = await this.bybitApi.getAccountBalance();
      const usdt = balanceList.find(b => b.coin === 'USDT');
      const availableBalance = parseFloat(usdt?.availableBalance || '0');
      const totalBalance = parseFloat(usdt?.walletBalance || '0');

      if (availableBalance < 10) {
        this.addAlert('warning', `יתרת USDT לא מספיקה ($${availableBalance.toFixed(2)})`);
        return false;
      }

      if (!(await this.checkPortfolioRiskLimits(totalBalance))) {
        return false;
      }

      const currentPrice = await this.bybitApi.getCurrentPrice(bybitSymbol, 'linear');
      
      // Fetch live Fear & Greed Index
      try {
        const fng = await fearGreedApi.getFearGreedIndex();
        if (fng?.value) this.fearGreedIndex = fng.value;
      } catch { /* use current */ }

      // Fetch real Kline candles (Bybit/Binance live only)
      const candles = await this.fetchLiveCandles(rawSymbol, currentPrice);

      // Without live candle data we cannot analyze the market — skip (no mock data)
      if (candles.length < 2) {
        this.addAlert('warning', `אין נתוני נרות חיים עבור ${bybitSymbol} — דילוג על העסקה`);
        return false;
      }

      // LAYER 0 — MARKET REGIME
      const layer0 = detectMarketRegime(candles, currentPrice);
      this.lastMarketRegime.set(bybitSymbol, layer0);

      // LAYER 1 — SIGNAL ENGINE (with real sentiment)
      const layer1 = evaluateSignals(candles, currentPrice, recommendation.priceChange24h || 0, layer0, this.fearGreedIndex);

      // Check existing futures position
      const linearPositions = await this.bybitApi.getPositions('linear');
      const hasOpenFutures = linearPositions.some(p => p.symbol === bybitSymbol && parseFloat(p.size) > 0);

      // LAYER 2 — TRADE TYPE ROUTER
      const layer2 = routeTradeType(layer1, layer0, hasOpenFutures);

      if (layer2.type === 'HOLD') {
        return false;
      }

      // LAYER 3 — RISK & SIZING
      const openFuturesCount = linearPositions.filter(p => parseFloat(p.size) > 0).length;
      const totalOpenPositions = linearPositions.length;
      const totalLeveragedExposureUsd = linearPositions.reduce((s, p) => s + parseFloat(p.positionValue || '0'), 0);

      const riskParams = calculateRiskParameters(
        currentPrice,
        layer2.type,
        layer2.side,
        layer0.atr,
        layer0.volatility,
        layer1.confidence,
        totalBalance,
        this.tradeHistory.map(t => ({ pnl: t.pnl })),
        totalOpenPositions,
        openFuturesCount,
        totalLeveragedExposureUsd
      );

      if (!riskParams || riskParams.betSizeUsd < 10) {
        this.addAlert('info', `עסקה ב-${bybitSymbol} נדחתה עקב מגבלת חשיפה או תקציב`);
        return false;
      }

      // ═══════════════════════════════════════════════════════
      // EXECUTION (Bybit API v5 Unified Linear / Spot)
      // ═══════════════════════════════════════════════════════
      if (layer2.type === 'FUTURES') {
        const isLong = layer2.side === 'LONG';
        const side = isLong ? 'Buy' : 'Sell';
        const leverage = riskParams.leverage;
        const notional = riskParams.betSizeUsd * leverage;
        const qty = (notional / currentPrice).toFixed(4);

        // 1. Set Leverage
        try {
          await this.bybitApi.setLeverage(bybitSymbol, leverage, 'linear');
        } catch (levErr) {
          console.warn('Set leverage notification:', levErr);
        }

        // 2. Place Order with Bybit Native TP/SL (TP1 partial + SL)
        const orderParams: OrderParams = {
          category: 'linear',
          symbol: bybitSymbol,
          side,
          orderType: 'Market',
          qty,
          stopLoss: riskParams.stopLoss.toString(),
          takeProfit: (isLong ? riskParams.takeProfit1 : riskParams.takeProfit1)?.toString(),
          tpslMode: 'Partial',
          tpOrderType: 'Market',
          slOrderType: 'Market'
        };

        await this.bybitApi.placeOrder(orderParams);
        const breakEven = calculateBreakEvenPrice(currentPrice, 'FUTURES', isLong);

        this.lastTradeTime.set(bybitSymbol, now);
        this.addTradeLog({
          symbol: bybitSymbol,
          type: 'FUTURES',
          side: isLong ? 'Long' : 'Short',
          quantity: parseFloat(qty),
          price: currentPrice,
          leverage,
          pnl: 0,
          confidence: layer1.confidence,
          sentiment: 0,
          fearGreedIndex: this.fearGreedIndex,
          breakEvenPrice: breakEven
        });

        this.addAlert('success', 
          `🚀 נפתחה פוזיציית FUTURES ${leverage}x ${layer2.side}: ${qty} ${bybitSymbol} ב-$${currentPrice.toFixed(2)} (SL: $${riskParams.stopLoss}, TP1: $${riskParams.takeProfit1}, Break-Even: $${breakEven.toFixed(2)})`,
          bybitSymbol, currentPrice
        );
        return true;
      } else if (layer2.type === 'SPOT' && layer2.side === 'BUY') {
        // SPOT BUY
        const qty = (riskParams.betSizeUsd / currentPrice).toFixed(4);
        const orderParams: OrderParams = {
          category: 'spot',
          symbol: bybitSymbol,
          side: 'Buy',
          orderType: 'Market',
          qty
        };

        await this.bybitApi.placeOrder(orderParams);
        const breakEven = calculateBreakEvenPrice(currentPrice, 'SPOT', true);

        this.lastTradeTime.set(bybitSymbol, now);
        this.addTradeLog({
          symbol: bybitSymbol,
          type: 'SPOT',
          side: 'Buy',
          quantity: parseFloat(qty),
          price: currentPrice,
          leverage: 1,
          pnl: 0,
          confidence: layer1.confidence,
          sentiment: 0,
          fearGreedIndex: this.fearGreedIndex,
          breakEvenPrice: breakEven
        });

        this.addAlert('success',
          `🛒 נרכשה פוזיציית SPOT: ${qty} ${bybitSymbol} ב-$${currentPrice.toFixed(2)} (SL: $${riskParams.stopLoss}, TP: $${riskParams.takeProfit})`,
          bybitSymbol, currentPrice
        );
        return true;
      }

      return false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.addAlert('error', `שגיאה במסחר ב-${bybitSymbol}: ${msg}`, bybitSymbol);
      return false;
    }
  }

  private addTradeLog(log: Omit<TradeHistory, 'id' | 'timestamp'>) {
    const entry: TradeHistory = {
      ...log,
      id: Date.now().toString(),
      timestamp: new Date()
    };
    this.tradeHistory.unshift(entry);
    if (this.tradeHistory.length > 100) this.tradeHistory = this.tradeHistory.slice(0, 100);
    this.metrics.totalTrades++;
    this.saveState();

    // Seamless Cloud Sync to Firebase (if configured)
    firebaseSync.saveTrade({
      id: entry.id,
      symbol: entry.symbol,
      type: entry.type,
      side: entry.side,
      price: entry.price,
      quantity: entry.quantity,
      leverage: entry.leverage,
      pnl: entry.pnl,
      timestamp: entry.timestamp.toISOString(),
      confidence: entry.confidence
    }).catch(() => { /* silent fallback */ });
  }

  private saveState() {
    localStorage.setItem('realTradeHistory', JSON.stringify(this.tradeHistory));
    localStorage.setItem('tradingMetrics', JSON.stringify(this.metrics));
  }

  private loadState() {
    try {
      const savedHist = localStorage.getItem('realTradeHistory');
      if (savedHist) this.tradeHistory = JSON.parse(savedHist);
      const savedMetrics = localStorage.getItem('tradingMetrics');
      if (savedMetrics) this.metrics = JSON.parse(savedMetrics);
      const savedAlerts = localStorage.getItem('tradingAlerts');
      if (savedAlerts) this.alerts = JSON.parse(savedAlerts);
    } catch { /* ignore */ }
  }

  async getPortfolioSummary() {
    try {
      const balances = await this.bybitApi.getAccountBalance();
      const positions = await this.bybitApi.getPositions('linear');
      const usdt = balances.find(b => b.coin === 'USDT');
      const totalBalance = parseFloat(usdt?.walletBalance || '0');
      const availableBalance = parseFloat(usdt?.availableBalance || '0');
      const openPositions = positions.filter(p => parseFloat(p.size) > 0);
      const totalUnrealizedPnL = openPositions.reduce((s, p) => s + parseFloat(p.unrealisedPnl || '0'), 0);
      const positionsValue = openPositions.reduce((s, p) => s + parseFloat(p.positionValue || '0'), 0);

      const summary = {
        totalBalance,
        availableBalance,
        openPositions: openPositions.length,
        totalUnrealizedPnL,
        positionsValue,
        dailyPnL: this.dailyPnL
      };

      // Periodic Firebase metrics sync
      firebaseSync.syncMetrics({
        totalBalance,
        availableBalance,
        openPositions: openPositions.length,
        totalUnrealizedPnL,
        winRate: this.metrics.winRate,
        totalTrades: this.metrics.totalTrades,
        syncedAt: new Date().toISOString()
      }).catch(() => { /* silent fallback */ });

      return summary;
    } catch (error) {
      console.error('Portfolio summary error:', error);
      return null;
    }
  }

  startTrading() {
    this.isActive = true;
    this.addAlert('success', 'בוט המסחר האוטומטי Bybit (Spot + Futures) הופעל בהצלחה');
  }

  stopTrading() {
    this.isActive = false;
    this.addAlert('info', 'בוט המסחר האוטומטי Bybit הושבת');
  }

  getAlerts(): Alert[] {
    return [...this.alerts];
  }

  getMetrics(): TradingMetrics {
    return { ...this.metrics };
  }

  updateRiskConfig(newConfig: RiskManagementConfig) {
    this.riskConfig = newConfig;
    localStorage.setItem('riskConfig', JSON.stringify(newConfig));
    this.addAlert('info', 'הגדרות ניהול סיכון עודכנו');
  }

  async performMaintenanceTasks(): Promise<void> {
    if (!this.isActive) return;

    try {
      const positions = await this.bybitApi.getPositions('linear');
      const openPositions = positions.filter(p => parseFloat(p.size) > 0);

      for (const pos of openPositions) {
        const isLong = pos.side === 'Buy';
        const entryPrice = parseFloat(pos.entryPrice);
        const markPrice = parseFloat(pos.markPrice);
        const unrealizedPnl = parseFloat(pos.unrealisedPnl || '0');

        if (entryPrice <= 0 || markPrice <= 0) continue;

        const pnlPercent = isLong
          ? ((markPrice - entryPrice) / entryPrice) * 100 * parseFloat(pos.leverage || '1')
          : ((entryPrice - markPrice) / entryPrice) * 100 * parseFloat(pos.leverage || '1');

        // Dynamic Trailing Stop to Break-Even / Profit Lock
        if (this.riskConfig.trailingStopEnabled && pnlPercent >= 3.0) {
          const trailingStopDistance = (markPrice * (this.riskConfig.trailingStopPercent / 100)).toFixed(2);
          try {
            await this.bybitApi.setTradingStop({
              symbol: pos.symbol,
              category: 'linear',
              trailingStop: trailingStopDistance
            });
          } catch { /* ignored if already set */ }
        }
      }
    } catch (err) {
      console.warn('Maintenance tasks error:', err);
    }
  }

  isTrading(): boolean {
    return this.isActive;
  }

  getMarketRegime(symbol: string): MarketRegimeResult | undefined {
    return this.lastMarketRegime.get(symbol);
  }
}

export default AdvancedTradingService;

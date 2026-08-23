/**
 * Binance Public API Service (100% Free, No API Key Required)
 * Provides cross-exchange price/volume validation and zero-lag market data.
 * Rate limit: 1200 req/min — far more permissive than CoinGecko's 30 req/min.
 */

const BINANCE_BASE_URL = 'https://api.binance.com/api/v3';

export interface Binance24hTicker {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  prevClosePrice: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}

export interface BinanceKline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** In-memory cache for the bulk ticker list to avoid redundant calls */
let _allTickersCache: { data: Binance24hTicker[]; fetchedAt: number } | null = null;
const ALL_TICKERS_TTL_MS = 15_000; // 15 seconds

export const binancePublicApi = {
  /**
   * Fetch ALL 24h tickers in a single call (most efficient).
   * Returns all USDT pairs from Binance spot market.
   * Cached for 15 seconds to avoid redundant calls.
   */
  async getAllTickers(): Promise<Binance24hTicker[]> {
    const now = Date.now();
    if (_allTickersCache && now - _allTickersCache.fetchedAt < ALL_TICKERS_TTL_MS) {
      return _allTickersCache.data;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${BINANCE_BASE_URL}/ticker/24hr`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) return _allTickersCache?.data ?? [];
      const all: Binance24hTicker[] = await res.json();
      // Filter to USDT pairs with real volume
      const filtered = all.filter(t =>
        t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 10000
      );
      _allTickersCache = { data: filtered, fetchedAt: now };
      return filtered;
    } catch {
      return _allTickersCache?.data ?? [];
    }
  },

  /**
   * Fetch 24h ticker for cross-exchange volume/price validation (single symbol).
   * For bulk lookups, prefer getAllTickers() + filter instead.
   */
  async get24hTicker(symbol: string): Promise<Binance24hTicker | null> {
    try {
      const formatted = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(`${BINANCE_BASE_URL}/ticker/24hr?symbol=${formatted}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },

  /**
   * Fetch real Kline candles from Binance public endpoint.
   * No API key required. Supports up to 1000 candles per call.
   */
  async getKlines(symbol: string, interval = '1d', limit = 30): Promise<BinanceKline[]> {
    try {
      const formatted = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(
        `${BINANCE_BASE_URL}/klines?symbol=${formatted}&interval=${interval}&limit=${limit}`,
        {
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        }
      );
      clearTimeout(timeout);

      if (!res.ok) return [];
      const data: unknown[][] = await res.json();

      return data.map(item => ({
        timestamp: item[0] as number,
        open:   parseFloat(item[1] as string),
        high:   parseFloat(item[2] as string),
        low:    parseFloat(item[3] as string),
        close:  parseFloat(item[4] as string),
        volume: parseFloat(item[5] as string)
      }));
    } catch {
      return [];
    }
  }
};

/**
 * Binance Public API Service (100% Free, No API Key Required)
 * Provides cross-exchange price/volume validation and zero-lag market data.
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

export const binancePublicApi = {
  /**
   * Fetch 24h ticker for cross-exchange volume/price validation
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
   * Fetch real Kline candles from Binance public endpoint
   */
  async getKlines(symbol: string, interval: string = '1d', limit: number = 30): Promise<BinanceKline[]> {
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
      const data: any[][] = await res.json();

      return data.map(item => ({
        timestamp: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5])
      }));
    } catch {
      return [];
    }
  }
};

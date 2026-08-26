
import { CryptoData, HistoricalPrice } from '../types/crypto';
import { CRYPTO_IDS } from './coinGeckoIds';

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

// ── Rate limiter state ────────────────────────────────────────────────────────
// CoinGecko free tier: 30 req/min. These guards enforce minimum inter-call gaps
// so a single transient outage from Bybit/Binance can't blow the shared budget.

/** Minimum gap between getCurrentPrices() calls: 2 minutes */
const PRICE_FETCH_MIN_GAP_MS = 2 * 60 * 1000;
let lastPriceFetchAt = 0;
let cachedPriceData: CryptoData[] = [];

/** Minimum gap per-coin for historical candle fetches: 10 minutes */
const HIST_FETCH_MIN_GAP_MS = 10 * 60 * 1000;
const lastHistFetchAt: Record<string, number> = {};
const cachedHistData: Record<string, HistoricalPrice[]> = {};

interface CoinGeckoMarketChart {
  prices: [number, number][];
  total_volumes: [number, number][];
}

/**
 * Lightweight fetch wrapper — fail fast on 429 (return null), single retry max.
 * The aggregator (cryptoPriceAggregator.ts) is the primary source; CoinGecko is
 * last-resort, so we should NEVER burn retries here.
 */
async function apiCall<T>(url: string, retries = 1, delay = 1000): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        // Rate limited — never retry, let the caller serve cached data instead.
        console.warn(`[CoinGecko] 429 rate limited on attempt ${i + 1} — stopping immediately`);
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as T;
      return data;
    } catch (error) {
      console.warn(`[CoinGecko] API call failed (attempt ${i + 1}/${retries + 1}):`, error);
      if (i === retries) return null;
      const waitTime = Math.min(delay * Math.pow(2, i), 8000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  return null;
}

export const coinGeckoApi = {
  /**
   * Returns current prices for all tracked coins.
   * RATE-GATED: Returns cached data if called within 2 minutes of last fetch.
   * Prefer cryptoPriceAggregator.getAggregatedPrices() which uses Bybit/Binance first.
   */
  async getCurrentPrices(): Promise<CryptoData[]> {
    const now = Date.now();

    // Serve cache if within the minimum gap
    if (now - lastPriceFetchAt < PRICE_FETCH_MIN_GAP_MS && cachedPriceData.length > 0) {
      console.log(`[CoinGecko] Serving cached prices (${cachedPriceData.length} coins, age ${Math.round((now - lastPriceFetchAt) / 1000)}s)`);
      return cachedPriceData;
    }

    const ids = Object.values(CRYPTO_IDS).join(',');
    const url = `${COINGECKO_BASE_URL}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h&locale=en`;

    console.log('[CoinGecko] Fetching current prices (100 coins)...');
    const data = await apiCall<CryptoData[]>(url, 1, 2000);

    if (!data || data.length === 0) {
      // Return cached data rather than throwing (stale > nothing)
      if (cachedPriceData.length > 0) {
        console.warn('[CoinGecko] Fetch failed — returning last-known-good prices');
        return cachedPriceData;
      }
      throw new Error('CoinGecko: no live prices and no cache available');
    }

    console.log(`[CoinGecko] Fetched ${data.length} coin prices`);

    const mappedData = data.map(coin => {
      const symbolEntry = Object.entries(CRYPTO_IDS).find(([, id]) => id === coin.id);
      const mappedSymbol = symbolEntry ? symbolEntry[0] : coin.symbol.toUpperCase();
      return { ...coin, symbol: mappedSymbol.toLowerCase() };
    });

    lastPriceFetchAt = now;
    cachedPriceData = mappedData;
    return mappedData;
  },

  /**
   * Returns daily historical prices for a coin.
   * RATE-GATED per coin: returns cached data if called within 10 minutes.
   * retries parameter kept for backward compatibility but defaults to 0 (fail fast).
   */
  async getHistoricalPrices(coinId: string, days = 60, retries = 0): Promise<HistoricalPrice[]> {
    const now = Date.now();
    const key = `${coinId}-${days}`;

    // Serve cache if within the per-coin gap
    if (now - (lastHistFetchAt[key] || 0) < HIST_FETCH_MIN_GAP_MS && cachedHistData[key]?.length > 0) {
      return cachedHistData[key];
    }

    const url = `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;

    const data = await apiCall<CoinGeckoMarketChart>(url, retries, 2000);

    if (!data || !data.prices || data.prices.length === 0) {
      // Return cached data rather than throwing
      if (cachedHistData[key]?.length > 0) {
        console.warn(`[CoinGecko] Historical fetch failed for ${coinId} — returning cached`);
        return cachedHistData[key];
      }
      throw new Error(`No historical data for ${coinId}`);
    }

    const volumes: number[] = Array.isArray(data.total_volumes)
      ? data.total_volumes.map(([, volume]: [number, number]) => volume)
      : [];

    const historicalData = data.prices.map(([timestamp, price]: [number, number], idx: number) => ({
      timestamp,
      price,
      volume: volumes[idx] ?? 0
    }));

    lastHistFetchAt[key] = now;
    cachedHistData[key] = historicalData;
    return historicalData;
  },

  async getVolumeData(coinId: string, days = 30): Promise<number[]> {
    const url = `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const data = await apiCall<CoinGeckoMarketChart>(url, 1, 2000);
    if (!data || !data.total_volumes || data.total_volumes.length === 0) {
      throw new Error(`No volume data for ${coinId}`);
    }
    return data.total_volumes.map(([, volume]: [number, number]) => volume);
  },

  getCoinId(symbol: string): string {
    const upperSymbol = symbol.toUpperCase();
    return CRYPTO_IDS[upperSymbol as keyof typeof CRYPTO_IDS] || symbol.toLowerCase();
  },

  getSupportedSymbols(): string[] {
    return Object.keys(CRYPTO_IDS);
  }
};


const BYBIT_BASE_URL = 'https://api.bybit.com';

interface BybitTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  price24hPcnt: string;
  volume24h: string;
  highPrice24h: string;
  lowPrice24h: string;
}

interface BybitKlineData {
  openTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// Helper function for Bybit API calls
async function bybitApiCall<T>(endpoint: string, params: Record<string, string> = {}): Promise<T | null> {
  try {
    const urlParams = new URLSearchParams(params);
    const url = `${BYBIT_BASE_URL}${endpoint}?${urlParams}`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      }
    });
    
    if (!response.ok) {
      throw new Error(`Bybit API error: ${response.status}`);
    }
    
    const data = await response.json() as { retCode: number; result: T };
    
    if (data.retCode !== 0) {
      return null;
    }
    
    return data.result;
  } catch (error) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// TOP 100 CRYPTO ASSETS — Expanded Bybit Symbol Mapping
// ═══════════════════════════════════════════════════════
// Stablecoins (USDT, USDC, DAI, FDUSD, TUSD) are EXCLUDED
// because they never produce trading signals.
// Wrapped tokens (WBTC) excluded — same price action as underlying.

import { TARGET_SYMBOLS } from '../shared/targetSymbols';

// Internal symbol to Bybit symbol mapping (auto-generated from TARGET_SYMBOLS)
function toInternalSymbol(bybitSymbol: string): string {
  return bybitSymbol.replace('USDT', '').toLowerCase();
}

function toBybitSymbol(internalSymbol: string): string {
  return `${internalSymbol.toUpperCase()}USDT`;
}

export const bybitApi = {
  async getTickers(): Promise<BybitTicker[]> {
    const data = await bybitApiCall<{ list: BybitTicker[] }>(
      '/v5/market/tickers',
      { category: 'spot' }
    );
    
    if (!data || !data.list) {
      return [];
    }
    
    // Filter for our target symbols (up to 100)
    const targetSet = new Set(TARGET_SYMBOLS);
    const filteredTickers = data.list.filter(ticker =>
      targetSet.has(ticker.symbol)
    );
    
    return filteredTickers;
  },

  async getKlineData(symbol: string, interval: string = 'D', limit: number = 60): Promise<BybitKlineData[]> {
    const validInterval = interval === '1d' ? 'D' : interval;
    
    const data = await bybitApiCall<{ list: string[][] }>(
      '/v5/market/kline',
      {
        category: 'spot',
        symbol,
        interval: validInterval,
        limit: limit.toString()
      }
    );
    
    if (!data || !data.list) {
      return [];
    }
    
    const klineData: BybitKlineData[] = data.list.map(item => ({
      openTime: item[0],
      open: item[1],
      high: item[2],
      low: item[3],
      close: item[4],
      volume: item[5]
    }));
    
    return klineData.reverse(); // Chronological order
  },

  getInternalSymbol(bybitSymbol: string): string {
    return toInternalSymbol(bybitSymbol);
  },

  getBybitSymbol(internalSymbol: string): string {
    return toBybitSymbol(internalSymbol);
  },

  getTargetSymbols(): string[] {
    return [...TARGET_SYMBOLS];
  }
};

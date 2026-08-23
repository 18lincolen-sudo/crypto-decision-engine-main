
import { CryptoData, HistoricalPrice } from '../types/crypto';

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

// ═══════════════════════════════════════════════════════
// TOP 100 CRYPTO ASSETS — CoinGecko ID Mapping
// Stablecoins (USDT, USDC, DAI, FDUSD, TUSD) EXCLUDED
// ═══════════════════════════════════════════════════════
const CRYPTO_IDS: Record<string, string> = {
  // Tier 1 — Top 10
  'BTC': 'bitcoin', 'ETH': 'ethereum', 'BNB': 'binancecoin', 'SOL': 'solana',
  'XRP': 'ripple', 'DOGE': 'dogecoin', 'TON': 'the-open-network', 'ADA': 'cardano',
  'AVAX': 'avalanche-2', 'TRX': 'tron',
  // Tier 2 — Top 11-25
  'DOT': 'polkadot', 'BCH': 'bitcoin-cash', 'NEAR': 'near', 'MATIC': 'matic-network',
  'ICP': 'internet-computer', 'UNI': 'uniswap', 'LTC': 'litecoin', 'ETC': 'ethereum-classic',
  'APT': 'aptos', 'SHIB': 'shiba-inu', 'LINK': 'chainlink', 'XLM': 'stellar',
  'ATOM': 'cosmos', 'FIL': 'filecoin', 'HBAR': 'hedera-hashgraph',
  // Tier 3 — Top 26-50
  'ARB': 'arbitrum', 'OP': 'optimism', 'IMX': 'immutable-x', 'MKR': 'maker',
  'INJ': 'injective-protocol', 'GRT': 'the-graph', 'SUI': 'sui', 'SEI': 'sei-network',
  'TIA': 'celestia', 'RNDR': 'render-token', 'FET': 'fetch-ai', 'THETA': 'theta-token',
  'FTM': 'fantom', 'AAVE': 'aave', 'ALGO': 'algorand', 'FLOW': 'flow',
  'AXS': 'axie-infinity', 'SAND': 'the-sandbox', 'MANA': 'decentraland', 'SNX': 'havven',
  'LDO': 'lido-dao', 'EGLD': 'elrond-erd-2', 'XTZ': 'tezos', 'EOS': 'eos', 'NEO': 'neo',
  // Tier 4 — Top 51-75
  'GALA': 'gala', 'CHZ': 'chiliz', 'APE': 'apecoin', 'CRV': 'curve-dao-token',
  'LRC': 'loopring', 'ENA': 'ethena', 'WLD': 'worldcoin-wld', 'STX': 'blockstack',
  'MINA': 'mina-protocol', 'CFX': 'conflux-token', 'RUNE': 'thorchain',
  'COMP': 'compound-governance-token', 'DYDX': 'dydx', 'GMX': 'gmx', 'KAVA': 'kava',
  'ZIL': 'zilliqa', 'IOTA': 'iota', 'CAKE': 'pancakeswap-token', '1INCH': '1inch',
  'MASK': 'mask-network', 'PENDLE': 'pendle', 'AR': 'arweave', 'BLUR': 'blur',
  'WOO': 'woo-network', 'SKL': 'skale',
  // Tier 5 — Top 76-100
  'CELO': 'celo', 'KSM': 'kusama', 'ZRX': '0x', 'YFI': 'yearn-finance', 'BAT': 'basic-attention-token',
  'ENS': 'ethereum-name-service', 'SSV': 'ssv-network', 'ANKR': 'ankr', 'BAND': 'band-protocol',
  'OGN': 'origin-protocol', 'ONT': 'ontology', 'WAVES': 'waves', 'STORJ': 'storj',
  'ONE': 'harmony', 'HOT': 'holotoken', 'IOST': 'iostoken', 'VET': 'vechain',
  'DASH': 'dash', 'ZEN': 'zencash', 'QTUM': 'qtum', 'ZEC': 'zcash', 'ICX': 'icon',
  'RVN': 'ravencoin', 'GLMR': 'moonbeam', 'BNT': 'bancor'
};

interface CoinGeckoMarketChart {
  prices: [number, number][];
  total_volumes: [number, number][];
}
async function apiCall<T>(url: string, retries = 1, delay = 500): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.status === 429) {
        const waitTime = Math.min(delay * Math.pow(2, i + 2), 60000);
        console.warn(`Rate limited, waiting ${waitTime}ms before retry ${i + 1}/${retries}`);
        if (i < retries) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        throw new Error('Rate limited after all retries');
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json() as T;
      console.log(`API call successful for: ${url}`);
      return data;
    } catch (error) {
      console.warn(`API call failed (attempt ${i + 1}/${retries + 1}):`, error);
      
      if (i === retries) {
        console.error(`API call failed after ${retries + 1} attempts:`, error);
        return null;
      }
      
      const waitTime = Math.min(delay * Math.pow(2, i), 15000);
      console.warn(`Retrying in ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  return null;
}

export const coinGeckoApi = {
  async getCurrentPrices(): Promise<CryptoData[]> {
    const ids = Object.values(CRYPTO_IDS).join(',');
    // CoinGecko free tier allows up to 250 coins per request
    const url = `${COINGECKO_BASE_URL}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h,24h,7d&locale=en`;
    
    console.log('Fetching current prices from CoinGecko (100 coins)...');
    const data = await apiCall<CryptoData[]>(url, 3, 2000);
    
    if (!data || data.length === 0) {
      throw new Error('Failed to fetch live prices from CoinGecko');
    }
    
    console.log(`Successfully fetched crypto prices: ${data.length} coins`);
    
    const mappedData = data.map(coin => {
      const symbolEntry = Object.entries(CRYPTO_IDS).find(([_, id]) => id === coin.id);
      const mappedSymbol = symbolEntry ? symbolEntry[0] : coin.symbol.toUpperCase();
      
      return {
        ...coin,
        symbol: mappedSymbol.toLowerCase()
      };
    });
    
    return mappedData;
  },

  async getHistoricalPrices(coinId: string, days: number = 60): Promise<HistoricalPrice[]> {
    const url = `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    
    console.log(`Fetching historical prices for ${coinId}...`);
    const data = await apiCall<CoinGeckoMarketChart>(url, 2, 3000);
    
    if (!data || !data.prices || data.prices.length === 0) {
      throw new Error(`No live historical data for ${coinId}`);
    }

    const volumes: number[] = Array.isArray(data.total_volumes)
      ? data.total_volumes.map(([, volume]: [number, number]) => volume)
      : [];

    const historicalData = data.prices.map(([timestamp, price]: [number, number], idx: number) => ({
      timestamp,
      price,
      volume: volumes[idx] ?? 0
    }));

    console.log(`Historical data for ${coinId}: ${historicalData.length} data points`);
    return historicalData;
  },

  async getVolumeData(coinId: string, days: number = 30): Promise<number[]> {
    const url = `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;

    console.log(`Fetching volume data for ${coinId}...`);
    const data = await apiCall<CoinGeckoMarketChart>(url, 2, 3000);

    if (!data || !data.total_volumes || data.total_volumes.length === 0) {
      throw new Error(`No live volume data for ${coinId}`);
    }

    const volumes = data.total_volumes.map(([, volume]: [number, number]) => volume);
    console.log(`Volume data for ${coinId}: ${volumes.length} data points`);
    return volumes;
  },

  getCoinId(symbol: string): string {
    const upperSymbol = symbol.toUpperCase();
    return CRYPTO_IDS[upperSymbol as keyof typeof CRYPTO_IDS] || symbol.toLowerCase();
  },

  getSupportedSymbols(): string[] {
    return Object.keys(CRYPTO_IDS);
  }
};

/**
 * CryptoPriceAggregator — Multi-Source, Rate-Limit-Safe Price & Candle Feed
 * ============================================================================
 * Priority order for prices:   Bybit → Binance → CoinGecko (cached)
 * Priority order for candles:  Bybit → Binance → CoinGecko (heavily rate-gated)
 *
 * CoinGecko free tier: 30 req/min shared across ALL callers on the same IP.
 * This aggregator enforces a 120s minimum TTL for CoinGecko calls so stale
 * cached data is returned instead of blowing the rate limit.
 *
 * Binance public API: 1200 req/min, no API key needed. Fetch ALL 24h tickers
 * in a SINGLE call instead of one per symbol.
 */

import { CryptoData } from '../types/crypto';
import { Candle } from './tradeEngine';

// ── Binance ticker shape ──────────────────────────────────────────────────────
interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
  openPrice: string;
}

interface BinanceKlineRaw {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// ── Internal cache entries ────────────────────────────────────────────────────
interface PriceCache {
  data: CryptoData[];
  fetchedAt: number;
  source: 'bybit' | 'binance' | 'coingecko';
}

interface CandleCache {
  candles: Candle[];
  fetchedAt: number;
  source: 'bybit' | 'binance' | 'coingecko';
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BINANCE_BASE = 'https://api.binance.com/api/v3';
const BYBIT_BASE   = 'https://api.bybit.com';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

/** Minimum time between CoinGecko getCurrentPrices() calls (2 minutes) */
const COINGECKO_PRICE_TTL = 2 * 60 * 1000;
/** Minimum time between CoinGecko per-coin candle fetches (10 minutes) */
const COINGECKO_CANDLE_TTL = 10 * 60 * 1000;
/** Binance full-ticker cache TTL (15 seconds — Binance allows it) */
const BINANCE_TICKER_TTL = 15_000;
/** Bybit ticker cache TTL (10 seconds) */
const BYBIT_TICKER_TTL = 10_000;

// ── CoinGecko symbol → ID map (same as coinGeckoApi.ts) ──────────────────────
const CRYPTO_IDS: Record<string, string> = {
  'BTC': 'bitcoin', 'ETH': 'ethereum', 'BNB': 'binancecoin', 'SOL': 'solana',
  'XRP': 'ripple', 'DOGE': 'dogecoin', 'TON': 'the-open-network', 'ADA': 'cardano',
  'AVAX': 'avalanche-2', 'TRX': 'tron',
  'DOT': 'polkadot', 'BCH': 'bitcoin-cash', 'NEAR': 'near', 'MATIC': 'matic-network',
  'ICP': 'internet-computer', 'UNI': 'uniswap', 'LTC': 'litecoin', 'ETC': 'ethereum-classic',
  'APT': 'aptos', 'SHIB': 'shiba-inu', 'LINK': 'chainlink', 'XLM': 'stellar',
  'ATOM': 'cosmos', 'FIL': 'filecoin', 'HBAR': 'hedera-hashgraph',
  'ARB': 'arbitrum', 'OP': 'optimism', 'IMX': 'immutable-x', 'MKR': 'maker',
  'INJ': 'injective-protocol', 'GRT': 'the-graph', 'SUI': 'sui', 'SEI': 'sei-network',
  'TIA': 'celestia', 'RNDR': 'render-token', 'FET': 'fetch-ai', 'THETA': 'theta-token',
  'FTM': 'fantom', 'AAVE': 'aave', 'ALGO': 'algorand', 'FLOW': 'flow',
  'AXS': 'axie-infinity', 'SAND': 'the-sandbox', 'MANA': 'decentraland', 'SNX': 'havven',
  'LDO': 'lido-dao', 'EGLD': 'elrond-erd-2', 'XTZ': 'tezos', 'EOS': 'eos', 'NEO': 'neo',
  'GALA': 'gala', 'CHZ': 'chiliz', 'APE': 'apecoin', 'CRV': 'curve-dao-token',
  'LRC': 'loopring', 'ENA': 'ethena', 'WLD': 'worldcoin-wld', 'STX': 'blockstack',
  'MINA': 'mina-protocol', 'CFX': 'conflux-token', 'RUNE': 'thorchain',
  'COMP': 'compound-governance-token', 'DYDX': 'dydx', 'GMX': 'gmx', 'KAVA': 'kava',
  'ZIL': 'zilliqa', 'IOTA': 'iota', 'CAKE': 'pancakeswap-token', '1INCH': '1inch',
  'MASK': 'mask-network', 'PENDLE': 'pendle', 'AR': 'arweave', 'BLUR': 'blur',
  'WOO': 'woo-network', 'SKL': 'skale',
  'CELO': 'celo', 'KSM': 'kusama', 'ZRX': '0x', 'YFI': 'yearn-finance', 'BAT': 'basic-attention-token',
  'ENS': 'ethereum-name-service', 'SSV': 'ssv-network', 'ANKR': 'ankr', 'BAND': 'band-protocol',
  'OGN': 'origin-protocol', 'ONT': 'ontology', 'WAVES': 'waves', 'STORJ': 'storj',
  'ONE': 'harmony', 'HOT': 'holotoken', 'IOST': 'iostoken', 'VET': 'vechain',
  'DASH': 'dash', 'ZEN': 'zencash', 'QTUM': 'qtum', 'ZEC': 'zcash', 'ICX': 'icon',
  'RVN': 'ravencoin', 'GLMR': 'moonbeam', 'BNT': 'bancor'
};

// ── In-memory caches ──────────────────────────────────────────────────────────
let priceCache: PriceCache | null = null;
let binanceTickerCache: { tickers: BinanceTicker[]; fetchedAt: number } | null = null;
let bybitTickerCache: { tickers: CryptoData[]; fetchedAt: number } | null = null;
const candleCache = new Map<string, CandleCache>();

// ── Helper: timed fetch ───────────────────────────────────────────────────────
async function timedFetch(url: string, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Binance: fetch ALL USDT tickers in one call ───────────────────────────────
async function fetchBinanceAllTickers(): Promise<BinanceTicker[]> {
  const now = Date.now();
  if (binanceTickerCache && now - binanceTickerCache.fetchedAt < BINANCE_TICKER_TTL) {
    return binanceTickerCache.tickers;
  }

  try {
    // Fetching ALL tickers without a symbol filter — single call, max efficiency
    const res = await timedFetch(`${BINANCE_BASE}/ticker/24hr`);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const all: BinanceTicker[] = await res.json();
    // Keep only USDT pairs with real volume
    const filtered = all.filter(t =>
      t.symbol.endsWith('USDT') &&
      parseFloat(t.quoteVolume) > 10000
    );
    binanceTickerCache = { tickers: filtered, fetchedAt: now };
    return filtered;
  } catch (e) {
    console.warn('[aggregator] Binance ticker fetch failed:', e instanceof Error ? e.message : String(e));
    return binanceTickerCache?.tickers ?? [];
  }
}

// ── Bybit: fetch all spot tickers ─────────────────────────────────────────────
async function fetchBybitAllTickers(): Promise<CryptoData[]> {
  const now = Date.now();
  if (bybitTickerCache && now - bybitTickerCache.fetchedAt < BYBIT_TICKER_TTL) {
    return bybitTickerCache.tickers;
  }

  try {
    const res = await timedFetch(`${BYBIT_BASE}/v5/market/tickers?category=spot`);
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
    const data = await res.json() as {
      retCode: number;
      result?: { list?: { symbol: string; lastPrice: string; price24hPcnt: string; volume24h: string }[] }
    };
    if (data.retCode !== 0 || !data.result?.list) throw new Error('Bybit retCode not 0');

    const tickers = data.result.list
      .filter(t => t.symbol.endsWith('USDT'))
      .map(t => {
        const sym = t.symbol.replace('USDT', '').toLowerCase();
        return {
          id: sym,
          symbol: sym,
          name: t.symbol,
          current_price: parseFloat(t.lastPrice),
          price_change_percentage_24h: parseFloat(t.price24hPcnt) * 100,
          total_volume: parseFloat(t.volume24h),
          market_cap: parseFloat(t.lastPrice) * parseFloat(t.volume24h) * 100,
          last_updated: new Date().toISOString()
        } as CryptoData;
      });

    bybitTickerCache = { tickers, fetchedAt: now };
    return tickers;
  } catch (e) {
    console.warn('[aggregator] Bybit ticker fetch failed:', e instanceof Error ? e.message : String(e));
    return bybitTickerCache?.tickers ?? [];
  }
}

// ── CoinGecko: rate-gated price fetch ────────────────────────────────────────
let lastCoinGeckoPriceFetch = 0;
let coinGeckoPriceCache: CryptoData[] = [];

async function fetchCoinGeckoPrices(): Promise<CryptoData[]> {
  const now = Date.now();
  if (now - lastCoinGeckoPriceFetch < COINGECKO_PRICE_TTL) {
    return coinGeckoPriceCache; // serve stale rather than blow rate limit
  }

  const ids = Object.values(CRYPTO_IDS).join(',');
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h&locale=en`;

  try {
    const res = await timedFetch(url, 10000);
    if (res.status === 429) {
      console.warn('[aggregator] CoinGecko rate limited — serving cached data');
      return coinGeckoPriceCache;
    }
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data: CryptoData[] = await res.json();
    if (!data || data.length === 0) throw new Error('Empty response');

    // Map CoinGecko IDs back to our symbol names
    const mapped = data.map(coin => {
      const entry = Object.entries(CRYPTO_IDS).find(([, id]) => id === coin.id);
      return { ...coin, symbol: entry ? entry[0].toLowerCase() : coin.symbol.toLowerCase() };
    });

    lastCoinGeckoPriceFetch = now;
    coinGeckoPriceCache = mapped;
    return mapped;
  } catch (e) {
    console.warn('[aggregator] CoinGecko price fetch failed:', e instanceof Error ? e.message : String(e));
    return coinGeckoPriceCache;
  }
}

// ── Main: getCurrentPrices — Bybit → Binance → CoinGecko ─────────────────────
export async function getAggregatedPrices(targetSymbols?: string[]): Promise<CryptoData[]> {
  // 1) Try Bybit (fastest, real-time)
  const bybitTickers = await fetchBybitAllTickers();
  if (bybitTickers.length > 10) {
    const filtered = targetSymbols
      ? bybitTickers.filter(t => targetSymbols.some(s => t.symbol.toUpperCase() === s.toUpperCase()))
      : bybitTickers;
    if (filtered.length > 10) {
      priceCache = { data: filtered, fetchedAt: Date.now(), source: 'bybit' };
      return filtered;
    }
  }

  // 2) Try Binance (one call for all tickers)
  const binanceTickers = await fetchBinanceAllTickers();
  if (binanceTickers.length > 10) {
    const mapped: CryptoData[] = binanceTickers
      .filter(t => {
        const sym = t.symbol.replace('USDT', '').toLowerCase();
        return targetSymbols
          ? targetSymbols.some(s => s.toUpperCase() === sym.toUpperCase())
          : true;
      })
      .map(t => {
        const sym = t.symbol.replace('USDT', '').toLowerCase();
        const price = parseFloat(t.lastPrice);
        const vol   = parseFloat(t.quoteVolume);
        return {
          id: sym,
          symbol: sym,
          name: t.symbol,
          current_price: price,
          price_change_percentage_24h: parseFloat(t.priceChangePercent),
          total_volume: vol,
          market_cap: price * vol * 100,
          last_updated: new Date().toISOString()
        } as CryptoData;
      });

    if (mapped.length > 10) {
      priceCache = { data: mapped, fetchedAt: Date.now(), source: 'binance' };
      return mapped;
    }
  }

  // 3) Fallback: CoinGecko (rate-gated, 2min TTL minimum)
  const cgData = await fetchCoinGeckoPrices();
  if (cgData.length > 0) {
    priceCache = { data: cgData, fetchedAt: Date.now(), source: 'coingecko' };
    return cgData;
  }

  // 4) Absolute last resort: return previously cached data
  return priceCache?.data ?? [];
}

// ── Candle fetching: Bybit → Binance → CoinGecko ────────────────────────────
export async function getAggregatedCandles(symbol: string, days = 60): Promise<Candle[]> {
  const SYM = symbol.toUpperCase();
  const now = Date.now();

  // 1) Bybit klines
  try {
    const res = await timedFetch(
      `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${SYM}USDT&interval=D&limit=${Math.min(days, 200)}`,
      8000
    );
    if (res.ok) {
      const data = await res.json() as {
        retCode: number;
        result?: { list?: string[][] }
      };
      if (data.retCode === 0 && data.result?.list && data.result.list.length > 2) {
        const candles: Candle[] = [...data.result.list].reverse().map(a => ({
          timestamp: Number(a[0]),
          open:  Number(a[1]),
          high:  Number(a[2]),
          low:   Number(a[3]),
          close: Number(a[4]),
          volume: Number(a[5])
        }));
        candleCache.set(SYM, { candles, fetchedAt: now, source: 'bybit' });
        return candles;
      }
    }
  } catch { /* fall through */ }

  // 2) Binance klines
  try {
    const res = await timedFetch(
      `${BINANCE_BASE}/klines?symbol=${SYM}USDT&interval=1d&limit=${Math.min(days, 1000)}`,
      8000
    );
    if (res.ok) {
      const raw: BinanceKlineRaw[] = (await res.json() as unknown[][]).map(a => ({
        openTime: a[0] as number,
        open:  a[1] as string,
        high:  a[2] as string,
        low:   a[3] as string,
        close: a[4] as string,
        volume: a[5] as string
      }));
      if (raw.length > 2) {
        const candles: Candle[] = raw.map(k => ({
          timestamp: k.openTime,
          open:  parseFloat(k.open),
          high:  parseFloat(k.high),
          low:   parseFloat(k.low),
          close: parseFloat(k.close),
          volume: parseFloat(k.volume)
        }));
        candleCache.set(SYM, { candles, fetchedAt: now, source: 'binance' });
        return candles;
      }
    }
  } catch { /* fall through */ }

  // 3) CoinGecko — rate-gated: minimum COINGECKO_CANDLE_TTL per symbol
  const cached = candleCache.get(SYM);
  if (cached && now - cached.fetchedAt < COINGECKO_CANDLE_TTL) {
    return cached.candles; // serve last-known-good rather than blow rate limit
  }

  const coinId = CRYPTO_IDS[SYM] || SYM.toLowerCase();
  try {
    const url = `${COINGECKO_BASE}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const res = await timedFetch(url, 10000);
    if (res.status === 429) {
      console.warn(`[aggregator] CoinGecko candle rate limited for ${SYM} — serving cached`);
      return cached?.candles ?? [];
    }
    if (!res.ok) throw new Error(`CoinGecko candle HTTP ${res.status}`);
    const data = await res.json() as { prices: [number, number][]; total_volumes: [number, number][] };
    if (!data.prices || data.prices.length < 2) throw new Error('insufficient data');

    const candles: Candle[] = data.prices.map(([ts, price], i) => {
      const open = i > 0 ? data.prices[i - 1][1] : price;
      const vol  = data.total_volumes[i]?.[1] ?? 0;
      return {
        timestamp: ts,
        open,
        high: Math.max(open, price),
        low:  Math.min(open, price),
        close: price,
        volume: vol
      };
    });

    candleCache.set(SYM, { candles, fetchedAt: now, source: 'coingecko' });
    return candles;
  } catch (e) {
    console.warn(`[aggregator] CoinGecko candle fetch failed for ${SYM}:`, e instanceof Error ? e.message : String(e));
    return cached?.candles ?? [];
  }
}

/** Expose cache health stats for /health endpoint */
export function getAggregatorHealth() {
  return {
    priceSource: priceCache?.source ?? 'none',
    priceCacheAge: priceCache ? Date.now() - priceCache.fetchedAt : null,
    candlesCached: candleCache.size,
    coinGeckoPriceCooldown: Math.max(0, COINGECKO_PRICE_TTL - (Date.now() - lastCoinGeckoPriceFetch))
  };
}

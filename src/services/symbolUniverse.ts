/**
 * Live liquidity-based trading universe — TS port of MISCHAR.py
 * (G:\claude-projects\MISCHAR.py). Sums real Bybit turnover24h across every
 * product type a base asset trades on (spot USDT, linear USDT, linear USDC,
 * inverse) to find genuinely liquid coins, then reports the actual tradeable
 * Spot USDT pair the bot can execute on.
 *
 * This is the actual code that runs live (refreshUniverseIfStale() in
 * tradingWorker.ts, daily) — MISCHAR.py is only an offline copy used to
 * regenerate the static targetSymbols.ts fallback. Both used to prefer the
 * LINEAR (futures) symbol over Spot when both existed (e.g. "1000PEPEUSDT",
 * which doesn't exist on Spot at all — Bybit Spot lists the same coin as
 * "PEPEUSDT"). The bot's price pipeline (fetchBybitAllTickers /
 * getAggregatedPrices) only ever reads Bybit's SPOT tickers, so a
 * linear-only symbol could never get live data — it just sat as a dead,
 * permanently-pending slot in the universe. Multiplier-prefixed linear
 * symbols (1000PEPE, 1000BONK, SHIB1000) also weren't normalized to their
 * real base before grouping, so the same coin could enter the universe
 * twice under two different symbol strings. Fixed 2026-08-26 (see
 * baseAndKind's stripMultiplier and computeLiquidUniverse's tradeSymbol
 * selection below) — kept in sync with the equivalent MISCHAR.py fix.
 */

const BYBIT_PUBLIC_BASE = 'https://api.bybit.com';
const LIQUID_THRESHOLD = 20_000_000;
const NEAR_THRESHOLD = 8_000_000;
// Sanity floor on the coin's OWN spot volume, separate from the near/liquid
// tier thresholds above (which use total liquidity across all venues). A coin
// can be genuinely liquid overall while its specific spot pair is a near-dead
// listing — that pair still won't give the bot usable live price data.
export const MIN_SPOT_VOLUME_FOR_INCLUSION = 200_000;

// Matches MULTIPLIER_PREFIXES in assetUniverse.ts / MISCHAR.py — Bybit's
// linear market often lists cheap tokens under a contract-size multiplier
// (1000PEPEUSDT) that Spot doesn't use (PEPEUSDT); strip it so both resolve
// to the same base coin instead of being counted as two unrelated coins.
const MULTIPLIER_PREFIXES = ['1000000', '100000', '10000', '1000'];
function stripMultiplier(base: string): string {
  for (const prefix of MULTIPLIER_PREFIXES) {
    if (base.startsWith(prefix) && base.length > prefix.length) return base.slice(prefix.length);
  }
  return base;
}

// Tokenized stocks/commodities/stablecoins on Bybit — excluded even if liquid;
// the engine's regime/ATR/leverage logic is tuned for crypto volatility, and
// stable pairs can't produce a real signal in the first place.
const EXCLUDE_BASES = new Set([
  'USDC', 'USD1', 'RLUSD', 'USDE',
  'XAU', 'XAUT', 'XAG', 'PAXG', 'CL',
  'NVDA', 'TSLA', 'MSTR', 'SNDK', 'SOXL', 'SPCX', 'MU',
  'SKHYNIX', 'SKHY', 'SAMSUNG'
]);

interface BybitTickerRow {
  symbol: string;
  turnover24h?: string;
}

async function fetchTickers(category: 'spot' | 'linear' | 'inverse'): Promise<BybitTickerRow[]> {
  const res = await fetch(`${BYBIT_PUBLIC_BASE}/v5/market/tickers?category=${category}`);
  if (!res.ok) throw new Error(`Bybit tickers HTTP ${res.status} (${category})`);
  const data = (await res.json()) as { retCode: number; retMsg?: string; result?: { list?: BybitTickerRow[] } };
  if (data.retCode !== 0) throw new Error(`Bybit tickers retCode ${data.retCode} ${data.retMsg || ''} (${category})`);
  return data.result?.list ?? [];
}

function baseAndKind(symbol: string): { base: string; kind: 'usdt' | 'usdc' | 'inverse' } | null {
  if (symbol.endsWith('USDT')) return { base: stripMultiplier(symbol.slice(0, -4)), kind: 'usdt' };
  if (symbol.endsWith('PERP')) return { base: stripMultiplier(symbol.slice(0, -4)), kind: 'usdc' };
  if (symbol.endsWith('USDC')) return { base: stripMultiplier(symbol.slice(0, -4)), kind: 'usdc' };
  if (symbol.endsWith('USD')) return { base: stripMultiplier(symbol.slice(0, -3)), kind: 'inverse' };
  return null;
}

export interface LiquidUniverseResult {
  liquid: string[];
  close: string[];
  symbols: string[];
  generatedAt: number;
}

export async function computeLiquidUniverse(): Promise<LiquidUniverseResult> {
  const [spot, linear, inverse] = await Promise.all([
    fetchTickers('spot'),
    fetchTickers('linear'),
    fetchTickers('inverse')
  ]);

  interface CoinEntry {
    usdtSpot: { symbol: string; vol: number } | null;
    usdtLinear: { symbol: string; vol: number } | null;
    usdc: number;
    inverse: number;
  }
  const coins = new Map<string, CoinEntry>();

  const add = (symbol: string, category: 'spot' | 'linear' | 'inverse', vol: number) => {
    const parsed = baseAndKind(symbol);
    if (!parsed) return;
    const { base, kind } = parsed;
    let entry = coins.get(base);
    if (!entry) {
      entry = { usdtSpot: null, usdtLinear: null, usdc: 0, inverse: 0 };
      coins.set(base, entry);
    }
    if (kind === 'usdt' && category === 'spot') entry.usdtSpot = { symbol, vol };
    else if (kind === 'usdt' && category === 'linear') entry.usdtLinear = { symbol, vol };
    else if (kind === 'usdc') entry.usdc += vol;
    else if (kind === 'inverse') entry.inverse += vol;
  };

  for (const row of spot) add(row.symbol, 'spot', Number(row.turnover24h ?? 0));
  for (const row of linear) add(row.symbol, 'linear', Number(row.turnover24h ?? 0));
  for (const row of inverse) add(row.symbol, 'inverse', Number(row.turnover24h ?? 0));

  const liquid: { symbol: string; vol: number }[] = [];
  const close: { symbol: string; vol: number }[] = [];

  for (const [base, entry] of coins) {
    if (EXCLUDE_BASES.has(base)) continue;

    // MUST prefer Spot: the bot's price pipeline only ever reads Bybit Spot
    // tickers, so a linear-only trade symbol would never get live data.
    const tradeSymbol = entry.usdtSpot?.symbol ?? entry.usdtLinear?.symbol ?? null;
    if (!tradeSymbol) continue; // liquid only via USDC/inverse — not tradeable by this bot

    const spotVol = entry.usdtSpot?.vol ?? 0;
    if (!entry.usdtSpot || spotVol < MIN_SPOT_VOLUME_FOR_INCLUSION) continue; // no real Spot pair (or a near-dead one) — unreachable by the bot's price pipeline

    // Rank by total liquidity across all venues (how "hot" the asset is
    // overall) — only the trade symbol SELECTION above needs Spot specifically.
    const tradeableLiquidity = spotVol + (entry.usdtLinear?.vol ?? 0) + entry.usdc + entry.inverse;

    if (tradeableLiquidity >= LIQUID_THRESHOLD) liquid.push({ symbol: tradeSymbol, vol: tradeableLiquidity });
    else if (tradeableLiquidity >= NEAR_THRESHOLD) close.push({ symbol: tradeSymbol, vol: tradeableLiquidity });
  }

  liquid.sort((a, b) => b.vol - a.vol);
  close.sort((a, b) => b.vol - a.vol);

  return {
    liquid: liquid.map((r) => r.symbol),
    close: close.map((r) => r.symbol),
    symbols: [...liquid.map((r) => r.symbol), ...close.map((r) => r.symbol)],
    generatedAt: Date.now()
  };
}

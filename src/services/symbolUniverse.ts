/**
 * Live liquidity-based trading universe — TS port of MISCHAR.py
 * (G:\claude-projects\MISCHAR.py). Sums real Bybit turnover24h across every
 * product type a base asset trades on (spot USDT, linear USDT, linear USDC,
 * inverse) to find genuinely liquid coins, then reports the actual USDT pair
 * the bot can execute on — gated by that pair's OWN volume, not the combined
 * total (a coin whose volume sits mostly in USDC/inverse would otherwise
 * "pass" while its actual USDT pair stays too thin to trade safely).
 */

const BYBIT_PUBLIC_BASE = 'https://api.bybit.com';
const LIQUID_THRESHOLD = 20_000_000;
const NEAR_THRESHOLD = 8_000_000;

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
  if (symbol.endsWith('USDT')) return { base: symbol.slice(0, -4), kind: 'usdt' };
  if (symbol.endsWith('PERP')) return { base: symbol.slice(0, -4), kind: 'usdc' };
  if (symbol.endsWith('USDC')) return { base: symbol.slice(0, -4), kind: 'usdc' };
  if (symbol.endsWith('USD')) return { base: symbol.slice(0, -3), kind: 'inverse' };
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

    const tradeSymbol = entry.usdtLinear?.symbol ?? entry.usdtSpot?.symbol ?? null;
    if (!tradeSymbol) continue; // liquid only via USDC/inverse — not tradeable by this bot

    // Gate on the volume of the pair the bot will actually execute on, not the
    // combined total across product types (§ see module docstring).
    const tradeableLiquidity = entry.usdtLinear ? entry.usdtLinear.vol : (entry.usdtSpot?.vol ?? 0);

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

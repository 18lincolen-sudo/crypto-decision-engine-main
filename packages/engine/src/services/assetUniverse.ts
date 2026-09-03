/**
 * AssetUniverse — Single Source of Truth for Symbol Mapping & Tradable Universe
 * ============================================================================
 * Fixes the "BUSDT / BTCUSDT sent straight to CoinGecko" bug class.
 *
 *      Bybit Symbol  ──▶  Base Asset  ──▶  CoinGecko ID
 *      BTCUSDT             BTC             bitcoin
 *      1000PEPEUSDT        1000PEPE        pepe
 *      BUSDT               B               (null — no mapping)
 *
 * Rules:
 *  1. A CoinGecko ID is NEVER derived by lowercasing a Bybit symbol.
 *  2. When no mapping exists, resolveCoinGeckoId() returns `null`, which callers
 *     must treat as "CoinGecko fallback unavailable" — never as a fatal error.
 *  3. The intraday universe is liquidity-filtered on purpose (§50/§51): a
 *     5–60 minute strategy must not be spread across illiquid altcoins.
 */

export type LiquidityTier = 1 | 2 | 3;

export interface AssetRegistryEntry {
  /** CoinGecko coin id — null when the asset has no verified mapping */
  coinGeckoId: string | null;
  /** 1 = deepest liquidity (majors), 2 = liquid large caps, 3 = everything else */
  tier: LiquidityTier;
  /** Human readable name (logs/UI only) */
  name?: string;
}

/** Quote currency used across the engine */
export const QUOTE_ASSET = 'USDT';

/**
 * Bybit "1000X" / "10000X" style contracts reference the same CoinGecko asset
 * as their un-multiplied base (1000PEPE → pepe).
 */
const MULTIPLIER_PREFIXES = ['1000000', '100000', '10000', '1000'];

export const ASSET_REGISTRY: Record<string, AssetRegistryEntry> = {
  // ── Tier 1 — majors, deepest intraday liquidity ────────────────────────────
  BTC: { coinGeckoId: 'bitcoin', tier: 1, name: 'Bitcoin' },
  ETH: { coinGeckoId: 'ethereum', tier: 1, name: 'Ethereum' },
  SOL: { coinGeckoId: 'solana', tier: 1, name: 'Solana' },
  BNB: { coinGeckoId: 'binancecoin', tier: 1, name: 'BNB' },
  XRP: { coinGeckoId: 'ripple', tier: 1, name: 'XRP' },
  DOGE: { coinGeckoId: 'dogecoin', tier: 1, name: 'Dogecoin' },

  // ── Tier 2 — liquid large caps (optional universe extension) ──────────────
  ADA: { coinGeckoId: 'cardano', tier: 2 },
  AVAX: { coinGeckoId: 'avalanche-2', tier: 2 },
  LINK: { coinGeckoId: 'chainlink', tier: 2 },
  TON: { coinGeckoId: 'the-open-network', tier: 2 },
  TRX: { coinGeckoId: 'tron', tier: 2 },
  LTC: { coinGeckoId: 'litecoin', tier: 2 },
  DOT: { coinGeckoId: 'polkadot', tier: 2 },
  BCH: { coinGeckoId: 'bitcoin-cash', tier: 2 },
  NEAR: { coinGeckoId: 'near', tier: 2 },
  SUI: { coinGeckoId: 'sui', tier: 2 },
  APT: { coinGeckoId: 'aptos', tier: 2 },
  ARB: { coinGeckoId: 'arbitrum', tier: 2 },
  OP: { coinGeckoId: 'optimism', tier: 2 },
  ATOM: { coinGeckoId: 'cosmos', tier: 2 },
  UNI: { coinGeckoId: 'uniswap', tier: 2 },
  FIL: { coinGeckoId: 'filecoin', tier: 2 },
  INJ: { coinGeckoId: 'injective-protocol', tier: 2 },
  TIA: { coinGeckoId: 'celestia', tier: 2 },
  SEI: { coinGeckoId: 'sei-network', tier: 2 },
  WLD: { coinGeckoId: 'worldcoin-wld', tier: 2 },
  ENA: { coinGeckoId: 'ethena', tier: 2 },
  PEPE: { coinGeckoId: 'pepe', tier: 2 },
  SHIB: { coinGeckoId: 'shiba-inu', tier: 2 },
  HBAR: { coinGeckoId: 'hedera-hashgraph', tier: 2 },
  XLM: { coinGeckoId: 'stellar', tier: 2 },
  ETC: { coinGeckoId: 'ethereum-classic', tier: 2 },
  AAVE: { coinGeckoId: 'aave', tier: 2 },
  ICP: { coinGeckoId: 'internet-computer', tier: 2 },

  // ── Tier 3 — analytics / legacy universe (not used for intraday by default) ─
  MATIC: { coinGeckoId: 'matic-network', tier: 3 },
  POL: { coinGeckoId: 'matic-network', tier: 3 },
  IMX: { coinGeckoId: 'immutable-x', tier: 3 },
  MKR: { coinGeckoId: 'maker', tier: 3 },
  GRT: { coinGeckoId: 'the-graph', tier: 3 },
  RNDR: { coinGeckoId: 'render-token', tier: 3 },
  RENDER: { coinGeckoId: 'render-token', tier: 3 },
  FET: { coinGeckoId: 'fetch-ai', tier: 3 },
  THETA: { coinGeckoId: 'theta-token', tier: 3 },
  FTM: { coinGeckoId: 'fantom', tier: 3 },
  ALGO: { coinGeckoId: 'algorand', tier: 3 },
  FLOW: { coinGeckoId: 'flow', tier: 3 },
  AXS: { coinGeckoId: 'axie-infinity', tier: 3 },
  SAND: { coinGeckoId: 'the-sandbox', tier: 3 },
  MANA: { coinGeckoId: 'decentraland', tier: 3 },
  SNX: { coinGeckoId: 'havven', tier: 3 },
  LDO: { coinGeckoId: 'lido-dao', tier: 3 },
  EGLD: { coinGeckoId: 'elrond-erd-2', tier: 3 },
  XTZ: { coinGeckoId: 'tezos', tier: 3 },
  EOS: { coinGeckoId: 'eos', tier: 3 },
  NEO: { coinGeckoId: 'neo', tier: 3 },
  GALA: { coinGeckoId: 'gala', tier: 3 },
  CHZ: { coinGeckoId: 'chiliz', tier: 3 },
  APE: { coinGeckoId: 'apecoin', tier: 3 },
  CRV: { coinGeckoId: 'curve-dao-token', tier: 3 },
  LRC: { coinGeckoId: 'loopring', tier: 3 },
  STX: { coinGeckoId: 'blockstack', tier: 3 },
  MINA: { coinGeckoId: 'mina-protocol', tier: 3 },
  CFX: { coinGeckoId: 'conflux-token', tier: 3 },
  RUNE: { coinGeckoId: 'thorchain', tier: 3 },
  COMP: { coinGeckoId: 'compound-governance-token', tier: 3 },
  DYDX: { coinGeckoId: 'dydx', tier: 3 },
  GMX: { coinGeckoId: 'gmx', tier: 3 },
  KAVA: { coinGeckoId: 'kava', tier: 3 },
  ZIL: { coinGeckoId: 'zilliqa', tier: 3 },
  IOTA: { coinGeckoId: 'iota', tier: 3 },
  CAKE: { coinGeckoId: 'pancakeswap-token', tier: 3 },
  '1INCH': { coinGeckoId: '1inch', tier: 3 },
  MASK: { coinGeckoId: 'mask-network', tier: 3 },
  PENDLE: { coinGeckoId: 'pendle', tier: 3 },
  AR: { coinGeckoId: 'arweave', tier: 3 },
  BLUR: { coinGeckoId: 'blur', tier: 3 },
  WOO: { coinGeckoId: 'woo-network', tier: 3 },
  SKL: { coinGeckoId: 'skale', tier: 3 },
  CELO: { coinGeckoId: 'celo', tier: 3 },
  KSM: { coinGeckoId: 'kusama', tier: 3 },
  ZRX: { coinGeckoId: '0x', tier: 3 },
  YFI: { coinGeckoId: 'yearn-finance', tier: 3 },
  BAT: { coinGeckoId: 'basic-attention-token', tier: 3 },
  ENS: { coinGeckoId: 'ethereum-name-service', tier: 3 },
  SSV: { coinGeckoId: 'ssv-network', tier: 3 },
  ANKR: { coinGeckoId: 'ankr', tier: 3 },
  BAND: { coinGeckoId: 'band-protocol', tier: 3 },
  OGN: { coinGeckoId: 'origin-protocol', tier: 3 },
  ONT: { coinGeckoId: 'ontology', tier: 3 },
  WAVES: { coinGeckoId: 'waves', tier: 3 },
  STORJ: { coinGeckoId: 'storj', tier: 3 },
  ONE: { coinGeckoId: 'harmony', tier: 3 },
  HOT: { coinGeckoId: 'holotoken', tier: 3 },
  IOST: { coinGeckoId: 'iostoken', tier: 3 },
  VET: { coinGeckoId: 'vechain', tier: 3 },
  DASH: { coinGeckoId: 'dash', tier: 3 },
  ZEN: { coinGeckoId: 'zencash', tier: 3 },
  QTUM: { coinGeckoId: 'qtum', tier: 3 },
  ZEC: { coinGeckoId: 'zcash', tier: 3 },
  ICX: { coinGeckoId: 'icon', tier: 3 },
  RVN: { coinGeckoId: 'ravencoin', tier: 3 },
  GLMR: { coinGeckoId: 'moonbeam', tier: 3 },
  BNT: { coinGeckoId: 'bancor', tier: 3 }
};

/** Stablecoins & wrapped duplicates never produce a tradable intraday signal. */
const EXCLUDED_BASES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'BUSD', 'USDE', 'WBTC', 'WETH']);

/**
 * Normalizes any input (Bybit symbol, lowercase base, perp symbol) to a base asset.
 * BTCUSDT → BTC | btc → BTC | BTCUSDT-PERP → BTC | 1000PEPEUSDT → 1000PEPE
 */
export function normalizeSymbolInput(input: string): string {
  if (!input) return '';
  let sym = input.toUpperCase().trim();
  sym = sym.replace(/[-_/]?PERP$/, '');
  sym = sym.replace(/[-_/]/g, '');
  if (sym.endsWith(QUOTE_ASSET) && sym.length > QUOTE_ASSET.length) {
    sym = sym.slice(0, -QUOTE_ASSET.length);
  }
  return sym;
}

/** Strips a Bybit contract multiplier prefix (1000PEPE → PEPE) */
export function stripMultiplier(base: string): string {
  for (const prefix of MULTIPLIER_PREFIXES) {
    if (base.startsWith(prefix) && base.length > prefix.length) {
      return base.slice(prefix.length);
    }
  }
  return base;
}

/** BTC → BTCUSDT (idempotent for symbols already in Bybit form) */
export function toBybitSymbol(input: string): string {
  const base = normalizeSymbolInput(input);
  return base ? `${base}${QUOTE_ASSET}` : '';
}

/** BTCUSDT → BTC */
export function toBaseAsset(input: string): string {
  return normalizeSymbolInput(input);
}

/**
 * Bybit symbol / base asset → CoinGecko coin id, or null when unmapped.
 * NEVER guesses. A null result means "CoinGecko fallback = unavailable".
 */
export function resolveCoinGeckoId(input: string): string | null {
  const base = normalizeSymbolInput(input);
  if (!base || EXCLUDED_BASES.has(base)) return null;
  const direct = ASSET_REGISTRY[base];
  if (direct) return direct.coinGeckoId;
  const stripped = stripMultiplier(base);
  if (stripped !== base && ASSET_REGISTRY[stripped]) return ASSET_REGISTRY[stripped].coinGeckoId;
  return null;
}

export function isMappedAsset(input: string): boolean {
  return resolveCoinGeckoId(input) !== null;
}

export function isExcludedAsset(input: string): boolean {
  return EXCLUDED_BASES.has(normalizeSymbolInput(input));
}

export function getAssetTier(input: string): LiquidityTier | null {
  const base = normalizeSymbolInput(input);
  const entry = ASSET_REGISTRY[base] || ASSET_REGISTRY[stripMultiplier(base)];
  return entry ? entry.tier : null;
}

/** Bases sorted by tier, filtered by max tier */
function basesByTier(maxTier: LiquidityTier): string[] {
  return Object.entries(ASSET_REGISTRY)
    .filter(([base, entry]) => entry.tier <= maxTier && !EXCLUDED_BASES.has(base))
    .sort((a, b) => a[1].tier - b[1].tier || a[0].localeCompare(b[0]))
    .map(([base]) => base);
}

/**
 * §51 — starting universe: the six most liquid Bybit USDT pairs.
 * Short-term trading is executed only where spread and depth support it.
 */
export const INTRADAY_UNIVERSE: string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];

/** Tier 1 + Tier 2 — opt-in extension once the core universe is validated */
export const EXTENDED_INTRADAY_UNIVERSE: string[] = basesByTier(2).map(toBybitSymbol);

/** The full analytics universe (Tier 1-3). NOT the intraday trading universe. */
export const ANALYTICS_UNIVERSE: string[] = basesByTier(3).map(toBybitSymbol);

/**
 * Resolves the trading universe from configuration.
 *  - unset / "core"      → INTRADAY_UNIVERSE (6 majors)
 *  - "extended"          → tier 1 + 2
 *  - "BTCUSDT,ETHUSDT"   → explicit list (validated + normalized)
 */
export function resolveTradingUniverse(raw?: string | null): string[] {
  const value = (raw || '').trim();
  if (!value || value.toLowerCase() === 'core') return [...INTRADAY_UNIVERSE];
  if (value.toLowerCase() === 'extended') return [...EXTENDED_INTRADAY_UNIVERSE];
  const explicit = value
    .split(',')
    .map((s) => toBybitSymbol(s))
    .filter((s) => s.length > QUOTE_ASSET.length && !isExcludedAsset(s));
  return explicit.length ? Array.from(new Set(explicit)) : [...INTRADAY_UNIVERSE];
}

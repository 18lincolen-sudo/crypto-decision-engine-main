// Single source of truth for the base-asset → CoinGecko-id mapping. Used to be
// copy-pasted identically into coinGeckoApi.ts and cryptoPriceAggregator.ts —
// any addition/removal had to be made in both, and they would eventually
// drift out of sync.
// ═══════════════════════════════════════════════════════
// TOP 100 CRYPTO ASSETS — CoinGecko ID Mapping
// Stablecoins (USDT, USDC, DAI, FDUSD, TUSD) EXCLUDED
// ═══════════════════════════════════════════════════════
export const CRYPTO_IDS: Record<string, string> = {
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

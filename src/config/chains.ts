import 'dotenv/config';

export type ChainKey =
  | 'ethereum'
  | 'arbitrum'
  | 'optimism'
  | 'base'
  | 'polygon'
  | 'bsc'
  | 'opbnb'
  | 'avalanche'
  | 'fantom'
  | 'celo'
  | 'linea'
  | 'scroll'
  | 'zksync'
  | 'zora'
  | 'mode'
  | 'blast'
  | 'abstract';

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: number;
  // Ordered list of RPC endpoints. Index 0 is the primary; the discovery
  // layer rotates to the next entry when the current one keeps failing.
  rpcs: string[];
  nativeSymbol: string;
  nativeCoingeckoId: string;
  explorer: string;
  // Multicall3 is deployed at the same address on virtually every EVM chain.
  multicall3: string;
}

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Build the per-chain RPC list. Order of precedence:
//   1. RPC_<KEY>      — user's explicit primary (e.g., paid endpoint)
//   2. RPC_<KEY>_2    — optional user-supplied backup
//   3. RPC_<KEY>_3    — optional user-supplied second backup
//   4. code defaults  — keyless public RPCs verified live on 2026-05-17
// Duplicates are removed while preserving order.
function rpcs(envKey: string, defaults: string[]): string[] {
  const fromEnv = [
    process.env[envKey],
    process.env[`${envKey}_2`],
    process.env[`${envKey}_3`],
  ]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0);
  const merged = [...fromEnv, ...defaults];
  return Array.from(new Set(merged));
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    // Refreshed 2026-05-24 after user reports of Ethereum-side hangs.
    // Live-tested with eth_blockNumber:
    //   publicnode  → 200 ~1.0s  (primary)
    //   blastapi    → 200 ~0.7s  (fastest; new replacement for merkle.io)
    //   drpc        → 200 ~0.7s today, but historically returns 500
    //                  ("eth.drpc.org" ... "500 Internal Server Error") in
    //                  earlier logs — last-resort fallback.
    // Dropped: eth.merkle.io (now sits behind Cloudflare 429 / "error code:
    // 1015" for free traffic), eth.llamarpc.com (525), cloudflare-eth.com
    // ("Cannot fulfill request" -32046), rpc.ankr.com/eth (requires key).
    rpcs: rpcs('RPC_ETHEREUM', [
      'https://ethereum-rpc.publicnode.com',
      'https://eth-mainnet.public.blastapi.io',
      'https://eth.drpc.org',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://etherscan.io',
    multicall3: MULTICALL3,
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    rpcs: rpcs('RPC_ARBITRUM', [
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.drpc.org',
      'https://arb1.arbitrum.io/rpc',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://arbiscan.io',
    multicall3: MULTICALL3,
  },
  optimism: {
    key: 'optimism',
    name: 'Optimism',
    chainId: 10,
    rpcs: rpcs('RPC_OPTIMISM', [
      'https://optimism-rpc.publicnode.com',
      'https://optimism.drpc.org',
      'https://op-pokt.nodies.app',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://optimistic.etherscan.io',
    multicall3: MULTICALL3,
  },
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    rpcs: rpcs('RPC_BASE', [
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
      'https://mainnet.base.org',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://basescan.org',
    multicall3: MULTICALL3,
  },
  polygon: {
    key: 'polygon',
    name: 'Polygon',
    chainId: 137,
    rpcs: rpcs('RPC_POLYGON', [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.drpc.org',
      'https://gateway.tenderly.co/public/polygon',
    ]),
    nativeSymbol: 'POL',
    // MATIC was renamed to POL in 2024; CoinGecko canonical id is now
    // polygon-ecosystem-token (matic-network was deprecated).
    nativeCoingeckoId: 'polygon-ecosystem-token',
    explorer: 'https://polygonscan.com',
    multicall3: MULTICALL3,
  },
  bsc: {
    key: 'bsc',
    name: 'BNB Smart Chain',
    chainId: 56,
    // drpc.org moved BSC behind a paid tier in 2026 — its free tier returns
    // HTTP 408 "Request timeout on the free tier, please upgrade your tier
    // to the paid one" within seconds. Our rotator falls past it but it
    // bleeds 5-10s per wallet on cold rotation. Dropped from defaults
    // 2026-05-24. Replaced with binance's own ninicoin mirror + bnbchain
    // dataseed as a third option.
    rpcs: rpcs('RPC_BSC', [
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed1.ninicoin.io',
      'https://bsc-dataseed1.bnbchain.org',
    ]),
    nativeSymbol: 'BNB',
    nativeCoingeckoId: 'binancecoin',
    explorer: 'https://bscscan.com',
    multicall3: MULTICALL3,
  },
  opbnb: {
    key: 'opbnb',
    name: 'opBNB',
    chainId: 204,
    rpcs: rpcs('RPC_OPBNB', [
      'https://opbnb-rpc.publicnode.com',
      'https://opbnb.drpc.org',
      'https://opbnb-mainnet-rpc.bnbchain.org',
    ]),
    nativeSymbol: 'BNB',
    nativeCoingeckoId: 'binancecoin',
    explorer: 'https://opbnbscan.com',
    multicall3: MULTICALL3,
  },
  avalanche: {
    key: 'avalanche',
    name: 'Avalanche C-Chain',
    chainId: 43114,
    rpcs: rpcs('RPC_AVALANCHE', [
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://avalanche.drpc.org',
      'https://api.avax.network/ext/bc/C/rpc',
    ]),
    nativeSymbol: 'AVAX',
    nativeCoingeckoId: 'avalanche-2',
    explorer: 'https://snowtrace.io',
    multicall3: MULTICALL3,
  },
  fantom: {
    key: 'fantom',
    name: 'Fantom',
    chainId: 250,
    // Fantom public RPCs have been musical-chairs in 2025–26:
    //   publicnode  → 403 "unsupported platform"
    //   ankr        → 401, demands an API key
    //   1rpc.io/ftm → 503 / fetch failed
    //   drpc.org    → HTTP 400
    // Only the Fantom Foundation's own rpcN.fantom.network family answers
    // keylessly in 2026-05; we use three of them for redundancy.
    rpcs: rpcs('RPC_FANTOM', [
      'https://rpcapi.fantom.network',
      'https://rpc2.fantom.network',
      'https://rpc3.fantom.network',
    ]),
    nativeSymbol: 'FTM',
    nativeCoingeckoId: 'fantom',
    explorer: 'https://ftmscan.com',
    multicall3: MULTICALL3,
  },
  celo: {
    key: 'celo',
    name: 'Celo',
    chainId: 42220,
    rpcs: rpcs('RPC_CELO', [
      'https://forno.celo.org',
      'https://celo.drpc.org',
      'https://celo-rpc.publicnode.com',
    ]),
    nativeSymbol: 'CELO',
    nativeCoingeckoId: 'celo',
    explorer: 'https://celoscan.io',
    multicall3: MULTICALL3,
  },
  linea: {
    key: 'linea',
    name: 'Linea',
    chainId: 59144,
    rpcs: rpcs('RPC_LINEA', [
      'https://rpc.linea.build',
      'https://linea.drpc.org',
      'https://linea-rpc.publicnode.com',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://lineascan.build',
    multicall3: MULTICALL3,
  },
  scroll: {
    key: 'scroll',
    name: 'Scroll',
    chainId: 534352,
    rpcs: rpcs('RPC_SCROLL', [
      'https://rpc.scroll.io',
      'https://scroll.drpc.org',
      'https://scroll-rpc.publicnode.com',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://scrollscan.com',
    multicall3: MULTICALL3,
  },
  zksync: {
    key: 'zksync',
    name: 'zkSync Era',
    chainId: 324,
    // zkSync is finicky: publicnode/meowrpc return 404, blastapi/1rpc/
    // omniatech/blockpi all 4xx-5xx. drpc and Matter Labs's own endpoint
    // work, plus thirdweb's chainId-prefixed mirror as a third option.
    rpcs: rpcs('RPC_ZKSYNC', [
      'https://mainnet.era.zksync.io',
      'https://zksync.drpc.org',
      'https://324.rpc.thirdweb.com',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://explorer.zksync.io',
    multicall3: MULTICALL3,
  },
  zora: {
    key: 'zora',
    name: 'Zora',
    chainId: 7777777,
    rpcs: rpcs('RPC_ZORA', [
      'https://rpc.zora.energy',
      'https://zora.drpc.org',
      'https://7777777.rpc.thirdweb.com',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://explorer.zora.energy',
    multicall3: MULTICALL3,
  },
  mode: {
    key: 'mode',
    name: 'Mode',
    chainId: 34443,
    rpcs: rpcs('RPC_MODE', [
      'https://mainnet.mode.network',
      'https://mode.drpc.org',
      'https://34443.rpc.thirdweb.com',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://explorer.mode.network',
    multicall3: MULTICALL3,
  },
  blast: {
    key: 'blast',
    name: 'Blast',
    chainId: 81457,
    rpcs: rpcs('RPC_BLAST', [
      'https://rpc.blast.io',
      'https://blast.drpc.org',
      'https://blast-rpc.publicnode.com',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://blastscan.io',
    multicall3: MULTICALL3,
  },
  abstract: {
    key: 'abstract',
    name: 'Abstract',
    chainId: 2741,
    rpcs: rpcs('RPC_ABSTRACT', [
      'https://api.mainnet.abs.xyz',
      'https://abstract.drpc.org',
      'https://2741.rpc.thirdweb.com',
    ]),
    nativeSymbol: 'ETH',
    nativeCoingeckoId: 'ethereum',
    explorer: 'https://abscan.org',
    multicall3: MULTICALL3,
  },
};

export const ALL_CHAIN_KEYS = Object.keys(CHAINS) as ChainKey[];

export function chainByChainId(chainId: number): ChainConfig | undefined {
  return Object.values(CHAINS).find((c) => c.chainId === chainId);
}

// Solana: list of RPC endpoints in priority order. Rotation happens inside
// flow/solana.ts when one hits 429. We can only ship `api.mainnet-beta` as a
// default — every other "public keyless" Solana RPC tested 2026-05 rejects
// the heavy `getTokenAccountsByOwner` method (publicnode/drpc/ankr/blastapi/
// extrnode/shyft → 401/403). For any non-trivial wallet count the user MUST
// supply a paid endpoint via `RPC_SOLANA=` — see .env.example for the free
// Helius signup link.
function solanaRpcs(): string[] {
  const fromEnv = [
    process.env.RPC_SOLANA,
    process.env.RPC_SOLANA_2,
    process.env.RPC_SOLANA_3,
  ]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0);
  const defaults = ['https://api.mainnet-beta.solana.com'];
  return Array.from(new Set([...fromEnv, ...defaults]));
}
export const SOLANA_RPCS = solanaRpcs();
export const SOLANA_RPC = SOLANA_RPCS[0];

// Destination chains allowed for the bridge step.
export function destChains(): ChainKey[] {
  const raw = (process.env.DEST_CHAINS || 'arbitrum,base').toLowerCase();
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ChainKey => s in CHAINS);
  if (parsed.length === 0) {
    throw new Error(`DEST_CHAINS env is empty or contains no known chains: "${raw}"`);
  }
  return parsed;
}

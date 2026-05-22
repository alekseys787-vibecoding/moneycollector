import fs from 'fs';
import path from 'path';
import { ChainKey, ALL_CHAIN_KEYS } from './chains';

export interface TokenInfo {
  address: string; // checksum or lower, normalised to lower at load
  symbol: string;
  decimals: number;
}

// Curated short list of high-liquidity tokens per chain.
// Extend via data/custom-tokens.json — that file is merged in at load time.
const BUILTIN: Record<ChainKey, TokenInfo[]> = {
  ethereum: [
    { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 },
    { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', decimals: 18 },
    { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18 },
    { address: '0x514910771af9ca656af840dff83e8264ecf986ca', symbol: 'LINK', decimals: 18 },
    { address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', symbol: 'UNI', decimals: 18 },
    { address: '0x4d224452801aced8b2f0aebe155379bb5d594381', symbol: 'APE', decimals: 18 },
    { address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', symbol: 'PEPE', decimals: 18 },
    { address: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', symbol: 'SHIB', decimals: 18 },
    { address: '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1', symbol: 'ARB', decimals: 18 },
    { address: '0xca14007eff0db1f8135f4c25b34de49ab0d42766', symbol: 'STRK', decimals: 18 },
    { address: '0x57e114b691db790c35207b2e685d4a43181e6061', symbol: 'ENA', decimals: 18 },
    { address: '0x6810e776880c02933d47db1b9fc05908e5386b96', symbol: 'GNO', decimals: 18 },
  ],
  arbitrum: [
    { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', symbol: 'USDC.e', decimals: 6 },
    { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USDT', decimals: 6 },
    { address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', symbol: 'DAI', decimals: 18 },
    { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', symbol: 'WETH', decimals: 18 },
    { address: '0x912ce59144191c1204e64559fe8253a0e49e6548', symbol: 'ARB', decimals: 18 },
    { address: '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a', symbol: 'GMX', decimals: 18 },
    { address: '0x539bde0d7dbd336b79148aa742883198bbf60342', symbol: 'MAGIC', decimals: 18 },
  ],
  optimism: [
    { address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', symbol: 'USDC', decimals: 6 },
    { address: '0x7f5c764cbc14f9669b88837ca1490cca17c31607', symbol: 'USDC.e', decimals: 6 },
    { address: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', symbol: 'USDT', decimals: 6 },
    { address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', symbol: 'DAI', decimals: 18 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    { address: '0x4200000000000000000000000000000000000042', symbol: 'OP', decimals: 18 },
    { address: '0x6fd9d7ad17242c41f7131d257212c54a0e816691', symbol: 'UNI', decimals: 18 },
  ],
  base: [
    { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    { address: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', symbol: 'USDbC', decimals: 6 },
    { address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', symbol: 'DAI', decimals: 18 },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    { address: '0x532f27101965dd16442e59d40670faf5ebb142e4', symbol: 'BRETT', decimals: 18 },
    { address: '0x9a26f5433671751c3276a065f57e5a02d2817973', symbol: 'KEYCAT', decimals: 18 },
  ],
  polygon: [
    { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', symbol: 'USDC', decimals: 6 },
    { address: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', symbol: 'USDC.e', decimals: 6 },
    { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', symbol: 'USDT', decimals: 6 },
    { address: '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', symbol: 'DAI', decimals: 18 },
    { address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', symbol: 'WMATIC', decimals: 18 },
    { address: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', symbol: 'WETH', decimals: 18 },
    { address: '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', symbol: 'WBTC', decimals: 8 },
  ],
  bsc: [
    { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18 },
    { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18 },
    { address: '0xe9e7cea3dedca5984780bafc599bd69add087d56', symbol: 'BUSD', decimals: 18 },
    { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18 },
    { address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', symbol: 'CAKE', decimals: 18 },
  ],
  opbnb: [
    // OP-stack canonical WETH-slot is used for WBNB here.
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WBNB', decimals: 18 },
    { address: '0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3', symbol: 'USDT', decimals: 18 },
    { address: '0x9c6fc5bf860a4a012c9de812002dc4d3424c0fbc', symbol: 'FDUSD', decimals: 18 },
    // Ecosystem is thin — extend via data/custom-tokens.json if needed.
  ],
  avalanche: [
    { address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', symbol: 'USDC', decimals: 6 },
    { address: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', symbol: 'USDT', decimals: 6 },
    { address: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', symbol: 'WAVAX', decimals: 18 },
    { address: '0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd', symbol: 'JOE', decimals: 18 },
  ],
  fantom: [
    { address: '0x04068da6c83afcfa0e13ba15a6696662335d5b75', symbol: 'USDC', decimals: 6 },
    { address: '0x049d68029688eabf473097a2fc38ef61633a3c7a', symbol: 'fUSDT', decimals: 6 },
    { address: '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83', symbol: 'WFTM', decimals: 18 },
  ],
  celo: [
    { address: '0x765de816845861e75a25fca122bb6898b8b1282a', symbol: 'cUSD', decimals: 18 },
    { address: '0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73', symbol: 'cEUR', decimals: 18 },
    { address: '0x471ece3750da237f93b8e339c536989b8978a438', symbol: 'CELO', decimals: 18 },
  ],
  linea: [
    { address: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', symbol: 'USDC', decimals: 6 },
    { address: '0xa219439258ca9da29e9cc4ce5596924745e12b93', symbol: 'USDT', decimals: 6 },
    { address: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', symbol: 'WETH', decimals: 18 },
  ],
  scroll: [
    { address: '0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4', symbol: 'USDC', decimals: 6 },
    { address: '0xf55bec9cafdbe8730f096aa55dad6d22d44099df', symbol: 'USDT', decimals: 6 },
    { address: '0x5300000000000000000000000000000000000004', symbol: 'WETH', decimals: 18 },
  ],
  zksync: [
    // Native Circle USDC on zkSync Era.
    { address: '0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4', symbol: 'USDC', decimals: 6 },
    // Bridged USDC.e (legacy).
    { address: '0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4', symbol: 'USDC.e', decimals: 6 },
    { address: '0x493257fd37edb34451f62edf8d2a0c418852ba4c', symbol: 'USDT', decimals: 6 },
    { address: '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91', symbol: 'WETH', decimals: 18 },
    { address: '0x5a7d6b2f92c77fad6ccabd7ee0624e64907eaf3e', symbol: 'ZK', decimals: 18 },
  ],
  zora: [
    // Zora is mostly ETH-only. WETH at the canonical OP-stack address.
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
  ],
  mode: [
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    { address: '0xd988097fb8612cc24eec14542bc03424c656005f', symbol: 'USDC', decimals: 6 },
    { address: '0xf0f161fda2712db8b566946122a5af183995e2ed', symbol: 'USDT', decimals: 6 },
    { address: '0xdfc7c877a950e49d2610114102175a06c2e3167a', symbol: 'MODE', decimals: 18 },
  ],
  blast: [
    { address: '0x4300000000000000000000000000000000000004', symbol: 'WETH', decimals: 18 },
    { address: '0x4300000000000000000000000000000000000003', symbol: 'USDB', decimals: 18 },
    { address: '0xb1a5700fa2358173fe465e6ea4ff52e36e88e2ad', symbol: 'BLAST', decimals: 18 },
  ],
  abstract: [
    // Abstract is new; few canonical ERC20s. Mostly native ETH at launch.
    // Add via custom-tokens.json once the ecosystem grows.
  ],
};

interface CustomTokensFile {
  // chainKey -> array of TokenInfo
  [chain: string]: TokenInfo[];
}

let CACHED: Record<ChainKey, TokenInfo[]> | null = null;

// Drop the in-memory merged-tokens cache. Call this AFTER mutating
// data/custom-tokens.json (e.g. from the wizard's "Manage custom EVM
// tokens" submenu) so the next loadTokens() picks up the new entries.
export function clearTokensCache(): void {
  CACHED = null;
}

export function loadTokens(): Record<ChainKey, TokenInfo[]> {
  if (CACHED) return CACHED;
  const merged: Record<ChainKey, TokenInfo[]> = {} as any;
  for (const k of ALL_CHAIN_KEYS) merged[k] = [...BUILTIN[k]];

  const customPath = path.resolve(process.cwd(), 'data', 'custom-tokens.json');
  if (fs.existsSync(customPath)) {
    try {
      const raw = fs.readFileSync(customPath, 'utf8');
      const parsed = JSON.parse(raw) as CustomTokensFile;
      for (const k of ALL_CHAIN_KEYS) {
        const extra = parsed[k];
        if (Array.isArray(extra)) merged[k].push(...extra);
      }
    } catch (e: any) {
      console.warn(`[tokens] failed to parse custom-tokens.json: ${e.message}`);
    }
  }

  // Normalise + dedupe by address (lower-case).
  for (const k of ALL_CHAIN_KEYS) {
    const seen = new Set<string>();
    const out: TokenInfo[] = [];
    for (const t of merged[k]) {
      const addr = t.address.toLowerCase();
      if (seen.has(addr)) continue;
      seen.add(addr);
      out.push({ ...t, address: addr });
    }
    merged[k] = out;
  }

  CACHED = merged;
  return merged;
}

// Register a token at runtime (used by protocol adapters that "free" a token
// from a stuck position — e.g., Koi LP exit → token0/token1 dropped into the
// wallet — so the subsequent sweep finds it via multicall balanceOf without
// the user having to edit data/custom-tokens.json).
//
// Mutates the cached map in place; later loadTokens() calls see it.
export function registerExtraToken(chain: ChainKey, token: TokenInfo): void {
  const all = loadTokens();
  const addr = token.address.toLowerCase();
  if (all[chain].some((t) => t.address === addr)) return;
  all[chain].push({ address: addr, symbol: token.symbol, decimals: token.decimals });
}

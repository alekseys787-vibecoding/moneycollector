import { retry, withTimeout } from './retry';
import { log } from './logger';

// Tiny CoinGecko client. Free, no API key, ~10-30 req/min limit.
// We only call this for native-coin USD prices (to estimate gas cost in USD).
// Cached in-memory for the lifetime of the run.

const CACHE = new Map<string, { v: number; t: number }>();
// Positive cache TTL: 30 min. Native prices drift slowly; over a single sweep
// session (typically a few minutes to an hour) one fetch per coin is plenty.
// Longer than the old 5 min so concurrent sweeps don't all miss on cold cache.
const TTL_MS = 30 * 60 * 1000;
// Negative cache: when CoinGecko rate-limits us (429) or otherwise fails, we
// pin "null for this id" for 90s so multiple parallel sweepers don't keep
// hammering the same blocked endpoint and spamming the log. 90s aligns with
// CoinGecko's published free-tier reset window.
const NEG_CACHE = new Map<string, number>(); // id -> earliest retry timestamp
const NEG_TTL_MS = 90 * 1000;
// In-flight request coalescing: when N concurrent callers want the same id
// they share a single fetch instead of firing N parallel requests. This was
// the root cause of the "binancecoin/avalanche-2/fantom 429 × 4" log spam —
// concurrency=4 fired 4 simultaneous identical requests every time.
const IN_FLIGHT = new Map<string, Promise<number | null>>();

export async function getUsdPrice(coingeckoId: string): Promise<number> {
  const v = await getUsdPriceOrNull(coingeckoId);
  if (v == null) throw new Error(`coingecko: no price for ${coingeckoId}`);
  return v;
}

// Returns null on failure instead of throwing. Use this in non-critical code
// paths (logging, gas estimation) so a single missing price doesn't take down
// a whole sweep run.
export async function getUsdPriceOrNull(coingeckoId: string): Promise<number | null> {
  const hit = CACHE.get(coingeckoId);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;

  const negUntil = NEG_CACHE.get(coingeckoId);
  if (negUntil && Date.now() < negUntil) return null;

  const inflight = IN_FLIGHT.get(coingeckoId);
  if (inflight) return inflight;

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    coingeckoId,
  )}&vs_currencies=usd`;
  const promise = (async () => {
    try {
      const v = await retry(
        async () => {
          const res = await withTimeout(
            fetch(url, { headers: { accept: 'application/json' } }),
            10_000,
            'coingecko',
          );
          if (!res.ok) throw new Error(`coingecko ${res.status}`);
          const j: any = await res.json();
          const p = j?.[coingeckoId]?.usd;
          if (typeof p !== 'number') throw new Error(`coingecko: no price for ${coingeckoId}`);
          return p;
        },
        { attempts: 2, baseMs: 600 },
      );
      CACHE.set(coingeckoId, { v, t: Date.now() });
      NEG_CACHE.delete(coingeckoId);
      return v;
    } catch (e: any) {
      // One warning per (id, ~negative-window) is enough.
      log.warn(`prices: ${coingeckoId} unavailable (${e.message})`);
      NEG_CACHE.set(coingeckoId, Date.now() + NEG_TTL_MS);
      return null;
    } finally {
      IN_FLIGHT.delete(coingeckoId);
    }
  })();
  IN_FLIGHT.set(coingeckoId, promise);
  return promise;
}

// CoinGecko "asset platform" IDs, keyed by our ChainKey. Used by the
// /simple/token_price/<platform> endpoint for contract-based price lookup.
// Omitted entries mean "no reliable CG coverage for this chain" — we just
// return no price for those, gracefully.
const CG_PLATFORM: Record<string, string> = {
  ethereum: 'ethereum',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  base: 'base',
  polygon: 'polygon-pos',
  bsc: 'binance-smart-chain',
  avalanche: 'avalanche',
  fantom: 'fantom',
  celo: 'celo',
  linea: 'linea',
  scroll: 'scroll',
  zksync: 'zksync',
  zora: 'zora-network',
  mode: 'mode',
  blast: 'blast',
};

// Heuristics first — they're free and cover ~95% of LP-pair tokens.
const STABLECOIN_SYMBOLS = new Set([
  'USDT', 'USDC', 'USDC.e', 'USDbC', 'DAI', 'BUSD', 'cUSD', 'cEUR',
  'USDB', 'FDUSD', 'fUSDT', 'USDe',
]);

// Wrapped-native and chain-native symbols → CoinGecko's "coin" id (works with
// the free /simple/price endpoint, which is much less restricted than the
// contract-based endpoint).
const SYMBOL_TO_CGID: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'ethereum',
  BNB: 'binancecoin',
  WBNB: 'binancecoin',
  AVAX: 'avalanche-2',
  WAVAX: 'avalanche-2',
  FTM: 'fantom',
  WFTM: 'fantom',
  MATIC: 'polygon-ecosystem-token',
  POL: 'polygon-ecosystem-token',
  WMATIC: 'polygon-ecosystem-token',
  CELO: 'celo',
  ZK: 'zksync',
  ARB: 'arbitrum',
  OP: 'optimism',
  GMX: 'gmx',
  UNI: 'uniswap',
};

// Resolve a single (symbol, contract address) on a chain to its USD price.
// Tries cheap routes first:
//   1. Stablecoin symbol → $1.00 (zero API cost)
//   2. Known wrapped-native symbol → /simple/price by coingecko id (batched
//      via the existing CACHE; multiple wallets calling for WETH only fetch
//      once per TTL).
//   3. Per-contract /simple/token_price/<platform> — last resort, one address
//      per request because CoinGecko's free tier now caps it at 1 contract.
// Returns null when no route succeeded.
export async function priceUnderlyingUsd(
  chainKey: string,
  symbol: string,
  address: string,
): Promise<number | null> {
  if (STABLECOIN_SYMBOLS.has(symbol)) return 1.0;
  const cgId = SYMBOL_TO_CGID[symbol];
  if (cgId) {
    const p = await getUsdPriceOrNull(cgId);
    if (p != null) return p;
  }
  const platform = CG_PLATFORM[chainKey];
  if (!platform) return null;
  const lower = address.toLowerCase();
  const cacheKey = `tok:${platform}:${lower}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.t < TTL_MS) return cached.v;

  const url =
    `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
    `?contract_addresses=${encodeURIComponent(lower)}&vs_currencies=usd`;
  try {
    const res = await withTimeout(
      fetch(url, { headers: { accept: 'application/json' } }),
      10_000,
      `coingecko token_price ${platform}`,
    );
    if (!res.ok) {
      log.warn(`prices: ${symbol}@${platform} HTTP ${res.status}`);
      return null;
    }
    const j: any = await res.json();
    const p = j?.[lower]?.usd;
    if (typeof p === 'number') {
      CACHE.set(cacheKey, { v: p, t: Date.now() });
      return p;
    }
  } catch (e: any) {
    log.warn(`prices: ${symbol}@${platform} fetch failed: ${e.message}`);
  }
  return null;
}

export async function getUsdPricesMany(ids: string[]): Promise<Record<string, number>> {
  const fresh = ids.filter((id) => {
    const c = CACHE.get(id);
    return !c || Date.now() - c.t >= TTL_MS;
  });
  if (fresh.length > 0) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
      fresh.join(','),
    )}&vs_currencies=usd`;
    try {
      const res = await withTimeout(
        fetch(url, { headers: { accept: 'application/json' } }),
        10_000,
        'coingecko batch',
      );
      if (!res.ok) throw new Error(`coingecko ${res.status}`);
      const j: any = await res.json();
      for (const id of fresh) {
        const p = j?.[id]?.usd;
        if (typeof p === 'number') CACHE.set(id, { v: p, t: Date.now() });
      }
    } catch (e: any) {
      log.warn(`prices: batch fetch failed: ${e.message}`);
    }
  }
  const out: Record<string, number> = {};
  for (const id of ids) {
    const c = CACHE.get(id);
    if (c) out[id] = c.v;
  }
  return out;
}

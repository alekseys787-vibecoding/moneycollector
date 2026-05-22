import { ChainKey } from '../config/chains';
import { EvmAccount } from '../wallet/derive';

// A position is a generic "stuck balance" — staked LP, unclaimed reward,
// open V3 NFT, etc. The adapter that produced it owns `data`'s shape.
export interface Position {
  protocol: string;       // adapter name, e.g. 'koi-v2'
  chain: ChainKey;
  description: string;    // human-readable, for logs
  // Optional underlying-value summary. Adapters populate `underlying` when
  // they can derive it cheaply (V2 LP share-of-reserves is trivial; V3 needs
  // off-chain tick math and is OK to omit). USD totalling is done by the
  // runner so adapters don't all need to know about CoinGecko.
  value?: {
    underlying: { symbol: string; address: string; amountHuman: number; decimals: number }[];
    usdTotal: number | null;
  };
  data: unknown;          // adapter-specific payload (tokenId, pool, etc.)
}

export interface FreedToken {
  address: string;        // ERC20 contract address (lower-case)
  symbol: string;
  decimals: number;
}

export interface ExitResult {
  ok: boolean;
  txHashes: string[];
  // ERC20s that the exit released into the wallet, so the orchestrator can
  // register them with tokens.ts and let the normal sweep pick them up.
  freedTokens?: FreedToken[];
  // If the exit also left native balance on the wallet (e.g., unwrapped ETH),
  // mention it in a freedNative log line. The native sweep already covers it.
  freedNativeWei?: bigint;
  error?: string;
}

export interface ProtocolAdapter {
  // Stable short name; used in logs and as the namespace for memories about
  // adapter-specific quirks. Lowercase, no spaces.
  name: string;
  // Chains this adapter can scan. Phase 0 intersects with the caller's
  // requested chain list before invoking scan().
  chains: ChainKey[];
  // Read-only enumeration of the wallet's positions across the given chains.
  // MUST NOT submit transactions. Failures should throw or return [].
  scan(address: string, chains: ChainKey[]): Promise<Position[]>;
  // Submits whatever transactions are needed to close the position and
  // return the underlying tokens to the wallet. Each call processes ONE
  // position. Idempotency is the adapter's responsibility (e.g., if liquidity
  // is already 0, just call collect()).
  exit(wallet: EvmAccount, position: Position): Promise<ExitResult>;
}

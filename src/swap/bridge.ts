// Bridge dispatcher. Picks Relay / LI.FI / Squid based on source chain.
//
// Why three providers:
//   - Relay.link is the default — cheapest, broadest L2/L1 coverage.
//   - LI.FI (li.quest) covers opBNB which Relay rejects with "Origin chain
//     204 not supported".
//   - Squid (Axelar) covers Fantom Opera (chainId 250): Relay never
//     supported it, LI.FI silently removed it from `fromChain` allowed-list
//     in 2026 after liquidity migrated to Sonic. Squid is the only remaining
//     aggregator that still routes FTM → ETH on Base/Arbitrum.
//
// Squid requires a registered x-integrator-id (apply at
// squidrouter.typeform.com/integrator-id, ~24h). Set SQUID_INTEGRATOR_ID in
// .env. Until you do, Fantom calls here throw a clean error which the
// per-token try/catch in trySwapAndBridge catches as a normal "skip" — the
// rest of the sweep keeps working.

import { Wallet } from 'ethers';
import { ChainConfig, ChainKey } from '../config/chains';
import * as relay from './relay';
import * as lifi from './lifi';
import * as squid from './squid';

export const NATIVE_ADDR = relay.NATIVE_ADDR;

// Per-source-chain routing override. Chains not listed default to Relay.
// Verify with a live $1 quote before adding a new entry.
const BRIDGE_ROUTE_BY_SRC_CHAIN: Partial<Record<ChainKey, 'relay' | 'lifi' | 'squid'>> = {
  opbnb: 'lifi',
  fantom: 'squid',
};

export interface BridgeQuoteParams {
  srcChain: ChainConfig;
  destChain: ChainConfig;
  user: string;
  recipient: string;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  slippageBps?: number;
}

export type UnifiedQuote =
  | { provider: 'relay'; quote: relay.RelayQuote }
  | { provider: 'lifi'; quote: lifi.LifiQuote }
  | { provider: 'squid'; quote: squid.SquidQuote };

export async function bridgeQuote(p: BridgeQuoteParams): Promise<UnifiedQuote> {
  const route = BRIDGE_ROUTE_BY_SRC_CHAIN[p.srcChain.key] ?? 'relay';
  switch (route) {
    case 'squid': {
      const q = await squid.squidQuote({
        fromChain: p.srcChain.chainId,
        toChain: p.destChain.chainId,
        fromToken: p.originCurrency,
        toToken: p.destinationCurrency,
        fromAddress: p.user,
        toAddress: p.recipient,
        fromAmount: p.amount,
        slippageBps: p.slippageBps,
      });
      return { provider: 'squid', quote: q };
    }
    case 'lifi': {
      const q = await lifi.lifiQuote({
        fromChain: p.srcChain.chainId,
        toChain: p.destChain.chainId,
        fromToken: p.originCurrency,
        toToken: p.destinationCurrency,
        fromAddress: p.user,
        toAddress: p.recipient,
        fromAmount: p.amount,
        slippageBps: p.slippageBps,
      });
      return { provider: 'lifi', quote: q };
    }
    case 'relay':
    default: {
      const q = await relay.relayQuote({
        user: p.user,
        recipient: p.recipient,
        originChainId: p.srcChain.chainId,
        destinationChainId: p.destChain.chainId,
        originCurrency: p.originCurrency,
        destinationCurrency: p.destinationCurrency,
        amount: p.amount,
        slippageBps: p.slippageBps,
      });
      return { provider: 'relay', quote: q };
    }
  }
}

export function summarise(q: UnifiedQuote): relay.QuoteSummary {
  switch (q.provider) {
    case 'squid': return squid.summariseSquid(q.quote);
    case 'lifi':  return lifi.summariseLifi(q.quote);
    case 'relay': return relay.summarise(q.quote);
  }
}

export async function predictUpfrontWei(
  q: UnifiedQuote,
  chainKey: ChainKey,
): Promise<bigint> {
  switch (q.provider) {
    case 'squid': return squid.predictSquidUpfrontWei(q.quote, chainKey);
    case 'lifi':  return lifi.predictLifiUpfrontWei(q.quote, chainKey);
    case 'relay': return relay.predictUpfrontWei(q.quote, chainKey);
  }
}

export async function executeQuote(
  q: UnifiedQuote,
  signer: Wallet,
  chain: ChainConfig,
): Promise<{ txHashes: string[] }> {
  switch (q.provider) {
    case 'squid': return squid.executeSquidQuote(q.quote, signer, chain);
    case 'lifi':  return lifi.executeLifiQuote(q.quote, signer, chain);
    case 'relay': return relay.executeQuote(q.quote, signer, chain);
  }
}

// Bridge dispatcher. Picks Relay or LI.FI based on source chain.
//
// Why: Relay doesn't route opBNB (returns "Origin chain 204 not supported")
// and has historically dropped Fantom too. LI.FI's public v1 API covers
// both. For chains Relay handles, we stay on Relay (better quotes, fewer
// route hops).

import { Wallet } from 'ethers';
import { ChainConfig, ChainKey } from '../config/chains';
import * as relay from './relay';
import * as lifi from './lifi';

export const NATIVE_ADDR = relay.NATIVE_ADDR;

// Chains that Relay.link does NOT support as ORIGIN — we route them through
// LI.FI (li.quest) instead. Both have been verified live with small test
// quotes from real wallets.
// - opbnb (chainId 204): Relay returns "Origin chain 204 not supported"
// - fantom (chainId 250): same — Relay returns "Origin chain 250 not supported"
const LIFI_FORCED_CHAINS = new Set<ChainKey>(['opbnb', 'fantom']);

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
  | { provider: 'lifi'; quote: lifi.LifiQuote };

export async function bridgeQuote(p: BridgeQuoteParams): Promise<UnifiedQuote> {
  if (LIFI_FORCED_CHAINS.has(p.srcChain.key)) {
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

export function summarise(q: UnifiedQuote): relay.QuoteSummary {
  return q.provider === 'lifi'
    ? lifi.summariseLifi(q.quote)
    : relay.summarise(q.quote);
}

export async function predictUpfrontWei(
  q: UnifiedQuote,
  chainKey: ChainKey,
): Promise<bigint> {
  return q.provider === 'lifi'
    ? lifi.predictLifiUpfrontWei(q.quote, chainKey)
    : relay.predictUpfrontWei(q.quote, chainKey);
}

export async function executeQuote(
  q: UnifiedQuote,
  signer: Wallet,
  chain: ChainConfig,
): Promise<{ txHashes: string[] }> {
  return q.provider === 'lifi'
    ? lifi.executeLifiQuote(q.quote, signer, chain)
    : relay.executeQuote(q.quote, signer, chain);
}

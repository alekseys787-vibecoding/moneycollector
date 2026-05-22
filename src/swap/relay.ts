import { Wallet, TransactionRequest } from 'ethers';
import { ChainConfig, ChainKey } from '../config/chains';
import { noteRpcFailure, rpcRetry, waitForTxWithRotation } from '../discovery/evm';
import { retry, sleep, withTimeout } from '../utils/retry';
import { log } from '../utils/logger';

// Relay.link public API. See: https://docs.relay.link
// We use POST /quote to get a quote + executable steps, then run each step.
//
// Response shape (loosely typed because Relay iterates on it):
//   { steps: Step[], fees: {...}, details: { currencyIn, currencyOut, totalImpact, rate } }
//
// Each Step has an `items` array; each item has `data` with from/to/value/data
// describing one EVM transaction to send. We send them in order.

export const NATIVE_ADDR = '0x0000000000000000000000000000000000000000';
const RELAY_BASE = 'https://api.relay.link';

interface RelayMoney {
  amount?: string;
  amountFormatted?: string;
  amountUsd?: string;
  currency?: { symbol?: string; decimals?: number; address?: string };
}

interface RelayStepItem {
  status?: string;
  data?: {
    from: string;
    to: string;
    value?: string;
    data?: string;
    chainId?: number;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    gas?: string;
  };
  check?: { endpoint?: string; method?: string };
}

interface RelayStep {
  id?: string;
  action?: string;
  kind?: string;
  items?: RelayStepItem[];
}

export interface RelayQuote {
  steps: RelayStep[];
  fees?: {
    gas?: RelayMoney;
    relayer?: RelayMoney;
    relayerGas?: RelayMoney;
    relayerService?: RelayMoney;
    app?: RelayMoney;
  };
  details?: {
    currencyIn?: RelayMoney;
    currencyOut?: RelayMoney;
    totalImpact?: { usd?: string; percent?: string };
    rate?: string;
  };
  // For diagnostics on errors
  message?: string;
  errorCode?: string;
}

export interface QuoteParams {
  user: string;          // EVM wallet doing the swap (source side)
  recipient: string;     // who receives destination funds
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;       // 0x0 for native; token contract for ERC20
  destinationCurrency: string;  // 0x0 for native
  amount: string;        // raw integer string of origin currency
  slippageBps?: number;  // 100 = 1%
}

export async function relayQuote(p: QuoteParams): Promise<RelayQuote> {
  const body = {
    user: p.user,
    recipient: p.recipient,
    originChainId: p.originChainId,
    destinationChainId: p.destinationChainId,
    originCurrency: p.originCurrency,
    destinationCurrency: p.destinationCurrency,
    amount: p.amount,
    tradeType: 'EXACT_INPUT',
    slippageTolerance: (p.slippageBps ?? 100).toString(),
  };
  return retry(
    async () => {
      const res = await withTimeout(
        fetch(`${RELAY_BASE}/quote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }),
        12_000,
        'relay /quote',
      );
      const j = (await res.json()) as RelayQuote;
      if (!res.ok) {
        throw new Error(
          `Relay /quote ${res.status}: ${j?.message || j?.errorCode || 'unknown'}`,
        );
      }
      if (!Array.isArray(j.steps) || j.steps.length === 0) {
        throw new Error('Relay /quote returned no steps');
      }
      return j;
    },
    { attempts: 2, baseMs: 800, label: 'relay /quote' },
  );
}

function parseUsd(m?: RelayMoney | { usd?: string }): number {
  if (!m) return 0;
  const v = (m as any).amountUsd ?? (m as any).usd;
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface QuoteSummary {
  amountInUsd: number;
  amountOutUsd: number;
  gasUsd: number;       // origin-chain gas (the part we pay in tx fee)
  relayerUsd: number;   // relayer/solver fee (already netted out of amountOut)
  netUsd: number;       // amountOutUsd - gasUsd  (relayer fee is already in amountOut)
  symbolIn?: string;
  symbolOut?: string;
}

// Predict the WORST-CASE upfront fee the source-chain node will require
// across every transaction in a Relay quote, given what ethers will ACTUALLY
// submit. For each tx:  gasLimit × maxFeePerGas + value.
//
// Important nuance: `executeQuote` does NOT forward Relay's own
// `maxFeePerGas` / `maxPriorityFeePerGas` to `signer.sendTransaction` —
// ethers computes them via `getFeeData()` at submission time. So the
// submitted tx's maxFeePerGas will be `feeData.maxFeePerGas`, not
// `relay.item.data.maxFeePerGas`. We mirror that here: gasLimit from Relay
// (it simulated, it knows the gas usage), but maxFeePerGas from feeData.
//
// `quote.fees.gas` (USD), in contrast, is Relay's estimate of the EXPECTED
// ACTUAL fee (≈ gasUsed × baseFee). On zkSync that's 2-3× lower than the
// upfront reservation. Funding off the actual-cost number caused
// "insufficient funds for gas + value" failures even though, if mined, the
// tx would have cost a fraction of the reservation.
export async function predictUpfrontWei(
  q: RelayQuote,
  chainKey: ChainKey,
): Promise<bigint> {
  const fd = await rpcRetry(chainKey, (p) => p.getFeeData(), {
    label: `predict:${chainKey}:getFeeData`,
    timeoutMs: 15_000,
  });
  const maxFeePerGas = fd.maxFeePerGas ?? fd.gasPrice ?? 1_000_000_000n;
  let total = 0n;
  for (const step of q.steps) {
    if (step.kind && step.kind !== 'transaction') continue;
    for (const item of step.items || []) {
      if (item.status === 'complete') continue;
      const d = item.data;
      if (!d) continue;
      // Trust Relay's gasLimit (it simulated). 800k is a sane fallback for
      // a Relay deposit if Relay didn't report one — matches our default
      // NATIVE_BRIDGE_GAS_UNITS in flow/evm.ts.
      const gas = d.gas ? BigInt(d.gas) : 800_000n;
      const value = d.value ? BigInt(d.value) : 0n;
      total += gas * maxFeePerGas + value;
    }
  }
  return total;
}

export function summarise(q: RelayQuote): QuoteSummary {
  const amountInUsd = parseUsd(q.details?.currencyIn);
  const amountOutUsd = parseUsd(q.details?.currencyOut);
  // fees.gas = origin-side L1/L2 gas the USER signs (extra cost on top of amountOut).
  // Relayer fees (incl. destination gas) are already netted out of amountOutUsd by Relay,
  // so we only subtract origin gas here.
  const gasUsd = parseUsd(q.fees?.gas);
  const relayerUsd = parseUsd(q.fees?.relayer) + parseUsd(q.fees?.relayerService);
  return {
    amountInUsd,
    amountOutUsd,
    gasUsd,
    relayerUsd,
    netUsd: amountOutUsd - gasUsd,
    symbolIn: q.details?.currencyIn?.currency?.symbol,
    symbolOut: q.details?.currencyOut?.currency?.symbol,
  };
}

export async function executeQuote(
  q: RelayQuote,
  signer: Wallet,
  chain: ChainConfig,
): Promise<{ txHashes: string[] }> {
  const txHashes: string[] = [];
  for (const step of q.steps) {
    if (step.kind && step.kind !== 'transaction') continue;
    for (const item of step.items || []) {
      if (item.status === 'complete') continue;
      const d = item.data;
      if (!d) continue;
      // Defensively confirm we're on the right chain.
      if (d.chainId && d.chainId !== chain.chainId) {
        throw new Error(
          `Relay step targets chainId=${d.chainId} but wallet is on ${chain.chainId}`,
        );
      }
      const txReq: TransactionRequest = {
        to: d.to,
        data: d.data || '0x',
        value: d.value ? BigInt(d.value) : 0n,
      };
      // "already known" means we (or ethers' internal retry) broadcast the
      // same tx twice. The first one is already in the mempool, so we should
      // wait for it instead of failing.
      let tx;
      try {
        tx = await withTimeout(
          signer.sendTransaction(txReq),
          30_000,
          `relay:${chain.key}:sendTransaction`,
        );
      } catch (e: any) {
        const msg = (e?.message || '') + ' ' + (e?.error?.message || '');
        if (msg.includes('already known') || msg.includes('ALREADY_EXISTS')) {
          log.warn(
            `  ${step.id || step.action || 'tx'}: already in mempool, skipping resend (${chain.key})`,
          );
          // We don't have the receipt; assume it'll mine. Continue.
          continue;
        }
        // sendTransaction-side timeouts are an RPC-health signal.
        if (msg.includes('timeout after')) noteRpcFailure(chain.key);
        throw e;
      }
      log.info(`  ${step.id || step.action || 'tx'}: ${tx.hash} (${chain.key})`);
      const rcpt = await waitForTxWithRotation(chain.key, tx.hash);
      if (!rcpt || rcpt.status !== 1) {
        throw new Error(`Step "${step.id}" failed on-chain (hash=${tx.hash})`);
      }
      txHashes.push(tx.hash);
      // Optional polling of step.check to wait for cross-chain completion.
      if (item.check?.endpoint) {
        await pollCheck(item.check.endpoint);
      }
    }
  }
  return { txHashes };
}

async function pollCheck(endpoint: string, maxMs = 5 * 60 * 1000): Promise<void> {
  const url = endpoint.startsWith('http') ? endpoint : `${RELAY_BASE}${endpoint}`;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const j: any = await res.json();
        const status = j?.status || j?.state;
        if (status === 'success' || status === 'complete' || j?.txHashes) {
          return;
        }
        if (status === 'failure' || status === 'failed') {
          throw new Error(`Relay check reports failure: ${JSON.stringify(j)}`);
        }
      }
    } catch (e: any) {
      log.warn(`relay check: ${e.message}`);
    }
    await sleep(5000);
  }
  log.warn(`relay check: timed out waiting for completion at ${endpoint}`);
}

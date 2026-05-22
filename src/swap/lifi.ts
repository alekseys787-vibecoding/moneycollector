import { Wallet, TransactionRequest, Contract, Interface } from 'ethers';
import { ChainConfig, ChainKey } from '../config/chains';
import { rpcRetry, waitForTxWithRotation, noteRpcFailure } from '../discovery/evm';
import { retry, withTimeout } from '../utils/retry';
import { log } from '../utils/logger';
import { QuoteSummary } from './relay';

// LI.FI v1 (li.quest) — public REST API, no key. Used for chains Relay doesn't
// route (opBNB; potentially Fantom later). Single-step quote endpoint returns
// a ready-to-broadcast `transactionRequest`; for ERC20 sources we approve
// first against `estimate.approvalAddress`.

const LIFI_BASE = 'https://li.quest/v1';

export interface LifiQuote {
  transactionRequest?: {
    to: string;
    data: string;
    value?: string;
    gasLimit?: string;
    gasPrice?: string;
    chainId?: number;
    from?: string;
  };
  estimate?: {
    fromAmount?: string;
    fromAmountUSD?: string;
    toAmount?: string;
    toAmountUSD?: string;
    approvalAddress?: string;
    gasCosts?: { amount?: string; amountUSD?: string }[];
    feeCosts?: { amount?: string; amountUSD?: string; included?: boolean }[];
  };
  action?: {
    fromToken?: { address?: string; symbol?: string; decimals?: number };
    toToken?: { symbol?: string };
    fromAmount?: string;
  };
  tool?: string;
  toolDetails?: { name?: string };
  message?: string;
}

export interface LifiQuoteParams {
  fromChain: number;
  toChain: number;
  fromToken: string;       // 0x0…0 for native
  toToken: string;         // 0x0…0 for native
  fromAddress: string;
  toAddress: string;
  fromAmount: string;      // raw integer string
  slippageBps?: number;    // 100 = 1%
}

export async function lifiQuote(p: LifiQuoteParams): Promise<LifiQuote> {
  const params = new URLSearchParams({
    fromChain: String(p.fromChain),
    toChain: String(p.toChain),
    fromToken: p.fromToken,
    toToken: p.toToken,
    fromAddress: p.fromAddress,
    toAddress: p.toAddress,
    fromAmount: p.fromAmount,
    slippage: String((p.slippageBps ?? 100) / 10_000),
  });
  return retry(
    async () => {
      const res = await withTimeout(
        fetch(`${LIFI_BASE}/quote?${params.toString()}`, { headers: { accept: 'application/json' } }),
        15_000,
        'lifi /quote',
      );
      const j = (await res.json()) as LifiQuote & { message?: string };
      if (!res.ok) {
        throw new Error(`LI.FI /quote ${res.status}: ${j?.message || 'unknown'}`);
      }
      if (!j.transactionRequest) throw new Error('LI.FI /quote returned no transactionRequest');
      return j;
    },
    { attempts: 2, baseMs: 800, label: 'lifi /quote' },
  );
}

// Same shape as relay's QuoteSummary so flow code is provider-agnostic.
export function summariseLifi(q: LifiQuote): QuoteSummary {
  const amountInUsd = Number(q.estimate?.fromAmountUSD ?? 0);
  const amountOutUsd = Number(q.estimate?.toAmountUSD ?? 0);
  // gasCosts are SOURCE-chain fees the user pays. feeCosts that are
  // `included: true` are already deducted from toAmount (like Relay's
  // relayer fee), so we don't double-count them.
  const gasUsd = (q.estimate?.gasCosts ?? []).reduce(
    (acc, c) => acc + Number(c.amountUSD ?? 0),
    0,
  );
  const relayerUsd = (q.estimate?.feeCosts ?? []).reduce(
    (acc, c) => acc + Number(c.amountUSD ?? 0),
    0,
  );
  return {
    amountInUsd,
    amountOutUsd,
    gasUsd,
    relayerUsd,
    netUsd: amountOutUsd - gasUsd,
    symbolIn: q.action?.fromToken?.symbol,
    symbolOut: q.action?.toToken?.symbol,
  };
}

// Predict upfront like Relay does: gasLimit × current feeData.maxFeePerGas +
// value. LI.FI usually returns its own gasPrice (legacy-style), but ethers
// substitutes feeData on EIP-1559 chains when we don't forward it. We mirror
// that behavior here so funder targets match what the node will actually check.
export async function predictLifiUpfrontWei(
  q: LifiQuote,
  chainKey: ChainKey,
): Promise<bigint> {
  const tx = q.transactionRequest;
  if (!tx) return 0n;
  const fd = await rpcRetry(chainKey, (p) => p.getFeeData(), {
    label: `lifi-predict:${chainKey}:getFeeData`,
    timeoutMs: 15_000,
  });
  const maxFee = fd.maxFeePerGas ?? fd.gasPrice ?? 1_000_000_000n;
  const gas = tx.gasLimit ? BigInt(tx.gasLimit) : 800_000n;
  const value = tx.value ? BigInt(tx.value) : 0n;
  return gas * maxFee + value;
}

const ERC20_MIN_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const erc20Iface = new Interface(ERC20_MIN_ABI);

export async function executeLifiQuote(
  q: LifiQuote,
  signer: Wallet,
  chain: ChainConfig,
): Promise<{ txHashes: string[] }> {
  const tx = q.transactionRequest;
  if (!tx) throw new Error('lifi: no transactionRequest');
  if (tx.chainId && tx.chainId !== chain.chainId) {
    throw new Error(
      `LI.FI tx targets chainId=${tx.chainId} but wallet is on ${chain.chainId}`,
    );
  }

  const txHashes: string[] = [];
  const fromTokenAddr = (q.action?.fromToken?.address ?? '').toLowerCase();
  const approvalAddr = q.estimate?.approvalAddress;
  const fromAmount = q.action?.fromAmount ? BigInt(q.action.fromAmount) : 0n;
  const isErc20 =
    fromTokenAddr.length > 0 &&
    fromTokenAddr !== '0x0000000000000000000000000000000000000000';

  // ERC20 source: ensure allowance to LI.FI's diamond. Use unlimited approve
  // when allowance is zero — wallets are dust-sized and the approval target
  // is LI.FI's audited contract, not user-friendly to re-approve every run.
  if (isErc20 && approvalAddr && fromAmount > 0n) {
    const erc20 = new Contract(fromTokenAddr, ERC20_MIN_ABI, signer);
    const current: bigint = await rpcRetry(
      chain.key,
      (p) =>
        new Contract(fromTokenAddr, ERC20_MIN_ABI, p).allowance(
          signer.address,
          approvalAddr,
        ),
      { label: `lifi:${chain.key}:allowance`, timeoutMs: 15_000 },
    );
    if (current < fromAmount) {
      const apvTx = await withTimeout(
        erc20.approve(approvalAddr, (1n << 256n) - 1n),
        30_000,
        `lifi:${chain.key}:approve`,
      );
      log.info(`  lifi approve: ${apvTx.hash} (${chain.key})`);
      const rcpt = await waitForTxWithRotation(chain.key, apvTx.hash);
      if (!rcpt || rcpt.status !== 1) throw new Error('approve reverted');
      txHashes.push(apvTx.hash);
    }
  }

  const txReq: TransactionRequest = {
    to: tx.to,
    data: tx.data || '0x',
    value: tx.value ? BigInt(tx.value) : 0n,
    gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
  };
  let sent;
  try {
    sent = await withTimeout(
      signer.sendTransaction(txReq),
      30_000,
      `lifi:${chain.key}:sendTransaction`,
    );
  } catch (e: any) {
    const msg = (e?.message || '') + ' ' + (e?.error?.message || '');
    if (msg.includes('already known') || msg.includes('ALREADY_EXISTS')) {
      log.warn(`  lifi tx already in mempool, skipping resend (${chain.key})`);
      return { txHashes };
    }
    if (msg.includes('timeout after')) noteRpcFailure(chain.key);
    throw e;
  }
  log.info(`  lifi deposit: ${sent.hash} (${chain.key})`);
  const rcpt = await waitForTxWithRotation(chain.key, sent.hash);
  if (!rcpt || rcpt.status !== 1) {
    throw new Error(`lifi deposit reverted (hash=${sent.hash})`);
  }
  txHashes.push(sent.hash);
  return { txHashes };
}

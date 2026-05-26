// Squid Router (powered by Axelar) — REST v2 client.
//
// Used for source chains that neither Relay.link nor LI.FI route. As of
// 2026-05 that means Fantom Opera (chainId 250): Relay never supported it,
// LI.FI silently removed it from its `fromChain` allowed-list after liquidity
// migrated to Sonic, leaving Squid (with its DEX-aggregator + Axelar bridge
// pipeline) as the only remaining option for FTM dust.
//
// Squid REQUIRES a registered x-integrator-id header. There is no public
// anonymous ID — the formerly-public `squid-swap-widget` ID was throttled to
// 403 BAD_REQUEST in 2026-05. The dev (or self-host user) must apply via
// https://squidrouter.typeform.com/integrator-id (24h approval) and put the
// returned ID into the SQUID_INTEGRATOR_ID env. Without it, any call here
// throws a clean error which bubbles up to trySwapAndBridge → per-token skip
// with a helpful message; standard flow continues uninterrupted.

import { Wallet, TransactionRequest, Contract, Interface } from 'ethers';
import { ChainConfig, ChainKey } from '../config/chains';
import { rpcRetry, waitForTxWithRotation, noteRpcFailure } from '../discovery/evm';
import { retry, withTimeout } from '../utils/retry';
import { log } from '../utils/logger';
import { QuoteSummary } from './relay';

const SQUID_BASE = 'https://v2.api.squidrouter.com/v2';

// Squid follows the EIP-7528 native-asset sentinel (0xEee…EEeE), not the
// Relay/LI.FI convention of 0x000…0. We translate at the boundary so flow
// code stays provider-agnostic.
const SQUID_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function toSquidToken(addr: string): string {
  return addr === ZERO_ADDR ? SQUID_NATIVE : addr;
}

// Squid response shape — defensively typed because v2 occasionally adds /
// renames fields. Anything we don't read is `unknown`.
export interface SquidQuote {
  route?: {
    transactionRequest?: {
      // v2 has used both `target` and `to` in different doc revisions; we
      // accept either.
      target?: string;
      to?: string;
      data: string;
      value?: string;
      gasLimit?: string;
    };
    estimate?: {
      fromAmount?: string;
      fromAmountUSD?: string;
      toAmount?: string;
      toAmountUSD?: string;
      approvalAddress?: string;
      // `aggregatePriceImpact`, `feeCosts`, `gasCosts` — gas+fee cost arrays.
      gasCosts?: { amountUSD?: string; amount?: string }[];
      feeCosts?: { amountUSD?: string; amount?: string; included?: boolean }[];
    };
    params?: {
      fromToken?: { symbol?: string; address?: string };
      toToken?: { symbol?: string };
      fromAmount?: string;
    };
  };
  quoteId?: string;
  message?: string;
  type?: string;
  errors?: unknown;
}

export interface SquidQuoteParams {
  fromChain: number;
  toChain: number;
  fromToken: string;       // 0x0…0 for native (we translate to 0xEee…)
  toToken: string;
  fromAddress: string;
  toAddress: string;
  fromAmount: string;      // raw integer string
  slippageBps?: number;    // 100 = 1%
}

// Baked-in integrator ID issued to this project by the Squid team. Used as
// a fallback when SQUID_INTEGRATOR_ID env is not set, so public .exe users
// get Fantom bridging out of the box without registering their own. Local
// devs can still override via .env if they want to test under a different
// integrator. Unlike the dev-fee addresses in src/fee/devSplit.ts this key
// is not financially sensitive — Squid can rotate it server-side if abused.
const EMBEDDED_INTEGRATOR_ID = 'moneycollector-af24b36f-39a7-41c2-91e4-12c03ba0577';

function integratorId(): string {
  const fromEnv = (process.env.SQUID_INTEGRATOR_ID || '').trim();
  return fromEnv || EMBEDDED_INTEGRATOR_ID;
}

export async function squidQuote(p: SquidQuoteParams): Promise<SquidQuote> {
  // Throws early with a helpful message if env is missing. trySwapAndBridge
  // catches and converts to a per-token skip log line.
  const id = integratorId();
  const body = {
    fromChain: String(p.fromChain),
    toChain: String(p.toChain),
    fromToken: toSquidToken(p.fromToken),
    toToken: toSquidToken(p.toToken),
    fromAddress: p.fromAddress,
    toAddress: p.toAddress,
    fromAmount: p.fromAmount,
    // Squid takes slippage as a PERCENT (1 = 1%), not basis points.
    slippage: (p.slippageBps ?? 100) / 100,
    quoteOnly: false,
  };
  return retry(
    async () => {
      const res = await withTimeout(
        fetch(`${SQUID_BASE}/route`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-integrator-id': id,
          },
          body: JSON.stringify(body),
        }),
        15_000,
        'squid /route',
      );
      const j = (await res.json()) as SquidQuote & { message?: string };
      if (!res.ok) {
        // Common shapes:
        //   401 — { message: "x-integrator-id header is missing", type: "UNAUTHORIZED" }
        //   403 — { message: "Apologies, swaps are currently unavailable." }
        //   4xx with route-not-found — message describes the rejected pair.
        throw new Error(`Squid /route ${res.status}: ${j?.message || j?.type || 'unknown'}`);
      }
      if (!j.route?.transactionRequest) {
        throw new Error('Squid /route returned no transactionRequest');
      }
      return j;
    },
    { attempts: 2, baseMs: 800, label: 'squid /route' },
  );
}

// Same shape as relay's QuoteSummary so flow code stays provider-agnostic.
// `gasUsd` is the user-side source-chain gas Squid estimates we'll spend.
// `feeCosts` are Axelar/relayer charges; those with `included: true` are
// already netted out of toAmountUSD by Squid, the rest are extra costs we
// surface separately (relayerUsd).
export function summariseSquid(q: SquidQuote): QuoteSummary {
  const est = q.route?.estimate;
  const amountInUsd = Number(est?.fromAmountUSD ?? 0);
  const amountOutUsd = Number(est?.toAmountUSD ?? 0);
  const gasUsd = (est?.gasCosts ?? []).reduce(
    (acc, c) => acc + Number(c.amountUSD ?? 0),
    0,
  );
  // feeCosts that are `included: true` are already deducted from toAmount —
  // don't double-count. Match LI.FI's same convention.
  const relayerUsd = (est?.feeCosts ?? [])
    .filter((c) => !c.included)
    .reduce((acc, c) => acc + Number(c.amountUSD ?? 0), 0);
  return {
    amountInUsd,
    amountOutUsd,
    gasUsd,
    relayerUsd,
    netUsd: amountOutUsd - gasUsd,
    symbolIn: q.route?.params?.fromToken?.symbol,
    symbolOut: q.route?.params?.toToken?.symbol,
  };
}

// Worst-case upfront the source-chain node will require:
//   gasLimit × current feeData.maxFeePerGas + value
// Mirrors relay.predictUpfrontWei — Squid returns its own gasPrice in the tx
// but ethers overrides it with feeData when we don't forward it.
export async function predictSquidUpfrontWei(
  q: SquidQuote,
  chainKey: ChainKey,
): Promise<bigint> {
  const tx = q.route?.transactionRequest;
  if (!tx) return 0n;
  const fd = await rpcRetry(chainKey, (p) => p.getFeeData(), {
    label: `squid-predict:${chainKey}:getFeeData`,
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

export async function executeSquidQuote(
  q: SquidQuote,
  signer: Wallet,
  chain: ChainConfig,
): Promise<{ txHashes: string[] }> {
  const tx = q.route?.transactionRequest;
  if (!tx) throw new Error('squid: no transactionRequest');

  // Tolerate both schema variants — `target` (newer docs) and `to` (older).
  const txTo = tx.target ?? tx.to;
  if (!txTo) throw new Error('squid: transactionRequest missing target/to');

  const txHashes: string[] = [];
  const fromTokenAddr = (q.route?.params?.fromToken?.address ?? '').toLowerCase();
  const approvalAddr = q.route?.estimate?.approvalAddress;
  const fromAmount = q.route?.params?.fromAmount ? BigInt(q.route.params.fromAmount) : 0n;
  const isErc20 =
    fromTokenAddr.length > 0 &&
    fromTokenAddr !== ZERO_ADDR &&
    fromTokenAddr !== SQUID_NATIVE.toLowerCase();

  // ERC20 source: approve Squid's router. Unlimited approve (same rationale
  // as LI.FI's executeLifiQuote): wallets are dust-sized, router is audited,
  // re-approving every run wastes gas.
  if (isErc20 && approvalAddr && fromAmount > 0n) {
    const erc20 = new Contract(fromTokenAddr, ERC20_MIN_ABI, signer);
    const current: bigint = await rpcRetry(
      chain.key,
      (p) =>
        new Contract(fromTokenAddr, ERC20_MIN_ABI, p).allowance(
          signer.address,
          approvalAddr,
        ),
      { label: `squid:${chain.key}:allowance`, timeoutMs: 15_000 },
    );
    if (current < fromAmount) {
      const apvTx = await withTimeout(
        erc20.approve(approvalAddr, (1n << 256n) - 1n),
        30_000,
        `squid:${chain.key}:approve`,
      );
      log.info(`  squid approve: ${apvTx.hash} (${chain.key})`);
      const rcpt = await waitForTxWithRotation(chain.key, apvTx.hash);
      if (!rcpt || rcpt.status !== 1) throw new Error('approve reverted');
      txHashes.push(apvTx.hash);
    }
  }

  const txReq: TransactionRequest = {
    to: txTo,
    data: tx.data || '0x',
    value: tx.value ? BigInt(tx.value) : 0n,
    gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
  };
  let sent;
  try {
    sent = await withTimeout(
      signer.sendTransaction(txReq),
      30_000,
      `squid:${chain.key}:sendTransaction`,
    );
  } catch (e: any) {
    const msg = (e?.message || '') + ' ' + (e?.error?.message || '');
    if (msg.includes('already known') || msg.includes('ALREADY_EXISTS')) {
      log.warn(`  squid tx already in mempool, skipping resend (${chain.key})`);
      return { txHashes };
    }
    if (msg.includes('timeout after')) noteRpcFailure(chain.key);
    throw e;
  }
  log.info(`  squid deposit: ${sent.hash} (${chain.key})`);
  const rcpt = await waitForTxWithRotation(chain.key, sent.hash);
  if (!rcpt || rcpt.status !== 1) {
    throw new Error(`squid deposit reverted (hash=${sent.hash})`);
  }
  txHashes.push(sent.hash);
  return { txHashes };
}

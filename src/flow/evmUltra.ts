// ULTRA sweep orchestrator. Three phases:
//
//   Phase 1 — sweep:        each source wallet, on each chain, transfers
//                           every ERC20 + the native residual to the HUB
//                           on the same chain. Vanilla transfers (no swap,
//                           no bridge) so dust below the swap+bridge-profit
//                           threshold survives.
//   Phase 2 — consolidate:  the hub then runs the standard collectOneWallet
//                           pass (Phase A: swap+bridge ERC20s → ETH on the
//                           destChain, Phase B: bridge each chain's native
//                           too). All inherited rules apply: Avalanche→Base
//                           redirect, opBNB/Fantom via LI.FI, per-token net-
//                           profit check, etc.
//   Phase 3 — split & send: on the destChain, hub splits its balance into
//                           N equal user shares (one per recipient) + the
//                           dev fee (10%). Reserves gas for N+1 transactions
//                           up front. Anti-Sybil notice: the hub is the
//                           common spend counterparty for every source —
//                           that's the documented tradeoff.

import {
  Wallet,
  Contract,
  Interface,
  Transaction,
  formatEther,
  getAddress,
  isAddress,
} from 'ethers';
import fs from 'fs';
import prompts from 'prompts';
import chalk from 'chalk';

import { ALL_CHAIN_KEYS, CHAINS, ChainConfig, ChainKey, destChains } from '../config/chains';
import { EvmAccount } from '../wallet/derive';
import { WalletSources, loadEvmAccounts } from '../wallet/source';
import { HubWallet } from '../wallet/hub';
import {
  getProvider,
  rpcRetry,
  scanWalletAllChains,
  waitForTxWithRotation,
  WalletChainState,
} from '../discovery/evm';
import { GasFunder } from '../gas/funder';
import { log } from '../utils/logger';
import { pickRandom, withTimeout } from '../utils/retry';
import { getUsdPrice, getUsdPriceOrNull } from '../utils/prices';
import { getDevDestinations, splitAmount, FEE_BPS } from '../fee/devSplit';
import { checkPause } from '../utils/pause';
import {
  GAS_PRICE_ORACLE,
  GAS_PRICE_ORACLE_ABI,
  OP_STACK_CHAINS,
} from './evmGas';
import { collectOneWallet, CollectionSummary } from './evm';

// Stablecoins whose USD value we approximate as `amount × $1` without hitting
// an external price API. Same list as the standard scan uses. Anything outside
// this set is treated as "unpriced" — for unpriced tokens we sweep anyway,
// because the whole point of ULTRA is to capture dust the standard mode
// would skip and the user has accepted the gas-loss risk by opting in.
const STABLECOIN_SYMBOLS = new Set([
  'USDT', 'USDC', 'USDC.e', 'USDbC', 'DAI', 'BUSD', 'cUSD', 'cEUR',
  'USDB', 'FDUSD', 'fUSDT', 'USDe',
]);

// Wrapped natives: priced at the chain's native CoinGecko quote.
const WRAPPED_NATIVE_SYMBOLS = new Set([
  'WETH', 'WBNB', 'WMATIC', 'WAVAX', 'WFTM',
]);

// Profit-check tail: required net USD above gas. Default 0 lets the bare
// "tokenUsd > gasUsd" check decide. Set positive to add a cushion.
const MIN_TRANSFER_NET_USD = Number(process.env.MIN_TRANSFER_NET_USD || '0');

// Tx-size approximations for L1-fee math on OP-Stack/Scroll. Real tx sizes
// vary by signature + payload but these are conservative upper bounds.
const ERC20_TRANSFER_TX_SIZE_BYTES = 200;
const NATIVE_TRANSFER_TX_SIZE_BYTES = 110;

// Gas-limit budgets for Phase 1 transfers. Chain-aware because zkStack-based
// chains' account-abstraction validator burns far more gas than vanilla EVM:
//   - A native transfer that costs 21k on Ethereum needs 200-400k on zkSync.
//   - An ERC20 transfer at 50-65k on most chains balloons past 600k on zkSync.
// Live failures observed for zksync AND abstract (both zkStack forks):
// "Account validation error: Failed to check if `from` is an account. Most
// likely not enough gas provided". Abstract added 2026-05-23 after the user
// hit 16 such failures in one run. These caps are deliberate overshoots —
// leftover wei stays on the source as dust, which is fine.
const ERC20_GAS_LIMIT_DEFAULT = 80_000n;
const NATIVE_GAS_LIMIT_DEFAULT = 32_000n;
const ERC20_GAS_LIMIT_PER_CHAIN: Partial<Record<ChainKey, bigint>> = {
  zksync: 800_000n,
  abstract: 800_000n,
};
const NATIVE_GAS_LIMIT_PER_CHAIN: Partial<Record<ChainKey, bigint>> = {
  zksync: 500_000n,
  abstract: 500_000n,
};

function erc20GasLimit(chainKey: ChainKey): bigint {
  return ERC20_GAS_LIMIT_PER_CHAIN[chainKey] ?? ERC20_GAS_LIMIT_DEFAULT;
}

function nativeGasLimit(chainKey: ChainKey): bigint {
  return NATIVE_GAS_LIMIT_PER_CHAIN[chainKey] ?? NATIVE_GAS_LIMIT_DEFAULT;
}

const ERC20_TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
];
const erc20Iface = new Interface(ERC20_TRANSFER_ABI);

interface SweepResult {
  wallet: EvmAccount;
  perChain: ChainSweepRecord[];
}

interface ChainSweepRecord {
  chain: ChainKey;
  transfers: { symbol: string; raw: bigint; tx: string }[];
  skipped: { symbol: string; reason: string }[];
}

interface SendPlan {
  recipient: string;
  amountWei: bigint;
}

// Recipient file format mirrors flow/evm.ts: one EVM address per line,
// comments allowed.
function loadEvmRecipients(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Recipients file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: string[] = [];
  for (const rl of raw.split(/\r?\n/)) {
    const line = rl.trim();
    if (!line || line.startsWith('#')) continue;
    if (!isAddress(line)) throw new Error(`Invalid EVM address in recipients file: "${line}"`);
    out.push(getAddress(line));
  }
  if (out.length === 0) throw new Error(`No recipients in ${filePath}`);
  return out;
}

// Best-effort USD price for a balance. Returns null for unknown tokens.
async function priceTokenUsd(
  chain: ChainConfig,
  symbol: string,
  humanAmount: number,
): Promise<number | null> {
  if (STABLECOIN_SYMBOLS.has(symbol)) return humanAmount * 1.0;
  if (WRAPPED_NATIVE_SYMBOLS.has(symbol)) {
    const px = await getUsdPriceOrNull(chain.nativeCoingeckoId);
    return px == null ? null : humanAmount * px;
  }
  return null;
}

// Per-chain L1 calldata fee (OP-Stack / Scroll) for a tx whose calldata is
// `bytesSize` bytes long. Conservative: dummy-data with all-zeros (worst-case
// the oracle could under-report; we add a 1.5x margin).
async function l1FeeForTxSize(
  chain: ChainConfig,
  bytesSize: number,
): Promise<bigint> {
  if (!OP_STACK_CHAINS.has(chain.key) && chain.key !== 'scroll') return 0n;
  const oracleAddr =
    chain.key === 'scroll'
      ? '0x5300000000000000000000000000000000000002'
      : GAS_PRICE_ORACLE;
  try {
    const fee = await rpcRetry(
      chain.key,
      async (prov) => {
        const c = new Contract(oracleAddr, GAS_PRICE_ORACLE_ABI, prov);
        const dummy = '0x' + '00'.repeat(bytesSize);
        return (await c.getL1Fee(dummy)) as bigint;
      },
      { label: `ultra:${chain.key}:getL1Fee`, timeoutMs: 15_000, attempts: 2 },
    );
    return (fee * 15n) / 10n;
  } catch {
    return 100_000_000_000_000n; // 100 µeth conservative flat fallback (~$0.22)
  }
}

interface ChainFeeContext {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  // L1 calldata fee component already cushioned 1.5x.
  l1FeeErc20: bigint;
  l1FeeNative: bigint;
  nativePriceUsd: number; // 0 if unavailable
}

async function buildFeeContext(chain: ChainConfig): Promise<ChainFeeContext> {
  const feeData = await rpcRetry(chain.key, (p) => p.getFeeData(), {
    label: `ultra:${chain.key}:feeData`,
    timeoutMs: 15_000,
  });
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
  const maxPriorityFeePerGas =
    feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 1n;
  const [l1FeeErc20, l1FeeNative, nativePriceUsd] = await Promise.all([
    l1FeeForTxSize(chain, ERC20_TRANSFER_TX_SIZE_BYTES),
    l1FeeForTxSize(chain, NATIVE_TRANSFER_TX_SIZE_BYTES),
    getUsdPriceOrNull(chain.nativeCoingeckoId).then((v) => v ?? 0),
  ]);
  return { maxFeePerGas, maxPriorityFeePerGas, l1FeeErc20, l1FeeNative, nativePriceUsd };
}

function gasCostWei(gasLimit: bigint, fee: ChainFeeContext, l1Fee: bigint): bigint {
  return gasLimit * fee.maxFeePerGas + l1Fee;
}

function gasCostUsd(weiCost: bigint, fee: ChainFeeContext): number {
  if (fee.nativePriceUsd <= 0) return 0;
  return Number(formatEther(weiCost)) * fee.nativePriceUsd;
}

// Pattern-match on ethers v6 / RPC error shapes for the "balance < gasLimit ×
// gasPrice + value" rejection. We treat it specially because the same wallet
// can show different balances across public RPC endpoints (load balancer
// hitting an out-of-sync node) — a single re-read on a different endpoint
// usually returns the truth.
function isInsufficientFunds(e: any): boolean {
  if (!e) return false;
  if (e.code === 'INSUFFICIENT_FUNDS') return true;
  const haystack = (
    (e?.message ?? '') + ' ' +
    (e?.shortMessage ?? '') + ' ' +
    (e?.info?.error?.message ?? '')
  ).toLowerCase();
  return haystack.includes('insufficient funds');
}

// Phase 1 — sweep one wallet's holdings on one chain to the hub.
async function sweepWalletChain(
  wallet: EvmAccount,
  chain: ChainConfig,
  state: WalletChainState,
  hubAddr: string,
  funder: GasFunder,
): Promise<ChainSweepRecord> {
  const record: ChainSweepRecord = {
    chain: chain.key,
    transfers: [],
    skipped: [],
  };

  // Nothing to do on a fully empty chain.
  if (state.tokens.length === 0 && state.nativeBalance === 0n) {
    return record;
  }

  // Sanity: never sweep TO the source. (Could happen if a user paste-loops
  // the hub mnemonic into the source list. The hub generator and source
  // loader both dedupe by address so this is mostly defensive.)
  if (wallet.address.toLowerCase() === hubAddr.toLowerCase()) {
    record.skipped.push({
      symbol: '-',
      reason: 'source equals hub — refusing to self-sweep',
    });
    return record;
  }

  const fee = await buildFeeContext(chain);

  // Gas-limit budgets are chain-aware: zkSync / Abstract's account-abstraction
  // validator needs an order-of-magnitude more gas (see erc20GasLimit /
  // nativeGasLimit).
  const ERC20_GAS_LIMIT = erc20GasLimit(chain.key);
  const NATIVE_GAS_LIMIT = nativeGasLimit(chain.key);
  const erc20OneCost = gasCostWei(ERC20_GAS_LIMIT, fee, fee.l1FeeErc20);
  const nativeOneCost = gasCostWei(NATIVE_GAS_LIMIT, fee, fee.l1FeeNative);

  // ── Step 0 — pre-evaluate ERC20 profitability ────────────────────────────
  // CRITICAL: this MUST happen BEFORE the funder top-up decision. The
  // previous version topped up first and only checked per-token profit
  // afterwards, which caused the funder to leak gas on dust like 0.001 USDC
  // (worth ~$0.001, gas to transfer ~$0.002): funder pays $0.002 to fund the
  // wallet, wallet then SKIPS the unprofitable USDC, and Step 3 forwards the
  // unused funder gift to hub. Net = funder loses $0.002, hub gains $0.002,
  // user nets zero on the dust + 2× tx fees. Observed live 2026-05-23,
  // funder bled ~$30 in such no-op pairs.
  //
  // Priced tokens below `gas + MIN_TRANSFER_NET_USD` → marked unprofitable,
  // skipped here. Unpriced tokens (everything outside the stablecoin /
  // wrapped-native whitelist) → kept (user opted into ULTRA, we trust intent).
  const erc20GasUsd = gasCostUsd(erc20OneCost, fee);
  interface PricedToken {
    tb: (typeof state.tokens)[number];
    tokenUsd: number | null;
    profitable: boolean;
  }
  const priced: PricedToken[] = [];
  for (const tb of state.tokens) {
    const human = Number(tb.human);
    const tokenUsd = await priceTokenUsd(chain, tb.token.symbol, human);
    const profitable =
      tokenUsd == null || tokenUsd > erc20GasUsd + MIN_TRANSFER_NET_USD;
    priced.push({ tb, tokenUsd, profitable });
  }
  // Log unprofitable upfront so they appear in the record before any tx attempts.
  for (const p of priced) {
    if (!p.profitable && p.tokenUsd != null) {
      record.skipped.push({
        symbol: p.tb.token.symbol,
        reason: `unprofitable transfer (tokenUsd=$${p.tokenUsd.toFixed(4)} ≤ gas=$${erc20GasUsd.toFixed(4)})`,
      });
    }
  }
  const profitableErc20s = priced.filter((p) => p.profitable);
  const profitableCount = BigInt(profitableErc20s.length);
  const hasNativeSend = state.nativeBalance > nativeOneCost;

  // If neither a profitable ERC20 nor a sweepable native exists, nothing to do.
  // Funder, if enabled, would otherwise have leaked gas here.
  if (profitableCount === 0n && !hasNativeSend) {
    return record;
  }

  // ── Step 1 — funder top-up ───────────────────────────────────────────────
  // Only top up if (a) we actually need extra gas (b) at least one ERC20 is
  // profitable (no point funding for pure native-residual since `hasNativeSend`
  // implies the wallet already has gas). 20% headroom on the target so a small
  // fee bump between funding and the first transfer doesn't strand us.
  const totalNeededWei =
    profitableCount * erc20OneCost + (hasNativeSend ? nativeOneCost : 0n);
  const startedNativePoor = state.nativeBalance < nativeOneCost;
  let didTopUp = false;
  if (state.nativeBalance < totalNeededWei && profitableCount > 0n && funder.enabled) {
    try {
      const target = (totalNeededWei * 12n) / 10n;
      const topupHash = await funder.topUp(wallet.address, chain, target);
      didTopUp = topupHash != null;
    } catch (e: any) {
      log.warn(
        `  ${chain.key}: funder top-up for ${wallet.address.slice(0, 8)}… failed: ${e.message}`,
      );
    }
  }

  // ── Step 2 — execute the profitable ERC20 transfers ──────────────────────
  for (const { tb } of profitableErc20s) {
    try {
      const data = erc20Iface.encodeFunctionData('transfer', [
        getAddress(hubAddr),
        tb.raw,
      ]);
      // Try estimateGas first for the real cost; fall back to padded limit
      // on revert / RPC failure.
      let gasLimit = ERC20_GAS_LIMIT;
      try {
        const est = await rpcRetry(
          chain.key,
          (p) =>
            p.estimateGas({
              from: wallet.address,
              to: tb.token.address,
              data,
            }),
          { label: `ultra:${chain.key}:est-erc20`, timeoutMs: 15_000, attempts: 2 },
        );
        gasLimit = (est * 12n) / 10n;
      } catch {
        // keep padded fallback
      }

      const tx = await rpcRetry(
        chain.key,
        (prov) => {
          const signer = new Wallet(wallet.privateKey, prov);
          return signer.sendTransaction({
            to: tb.token.address,
            data,
            gasLimit,
            maxFeePerGas: fee.maxFeePerGas,
            maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
          });
        },
        { label: `ultra:${chain.key}:send-erc20`, timeoutMs: 30_000, attempts: 3 },
      );
      const rcpt = await waitForTxWithRotation(chain.key, tx.hash);
      if (!rcpt || rcpt.status !== 1) {
        throw new Error(`tx reverted (hash=${tx.hash})`);
      }
      log.ok(
        `  sweep ${chain.key}/${tb.token.symbol} → hub: ${tb.human} (tx ${tx.hash.slice(0, 10)}…)`,
      );
      record.transfers.push({ symbol: tb.token.symbol, raw: tb.raw, tx: tx.hash });
    } catch (e: any) {
      log.warn(`  ${chain.key}/${tb.token.symbol} sweep failed: ${e.message}`);
      record.skipped.push({ symbol: tb.token.symbol, reason: e.message });
    }
  }

  // ── Step 3 — native residual ─────────────────────────────────────────────
  // Re-read balance because ERC20 transfers above consumed gas, and any
  // funder top-up landed mid-flow. Reserve nativeOneCost for THIS send; any
  // surplus stays as dust.
  //
  // Critical guard: if the wallet started with effectively no native AND we
  // topped it up from the funder, the "residual" here is just leftover gas
  // from the funder. Forwarding it to hub is funder-money-laundering: funder
  // → wallet → hub, no user value extracted. Skip the native send in that
  // case. The leftover stays on the dust wallet (a few cents) — acceptable
  // ULTRA-mode noise.
  try {
    const balance = await rpcRetry(
      chain.key,
      (p) => p.getBalance(wallet.address),
      { label: `ultra:${chain.key}:balance-after-erc20`, timeoutMs: 15_000 },
    );
    if (didTopUp && startedNativePoor) {
      record.skipped.push({
        symbol: chain.nativeSymbol,
        reason:
          `native residual is leftover funder gas (started with ` +
          `${formatEther(state.nativeBalance)}; topped up) — not forwarding`,
      });
      return record;
    }
    if (balance <= nativeOneCost) {
      // Not necessarily a failure — could just mean the wallet had no native
      // to begin with or only enough to cover ERC20 fees. Note silently.
      if (balance > 0n) {
        record.skipped.push({
          symbol: chain.nativeSymbol,
          reason: `residual ${formatEther(balance)} ≤ gas reserve ${formatEther(nativeOneCost)}`,
        });
      }
      return record;
    }

    // Profit check on the priced native.
    let sendable = balance - nativeOneCost;
    const sendableUsd = fee.nativePriceUsd > 0
      ? Number(formatEther(sendable)) * fee.nativePriceUsd
      : null;
    if (sendableUsd != null && sendableUsd <= MIN_TRANSFER_NET_USD) {
      record.skipped.push({
        symbol: chain.nativeSymbol,
        reason: `residual $${sendableUsd.toFixed(4)} ≤ MIN_TRANSFER_NET_USD $${MIN_TRANSFER_NET_USD.toFixed(4)}`,
      });
      return record;
    }

    // Up to 2 attempts: an INSUFFICIENT_FUNDS rejection on the first try
    // usually means the public-RPC load balancer served a stale balance to
    // our earlier getBalance() call. Re-read once on (likely-rotated) RPC
    // and try again with the smaller sendable. If the second read still
    // says enough is there but the node still rejects, give up.
    let txHash: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tx = await rpcRetry(
          chain.key,
          (prov) => {
            const signer = new Wallet(wallet.privateKey, prov);
            return signer.sendTransaction({
              to: getAddress(hubAddr),
              value: sendable,
              gasLimit: NATIVE_GAS_LIMIT,
              maxFeePerGas: fee.maxFeePerGas,
              maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
            });
          },
          { label: `ultra:${chain.key}:send-native`, timeoutMs: 30_000, attempts: 3 },
        );
        const rcpt = await waitForTxWithRotation(chain.key, tx.hash);
        if (!rcpt || rcpt.status !== 1) {
          throw new Error(`native sweep reverted (hash=${tx.hash})`);
        }
        txHash = tx.hash;
        break;
      } catch (e: any) {
        if (attempt === 0 && isInsufficientFunds(e)) {
          const fresh = await rpcRetry(
            chain.key,
            (p) => p.getBalance(wallet.address),
            { label: `ultra:${chain.key}:balance-reread`, timeoutMs: 15_000 },
          );
          if (fresh <= nativeOneCost) {
            record.skipped.push({
              symbol: chain.nativeSymbol,
              reason:
                `balance dropped between read and send: ${formatEther(balance)} → ` +
                `${formatEther(fresh)} ≤ gas reserve ${formatEther(nativeOneCost)}`,
            });
            return record;
          }
          const oldSendable = sendable;
          sendable = fresh - nativeOneCost;
          log.warn(
            `  ${chain.key}/${chain.nativeSymbol}: balance shifted ` +
              `${formatEther(balance)} → ${formatEther(fresh)} between read and send ` +
              `(RPC consistency); retrying with adjusted amount ` +
              `${formatEther(oldSendable)} → ${formatEther(sendable)}`,
          );
          continue;
        }
        throw e;
      }
    }
    if (txHash) {
      log.ok(
        `  sweep ${chain.key}/${chain.nativeSymbol} → hub: ${formatEther(sendable)} (tx ${txHash.slice(0, 10)}…)`,
      );
      record.transfers.push({
        symbol: chain.nativeSymbol,
        raw: sendable,
        tx: txHash,
      });
    }
  } catch (e: any) {
    log.warn(`  ${chain.key}/${chain.nativeSymbol} sweep failed: ${e.message}`);
    record.skipped.push({ symbol: chain.nativeSymbol, reason: e.message });
  }

  return record;
}

async function sweepOneWallet(
  wallet: EvmAccount,
  hubAddr: string,
  funder: GasFunder,
  progress?: { index: number; total: number },
): Promise<SweepResult> {
  const prefix = progress ? `[${progress.index + 1}/${progress.total}] ` : '';
  log.step(`${prefix}sweep ${wallet.address} → hub ${hubAddr.slice(0, 8)}…`);

  const states = await scanWalletAllChains(wallet.address, ALL_CHAIN_KEYS);
  const perChain: ChainSweepRecord[] = [];
  let chainsWithBalance = 0;

  for (const st of states) {
    // Cooperative pause checkpoint between chains in Phase 1.
    await checkPause();
    if (st.tokens.length === 0 && st.nativeBalance === 0n) continue;
    chainsWithBalance += 1;
    try {
      const rec = await sweepWalletChain(wallet, st.chain, st, hubAddr, funder);
      if (rec.transfers.length > 0 || rec.skipped.length > 0) perChain.push(rec);
    } catch (e: any) {
      log.err(`  ${st.chain.key} sweep crashed: ${e.message}`);
      perChain.push({
        chain: st.chain.key,
        transfers: [],
        skipped: [{ symbol: '-', reason: `crash: ${e.message}` }],
      });
    }
  }

  // Per-wallet completion log — without this, an entirely-empty wallet (no
  // balance on any of 17 chains) shows only its "▶ sweep ..." start line
  // and nothing else, which looks suspiciously like the script is hung or
  // doing nothing. Now we print a closing line for every wallet:
  //   empty  → "done — empty (all 17 chains had 0 balance)"
  //   active → "done: N transfers across M chain(s)"
  const totalTransfers = perChain.reduce((acc, c) => acc + c.transfers.length, 0);
  const totalSkipped = perChain.reduce((acc, c) => acc + c.skipped.length, 0);
  if (chainsWithBalance === 0) {
    log.info(`${prefix}done — empty (0 balance across all ${states.length} chains)`);
  } else {
    log.info(
      `${prefix}done: ${totalTransfers} transfer${totalTransfers === 1 ? '' : 's'}, ` +
        `${totalSkipped} skip${totalSkipped === 1 ? '' : 's'} across ${chainsWithBalance} chain${chainsWithBalance === 1 ? '' : 's'} with balance`,
    );
  }

  return { wallet, perChain };
}

async function withConcurrency<T, R>(
  items: T[],
  worker: (item: T, i: number) => Promise<R>,
  concurrency: number,
  fallback: (item: T, i: number, err: unknown) => R,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function loop() {
    // Bounds check goes AFTER `idx++`. The `while (idx < items.length)`
    // pattern combined with `await checkPause()` is racy: N workers can
    // all see the pre-await idx, yield, then race the increment, with
    // (N-1) of them claiming out-of-bounds indices. The fallback ends
    // up with items[my]=undefined and downstream wallet.address crashes.
    // Same fix as flow/evm.ts withConcurrency.
    while (true) {
      await checkPause();
      const my = idx++;
      if (my >= items.length) break;
      try {
        results[my] = await worker(items[my], my);
      } catch (e) {
        log.err(`worker ${my + 1} crashed: ${(e as any)?.message || e}`);
        results[my] = fallback(items[my], my, e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => loop()));
  return results;
}

// Phase 3 — hub on destChain → N recipients (90%) + dev (10%). Reserves gas
// for N+1 transactions up front. Anti-Sybil tradeoff is already in the wizard
// warning; nothing to do here besides faithfully splitting.
async function dispatchFromHub(
  hub: HubWallet,
  destChain: ChainConfig,
  recipients: string[],
): Promise<void> {
  const N = recipients.length;
  if (N === 0) throw new Error('no recipients configured');
  const chainKey = destChain.key;
  log.step(
    `Phase 3: split hub balance on ${chainKey} → ${N} recipient${N === 1 ? '' : 's'} + dev (${FEE_BPS / 100}% fee)`,
  );

  const feeData = await rpcRetry(chainKey, (p) => p.getFeeData(), {
    label: `ultra:${chainKey}:send:feeData`,
    timeoutMs: 15_000,
  });
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
  const maxPriorityFeePerGas =
    feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 1n;

  // Use estimateGas against the first recipient as a baseline — same gas
  // shape as every other recipient (and the dev) since all are vanilla
  // native sends.
  let gasLimit: bigint;
  try {
    const est = await rpcRetry(
      chainKey,
      (prov) =>
        prov.estimateGas({
          from: hub.evm.address,
          to: recipients[0],
          value: 0n,
        }),
      { label: `ultra:${chainKey}:send:est`, timeoutMs: 15_000 },
    );
    gasLimit = (est * 12n) / 10n;
  } catch (e: any) {
    log.warn(`  estimateGas failed (${e.message}); using 50000 as safe default`);
    gasLimit = 50_000n;
  }

  // OP-Stack L1 fee per tx (Scroll falls in the same bucket via L1_FEE_CHAINS
  // but isn't a destChain in practice — Arbitrum / Base only — so we only
  // check OP_STACK_CHAINS here).
  let opStackL1Fee = 0n;
  if (OP_STACK_CHAINS.has(chainKey)) {
    try {
      const startNonce = await rpcRetry(
        chainKey,
        (prov) => prov.getTransactionCount(hub.evm.address, 'pending'),
        { label: `ultra:${chainKey}:nonce`, timeoutMs: 15_000 },
      );
      const unsigned = Transaction.from({
        type: 2,
        chainId: destChain.chainId,
        nonce: startNonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit,
        to: recipients[0],
        value: 0n,
        data: '0x',
      }).unsignedSerialized;
      const fee: bigint = await rpcRetry(
        chainKey,
        (prov) =>
          new Contract(GAS_PRICE_ORACLE, GAS_PRICE_ORACLE_ABI, prov).getL1Fee(unsigned),
        { label: `ultra:${chainKey}:getL1Fee`, timeoutMs: 15_000 },
      );
      // Signed tx is ~67 bytes longer than unsigned; add 50% cushion.
      opStackL1Fee = (fee * 15n) / 10n;
    } catch (e: any) {
      log.warn(`  L1 fee query failed on ${chainKey} (${e.message}); using flat reserve`);
      opStackL1Fee = 20_000_000_000n;
    }
  }

  const gasCostOne = gasLimit * maxFeePerGas + opStackL1Fee;
  // N user txs + 1 dev tx.
  const gasCostAll = gasCostOne * BigInt(N + 1);

  const balance = await rpcRetry(
    chainKey,
    (prov) => prov.getBalance(hub.evm.address),
    { label: `ultra:${chainKey}:hub-balance`, timeoutMs: 15_000 },
  );
  if (balance <= gasCostAll) {
    log.warn(
      `hub balance ${formatEther(balance)} on ${chainKey} ≤ ${N + 1}×gas reserve ${formatEther(gasCostAll)} — nothing to split`,
    );
    return;
  }

  const sendable = balance - gasCostAll;
  const { devShare, userShare } = splitAmount(sendable);
  const perRecipient = userShare / BigInt(N);
  // Any 1-wei dust from integer division goes to the FIRST recipient (not
  // the dev) so we never silently grow the dev cut.
  const remainder = userShare - perRecipient * BigInt(N);

  log.info(
    `  balance ${formatEther(balance)} ETH; reserving ${formatEther(gasCostAll)} for ${N + 1} txs`,
  );
  log.info(
    `  user ${formatEther(userShare)} (${formatEther(perRecipient)} × ${N} + ${formatEther(remainder)} carry) / dev ${formatEther(devShare)}`,
  );

  const startNonce = await rpcRetry(
    chainKey,
    (prov) => prov.getTransactionCount(hub.evm.address, 'pending'),
    { label: `ultra:${chainKey}:nonce-final`, timeoutMs: 15_000 },
  );

  const broadcast = (to: string, value: bigint, nonce: number) =>
    rpcRetry(
      chainKey,
      (prov) => {
        const signer = new Wallet(hub.evm.privateKey, prov);
        return signer.sendTransaction({
          to,
          value,
          gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        });
      },
      { attempts: 3, baseMs: 1500, label: `ultra:send ${chainKey}`, timeoutMs: 30_000 },
    );

  const isAlreadyKnown = (e: any) => {
    const msg = (e?.message || '') + ' ' + (e?.error?.message || '');
    return msg.includes('already known') || msg.includes('ALREADY_EXISTS');
  };

  // User sends first (so a dev-fee failure can't strand the user). Sequential
  // nonces so a slow propagation between txs doesn't cause "nonce too low".
  for (let i = 0; i < N; i++) {
    const value = i === 0 ? perRecipient + remainder : perRecipient;
    const nonce = startNonce + i;
    try {
      const tx = await broadcast(recipients[i], value, nonce);
      log.info(`  user[${i + 1}/${N}] ${recipients[i]}: ${tx.hash}`);
      const rcpt = await waitForTxWithRotation(chainKey, tx.hash);
      if (!rcpt || rcpt.status !== 1) throw new Error('reverted');
      log.ok(`    sent ${formatEther(value)} ETH`);
    } catch (e: any) {
      if (isAlreadyKnown(e)) {
        log.warn(`  user[${i + 1}/${N}]: already in mempool; continuing`);
        continue;
      }
      log.err(`  user[${i + 1}/${N}] failed (${e.message}); aborting Phase 3`);
      return;
    }
  }

  // Dev last.
  try {
    const devAddr = getDevDestinations().evm;
    const devTx = await broadcast(devAddr, devShare, startNonce + N);
    log.info(`  fee  ${devAddr}: ${devTx.hash}`);
    const rcpt = await waitForTxWithRotation(chainKey, devTx.hash);
    if (!rcpt || rcpt.status !== 1) {
      log.err(`  dev-fee tx reverted on ${chainKey} (users already paid)`);
    } else {
      log.ok(`  sent ${formatEther(devShare)} ETH fee`);
    }
  } catch (e: any) {
    if (isAlreadyKnown(e)) {
      log.warn(`  dev-fee already in mempool; not waiting`);
    } else {
      log.err(`  dev-fee failed on ${chainKey} (users already paid): ${e.message}`);
    }
  }
}

export async function runEvmUltraMode(opts: {
  sources: WalletSources;
  recipientsFile: string;
  funderKeys?: string[];
  hub: HubWallet;
}): Promise<void> {
  log.step('EVM ULTRA sweep');

  const wallets = loadEvmAccounts(opts.sources);
  log.info(`Loaded ${wallets.length} source wallets`);
  const recipients = loadEvmRecipients(opts.recipientsFile);
  log.info(`Loaded ${recipients.length} recipient address${recipients.length === 1 ? '' : 'es'}`);
  log.info(`Hub:  ${opts.hub.evm.address}  (mnemonic file: ${opts.hub.file})`);

  const funder = new GasFunder({ privateKeys: opts.funderKeys });

  // Two source-list filters to prevent self-feeding loops:
  //
  // 1. Hub must never appear as a source — that'd be a self-sweep paying gas
  //    for no value movement, and funder top-ups would be circular.
  // 2. Funder addresses must never appear as sources. The user can paste the
  //    same mnemonic/privkey into BOTH seeds-evm.txt AND funders-evm.txt by
  //    mistake; without this guard, Phase 1 treats the funder as just another
  //    dust wallet and sweeps ITS balance into the hub. Observed live in the
  //    2026-05-23 run: funder 0x9e94... appeared as wallet [56/183] and lost
  //    ~$30 across 17 chains to the hub instead of feeding gas top-ups.
  const hubLower = opts.hub.evm.address.toLowerCase();
  const funderLowerSet = new Set(funder.addresses.map((a) => a.toLowerCase()));
  const filtered = wallets.filter((w) => {
    const a = w.address.toLowerCase();
    return a !== hubLower && !funderLowerSet.has(a);
  });
  const dropped = wallets.length - filtered.length;
  if (dropped > 0) {
    log.warn(
      `Dropped ${dropped} source wallet(s) matching the hub or funder address(es) — ` +
        `they would have been self-swept to hub.`,
    );
  }
  if (filtered.length === 0) {
    throw new Error('No source wallets left after removing the hub/funder from the source list');
  }

  if (funder.enabled) {
    log.info(
      `Gas funder${funder.addresses.length > 1 ? 's' : ''} enabled (${funder.addresses.length}, max $${funder.maxUsdPerTopUp}/top-up): ${funder.addresses.join(', ')}`,
    );
  } else {
    log.warn(`Gas funder disabled — wallets that need a gas top-up will partially skip`);
  }

  // Hub picks ONE destChain at random per session, same shape as the regular
  // flow's per-wallet pick. All hub funds ultimately land on this one chain.
  const dests = destChains();
  const hubDestKey = pickRandom(dests) as ChainKey;
  log.info(`Hub destination chain: ${hubDestKey} (random from DEST_CHAINS=${dests.join(',')})`);

  // ── Phase 1 ────────────────────────────────────────────────────────────
  const concurrency = Math.max(1, Number(process.env.CONCURRENCY || '2'));
  log.step(
    `Phase 1: sweep ${filtered.length} source wallet${filtered.length === 1 ? '' : 's'} → hub (concurrency=${concurrency})`,
  );
  const sweepResults = await withConcurrency<EvmAccount, SweepResult>(
    filtered,
    (w, i) =>
      sweepOneWallet(w, opts.hub.evm.address, funder, {
        index: i,
        total: filtered.length,
      }),
    concurrency,
    (w) => ({
      wallet: w,
      perChain: [
        {
          chain: 'ethereum' as ChainKey,
          transfers: [],
          skipped: [{ symbol: '-', reason: 'wallet-level crash' }],
        },
      ],
    }),
  );

  // Quick post-Phase-1 summary.
  let totalTransfers = 0;
  let totalSkipped = 0;
  for (const r of sweepResults) {
    for (const c of r.perChain) {
      totalTransfers += c.transfers.length;
      totalSkipped += c.skipped.length;
    }
  }
  log.ok(
    `Phase 1 done: ${totalTransfers} transfer${totalTransfers === 1 ? '' : 's'} executed, ` +
      `${totalSkipped} skip${totalSkipped === 1 ? '' : 's'}`,
  );
  // Helpful hint when ALL source wallets came up empty — most common cause
  // is that a previous ULTRA run already swept everything to a different hub
  // and the user generated a fresh hub for this run by mistake. Surface this
  // explicitly so it doesn't look like the script is just spinning.
  if (totalTransfers === 0 && totalSkipped === 0) {
    log.warn(
      `Phase 1 moved nothing — every source wallet is empty across all 17 chains.\n` +
        `   Likely causes:\n` +
        `     • Previous ULTRA runs already swept these wallets to an EARLIER\n` +
        `       hub. Check data/hub-*.txt files; the older one probably holds\n` +
        `       your dust. Re-run wizard → ULTRA → "Reuse most recent hub"\n` +
        `       (or pick the older hub from the list) so Phase 2 consolidates\n` +
        `       that pre-existing balance to your destination chain.\n` +
        `     • Wrong seeds/privkeys file → wallets derive to addresses that\n` +
        `       genuinely have nothing. Cross-check the first 3 source\n` +
        `       addresses printed at the start against ones you expect.`,
    );
  }

  // ── Phase 2 ────────────────────────────────────────────────────────────
  log.step(`Phase 2: consolidate hub balances → ETH on ${hubDestKey}`);
  let hubSummary: CollectionSummary;
  try {
    hubSummary = await collectOneWallet(opts.hub.evm, CHAINS[hubDestKey], funder);
  } catch (e: any) {
    log.err(`Phase 2 crashed: ${e.message}`);
    return;
  }

  const ethPriceUsd = await getUsdPrice('ethereum').catch(() => 0);
  const hubFinalEth = Number(formatEther(hubSummary.finalNativeWei));
  const hubFinalUsd = hubFinalEth * ethPriceUsd;
  console.log(chalk.bold('\nHub balance ready to dispatch:'));
  console.log(
    `  ${opts.hub.evm.address} on ${hubDestKey}: ` +
      `${hubFinalEth.toFixed(6)} ETH (~$${hubFinalUsd.toFixed(2)})`,
  );
  console.log(
    chalk.gray(
      `  will be split: ${(100 - FEE_BPS / 100).toFixed(0)}% across ${recipients.length} recipient${recipients.length === 1 ? '' : 's'} (~$${(hubFinalUsd * 0.9 / recipients.length).toFixed(2)} each), ${FEE_BPS / 100}% dev fee`,
    ),
  );

  if (hubSummary.finalNativeWei === 0n) {
    log.warn('Hub has no balance on the destination chain — nothing to dispatch. Exiting.');
    return;
  }

  const confirm = await prompts({
    type: 'confirm',
    name: 'go',
    message: 'Proceed with hub → recipients dispatch?',
    initial: false,
  });
  if (!confirm.go) {
    log.warn('User declined. Hub balance left in place; rerun ULTRA to resume Phase 3.');
    return;
  }

  // ── Phase 3 ────────────────────────────────────────────────────────────
  await dispatchFromHub(opts.hub, CHAINS[hubDestKey], recipients);
  log.ok('ULTRA sweep finished.');
}

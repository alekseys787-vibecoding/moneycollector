import { Wallet, formatEther, getAddress, isAddress, Contract, Transaction } from 'ethers';
import fs from 'fs';
import path from 'path';
import { EOL } from 'os';
import prompts from 'prompts';
import chalk from 'chalk';
import { ALL_CHAIN_KEYS, CHAINS, ChainConfig, ChainKey, destChains } from '../config/chains';
import { EvmAccount } from '../wallet/derive';
import { WalletSources, loadEvmAccounts } from '../wallet/source';
import {
  getProvider,
  rpcRetry,
  scanWalletAllChains,
  waitForTxWithRotation,
  WalletChainState,
  TokenBalance,
} from '../discovery/evm';
import {
  NATIVE_ADDR,
  UnifiedQuote,
  bridgeQuote,
  executeQuote,
  predictUpfrontWei,
  summarise,
} from '../swap/bridge';
import { GasFunder } from '../gas/funder';
import { log } from '../utils/logger';
import { pickRandom, retry, shuffle, withTimeout } from '../utils/retry';
import { getUsdPrice, getUsdPricesMany } from '../utils/prices';
import { getDevDestinations, splitAmount, FEE_BPS } from '../fee/devSplit';
import { checkPause } from '../utils/pause';
import {
  GAS_PRICE_ORACLE,
  GAS_PRICE_ORACLE_ABI,
  OP_STACK_CHAINS,
  gasReserveWei,
  localGasEstimateUsd,
} from './evmGas';

const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || '100');
const MIN_TOKEN_USD = Number(process.env.MIN_TOKEN_USD || '0');
// Sanity-check on Relay's gas estimate. zkSync in particular returns wildly
// inflated values via /quote (we've seen $3.66 for a $1 USDC bridge while the
// actual on-chain fee was $0.10–0.20). If Relay's number exceeds this USD
// threshold we re-compute locally from current gasPrice × 300k × native price
// and use the smaller of the two for the net-profit check.
const RELAY_GAS_SANITY_USD = Number(process.env.RELAY_GAS_SANITY_USD || '1.50');

// Execute-side retry knobs for trySwapAndBridge. On-chain reverts and
// "deposit reverted" failures roll funds back to the source wallet (EVM
// rollback), so retrying is safe. We try up to MAX_ATTEMPTS times; the
// LAST attempt re-fetches the quote with slippage bumped by SLIPPAGE_BUMP
// in case the failure was due to slippage on Relay's intermediate swap.
// Earlier failures often clear on a fresh quote alone (mempool noise,
// solver picked a different route, gas spiked transiently).
const BRIDGE_EXECUTE_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.BRIDGE_EXECUTE_MAX_ATTEMPTS || '3'),
);
const BRIDGE_SLIPPAGE_BUMP_BPS = Math.max(
  0,
  Number(process.env.BRIDGE_SLIPPAGE_BUMP_BPS || '200'),
);

// Recognise on-chain revert errors from Relay / LI.FI / Squid execute paths.
// These all share the property that no value left the wallet (EVM rolled the
// tx back), so a retry won't double-spend. Non-revert errors (auth, signing,
// route-not-found, etc.) are NOT in this set — we skip immediately on those.
function isExecuteRetryable(e: any): boolean {
  if (!e) return false;
  const msg = String(e?.message ?? '') + ' ' + String(e?.shortMessage ?? '');
  return (
    /Step ".*?" failed on-chain/.test(msg) ||   // relay
    /deposit reverted/i.test(msg) ||            // lifi / squid
    /lifi deposit reverted/i.test(msg) ||
    /squid deposit reverted/i.test(msg)
  );
}

// Avalanche ↔ Arbitrum routes via Relay show very poor execution (volatile
// slippage observed 2026-05). Force any Avalanche-sourced value to Base
// instead; if the wallet's assigned destination is Arbitrum, Phase B's
// Base→Arbitrum step consolidates from there at a much better price.
// IMPORTANT: this requires Avalanche to be processed BEFORE Base in both
// the token-swap and native-bridge phases — otherwise the AVAX-derived ETH
// would arrive on Base after Base's own sweep already ran.
const AVALANCHE_REDIRECT_TO: ChainKey = 'base';

function effectiveDestChain(src: ChainKey, walletDest: ChainKey): ChainKey {
  if (
    src === 'avalanche' &&
    walletDest !== 'base' &&
    walletDest !== 'avalanche'
  ) {
    return AVALANCHE_REDIRECT_TO;
  }
  return walletDest;
}

// Reorder chain states so avalanche is processed before base. We don't care
// about the ordering of other chains relative to each other; only this pair
// has a producer→consumer relationship (avax sweep deposits ETH on base,
// which base's own sweep then bridges onward to the wallet's destChain).
function orderForAvaxBeforeBase<T extends { chain: { key: ChainKey } }>(items: T[]): T[] {
  const out = [...items];
  out.sort((a, b) => {
    if (a.chain.key === 'avalanche' && b.chain.key === 'base') return -1;
    if (a.chain.key === 'base' && b.chain.key === 'avalanche') return 1;
    return 0;
  });
  return out;
}

interface RecipientList {
  addresses: string[];
}

function loadEvmRecipients(filePath: string): RecipientList {
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
  return { addresses: out };
}

export interface CollectionSummary {
  wallet: EvmAccount;
  destChain: ChainKey;
  finalNativeWei: bigint; // balance on destChain after all swaps+bridges
  swapped: { from: string; chain: ChainKey; outUsd: number; netUsd: number; tx: string[] }[];
  skipped: { reason: string; chain: ChainKey; symbol: string }[];
}

// Result of the read-only "prep" half of a bridge. Contains everything the
// execute half needs but does NOT touch the funder or broadcast a tx.
// Splitting prep from execute is what lets us parallelise quote-fetching
// across multiple chains while keeping execution serial.
interface BridgePrep {
  quote: UnifiedQuote;
  summary: ReturnType<typeof summarise>;
  amountIn: bigint;
  effectiveGasUsd: number;
  effectiveNetUsd: number;
  needsGasReserve: boolean;
}

type PrepResult =
  | { ok: true; prep: BridgePrep }
  | { ok: false; skipped: string };

// Steps 1-4 of the old trySwapAndBridge: gas-reserve trim, quote, gas
// sanity-check, profit check. NO side effects (no funder, no tx). Safe to
// run in parallel across (chain, token) pairs.
async function prepareBridge(
  wallet: EvmAccount,
  srcChain: ChainConfig,
  origin: { address: string; symbol: string; rawAmount: bigint },
  destChain: ChainConfig,
): Promise<PrepResult> {
  const provider = getProvider(srcChain);

  // ── 1. Determine the actual amount to quote.
  //
  // When we bridge the wallet's full native balance, Relay does NOT subtract
  // the user-side tx gas; that produced cascading "insufficient funds for
  // intrinsic transaction cost" errors. So for native bridges we trim the
  // amount by a local gas reserve.
  //
  // The same applies to chains where the "ERC20" is really the native asset
  // in disguise (CELO at 0x471ece… on Celo) — swapping the full token balance
  // leaves no native to pay gas. We treat it the same way.
  const isCeloDualToken =
    srcChain.key === 'celo' &&
    origin.address.toLowerCase() === '0x471ece3750da237f93b8e339c536989b8978a438';
  const needsGasReserve = origin.address === NATIVE_ADDR || isCeloDualToken;

  let amountIn = origin.rawAmount;
  if (needsGasReserve) {
    try {
      const reserve = await gasReserveWei(provider, srcChain);
      if (amountIn <= reserve) {
        return {
          ok: false,
          skipped:
            `balance ${formatEther(amountIn)} ${srcChain.nativeSymbol} ≤ gas reserve ` +
            `${formatEther(reserve)} — nothing left to bridge after gas`,
        };
      }
      amountIn -= reserve;
    } catch (e: any) {
      log.warn(`  ${srcChain.key}: fee-data fetch failed (${e.message}); proceeding without gas reserve`);
    }
  }

  let quote: UnifiedQuote;
  try {
    quote = await bridgeQuote({
      srcChain,
      destChain,
      user: wallet.address,
      recipient: wallet.address, // bring funds to OUR wallet on dest; final send is separate
      originCurrency: origin.address,
      destinationCurrency: NATIVE_ADDR,
      amount: amountIn.toString(),
      slippageBps: SLIPPAGE_BPS,
    });
  } catch (e: any) {
    return { ok: false, skipped: `quote: ${e.message}` };
  }

  const s = summarise(quote);

  // ── 2. Sanity-check Relay's gas estimate.
  // We've seen $3+ values from Relay for tiny zkSync bridges that actually
  // cost cents on-chain. Fall back to local estimate if Relay's number is
  // suspiciously high.
  let effectiveGasUsd = s.gasUsd;
  let usedFallback = false;
  if (s.gasUsd > RELAY_GAS_SANITY_USD) {
    const local = await localGasEstimateUsd(srcChain);
    if (local != null && local < s.gasUsd) {
      effectiveGasUsd = local;
      usedFallback = true;
    }
  }
  const effectiveNetUsd = s.amountOutUsd - effectiveGasUsd;

  log.info(
    `  quote ${srcChain.key}/${origin.symbol} → ${destChain.key}/ETH: ` +
      `in=$${s.amountInUsd.toFixed(4)} out=$${s.amountOutUsd.toFixed(4)} ` +
      `gas=$${effectiveGasUsd.toFixed(4)}${usedFallback ? ` (local; relay said $${s.gasUsd.toFixed(4)})` : ''} ` +
      `net=$${effectiveNetUsd.toFixed(4)}`,
  );

  if (MIN_TOKEN_USD > 0 && s.amountInUsd < MIN_TOKEN_USD) {
    return { ok: false, skipped: `below MIN_TOKEN_USD ($${s.amountInUsd.toFixed(4)} < $${MIN_TOKEN_USD})` };
  }
  if (effectiveNetUsd <= 0) {
    return { ok: false, skipped: `unprofitable (net=$${effectiveNetUsd.toFixed(4)})` };
  }

  return {
    ok: true,
    prep: {
      quote,
      summary: s,
      amountIn,
      effectiveGasUsd,
      effectiveNetUsd,
      needsGasReserve,
    },
  };
}

// Steps 5-6 of the old trySwapAndBridge: funder top-up + execute with the
// existing retry-on-revert + slippage-bump-on-last-attempt loop. Must be
// serial per chain to avoid nonce races and funder coordination conflicts.
async function executeBridge(
  prep: BridgePrep,
  wallet: EvmAccount,
  srcChain: ChainConfig,
  origin: { address: string; symbol: string; rawAmount: bigint },
  destChain: ChainConfig,
  funder: GasFunder,
): Promise<{ tx: string[]; outUsd: number; netUsd: number } | { skipped: string }> {
  const provider = getProvider(srcChain);
  const { quote, summary: s, amountIn, effectiveGasUsd, effectiveNetUsd, needsGasReserve } = prep;

  // ── 3. Optional gas top-up from sponsor wallet.
  //
  // SKIP funder entirely when the SOURCE is native (origin === NATIVE_ADDR,
  // or CELO-on-Celo where the ERC20 IS the native). In that case we already
  // subtracted `gasReserveWei` from `amountIn` above on line ~213, so the
  // wallet keeps `reserve` worth of native sitting as its post-tx balance —
  // exactly enough to pay `gas × maxFeePerGas`. Topping up the sponsor here
  // would double-count: `predictUpfrontWei = gas × maxFeePerGas + value` and
  // `value` itself comes from the same wallet, so `target = upfront × 1.2`
  // is always larger than the wallet balance, and the funder always triggers
  // even though the wallet self-funds. Observed on BNB→Arb, ETH-on-base→Arb,
  // ETH-on-zksync→Arb — wasted ~$0.10 per swap on a redundant top-up.
  //
  // For ERC20 swaps (origin !== NATIVE_ADDR), value=0 and the funder is
  // essential: the wallet may have plenty of USDC but no native to pay gas.
  // We fund off the WORST-CASE UPFRONT (gas × maxFeePerGas), NOT Relay's
  // quote.fees.gas USD (which is the expected actual fee, 2-3× lower than
  // the upfront on zkSync — caused "insufficient funds" rejections before).
  // The exact upfront sits in Relay's tx params; we just sum it.
  if (funder.enabled && !needsGasReserve) {
    let upfront = 0n;
    try {
      upfront = await predictUpfrontWei(quote, srcChain.key);
    } catch (e: any) {
      log.warn(`  predict upfront failed (${e.message}); using local gasReserveWei`);
    }
    if (upfront === 0n) {
      try {
        upfront = await gasReserveWei(provider, srcChain);
      } catch {/* leave 0, funder will no-op */}
    }
    if (upfront > 0n) {
      // 20% headroom for slot-time fee fluctuations between funding and submission.
      const target = (upfront * 12n) / 10n;
      try {
        await funder.topUp(wallet.address, srcChain, target);
      } catch (e: any) {
        log.warn(`  gas top-up failed: ${e.message}`);
      }
    }
  }

  // ── 4. Execute — up to BRIDGE_EXECUTE_MAX_ATTEMPTS tries.
  //
  // Attempts 1..(N-1): reuse the same quote (cheap retry, often clears a
  // transient on-chain hiccup — solver retry / gas spike / liquidity blip).
  // Attempt N (last): re-quote with `SLIPPAGE_BPS + BRIDGE_SLIPPAGE_BUMP_BPS`
  // (default 1% → 3%). This costs an extra API round-trip but handles the
  // "slippage exceeded on intermediate swap" case that triggered the
  // Avalanche→Base failure observed 2026-05-23 (hash 0x704ad7c5…).
  //
  // Safety: we only retry on patterns where funds rolled back (EVM revert
  // restores the source-token balance). Anything else exits immediately so
  // we never double-broadcast a partially-successful multi-step quote.
  let activeQuote: UnifiedQuote = quote;
  let activeSummary = s;
  let activeNetUsd = effectiveNetUsd;
  let lastErr: any;

  for (let attempt = 1; attempt <= BRIDGE_EXECUTE_MAX_ATTEMPTS; attempt++) {
    const isLast = attempt === BRIDGE_EXECUTE_MAX_ATTEMPTS;
    if (attempt > 1 && isLast && BRIDGE_SLIPPAGE_BUMP_BPS > 0) {
      const bumpedSlippage = SLIPPAGE_BPS + BRIDGE_SLIPPAGE_BUMP_BPS;
      log.info(
        `  ${srcChain.key}/${origin.symbol}: attempt ${attempt}/${BRIDGE_EXECUTE_MAX_ATTEMPTS} — re-quoting with slippage ${(bumpedSlippage / 100).toFixed(2)}% (was ${(SLIPPAGE_BPS / 100).toFixed(2)}%)`,
      );
      try {
        activeQuote = await bridgeQuote({
          srcChain,
          destChain,
          user: wallet.address,
          recipient: wallet.address,
          originCurrency: origin.address,
          destinationCurrency: NATIVE_ADDR,
          amount: amountIn.toString(),
          slippageBps: bumpedSlippage,
        });
        activeSummary = summarise(activeQuote);
        // Re-validate net profit on the higher-slippage quote — guards
        // against a degraded route. We DON'T re-run the sanity gas swap
        // because the gas portion is dominated by source-chain fee data,
        // not the quote's internal slippage.
        activeNetUsd = activeSummary.amountOutUsd - effectiveGasUsd;
        if (activeNetUsd <= 0) {
          log.warn(
            `  ${srcChain.key}/${origin.symbol}: high-slippage re-quote unprofitable (net=$${activeNetUsd.toFixed(4)}); giving up`,
          );
          return {
            skipped:
              `execute: ${lastErr?.message ?? 'reverted'} (high-slip re-quote unprofitable)`,
          };
        }
      } catch (e: any) {
        log.warn(
          `  ${srcChain.key}/${origin.symbol}: high-slippage re-quote failed: ${e.message}`,
        );
        return { skipped: `execute: ${lastErr?.message ?? e.message}` };
      }
    }

    try {
      const signer = new Wallet(wallet.privateKey, provider);
      const { txHashes } = await executeQuote(activeQuote, signer, srcChain);
      if (attempt > 1) {
        log.ok(
          `  ${srcChain.key}/${origin.symbol}: succeeded on attempt ${attempt}/${BRIDGE_EXECUTE_MAX_ATTEMPTS}`,
        );
      }
      return {
        tx: txHashes,
        outUsd: activeSummary.amountOutUsd,
        netUsd: activeNetUsd,
      };
    } catch (e: any) {
      lastErr = e;
      if (attempt < BRIDGE_EXECUTE_MAX_ATTEMPTS && isExecuteRetryable(e)) {
        const shortMsg = (e?.message ?? '').slice(0, 100);
        log.warn(
          `  ${srcChain.key}/${origin.symbol}: execute attempt ${attempt}/${BRIDGE_EXECUTE_MAX_ATTEMPTS} reverted (${shortMsg}…); retrying`,
        );
        continue;
      }
      return { skipped: `execute: ${e.message}` };
    }
  }
  // Loop exited without success or explicit skip — defensive return.
  return { skipped: `execute: ${lastErr?.message ?? 'exhausted retries'}` };
}

// Thin wrapper combining prep + execute. Kept for callers that don't need
// the split (none currently, but stable surface area in case anything
// imports it later). New code uses prepareBridge + executeBridge directly.
async function trySwapAndBridge(
  wallet: EvmAccount,
  srcChain: ChainConfig,
  origin: { address: string; symbol: string; rawAmount: bigint },
  destChain: ChainConfig,
  funder: GasFunder,
): Promise<{ tx: string[]; outUsd: number; netUsd: number } | { skipped: string }> {
  const prep = await prepareBridge(wallet, srcChain, origin, destChain);
  if (!prep.ok) return { skipped: prep.skipped };
  return executeBridge(prep.prep, wallet, srcChain, origin, destChain, funder);
}

// Concurrency cap for parallel quote-prep across chains within a single
// wallet's Phase A and Phase B. Default 5 — same chain's RPC sees only one
// in-flight read (we keep tokens within a chain serial), and 5 API hits to
// Relay/LI.FI/Squid in parallel is well below their burst limits. Drop to
// 2 if you hit "too many requests" on an aggregator. 1 = old serial behaviour.
const BRIDGE_QUOTE_CONCURRENCY = Math.max(
  1,
  Number(process.env.BRIDGE_QUOTE_CONCURRENCY || '5'),
);

// Generic semaphore-limited parallel map. Preserves input-order in results.
async function mapWithSemaphore<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= items.length) break;
      await checkPause();
      results[my] = await fn(items[my], my);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return results;
}

// Exported so ULTRA mode (flow/evmUltra.ts) can reuse the full collect-and-
// bridge-to-destChain pass against the hub wallet without duplicating the
// per-chain logic.
export async function collectOneWallet(
  wallet: EvmAccount,
  destChain: ChainConfig,
  funder: GasFunder,
  progress?: { index: number; total: number },
): Promise<CollectionSummary> {
  const prefix = progress ? `[${progress.index + 1}/${progress.total}] ` : '';
  log.step(`${prefix}wallet ${wallet.address} → dest ${destChain.key}`);

  // NB: protocol-adapter exits (Koi/Zora/Stargate) live in their own mode now
  // (`npm run protocols`). They're a separate, slower workflow that the user
  // opts into explicitly. If you've just exited positions there, freed tokens
  // are already in the tokens.ts in-memory cache — but only for the SAME
  // session. For a fresh run, add them to data/custom-tokens.json or run
  // protocols first in the same process.

  const states = await scanWalletAllChains(wallet.address, ALL_CHAIN_KEYS);

  const summary: CollectionSummary = {
    wallet,
    destChain: destChain.key,
    finalNativeWei: 0n,
    swapped: [],
    skipped: [],
  };

  // ── Phase A ─────────────────────────────────────────────────────────────
  // Quotes are fetched in parallel across chains (semaphore-limited) but
  // tokens within a single chain are quoted serially — that keeps any one
  // chain's RPC at 1 in-flight request at a time, which matters on flaky
  // public endpoints. Executes run strictly serially afterwards so funder
  // top-ups don't race and Avalanche-before-Base ordering is preserved.
  const orderedStates = orderForAvaxBeforeBase(states);
  type PhaseAJob = {
    chain: ChainConfig;
    destForSrc: ChainConfig;
    tokens: TokenBalance[];
  };
  const phaseAJobs: PhaseAJob[] = [];
  for (const st of orderedStates) {
    if (st.tokens.length === 0) continue;
    phaseAJobs.push({
      chain: st.chain,
      destForSrc: CHAINS[effectiveDestChain(st.chain.key, destChain.key)],
      tokens: st.tokens,
    });
  }

  type TokenPrep = {
    chain: ChainConfig;
    destForSrc: ChainConfig;
    tb: TokenBalance;
    prep: PrepResult;
  };
  const phaseAPreps: TokenPrep[][] = await mapWithSemaphore(
    phaseAJobs,
    BRIDGE_QUOTE_CONCURRENCY,
    async (job) => {
      const out: TokenPrep[] = [];
      for (const tb of job.tokens) {
        await checkPause();
        let prep: PrepResult;
        try {
          prep = await prepareBridge(
            wallet,
            job.chain,
            { address: tb.token.address, symbol: tb.token.symbol, rawAmount: tb.raw },
            job.destForSrc,
          );
        } catch (e: any) {
          prep = { ok: false, skipped: `prepare crash: ${e.message}` };
        }
        out.push({ chain: job.chain, destForSrc: job.destForSrc, tb, prep });
      }
      return out;
    },
  );

  // Flatten in input order — mapWithSemaphore preserved per-chain order,
  // so Avalanche-before-Base survives.
  const phaseATokenPreps = phaseAPreps.flat();

  for (const item of phaseATokenPreps) {
    await checkPause();
    if (!item.prep.ok) {
      log.warn(`  skip ${item.chain.key}/${item.tb.token.symbol}: ${item.prep.skipped}`);
      summary.skipped.push({
        reason: item.prep.skipped,
        chain: item.chain.key,
        symbol: item.tb.token.symbol,
      });
      continue;
    }
    try {
      const res = await executeBridge(
        item.prep.prep,
        wallet,
        item.chain,
        { address: item.tb.token.address, symbol: item.tb.token.symbol, rawAmount: item.tb.raw },
        item.destForSrc,
        funder,
      );
      if ('skipped' in res) {
        log.warn(`  skip ${item.chain.key}/${item.tb.token.symbol}: ${res.skipped}`);
        summary.skipped.push({
          reason: res.skipped,
          chain: item.chain.key,
          symbol: item.tb.token.symbol,
        });
      } else {
        log.ok(
          `  swap+bridge ${item.chain.key}/${item.tb.token.symbol} → ${item.destForSrc.key}/ETH ` +
            `net $${res.netUsd.toFixed(4)}`,
        );
        summary.swapped.push({
          from: item.tb.token.symbol,
          chain: item.chain.key,
          outUsd: res.outUsd,
          netUsd: res.netUsd,
          tx: res.tx,
        });
      }
    } catch (e: any) {
      log.err(`  crash on ${item.chain.key}/${item.tb.token.symbol}: ${e.message}`);
      summary.skipped.push({
        reason: `crash: ${e.message}`,
        chain: item.chain.key,
        symbol: item.tb.token.symbol,
      });
    }
  }

  // ── Phase B ─────────────────────────────────────────────────────────────
  // Re-scan native balances (Phase A's swaps changed them) and bridge each
  // chain's native to the effective destination. Same parallel-prep /
  // serial-execute structure as Phase A.
  const states2 = await scanWalletAllChains(wallet.address, ALL_CHAIN_KEYS);
  const orderedStates2 = orderForAvaxBeforeBase(states2);

  type NativeJob = {
    chain: ChainConfig;
    destForSrc: ChainConfig;
    nativeBalance: bigint;
  };
  const phaseBJobs: NativeJob[] = [];
  for (const st of orderedStates2) {
    const destForSrc = CHAINS[effectiveDestChain(st.chain.key, destChain.key)];
    if (st.chain.key === destForSrc.key) continue; // already on its destination
    if (st.nativeBalance === 0n) continue;
    phaseBJobs.push({ chain: st.chain, destForSrc, nativeBalance: st.nativeBalance });
  }

  type NativePrep = { job: NativeJob; prep: PrepResult };
  const phaseBPreps: NativePrep[] = await mapWithSemaphore(
    phaseBJobs,
    BRIDGE_QUOTE_CONCURRENCY,
    async (job) => {
      await checkPause();
      let prep: PrepResult;
      try {
        prep = await prepareBridge(
          wallet,
          job.chain,
          { address: NATIVE_ADDR, symbol: job.chain.nativeSymbol, rawAmount: job.nativeBalance },
          job.destForSrc,
        );
      } catch (e: any) {
        prep = { ok: false, skipped: `prepare crash: ${e.message}` };
      }
      return { job, prep };
    },
  );

  for (const { job, prep } of phaseBPreps) {
    await checkPause();
    if (!prep.ok) {
      log.warn(`  skip ${job.chain.key}/${job.chain.nativeSymbol} bridge: ${prep.skipped}`);
      summary.skipped.push({
        reason: prep.skipped,
        chain: job.chain.key,
        symbol: job.chain.nativeSymbol,
      });
      continue;
    }
    try {
      const res = await executeBridge(
        prep.prep,
        wallet,
        job.chain,
        { address: NATIVE_ADDR, symbol: job.chain.nativeSymbol, rawAmount: job.nativeBalance },
        job.destForSrc,
        funder,
      );
      if ('skipped' in res) {
        log.warn(`  skip ${job.chain.key}/${job.chain.nativeSymbol} bridge: ${res.skipped}`);
        summary.skipped.push({
          reason: res.skipped,
          chain: job.chain.key,
          symbol: job.chain.nativeSymbol,
        });
      } else {
        log.ok(
          `  bridge ${job.chain.key}/${job.chain.nativeSymbol} → ${job.destForSrc.key}/ETH ` +
            `net $${res.netUsd.toFixed(4)}`,
        );
        summary.swapped.push({
          from: job.chain.nativeSymbol,
          chain: job.chain.key,
          outUsd: res.outUsd,
          netUsd: res.netUsd,
          tx: res.tx,
        });
      }
    } catch (e: any) {
      log.err(`  crash on ${job.chain.key}/${job.chain.nativeSymbol} bridge: ${e.message}`);
      summary.skipped.push({
        reason: `crash: ${e.message}`,
        chain: job.chain.key,
        symbol: job.chain.nativeSymbol,
      });
    }
  }

  // Third: avalanche-redirect residual.
  // Phase B's base iteration used a snapshot taken BEFORE the avax→base
  // step ran in the same loop. Any AVAX-derived ETH that landed on base
  // mid-loop is therefore NOT covered by base→walletDest. Do one extra
  // base→walletDest bridge fresh-reading base's current balance.
  // Only runs when (a) walletDest is something other than base/avalanche
  // AND (b) avalanche actually had value worth redirecting — otherwise
  // we'd emit a noisy skip log on every Arbitrum-bound wallet.
  const avaxHadValue =
    states.some((s) => s.chain.key === 'avalanche' && s.tokens.length > 0) ||
    states2.some((s) => s.chain.key === 'avalanche' && s.nativeBalance > 0n);
  if (
    avaxHadValue &&
    destChain.key !== 'base' &&
    destChain.key !== 'avalanche'
  ) {
    try {
      const baseNative = await rpcRetry('base', (p) => p.getBalance(wallet.address), {
        label: 'avax-residual:base:getBalance',
        timeoutMs: 15_000,
      });
      if (baseNative > 0n) {
        const res = await trySwapAndBridge(
          wallet,
          CHAINS.base,
          { address: NATIVE_ADDR, symbol: 'ETH', rawAmount: baseNative },
          destChain,
          funder,
        );
        if ('skipped' in res) {
          log.warn(`  skip residual base→${destChain.key} (avax redirect): ${res.skipped}`);
          summary.skipped.push({ reason: res.skipped, chain: 'base', symbol: 'ETH' });
        } else {
          log.ok(
            `  bridge base/ETH → ${destChain.key}/ETH (avax residual) net $${res.netUsd.toFixed(4)}`,
          );
          summary.swapped.push({
            from: 'ETH',
            chain: 'base',
            outUsd: res.outUsd,
            netUsd: res.netUsd,
            tx: res.tx,
          });
        }
      }
    } catch (e: any) {
      log.err(`  residual base→${destChain.key} bridge crashed: ${e.message}`);
    }
  }

  // Read final native balance on dest chain. Uses rpcRetry so a hanging
  // RPC triggers rotation between attempts instead of blocking forever.
  summary.finalNativeWei = await rpcRetry(destChain.key, (p) => p.getBalance(wallet.address), {
    label: `${destChain.key}:final-getBalance`,
    timeoutMs: 15_000,
  });
  log.ok(
    `  done. final on ${destChain.key}: ${formatEther(summary.finalNativeWei)} ETH`,
  );
  return summary;
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
    // Bounds check must happen AFTER `idx++`, not before `await checkPause()`.
    // Otherwise: N workers each see `idx < items.length`, all yield on
    // checkPause, then race to `idx++` after resume. The first claims the
    // last real slot; the rest get `my >= items.length`, items[my] is
    // undefined, and `wallet.address` crashes downstream. Observed live
    // with 210 items × concurrency=4 → 3 workers crashed at the tail.
    while (true) {
      await checkPause();
      const my = idx++;
      if (my >= items.length) break;
      try {
        results[my] = await worker(items[my], my);
      } catch (e) {
        log.err(`wallet ${my + 1} crashed: ${(e as any)?.message || e}`);
        results[my] = fallback(items[my], my, e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => loop()));
  return results;
}

export async function runEvmMode(opts: {
  sources: WalletSources;
  recipientsFile: string;
  // EVM funder private keys. Optional; constructor falls back to env
  // GAS_FUNDER_PRIVATE_KEY when absent.
  funderKeys?: string[];
}): Promise<void> {
  log.step('EVM mode');
  const wallets = loadEvmAccounts(opts.sources);
  log.info(`Loaded ${wallets.length} wallets`);

  const recipients = loadEvmRecipients(opts.recipientsFile);
  log.info(`Loaded ${recipients.addresses.length} recipient addresses`);

  const dests = destChains();
  log.info(`Destination chains (random per wallet): ${dests.join(', ')}`);

  const funder = new GasFunder({ privateKeys: opts.funderKeys });
  if (funder.enabled) {
    log.info(
      `Gas funder${funder.addresses.length > 1 ? 's' : ''} enabled (${funder.addresses.length}, max $${funder.maxUsdPerTopUp}/top-up): ${funder.addresses.join(', ')}`,
    );
  } else {
    log.warn(`Gas funder disabled — wallets without native gas will be skipped`);
  }

  // Defensive filter: if a funder address also appears in the source list
  // (user pasted the same key in both files by mistake), drop it from the
  // source list. Otherwise Phase 1 sweeps the funder's own balance off to
  // a recipient, which is the opposite of what the user wants. Mirrors the
  // same guard in evmUltra.ts where the bug was first observed.
  const funderLowerSet = new Set(funder.addresses.map((a) => a.toLowerCase()));
  const filteredWallets = wallets.filter(
    (w) => !funderLowerSet.has(w.address.toLowerCase()),
  );
  const droppedFunders = wallets.length - filteredWallets.length;
  if (droppedFunders > 0) {
    log.warn(
      `Dropped ${droppedFunders} source wallet(s) matching the funder address(es) — ` +
        `they would have been swept away from your gas funder.`,
    );
  }
  if (filteredWallets.length === 0) {
    throw new Error('No source wallets left after removing the funder from the source list');
  }

  // Assign dest chain randomly per wallet.
  const plans = filteredWallets.map((w) => ({ w, destKey: pickRandom(dests) as ChainKey }));
  // Shuffle source→recipient mapping: shuffle wallets, then assign round-robin.
  const shuffledIdx = shuffle(plans.map((_, i) => i));
  const assignment: { plan: typeof plans[number]; recipient: string }[] = [];
  for (let i = 0; i < shuffledIdx.length; i++) {
    const plan = plans[shuffledIdx[i]];
    const recipient = recipients.addresses[i % recipients.addresses.length];
    assignment.push({ plan, recipient });
  }

  console.log(chalk.bold('\nPlanned mapping (will be confirmed again before sends):'));
  for (const a of assignment) {
    console.log(
      `  ${chalk.cyan(a.plan.w.address)} → bridge to ${chalk.yellow(a.plan.destKey)} ` +
        `→ send to ${chalk.green(a.recipient)}`,
    );
  }

  // Phase 1: collect & bridge.
  const concurrency = Math.max(1, Number(process.env.CONCURRENCY || '2'));
  log.step(`Phase 1: collect dust on ${filteredWallets.length} wallets (concurrency=${concurrency})`);
  const summaries = await withConcurrency(
    assignment,
    async (a, i) =>
      collectOneWallet(a.plan.w, CHAINS[a.plan.destKey], funder, {
        index: i,
        total: assignment.length,
      }),
    concurrency,
    (a) => ({
      wallet: a.plan.w,
      destChain: a.plan.destKey,
      finalNativeWei: 0n,
      swapped: [],
      skipped: [{ reason: 'wallet-level crash', chain: a.plan.destKey, symbol: '-' }],
    }),
  );

  // Phase 2: print final per-destination balances and ask for confirmation.
  console.log(chalk.bold('\nBalances ready to send:'));
  const ethPriceUsd = await getUsdPrice('ethereum');
  let totalUsd = 0;
  const sendPlan: {
    wallet: EvmAccount;
    destChain: ChainConfig;
    recipient: string;
    balanceWei: bigint;
  }[] = [];
  for (let i = 0; i < assignment.length; i++) {
    const a = assignment[i];
    const s = summaries[i];
    const wei = s.finalNativeWei;
    const eth = Number(formatEther(wei));
    const usd = eth * ethPriceUsd;
    totalUsd += usd;
    console.log(
      `  ${a.plan.w.address} on ${a.plan.destKey}: ` +
        `${eth.toFixed(6)} ETH (~$${usd.toFixed(2)}) → ${a.recipient}`,
    );
    if (wei > 0n) {
      sendPlan.push({
        wallet: a.plan.w,
        destChain: CHAINS[a.plan.destKey],
        recipient: a.recipient,
        balanceWei: wei,
      });
    }
  }
  console.log(chalk.bold(`Total: ~$${totalUsd.toFixed(2)} across ${sendPlan.length} wallets`));

  if (sendPlan.length === 0) {
    log.warn('Nothing to send.');
    return;
  }

  const answer = await prompts({
    type: 'confirm',
    name: 'go',
    message: 'Proceed with sending these balances to the recipients?',
    initial: false,
  });
  if (!answer.go) {
    log.warn('User declined. No transfers will be made.');
    return;
  }

  // Phase 3: send. Two transactions per wallet:
  //   1. 90% → recipient (user-first, so a dev-fee failure can't strand the user)
  //   2. 10% → dev fee address (from fee/devSplit.ts chokepoint)
  // Gas for BOTH txs is reserved upfront from the wallet's balance, then the
  // remainder is split 90/10. Explicit nonces sequence the two sends.
  log.step(`Phase 3: send native balances to recipients (90% user / ${FEE_BPS / 100}% fee)`);
  const devAddr = getDevDestinations().evm;
  for (const p of sendPlan) {
    try {
      const chainKey = p.destChain.key;
      const feeData = await rpcRetry(chainKey, (prov) => prov.getFeeData(), {
        label: `send:${chainKey}:getFeeData`,
        timeoutMs: 15_000,
      });
      const maxFeePerGas =
        feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
      const maxPriorityFeePerGas =
        feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 1n;

      // Ask the node for the actual intrinsic gas. On Arbitrum/Optimism/zkSync
      // a vanilla "21000" transfer reverts as "intrinsic gas too low" because
      // L1 calldata pricing adds dynamic overhead. estimateGas accounts for it.
      let gasLimit: bigint;
      try {
        const estimated = await rpcRetry(
          chainKey,
          (prov) =>
            prov.estimateGas({
              from: p.wallet.address,
              to: p.recipient,
              value: 0n,
            }),
          {
            label: `send:${chainKey}:estimateGas`,
            timeoutMs: 15_000,
          },
        );
        gasLimit = (estimated * 12n) / 10n; // 20% cushion
      } catch (e: any) {
        log.warn(
          `  estimateGas failed (${e.message}); using 50000 as safe default`,
        );
        gasLimit = 50_000n;
      }

      // Pre-fetch nonce so we can sequence the user-tx and dev-tx reliably
      // without depending on the provider's pending-pool view between calls.
      const startNonce = await rpcRetry(
        chainKey,
        (prov) => prov.getTransactionCount(p.wallet.address, 'pending'),
        { label: `send:${chainKey}:nonce`, timeoutMs: 15_000 },
      );

      // On OP-Stack chains the up-front balance check includes a SEPARATE L1
      // calldata fee on top of (gasLimit × maxFeePerGas). We were observing
      // ~1.3 GWei deficits because we didn't reserve it. Query the canonical
      // GasPriceOracle at 0x420…000F to get the exact L1 fee for this tx.
      let opStackL1Fee = 0n;
      if (OP_STACK_CHAINS.has(chainKey)) {
        try {
          // Build an unsigned tx with the same shape we're about to broadcast,
          // RLP-serialize it, and ask the oracle what the L1 portion costs.
          const unsigned = Transaction.from({
            type: 2,
            chainId: p.destChain.chainId,
            nonce: startNonce,
            maxFeePerGas,
            maxPriorityFeePerGas,
            gasLimit,
            to: p.recipient,
            value: 0n, // value substituted later; size is what matters
            data: '0x',
          }).unsignedSerialized;
          const fee: bigint = await rpcRetry(
            chainKey,
            (prov) =>
              new Contract(GAS_PRICE_ORACLE, GAS_PRICE_ORACLE_ABI, prov).getL1Fee(unsigned),
            { label: `send:${chainKey}:getL1Fee`, timeoutMs: 15_000 },
          );
          // Signed tx is ~67 bytes longer than unsigned; add 50% cushion to be safe.
          opStackL1Fee = (fee * 15n) / 10n;
        } catch (e: any) {
          // Conservative flat fallback: 20 GWei (~$0.000045 — irrelevant cost).
          log.warn(`  L1 fee query failed on ${chainKey} (${e.message}); using flat reserve`);
          opStackL1Fee = 20_000_000_000n;
        }
      }

      // Reserve gas for TWO txs (user + dev). On OP-Stack the per-tx L1 fee
      // applies to each, so it doubles too.
      const gasCostOne = gasLimit * maxFeePerGas + opStackL1Fee;
      const gasCostBoth = gasCostOne * 2n;
      const balance = await rpcRetry(
        chainKey,
        (prov) => prov.getBalance(p.wallet.address),
        { label: `send:${chainKey}:getBalance`, timeoutMs: 15_000 },
      );
      if (balance <= gasCostBoth) {
        log.warn(
          `skip send from ${p.wallet.address} on ${chainKey}: balance ${formatEther(
            balance,
          )} ≤ 2×gas reserve ${formatEther(gasCostBoth)}`,
        );
        continue;
      }
      const sendable = balance - gasCostBoth;
      const { devShare, userShare } = splitAmount(sendable);

      // Inner broadcast helper. rpcRetry rebuilds the signer per attempt (bound
      // to the possibly-rotated provider). "already known" → first attempt did
      // reach mempool; caller decides whether to keep going.
      const broadcast = (to: string, value: bigint, nonce: number) =>
        rpcRetry(
          chainKey,
          (prov) => {
            const signer = new Wallet(p.wallet.privateKey, prov);
            return signer.sendTransaction({
              to,
              value,
              gasLimit,
              maxFeePerGas,
              maxPriorityFeePerGas,
              nonce,
            });
          },
          { attempts: 3, baseMs: 1500, label: `send ${chainKey}`, timeoutMs: 30_000 },
        );

      const isAlreadyKnown = (e: any) => {
        const msg = (e?.message || '') + ' ' + (e?.error?.message || '');
        return msg.includes('already known') || msg.includes('ALREADY_EXISTS');
      };

      // --- USER TX (90%, nonce N) -----------------------------------------
      let userTx: any;
      try {
        userTx = await broadcast(p.recipient, userShare, startNonce);
      } catch (e: any) {
        if (isAlreadyKnown(e)) {
          // First broadcast hit mempool; we have no tx object to wait on, and
          // can't safely send dev-tx with nonce+1 (user tx might still revert).
          log.warn(`  user send already in mempool on ${chainKey}; skipping dev-fee tx`);
          continue;
        }
        throw e;
      }
      log.info(`  send user ${p.wallet.address} → ${p.recipient}: ${userTx.hash}`);
      const userRcpt = await waitForTxWithRotation(chainKey, userTx.hash);
      if (!userRcpt || userRcpt.status !== 1) throw new Error('user tx reverted');
      log.ok(`  sent ${formatEther(userShare)} ETH to recipient on ${chainKey}`);

      // --- DEV TX (10%, nonce N+1) ----------------------------------------
      // If this fails the user still got their funds — don't surface as fatal.
      try {
        const devTx = await broadcast(devAddr, devShare, startNonce + 1);
        log.info(`  send fee  ${p.wallet.address} → ${devAddr}: ${devTx.hash}`);
        const devRcpt = await waitForTxWithRotation(chainKey, devTx.hash);
        if (!devRcpt || devRcpt.status !== 1) {
          log.err(`  dev-fee tx reverted on ${chainKey} (user already paid)`);
        } else {
          log.ok(`  sent ${formatEther(devShare)} ETH fee on ${chainKey}`);
        }
      } catch (e: any) {
        if (isAlreadyKnown(e)) {
          log.warn(`  dev-fee send already in mempool on ${chainKey}; not waiting`);
        } else {
          log.err(`  dev-fee tx failed on ${chainKey} (user already paid): ${e.message}`);
        }
      }
    } catch (e: any) {
      log.err(`send failed for ${p.wallet.address}: ${e.message}`);
    }
  }
  log.ok('All done.');
}

// ---------------------------------------------------------------------------
// Read-only scan. No transactions. Reports per-wallet balances and how much
// the gas funder would need on each chain to actually execute the sweep.
// ---------------------------------------------------------------------------

const SWAP_GAS_BUDGET = 300_000n; // rough budget per token swap on EVM

// Stablecoins whose USD value we can approximate as `amount × $1` without
// hitting an external price API. Used by the scan to decide whether a token
// is "worth swapping" given current gas — so we don't bother reporting
// "NEEDS GAS" for a position that's obviously below cost.
const STABLECOIN_SYMBOLS = new Set([
  'USDT', 'USDC', 'USDC.e', 'USDbC', 'DAI', 'BUSD', 'cUSD', 'cEUR',
  'USDB', 'FDUSD', 'fUSDT', 'USDe',
]);

function estimateTokenUsd(symbol: string, humanAmount: number): number | null {
  if (STABLECOIN_SYMBOLS.has(symbol)) return humanAmount * 1.0;
  return null; // unknown — price not derivable without a quote
}

export async function runEvmScan(opts: { sources: WalletSources }): Promise<void> {
  log.step('EVM scan (no transactions)');
  const wallets = loadEvmAccounts(opts.sources);
  log.info(`Loaded ${wallets.length} wallets`);

  // Get current native USD prices for every chain in one batch.
  const cgIds = Array.from(new Set(ALL_CHAIN_KEYS.map((k) => CHAINS[k].nativeCoingeckoId)));
  const prices = await getUsdPricesMany(cgIds);

  // Per-chain gas estimate per swap.
  log.info('Fetching gas prices across chains…');
  const gasEstimates: Record<ChainKey, { gasPriceWei: bigint; usdPerSwap: number; ok: boolean }> =
    {} as any;
  await Promise.all(
    ALL_CHAIN_KEYS.map(async (k) => {
      const chain = CHAINS[k];
      try {
        const provider = getProvider(chain);
        const feeData = await retry(() => provider.getFeeData(), { attempts: 2, baseMs: 400 });
        const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
        const totalWei = gasPrice * SWAP_GAS_BUDGET;
        const totalNative = Number(formatEther(totalWei));
        const price = prices[chain.nativeCoingeckoId] ?? 0;
        gasEstimates[k] = { gasPriceWei: gasPrice, usdPerSwap: totalNative * price, ok: true };
      } catch (e: any) {
        log.warn(`${k}: gas fetch failed (${e.message})`);
        gasEstimates[k] = { gasPriceWei: 0n, usdPerSwap: 0, ok: false };
      }
    }),
  );

  // Scan each wallet sequentially (gentler on public RPCs; scan is light anyway).
  const funderNeeds = new Map<ChainKey, { walletCount: number; usdTotal: number }>();
  let totalNativeUsdAcrossAll = 0;
  const walletHasTokens: { addr: string; chains: string[] }[] = [];

  for (let i = 0; i < wallets.length; i++) {
    // Cooperative pause checkpoint between wallets. Ctrl+C stalls the
    // scan loop here; the previously-started wallet finishes its 17-chain
    // multicall first.
    await checkPause();
    const w = wallets[i];
    console.log(chalk.bold(`\nWallet ${i + 1}/${wallets.length}: ${w.address}`));

    // Protocol-adapter scan lives in its own mode (`npm run scan:protocols`)
    // so this fast dust scan doesn't pay for per-wallet adapter enumeration.

    const states = await scanWalletAllChains(w.address, ALL_CHAIN_KEYS);
    const chainsWithSomething: string[] = [];

    for (const st of states) {
      const native = Number(formatEther(st.nativeBalance));
      const nativePrice = prices[st.chain.nativeCoingeckoId] ?? 0;
      const nativeUsd = native * nativePrice;
      const hasTokens = st.tokens.length > 0;

      // Skip totally empty chains from the per-wallet output to reduce noise.
      if (!hasTokens && nativeUsd < 0.001) continue;

      const gas = gasEstimates[st.chain.key];

      // For each token, decide whether it's likely worth a swap. A swap is
      // pointless if our best estimate of its USD value is less than the gas
      // it would cost. We can only price stablecoins without a Relay quote;
      // anything else is treated as "unknown — worth attempting".
      const tokenSummaryParts: string[] = [];
      let swappableCount = 0;
      for (const t of st.tokens) {
        const human = Number(t.human);
        const estUsd = estimateTokenUsd(t.token.symbol, human);
        // Below-cost threshold: 1.5× gas to leave a meaningful net.
        const belowCost =
          gas.ok && estUsd != null && estUsd < gas.usdPerSwap * 1.5;
        if (belowCost) {
          tokenSummaryParts.push(
            chalk.gray(
              `${t.token.symbol}:${human.toFixed(6)} (skip <gas $${estUsd.toFixed(4)})`,
            ),
          );
        } else {
          tokenSummaryParts.push(`${t.token.symbol}:${human.toFixed(6)}`);
          swappableCount += 1;
        }
      }
      const tokenSummary = tokenSummaryParts.join(', ');

      // Flag "needs gas" only if there's at least one swappable token AND
      // current native is below half a swap's worth.
      const needsGas = swappableCount > 0 && gas.ok && nativeUsd < gas.usdPerSwap * 0.5;

      const flag = needsGas ? chalk.yellow(` ⚠ NEEDS ~$${gas.usdPerSwap.toFixed(3)} gas`) : '';
      const nativeStr =
        `${native.toFixed(6).padStart(12)} ${st.chain.nativeSymbol.padEnd(4)} ` +
        `($${nativeUsd.toFixed(3).padStart(7)})`;

      console.log(
        `  ${st.chain.key.padEnd(10)} ${chalk.gray(nativeStr)}  ` +
          `${tokenSummary || chalk.gray('—')}${flag}`,
      );

      totalNativeUsdAcrossAll += nativeUsd;
      if (hasTokens || nativeUsd > 0.01) chainsWithSomething.push(st.chain.key);

      if (needsGas) {
        const entry = funderNeeds.get(st.chain.key) ?? { walletCount: 0, usdTotal: 0 };
        entry.walletCount += 1;
        entry.usdTotal += gas.usdPerSwap * swappableCount;
        funderNeeds.set(st.chain.key, entry);
      }
    }

    if (chainsWithSomething.length === 0) {
      console.log(chalk.gray('  (all chains empty)'));
    }
    walletHasTokens.push({ addr: w.address, chains: chainsWithSomething });
  }

  // ===== Summary =====
  console.log(chalk.bold('\n========== Gas funder requirements =========='));
  if (funderNeeds.size === 0) {
    console.log(
      chalk.green(
        '  None. Every wallet that has tokens also has enough native gas to swap.',
      ),
    );
  } else {
    console.log(
      chalk.gray(
        '  Estimate per swap = current gasPrice × 300k gas. Multiplied by # of token positions per wallet.\n',
      ),
    );
    let grandUsd = 0;
    for (const [k, v] of funderNeeds) {
      const chain = CHAINS[k];
      const native = v.usdTotal / (prices[chain.nativeCoingeckoId] || 1);
      grandUsd += v.usdTotal;
      console.log(
        `  ${k.padEnd(10)}: ${String(v.walletCount).padStart(3)} wallets need gas, ` +
          `~$${v.usdTotal.toFixed(2).padStart(6)} (${native.toFixed(6)} ${chain.nativeSymbol})`,
      );
    }
    console.log(chalk.bold(`  Total funder needs ≈ $${grandUsd.toFixed(2)}\n`));
    console.log(
      chalk.gray(
        '  Set GAS_FUNDER_PRIVATE_KEY in .env and pre-fund this wallet with native\n' +
          '  on the chains above. GAS_FUNDER_MAX_USD_PER_TOPUP caps individual top-ups.',
      ),
    );
  }

  const populated = walletHasTokens.filter((w) => w.chains.length > 0);
  console.log(
    chalk.bold(
      `\n${populated.length}/${wallets.length} wallets have something. ` +
        `Total native USD across all chains: ~$${totalNativeUsdAcrossAll.toFixed(2)}`,
    ),
  );
  console.log(
    chalk.gray(
      'Note: USD values for ERC20 tokens not shown in scan mode (would require a Relay quote per token).\n' +
        'Run without --scan-only to get per-token quotes and execute the sweep.',
    ),
  );

  // ===== Active-seeds list =====
  // Write a separate file of mnemonics that had any balance. Privkey-derived
  // wallets are skipped here (no mnemonic to write) — those users can prune
  // their privkeys-evm.txt by hand if they want the same speedup.
  const activeSeeds: string[] = [];
  let privkeyOnlyWithBalance = 0;
  for (let i = 0; i < wallets.length; i++) {
    if (!walletHasTokens[i]?.chains.length) continue;
    if (wallets[i].seed) activeSeeds.push(wallets[i].seed as string);
    else privkeyOnlyWithBalance += 1;
  }
  if (activeSeeds.length > 0 && activeSeeds.length < wallets.length) {
    const outPath = path.resolve(process.cwd(), 'data', 'seeds-evm-active.txt');
    // Use os.EOL (CRLF on Windows) for the entire file so the user can paste
    // its contents straight back into the wizard. LF-only files copied via
    // PowerShell / Windows Terminal can arrive at the program as one glued
    // line, breaking BIP39 parsing.
    const header =
      `# Auto-generated by EVM scan on ${new Date().toISOString()}${EOL}` +
      `# ${activeSeeds.length} of ${wallets.length} mnemonic-derived wallets had something on at least one EVM chain.${EOL}` +
      `# To skip empty wallets next run, replace seeds-evm.txt with this file.${EOL}${EOL}`;
    fs.writeFileSync(outPath, header + activeSeeds.join(EOL) + EOL);
    console.log(
      chalk.cyan(
        `\nWrote ${activeSeeds.length} non-empty seed phrases to data/seeds-evm-active.txt. ` +
          `Rename it to seeds-evm.txt next run to skip the empty wallets.` +
          (privkeyOnlyWithBalance > 0
            ? ` (${privkeyOnlyWithBalance} more privkey-derived wallets had balances; trim privkeys-evm.txt by hand.)`
            : ''),
      ),
    );
  }
}

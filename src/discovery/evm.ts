import { Contract, JsonRpcProvider, Interface, getAddress, Network } from 'ethers';
import { ChainConfig, ChainKey, CHAINS } from '../config/chains';
import { TokenInfo, loadTokens } from '../config/tokens';
import { retry, sleep, withTimeout } from '../utils/retry';
import { log } from '../utils/logger';

// Per-RPC timeout. Public RPCs sometimes hang for tens of seconds when rate-
// limited; without a cap, scanWalletAllChains's Promise.all is held hostage
// by the slowest chain and the whole wallet "freezes".
const RPC_CALL_TIMEOUT_MS = 8000;

// Rotation policy: each chain has multiple RPC endpoints in chains.ts.
// After ROTATE_AFTER_FAILS consecutive failures on the current endpoint, we
// switch to the next one. Only when every endpoint has failed ~this many
// times do we give up on the chain for the rest of the session.
//
// ROTATE_AFTER_FAILS=1 means: ANY failure (timeout, 5xx) on current RPC →
// rotate immediately to the next URL. Set this low because a timeout in the
// flow layer is expensive — 30s for a read, 60-180s for a tx wait. Better to
// switch endpoints fast and recover than to retry a stuck endpoint.
// noteSuccess() resets counters, so a single transient blip doesn't snowball.
const ROTATE_AFTER_FAILS = 1;
const DISABLE_AFTER_FAILS_PER_RPC = 2; // total fails ≥ N_rpcs * this → disable

interface RpcState {
  idx: number;          // current RPC index into chain.rpcs
  currentFails: number; // consecutive fails on the current RPC
  totalFails: number;   // cumulative fails across all RPCs since last success
}

const RPC_STATE = new Map<ChainKey, RpcState>();
const DISABLED_NOTICED = new Set<ChainKey>();

function getState(chain: ChainKey): RpcState {
  let s = RPC_STATE.get(chain);
  if (!s) {
    s = { idx: 0, currentFails: 0, totalFails: 0 };
    RPC_STATE.set(chain, s);
  }
  return s;
}

export function currentRpcUrl(chain: ChainKey): string {
  const cfg = CHAINS[chain];
  const s = getState(chain);
  return cfg.rpcs[s.idx] ?? cfg.rpcs[0];
}

function disableThreshold(chain: ChainKey): number {
  return CHAINS[chain].rpcs.length * DISABLE_AFTER_FAILS_PER_RPC;
}

// Exported so other layers (flow/evm, swap/relay, gas/funder) can signal
// an RPC failure they observed (timeout, 5xx, etc.) and trigger the same
// rotation/disable logic that discovery-time scans use.
export function noteRpcFailure(chain: ChainKey): void {
  noteFailure(chain);
}

function noteFailure(chain: ChainKey): void {
  const cfg = CHAINS[chain];
  const s = getState(chain);
  s.currentFails++;
  s.totalFails++;

  if (s.totalFails >= disableThreshold(chain)) {
    if (!DISABLED_NOTICED.has(chain)) {
      DISABLED_NOTICED.add(chain);
      log.err(
        `${chain}: all ${cfg.rpcs.length} RPC endpoints failed (${s.totalFails} total failures); ` +
          `disabling for the rest of this run. Set RPC_${chain.toUpperCase()} in .env to a working ` +
          `endpoint and re-run.`,
      );
    }
    return;
  }

  if (s.currentFails >= ROTATE_AFTER_FAILS && cfg.rpcs.length > 1) {
    const prevUrl = cfg.rpcs[s.idx];
    const nextIdx = (s.idx + 1) % cfg.rpcs.length;
    s.idx = nextIdx;
    s.currentFails = 0;
    providerCache.delete(chain);
    log.warn(
      `${chain}: RPC ${prevUrl} failed ${ROTATE_AFTER_FAILS}x; rotating to ${cfg.rpcs[nextIdx]}`,
    );
  }
}

function isDisabled(chain: ChainKey): boolean {
  const s = RPC_STATE.get(chain);
  if (!s) return false;
  return s.totalFails >= disableThreshold(chain);
}

function noteSuccess(chain: ChainKey): void {
  const s = RPC_STATE.get(chain);
  if (s) {
    s.currentFails = 0;
    s.totalFails = 0;
  }
  DISABLED_NOTICED.delete(chain);
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];

const erc20Iface = new Interface(ERC20_ABI);

export interface TokenBalance {
  token: TokenInfo;
  raw: bigint;
  human: string; // formatted
}

export interface WalletChainState {
  chain: ChainConfig;
  nativeBalance: bigint;
  tokens: TokenBalance[];
}

const providerCache = new Map<ChainKey, JsonRpcProvider>();

export function getProvider(chain: ChainConfig): JsonRpcProvider {
  let p = providerCache.get(chain.key);
  if (!p) {
    const url = currentRpcUrl(chain.key);
    // Build a plugin-free Network manually instead of letting ethers v6
    // resolve `chainId → Network.from(chainId)`. The auto-resolver attaches
    // chain-specific plugins — most notoriously a PolygonGasStationPlugin
    // that hooks `getFeeData()` to call https://gasstation.polygon.technology
    // outside our RPC rotation. When that endpoint times out or returns
    // garbage (current state, 2026-05) every Polygon call crashes with
    // SERVER_ERROR and our normal rotation can't recover. Passing a vanilla
    // Network instance with `staticNetwork: <that instance>` bypasses the
    // plugin chain entirely; getFeeData() then falls back to eth_gasPrice
    // on the underlying RPC, which is what we actually want.
    const network = new Network(chain.name, BigInt(chain.chainId));
    p = new JsonRpcProvider(url, network, { staticNetwork: network });
    providerCache.set(chain.key, p);
  }
  return p;
}

// rpcRetry: retry an RPC operation with two things the bare `retry()` doesn't
// do for us —
//   1. The closure receives a FRESH provider each attempt (so if rotation
//      happens mid-retry, the next attempt uses the new RPC endpoint).
//   2. Timeout errors trigger `noteRpcFailure(chain)`, which after a few
//      consecutive failures rotates the cached provider to the next URL in
//      `chain.rpcs`. So a stuck endpoint stops swallowing wall-clock time
//      across the rest of the session.
//
// Use this everywhere a non-discovery layer (flow, swap, gas funder, etc.)
// calls a chain-bound provider/contract method. For tx.wait()-style calls
// pass `timeoutMs: 180_000` (default 30s is the right cap for read calls and
// broadcasts).
export async function rpcRetry<T>(
  chainKey: ChainKey,
  fn: (provider: JsonRpcProvider) => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label?: string; timeoutMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const label = opts.label ?? `${chainKey}:rpcRetry`;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const provider = getProvider(CHAINS[chainKey]);
    try {
      const result = timeoutMs > 0
        ? await withTimeout(fn(provider), timeoutMs, label)
        : await fn(provider);
      // Reset failure counters so a single transient blip earlier doesn't
      // keep us one-fail-away from rotating away from a now-healthy RPC.
      noteSuccess(chainKey);
      return result;
    } catch (e: any) {
      lastErr = e;
      // Treat both our own withTimeout signal AND ethers/network 5xx codes as
      // signals to bump the failure counter. Once it crosses ROTATE_AFTER_FAILS
      // (2), the provider cache is dropped and the next iteration picks the
      // next RPC in chain.rpcs.
      const msg = String(e?.message ?? '');
      const code = String(e?.code ?? '');
      const looksLikeRpcFault =
        msg.includes('timeout after') ||
        code === 'SERVER_ERROR' ||
        code === 'NETWORK_ERROR' ||
        code === 'TIMEOUT' ||
        /\b5\d\d\b/.test(msg);
      if (looksLikeRpcFault) {
        noteRpcFailure(chainKey);
      }
      if (i === attempts - 1) break;
      const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Wait for a tx receipt while tolerating RPC failures: each attempt goes
// through `rpcRetry`, which (a) re-acquires the provider per attempt — so if
// rotation kicks in mid-wait, the next attempt uses the new RPC — and (b)
// reports timeouts to `noteRpcFailure`, which is what drives the rotation.
//
// Without this, the typical failure looked like: send tx → tx.wait() blocks
// 3 minutes on a slow public RPC → timeout → script gives up. With this:
// first attempt times out at 60s → counted as a fault → second attempt uses
// the rotated RPC → receipt usually comes back in seconds.
//
// Generic enough that flow/evm.ts (Phase 3 send) and swap/relay.ts both call it.
export async function waitForTxWithRotation(
  chainKey: ChainKey,
  hash: string,
): Promise<{ status?: number } | null> {
  return rpcRetry(
    chainKey,
    async (p) => {
      // ethers' waitForTransaction internally polls eth_getTransactionReceipt
      // until the receipt arrives or its own timeout fires. Cap at 60s/attempt
      // so a stuck endpoint is detected fast.
      return (await p.waitForTransaction(hash, 1, 60_000)) as { status?: number } | null;
    },
    {
      attempts: 4,        // 4 × 60s = up to 4 min total, with rotation between attempts
      timeoutMs: 75_000,  // outer cap > inner 60s ethers timeout, with slack
      baseMs: 1_000,
      label: `wait:${chainKey}:${hash.slice(0, 10)}`,
    },
  );
}

export async function scanWalletOnChain(
  address: string,
  chain: ChainConfig,
): Promise<WalletChainState> {
  // Short-circuit if this chain has already failed too many times.
  if (isDisabled(chain.key)) {
    return { chain, nativeBalance: 0n, tokens: [] };
  }

  const provider = getProvider(chain);
  const tokens = loadTokens()[chain.key];
  const owner = getAddress(address);

  let nativeBalance: bigint;
  try {
    // Aggressive timeout on the call itself; only ONE retry to keep the
    // worst-case wallet-scan time bounded (~16s) even on a flaky chain.
    nativeBalance = await retry(
      () =>
        withTimeout(provider.getBalance(owner), RPC_CALL_TIMEOUT_MS, `${chain.key}:getBalance`),
      { attempts: 2, baseMs: 400, label: `${chain.key}:getBalance` },
    );
  } catch (e: any) {
    noteFailure(chain.key);
    throw e;
  }

  if (tokens.length === 0) {
    noteSuccess(chain.key);
    return { chain, nativeBalance, tokens: [] };
  }

  // Multicall ERC20 balanceOf for all curated tokens at once.
  const mc = new Contract(chain.multicall3, MULTICALL3_ABI, provider);
  const calls = tokens.map((t) => ({
    target: t.address,
    allowFailure: true,
    callData: erc20Iface.encodeFunctionData('balanceOf', [owner]),
  }));

  let results: { success: boolean; returnData: string }[];
  try {
    results = await retry(
      () =>
        withTimeout(
          mc.aggregate3.staticCall(calls),
          RPC_CALL_TIMEOUT_MS,
          `${chain.key}:multicall`,
        ),
      { attempts: 2, baseMs: 400, label: `${chain.key}:multicall` },
    );
  } catch (e: any) {
    noteFailure(chain.key);
    log.warn(`${chain.key}: multicall failed (${e.message}); skipping token scan`);
    // Don't fall back to per-token (it's slow when an RPC is rate-limited).
    return { chain, nativeBalance, tokens: [] };
  }
  noteSuccess(chain.key);

  const balances: TokenBalance[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const r = results[i];
    if (!r?.success || r.returnData === '0x') continue;
    try {
      const decoded = erc20Iface.decodeFunctionResult('balanceOf', r.returnData);
      const raw: bigint = decoded[0];
      if (raw > 0n) {
        balances.push({
          token: t,
          raw,
          human: formatUnits(raw, t.decimals),
        });
      }
    } catch {
      // skip malformed responses
    }
  }

  return { chain, nativeBalance, tokens: balances };
}

export async function scanWalletAllChains(
  address: string,
  chains: ChainKey[],
): Promise<WalletChainState[]> {
  // Run chains in parallel but cap to avoid hammering public RPCs.
  const states: WalletChainState[] = [];
  const POOL = 4;
  let idx = 0;
  async function worker() {
    while (idx < chains.length) {
      const my = idx++;
      const ck = chains[my];
      try {
        const st = await scanWalletOnChain(address, CHAINS[ck]);
        states.push(st);
      } catch (e: any) {
        log.warn(`${ck}: scan failed for ${address}: ${e.message}`);
        states.push({ chain: CHAINS[ck], nativeBalance: 0n, tokens: [] });
      }
    }
  }
  await Promise.all(Array.from({ length: POOL }, () => worker()));
  return states;
}

function formatUnits(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, -decimals);
  let frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : intPart;
}

import { Contract, Interface, Wallet } from 'ethers';
import { CHAINS } from '../config/chains';
import { getProvider } from '../discovery/evm';
import { EvmAccount } from '../wallet/derive';
import { log } from '../utils/logger';
import { retry, withTimeout } from '../utils/retry';
import { ProtocolAdapter, Position, ExitResult, FreedToken } from './types';

// ===========================================================================
// Koi Finance addresses on zkSync Era.
// Source: docs.koi.finance/info/tokenomics/token-contracts.md (queried 2026-05-17).
// Koi is the rebrand of MuteSwitch — the v2 factory and pair contracts are
// the original Mute deployments; LP tokens still report names like
// "Volatile Mute LP (USDC/WETH)" with symbol "vMLP". Despite the historical
// branding, all v2 pairs are managed by Koi's UI today.
// ===========================================================================
const KOI_V3_NPM = '0xa459EbF3E6A6d5875345f725bA3F107340b67732'; // V3 NFT position manager
const KOI_V2_FACTORY = '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D'; // v2 (volatile) pair factory
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// ---- ABIs (subset, kept inline so each adapter is self-contained) -------
const NPM_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
];
const FACTORY_V2_ABI = [
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
];
const PAIR_V2_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function burn(address to) returns (uint256 amount0, uint256 amount1)',
];
const ERC20_META_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];

const npmIface = new Interface(NPM_ABI);
const factoryV2Iface = new Interface(FACTORY_V2_ABI);
const pairV2Iface = new Interface(PAIR_V2_ABI);

const UINT128_MAX = (1n << 128n) - 1n;
const RPC_CALL_TIMEOUT_MS = 12_000;

// ===========================================================================
// Helpers shared by both adapters
// ===========================================================================

async function readErc20Meta(address: string): Promise<{ symbol: string; decimals: number }> {
  const provider = getProvider(CHAINS.zksync);
  const c = new Contract(address, ERC20_META_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    withTimeout(c.symbol() as Promise<string>, RPC_CALL_TIMEOUT_MS, 'erc20.symbol').catch(() => '?'),
    withTimeout(c.decimals() as Promise<bigint>, RPC_CALL_TIMEOUT_MS, 'erc20.decimals').catch(() => 18n),
  ]);
  return { symbol: String(symbol), decimals: Number(decimals) };
}

// ===========================================================================
// koiV3Adapter — Uniswap V3-style LP NFTs via NonfungiblePositionManager.
// Most current Koi users hold v2 LP, not v3 NFTs, but we still scan v3 for
// completeness. Exit: npm.multicall([decreaseLiquidity, collect]).
// ===========================================================================
interface KoiV3Data {
  tokenId: bigint;
  token0: string;
  token1: string;
  fee: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export const koiV3Adapter: ProtocolAdapter = {
  name: 'koi-v3',
  chains: ['zksync'],

  async scan(address, requestedChains) {
    if (!requestedChains.includes('zksync')) return [];
    const provider = getProvider(CHAINS.zksync);
    const npm = new Contract(KOI_V3_NPM, NPM_ABI, provider);

    let count: bigint;
    try {
      count = await retry(
        () => withTimeout(npm.balanceOf(address) as Promise<bigint>, RPC_CALL_TIMEOUT_MS, 'koi-v3:balanceOf'),
        { attempts: 2, baseMs: 500, label: 'koi-v3:balanceOf' },
      );
    } catch (e: any) {
      log.warn(`koi-v3: balanceOf failed for ${address}: ${e.message}`);
      return [];
    }
    if (count === 0n) return [];

    const tokenIds: bigint[] = [];
    for (let i = 0n; i < count; i++) {
      try {
        const id: bigint = await retry(
          () =>
            withTimeout(
              npm.tokenOfOwnerByIndex(address, i) as Promise<bigint>,
              RPC_CALL_TIMEOUT_MS,
              `koi-v3:tokenOfOwnerByIndex[${i}]`,
            ),
          { attempts: 2, baseMs: 500, label: `koi-v3:tokenOfOwnerByIndex[${i}]` },
        );
        tokenIds.push(id);
      } catch (e: any) {
        log.warn(`koi-v3: tokenOfOwnerByIndex(${address}, ${i}) failed: ${e.message}`);
      }
    }

    const positions: Position[] = [];
    for (const tokenId of tokenIds) {
      try {
        const p = await retry(
          () => withTimeout(npm.positions(tokenId), RPC_CALL_TIMEOUT_MS, `koi-v3:positions(${tokenId})`),
          { attempts: 2, baseMs: 500, label: `koi-v3:positions(${tokenId})` },
        );
        const data: KoiV3Data = {
          tokenId,
          token0: String(p.token0).toLowerCase(),
          token1: String(p.token1).toLowerCase(),
          fee: Number(p.fee),
          liquidity: BigInt(p.liquidity),
          tokensOwed0: BigInt(p.tokensOwed0),
          tokensOwed1: BigInt(p.tokensOwed1),
        };
        if (data.liquidity === 0n && data.tokensOwed0 === 0n && data.tokensOwed1 === 0n) continue;
        positions.push({
          protocol: 'koi-v3',
          chain: 'zksync',
          description:
            `koi V3 LP #${tokenId} (${data.token0.slice(0, 8)}…/${data.token1.slice(0, 8)}…, fee=${data.fee})`,
          data,
        });
      } catch (e: any) {
        log.warn(`koi-v3: positions(${tokenId}) failed: ${e.message}`);
      }
    }
    return positions;
  },

  async exit(wallet, position) {
    const data = position.data as KoiV3Data;
    const provider = getProvider(CHAINS.zksync);
    const signer = new Wallet(wallet.privateKey, provider);
    const npm = new Contract(KOI_V3_NPM, NPM_ABI, signer);

    const calls: string[] = [];
    if (data.liquidity > 0n) {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      calls.push(
        npmIface.encodeFunctionData('decreaseLiquidity', [
          { tokenId: data.tokenId, liquidity: data.liquidity, amount0Min: 0n, amount1Min: 0n, deadline },
        ]),
      );
    }
    calls.push(
      npmIface.encodeFunctionData('collect', [
        { tokenId: data.tokenId, recipient: wallet.address, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX },
      ]),
    );

    try {
      const tx = await retry(() => npm.multicall(calls), {
        attempts: 2,
        baseMs: 2000,
        label: `koi-v3:exit[${data.tokenId}]`,
      });
      log.info(`  koi-v3 exit tx for #${data.tokenId}: ${tx.hash}`);
      const rcpt = await retry(() => tx.wait() as Promise<{ status: number } | null>, {
        attempts: 3,
        baseMs: 2500,
        timeoutMs: 180_000,
        label: `koi-v3:wait[${data.tokenId}]`,
      });
      if (!rcpt || rcpt.status !== 1) return { ok: false, txHashes: [tx.hash], error: 'tx reverted' };
      return {
        ok: true,
        txHashes: [tx.hash],
        freedTokens: await freedTokensFromAddresses([data.token0, data.token1]),
      };
    } catch (e: any) {
      const msg = (e?.message || '') + ' ' + (e?.error?.message || '');
      if (msg.includes('already known') || msg.includes('ALREADY_EXISTS')) {
        return { ok: true, txHashes: [], freedTokens: await freedTokensFromAddresses([data.token0, data.token1]) };
      }
      return { ok: false, txHashes: [], error: msg.trim() || 'unknown error' };
    }
  },
};

// ===========================================================================
// koiV2Adapter — UniV2-style LP tokens (ERC20 per pair) from the Mute/Koi
// factory at 0x40be1cba…. Most users have these, not V3 NFTs.
//
// Scan strategy: factory.allPairsLength() + multicall to enumerate every
// pair address (cached per session — list is ~2.5k pairs and rarely grows
// during a single run), then multicall balanceOf(wallet) across all pairs.
//
// Exit strategy: classic UniV2 burn pattern, no router/approval needed:
//   tx 1: pair.transfer(pair, lpBalance) — sends LP into the pair contract
//   tx 2: pair.burn(wallet)              — burns whatever LP is in the pair,
//                                          sends underlying token0/token1
//                                          to wallet.
// Race risk between tx 1 and tx 2 is negligible on zkSync (sequencer-private
// mempool, position values are dust).
// ===========================================================================
interface KoiV2Data {
  pair: string;
  token0: string;
  token1: string;
  lpBalance: bigint;
  // Populated by scan() for display + USD valuation by the runner.
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  // Pre-computed: lpBalance × reserveN / totalSupply, in raw token units.
  amount0Raw: bigint;
  amount1Raw: bigint;
}

let pairsCachePromise: Promise<string[]> | null = null;

async function getAllV2Pairs(): Promise<string[]> {
  if (!pairsCachePromise) {
    pairsCachePromise = (async () => {
      const provider = getProvider(CHAINS.zksync);
      const factory = new Contract(KOI_V2_FACTORY, FACTORY_V2_ABI, provider);
      const total: bigint = await retry(
        () => withTimeout(factory.allPairsLength() as Promise<bigint>, RPC_CALL_TIMEOUT_MS, 'koi-v2:allPairsLength'),
        { attempts: 2, baseMs: 500, label: 'koi-v2:allPairsLength' },
      );
      const N = Number(total);
      if (N === 0) return [];

      const mc = new Contract(MULTICALL3, MULTICALL3_ABI, provider);
      const calls = [];
      for (let i = 0; i < N; i++) {
        calls.push({
          target: KOI_V2_FACTORY,
          allowFailure: true,
          callData: factoryV2Iface.encodeFunctionData('allPairs', [BigInt(i)]),
        });
      }
      const BATCH = 500;
      const out: string[] = [];
      for (let i = 0; i < calls.length; i += BATCH) {
        const slice = calls.slice(i, i + BATCH);
        try {
          const res: { success: boolean; returnData: string }[] = await retry(
            () => withTimeout(mc.aggregate3.staticCall(slice), RPC_CALL_TIMEOUT_MS, `koi-v2:multicall.allPairs[${i}]`),
            { attempts: 2, baseMs: 800, label: `koi-v2:multicall.allPairs[${i}]` },
          );
          for (const r of res) {
            if (r.success && r.returnData !== '0x') {
              const addr = '0x' + r.returnData.slice(-40);
              out.push(addr.toLowerCase());
            }
          }
        } catch (e: any) {
          log.warn(`koi-v2: pair enumeration batch starting at ${i} failed: ${e.message}`);
        }
      }
      log.info(`koi-v2: cached ${out.length} pair addresses (of ${N} reported by factory)`);
      return out;
    })();
  }
  return pairsCachePromise;
}

async function findV2Positions(address: string): Promise<KoiV2Data[]> {
  const pairs = await getAllV2Pairs();
  if (pairs.length === 0) return [];
  const provider = getProvider(CHAINS.zksync);
  const mc = new Contract(MULTICALL3, MULTICALL3_ABI, provider);

  const balanceCalls = pairs.map((p) => ({
    target: p,
    allowFailure: true,
    callData: pairV2Iface.encodeFunctionData('balanceOf', [address]),
  }));

  const positionsRaw: { pair: string; lpBalance: bigint }[] = [];
  const BATCH = 500;
  for (let i = 0; i < balanceCalls.length; i += BATCH) {
    const slice = balanceCalls.slice(i, i + BATCH);
    try {
      const res: { success: boolean; returnData: string }[] = await retry(
        () => withTimeout(mc.aggregate3.staticCall(slice), RPC_CALL_TIMEOUT_MS, `koi-v2:multicall.balanceOf[${i}]`),
        { attempts: 2, baseMs: 800, label: `koi-v2:multicall.balanceOf[${i}]` },
      );
      for (let j = 0; j < res.length; j++) {
        const r = res[j];
        if (!r?.success || r.returnData === '0x') continue;
        const bal = BigInt(r.returnData);
        if (bal > 0n) positionsRaw.push({ pair: pairs[i + j], lpBalance: bal });
      }
    } catch (e: any) {
      log.warn(`koi-v2: balanceOf batch starting at ${i} failed: ${e.message}`);
    }
  }

  // For each candidate, look up everything needed to compute the user's
  // underlying token amounts in one multicall round:
  //   token0, token1, getReserves, totalSupply.
  if (positionsRaw.length === 0) return [];
  const pairCalls: { target: string; allowFailure: boolean; callData: string }[] = [];
  for (const { pair } of positionsRaw) {
    pairCalls.push({ target: pair, allowFailure: true, callData: pairV2Iface.encodeFunctionData('token0') });
    pairCalls.push({ target: pair, allowFailure: true, callData: pairV2Iface.encodeFunctionData('token1') });
    pairCalls.push({ target: pair, allowFailure: true, callData: pairV2Iface.encodeFunctionData('getReserves') });
    pairCalls.push({ target: pair, allowFailure: true, callData: pairV2Iface.encodeFunctionData('totalSupply') });
  }
  let pairRes: { success: boolean; returnData: string }[] = [];
  try {
    pairRes = await retry(
      () => withTimeout(mc.aggregate3.staticCall(pairCalls), RPC_CALL_TIMEOUT_MS, 'koi-v2:multicall.pairMeta'),
      { attempts: 2, baseMs: 800, label: 'koi-v2:multicall.pairMeta' },
    );
  } catch (e: any) {
    log.warn(`koi-v2: pair-meta multicall failed: ${e.message}`);
    return [];
  }

  // Collect token addresses encountered, then one more multicall for symbol+decimals.
  const tokenAddrs = new Set<string>();
  type RawRow = {
    pair: string;
    lpBalance: bigint;
    token0: string;
    token1: string;
    reserve0: bigint;
    reserve1: bigint;
    totalSupply: bigint;
  };
  const raw: RawRow[] = [];
  for (let i = 0; i < positionsRaw.length; i++) {
    const t0Hex = pairRes[i * 4]?.returnData;
    const t1Hex = pairRes[i * 4 + 1]?.returnData;
    const resHex = pairRes[i * 4 + 2]?.returnData;
    const tsHex = pairRes[i * 4 + 3]?.returnData;
    if (!t0Hex || !t1Hex || !resHex || !tsHex) continue;
    if (t0Hex === '0x' || t1Hex === '0x' || resHex === '0x' || tsHex === '0x') continue;
    const t0 = ('0x' + t0Hex.slice(-40)).toLowerCase();
    const t1 = ('0x' + t1Hex.slice(-40)).toLowerCase();
    // getReserves returns (uint112, uint112, uint32) — packed as 3 × 32-byte words.
    const r0 = BigInt('0x' + resHex.slice(2, 66));
    const r1 = BigInt('0x' + resHex.slice(66, 130));
    const ts = BigInt(tsHex);
    if (ts === 0n) continue;
    tokenAddrs.add(t0);
    tokenAddrs.add(t1);
    raw.push({
      pair: positionsRaw[i].pair,
      lpBalance: positionsRaw[i].lpBalance,
      token0: t0,
      token1: t1,
      reserve0: r0,
      reserve1: r1,
      totalSupply: ts,
    });
  }
  if (raw.length === 0) return [];

  // Token metadata multicall (symbol + decimals per unique token address).
  const tokenList = Array.from(tokenAddrs);
  const metaCalls: { target: string; allowFailure: boolean; callData: string }[] = [];
  const erc20Iface = new Interface(ERC20_META_ABI);
  for (const addr of tokenList) {
    metaCalls.push({ target: addr, allowFailure: true, callData: erc20Iface.encodeFunctionData('symbol') });
    metaCalls.push({ target: addr, allowFailure: true, callData: erc20Iface.encodeFunctionData('decimals') });
  }
  let metaRes: { success: boolean; returnData: string }[] = [];
  try {
    metaRes = await retry(
      () => withTimeout(mc.aggregate3.staticCall(metaCalls), RPC_CALL_TIMEOUT_MS, 'koi-v2:multicall.meta'),
      { attempts: 2, baseMs: 800, label: 'koi-v2:multicall.meta' },
    );
  } catch (e: any) {
    log.warn(`koi-v2: token-meta multicall failed: ${e.message}; falling back to ?/18`);
  }
  const meta = new Map<string, { symbol: string; decimals: number }>();
  for (let i = 0; i < tokenList.length; i++) {
    const symRaw = metaRes[i * 2]?.returnData;
    const decRaw = metaRes[i * 2 + 1]?.returnData;
    let symbol = '?';
    let decimals = 18;
    if (symRaw && symRaw !== '0x') {
      try {
        const decoded = erc20Iface.decodeFunctionResult('symbol', symRaw);
        symbol = String(decoded[0]);
      } catch {/* keep default */}
    }
    if (decRaw && decRaw !== '0x') {
      try {
        const decoded = erc20Iface.decodeFunctionResult('decimals', decRaw);
        decimals = Number(decoded[0]);
      } catch {/* keep default */}
    }
    meta.set(tokenList[i], { symbol, decimals });
  }

  const out: KoiV2Data[] = [];
  for (const r of raw) {
    const m0 = meta.get(r.token0) ?? { symbol: '?', decimals: 18 };
    const m1 = meta.get(r.token1) ?? { symbol: '?', decimals: 18 };
    out.push({
      pair: r.pair,
      lpBalance: r.lpBalance,
      token0: r.token0,
      token1: r.token1,
      reserve0: r.reserve0,
      reserve1: r.reserve1,
      totalSupply: r.totalSupply,
      decimals0: m0.decimals,
      decimals1: m1.decimals,
      symbol0: m0.symbol,
      symbol1: m1.symbol,
      // share = lpBalance / totalSupply ⇒ userAmountN = reserveN × lpBalance / totalSupply.
      // Bigint integer division loses sub-unit precision; acceptable for dust valuation.
      amount0Raw: (r.reserve0 * r.lpBalance) / r.totalSupply,
      amount1Raw: (r.reserve1 * r.lpBalance) / r.totalSupply,
    });
  }
  return out;
}

function formatRaw(raw: bigint, decimals: number): number {
  if (decimals === 0) return Number(raw);
  // Convert via string to avoid 1e18 → Number-precision loss on big amounts.
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const s = abs.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, -decimals);
  const fracPart = s.slice(-decimals);
  const num = Number(`${intPart}.${fracPart}`);
  return negative ? -num : num;
}

export const koiV2Adapter: ProtocolAdapter = {
  name: 'koi-v2',
  chains: ['zksync'],

  async scan(address, requestedChains) {
    if (!requestedChains.includes('zksync')) return [];
    let v2: KoiV2Data[];
    try {
      v2 = await findV2Positions(address);
    } catch (e: any) {
      log.warn(`koi-v2: scan failed for ${address}: ${e.message}`);
      return [];
    }
    return v2.map<Position>((d) => {
      const amt0 = formatRaw(d.amount0Raw, d.decimals0);
      const amt1 = formatRaw(d.amount1Raw, d.decimals1);
      return {
        protocol: 'koi-v2',
        chain: 'zksync',
        description:
          `koi V2 LP [${d.symbol0}/${d.symbol1}] — ` +
          `${amt0.toPrecision(4)} ${d.symbol0} + ${amt1.toPrecision(4)} ${d.symbol1}`,
        value: {
          underlying: [
            { symbol: d.symbol0, address: d.token0, amountHuman: amt0, decimals: d.decimals0 },
            { symbol: d.symbol1, address: d.token1, amountHuman: amt1, decimals: d.decimals1 },
          ],
          usdTotal: null,
        },
        data: d,
      };
    });
  },

  async exit(wallet, position) {
    const data = position.data as KoiV2Data;
    const provider = getProvider(CHAINS.zksync);
    const signer = new Wallet(wallet.privateKey, provider);
    const pair = new Contract(data.pair, PAIR_V2_ABI, signer);
    const txHashes: string[] = [];

    // Step 1: transfer LP into the pair contract so its self-balanceOf reads
    // the amount we want burnt. Failing here is non-recoverable for this
    // position — we abort and don't attempt the burn.
    try {
      const tx1 = await retry(() => pair.transfer(data.pair, data.lpBalance), {
        attempts: 2,
        baseMs: 2000,
        label: `koi-v2:transfer[${data.pair}]`,
      });
      txHashes.push(tx1.hash);
      log.info(`  koi-v2 transfer tx: ${tx1.hash}`);
      const r1 = await retry(() => tx1.wait() as Promise<{ status: number } | null>, {
        attempts: 3,
        baseMs: 2500,
        timeoutMs: 180_000,
        label: `koi-v2:transfer-wait`,
      });
      if (!r1 || r1.status !== 1) return { ok: false, txHashes, error: 'transfer reverted' };
    } catch (e: any) {
      const msg = (e?.message || '') + ' ' + (e?.error?.message || '');
      if (!msg.includes('already known') && !msg.includes('ALREADY_EXISTS')) {
        return { ok: false, txHashes, error: `transfer: ${msg.trim()}` };
      }
      // "already known" — earlier attempt got mined; proceed to burn.
    }

    // Step 2: burn whatever LP is now in the pair, sending token0/token1 to
    // wallet. This is the step that actually frees value.
    try {
      const tx2 = await retry(() => pair.burn(wallet.address), {
        attempts: 2,
        baseMs: 2000,
        label: `koi-v2:burn[${data.pair}]`,
      });
      txHashes.push(tx2.hash);
      log.info(`  koi-v2 burn tx: ${tx2.hash}`);
      const r2 = await retry(() => tx2.wait() as Promise<{ status: number } | null>, {
        attempts: 3,
        baseMs: 2500,
        timeoutMs: 180_000,
        label: `koi-v2:burn-wait`,
      });
      if (!r2 || r2.status !== 1) return { ok: false, txHashes, error: 'burn reverted' };
    } catch (e: any) {
      const msg = (e?.message || '') + ' ' + (e?.error?.message || '');
      if (!msg.includes('already known') && !msg.includes('ALREADY_EXISTS')) {
        return { ok: false, txHashes, error: `burn: ${msg.trim()}` };
      }
    }

    return {
      ok: true,
      txHashes,
      freedTokens: await freedTokensFromAddresses([data.token0, data.token1]),
    };
  },
};

// Used by both v2 and v3 exits.
async function freedTokensFromAddresses(addrs: string[]): Promise<FreedToken[]> {
  const out: FreedToken[] = [];
  for (const addr of addrs) {
    try {
      const meta = await readErc20Meta(addr);
      out.push({ address: addr, symbol: meta.symbol, decimals: meta.decimals });
    } catch {
      out.push({ address: addr, symbol: '?', decimals: 18 });
    }
  }
  return out;
}

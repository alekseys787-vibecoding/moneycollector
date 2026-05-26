// Chain-aware EVM gas helpers shared between flow/evm.ts (standard sweep) and
// flow/evmUltra.ts (ULTRA aggregator sweep). Extracted so the ULTRA flow can
// reuse the OP-Stack / Scroll L1 fee math and per-chain bridge gas reserves
// without copy-pasting them.

import { Contract, JsonRpcProvider, formatEther } from 'ethers';
import { ChainConfig, ChainKey } from '../config/chains';
import { getProvider } from '../discovery/evm';
import { withTimeout } from '../utils/retry';
import { getUsdPriceOrNull } from '../utils/prices';

// Gas units we reserve when bridging the wallet's full native balance.
// Relay deposit txs use 300-600k on most chains; zkSync's ZK proving overhead
// pushes them to 1.5M+. Numbers below are chosen so `units × current gasPrice`
// always overshoots the real tx by some margin (we keep the surplus as dust).
export const NATIVE_BRIDGE_GAS_UNITS_DEFAULT = 800_000n;
export const NATIVE_BRIDGE_GAS_UNITS_PER_CHAIN: Partial<Record<ChainKey, bigint>> = {
  zksync: 2_500_000n,    // ZK-prove gas; we saw real txs at 1.48M
  ethereum: 600_000n,    // gas is expensive — don't over-reserve $-wise
};

// OP-Stack chains charge an extra L1 calldata fee on top of L2 gas. The
// node's pre-flight balance check includes this fee in the required amount,
// so we must reserve it ourselves. Scroll has the same model with a different
// oracle address. Both expose a getL1Fee(bytes) view function.
export const OP_STACK_CHAINS = new Set<ChainKey>([
  'optimism', 'base', 'zora', 'mode', 'blast',
]);
export const L1_FEE_CHAINS = new Set<ChainKey>([
  'optimism', 'base', 'zora', 'mode', 'blast', 'scroll',
]);
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';        // OP-Stack
export const SCROLL_L1_GAS_ORACLE = '0x5300000000000000000000000000000000000002';   // Scroll
export const GAS_PRICE_ORACLE_ABI = [
  'function getL1Fee(bytes _data) view returns (uint256)',
];

// Worst-case calldata size for a Relay deposit (varies by route; 1.5KB is a
// safe upper bound). Used to pre-reserve L1 fee for native bridges.
const RELAY_TX_SIZE_FOR_L1_FEE = 1500;

// Returns the on-chain gas reserve (wei) we should keep on a wallet so that
// a swap/bridge tx originating from this chain can be paid for. Includes:
//   - L2 portion: gasPrice × chain-specific gas units × 1.2x cushion
//   - L1 portion (OP-Stack & Scroll only): getL1Fee(dummy 1.5KB calldata) × 1.5x
export async function gasReserveWei(
  provider: JsonRpcProvider,
  chain: ChainConfig,
): Promise<bigint> {
  const feeData = await withTimeout(provider.getFeeData(), 15_000, `${chain.key}:getFeeData`);
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
  const units =
    NATIVE_BRIDGE_GAS_UNITS_PER_CHAIN[chain.key] ?? NATIVE_BRIDGE_GAS_UNITS_DEFAULT;
  let reserveWei = (gasPrice * units * 12n) / 10n;

  if (L1_FEE_CHAINS.has(chain.key)) {
    try {
      const oracleAddr =
        chain.key === 'scroll' ? SCROLL_L1_GAS_ORACLE : GAS_PRICE_ORACLE;
      const oracle = new Contract(oracleAddr, GAS_PRICE_ORACLE_ABI, provider);
      const dummyData = '0x' + '00'.repeat(RELAY_TX_SIZE_FOR_L1_FEE);
      const l1Fee: bigint = await withTimeout(
        oracle.getL1Fee(dummyData),
        15_000,
        `${chain.key}:getL1Fee`,
      );
      reserveWei += (l1Fee * 15n) / 10n;
    } catch {
      // Conservative flat fallback if oracle query fails.
      reserveWei += 100_000_000_000_000n; // 100 µeth ≈ $0.22
    }
  }

  return reserveWei;
}

export async function localGasEstimateUsd(srcChain: ChainConfig): Promise<number | null> {
  try {
    const provider = getProvider(srcChain);
    const reserveWei = await gasReserveWei(provider, srcChain);
    const native = Number(formatEther(reserveWei));
    const price = await getUsdPriceOrNull(srcChain.nativeCoingeckoId);
    if (price == null) return null;
    return native * price;
  } catch {
    return null;
  }
}

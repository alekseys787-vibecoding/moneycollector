import { getAddress, isAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';

// Dev fee destinations and split ratio. THIS IS THE SINGLE CHOKEPOINT for
// where the 10% goes — everything else in the codebase routes through
// `getDevDestinations()`. The L2 upgrade path (signed config fetched from a
// license server at startup) replaces ONLY this module; flow code is unchanged.
//
// L1 protection right now: source value is hardcoded; the released artifact is
// a pkg/sea-packaged .exe with `javascript-obfuscator` applied to this module.
// Anyone reverse-engineering the .exe can locate and patch these constants
// (that's why we picked 10% — at $50-200 dust per run, it's not worth 4 hours
// of RE). If patched copies surface in the wild, switch this module to a
// signed-server fetcher; see HANDOFF.md "Anti-tamper packaging".

const DEV_EVM_RAW = '0x4D62DB75A2F286A6065CA58F7B84719d3a162A89';
const DEV_SOL_RAW = '2KZVcSXarHcKMZef2XoD9Y4T4zeezPixoMdFDjsyHEH6';

// Fee in basis points. 1000 = 10%.
export const FEE_BPS = 1000;

let cached: { evm: string; sol: string } | null = null;

export function getDevDestinations(): { evm: string; sol: string } {
  if (cached) return cached;

  if (!isAddress(DEV_EVM_RAW)) {
    throw new Error(`Invalid DEV_EVM address: ${DEV_EVM_RAW}`);
  }
  // Throws if not valid base58 or wrong length — fails fast at first use.
  // eslint-disable-next-line no-new
  new PublicKey(DEV_SOL_RAW);

  cached = {
    evm: getAddress(DEV_EVM_RAW),
    sol: DEV_SOL_RAW,
  };
  return cached;
}

// Split `total` into devShare = total*bps/10000 and userShare = total - devShare.
// Uses bigint floor division — any 1-wei/1-lamport rounding goes to the user.
export function splitAmount(
  total: bigint,
  bps: number = FEE_BPS,
): { devShare: bigint; userShare: bigint } {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error(`Invalid fee bps: ${bps}`);
  }
  if (total < 0n) throw new Error(`Invalid total: ${total}`);
  const devShare = (total * BigInt(bps)) / 10000n;
  const userShare = total - devShare;
  return { devShare, userShare };
}

import { koiV2Adapter, koiV3Adapter } from './koi';
import { ProtocolAdapter } from './types';

// All registered adapters. Order matters only for log readability — each
// adapter is independent and operates on its own protocol/chain scope.
// koi-v2 first because it's the common case (most Koi users hold v2 LP
// tokens from the Mute-era factory, not v3 NFTs).
export const ADAPTERS: ProtocolAdapter[] = [
  koiV2Adapter,
  koiV3Adapter,
  // Next up: zoraAdapter (single ProtocolRewards.withdraw call per OP-Stack
  // chain), then stargateAdapter (LPStaking.withdraw → Pool.removeLiquidity).
];

export type { Position, ExitResult, ProtocolAdapter, FreedToken } from './types';

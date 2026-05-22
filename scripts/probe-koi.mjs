// Probe Koi-related contracts on zkSync for the user's wallets.
// Tries:
//  - The NPM address baked into koi.ts (V3 NFTs)
//  - A few alternative candidates I've seen in public sources
//  - Koi v2 Router/Factory pair-balance check (for v2 LP tokens)
//  - Farm Factory's getter (if it exposes "user positions")
//
// Usage: & "C:\Program Files\nodejs\node.exe" .\scripts\probe-koi.mjs

const RPC = 'https://mainnet.era.zksync.io';
const WALLETS = [
  '0xDF5A735C63c726e9Ba46bF5FdAbB7Dc10bb87293',
  '0x14e4687B89EF0903a1d5B182e8DFd569F17D7b61',
  '0x435978194E8343048db3AbF2577Ac6EC23Becdca',
];

// Address candidates for Koi NFT-based position manager on zkSync Era.
// First one is what koi.ts currently uses; the rest are seen in various
// docs / explorer hints — probing all of them to see which (if any) the
// user's wallets have a non-zero balance on.
const NPM_CANDIDATES = [
  '0xa459EbF3E6A6d5875345f725bA3F107340b67732',
  // Alt addresses I've seen referenced for Koi/Mute V3 NPM:
  '0x4Bba637a74Cb35dD6f701124a76c45c1f9f6E658',
  '0x9F0e9e3635DDA08E0e7c69d3D34D87FF5A87dF20',
];

// Koi v2 Factory — for v2 LP tokens (separate ERC20 per pair).
const V2_FACTORY = '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D';
// Koi v2 Router (just to verify it responds).
const V2_ROUTER = '0x8B791913eB07C32779a16750e3868aA8495F5964';
// Koi Farm Factory — masterchef-like.
const FARM_FACTORY = '0x4772D618AD88b602a2ea76F2155D0356E6756b3e';

async function call(to, data) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  const j = await res.json();
  if (j.error) return { err: j.error.message ?? JSON.stringify(j.error) };
  return { result: j.result };
}

async function getCode(addr) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getCode',
      params: [addr, 'latest'],
    }),
  });
  const j = await res.json();
  return j.result ?? null;
}

// ABI: balanceOf(address) → uint256.  Selector = 0x70a08231
function encodeBalanceOf(addr) {
  return '0x70a08231' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

// ABI: name() → string.  Selector = 0x06fdd803
const NAME_SEL = '0x06fdd803';

function decodeUint256(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function decodeStringFromAbi(hex) {
  if (!hex || hex.length < 2 + 64 * 2) return '';
  // dynamic string: [offset][len][data...]
  const lenHex = '0x' + hex.slice(2 + 64, 2 + 64 * 2);
  const len = Number(BigInt(lenHex));
  const dataHex = hex.slice(2 + 64 * 2, 2 + 64 * 2 + len * 2);
  const bytes = Buffer.from(dataHex, 'hex');
  return bytes.toString('utf8');
}

(async () => {
  console.log('=== Code presence + .name() for each candidate ===');
  for (const a of [...NPM_CANDIDATES, V2_FACTORY, V2_ROUTER, FARM_FACTORY]) {
    const code = await getCode(a);
    const present = code && code !== '0x';
    let nameStr = '';
    if (present) {
      const r = await call(a, NAME_SEL);
      if (r.result) nameStr = decodeStringFromAbi(r.result);
    }
    console.log(`  ${a}  ${present ? 'CODE' : 'NO-CODE'}  name="${nameStr}"`);
  }

  console.log('\n=== NPM candidate: balanceOf(wallet) for each user wallet ===');
  for (const npm of NPM_CANDIDATES) {
    console.log(`\nNPM = ${npm}`);
    for (const w of WALLETS) {
      const r = await call(npm, encodeBalanceOf(w));
      if (r.err) {
        console.log(`  ${w}  ERR ${r.err}`);
      } else {
        const n = decodeUint256(r.result);
        console.log(`  ${w}  balanceOf = ${n}`);
      }
    }
  }
})();

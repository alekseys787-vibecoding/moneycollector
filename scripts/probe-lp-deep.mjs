// Deep probe: for each ERC20-with-real-balance on each wallet, check whether
// it's a UniV2-style LP pair (has token0/token1/factory). If factory matches
// Koi v2 factory or any known AMM factory, we've found stuck LP.
// Also queries Maverick Position NFT directly.

const RPC = 'https://mainnet.era.zksync.io';

const WALLETS = [
  '0xDF5A735C63c726e9Ba46bF5FdAbB7Dc10bb87293',
  '0x14e4687B89EF0903a1d5B182e8DFd569F17D7b61',
  '0x435978194E8343048db3AbF2577Ac6EC23Becdca',
];

const KNOWN_FACTORIES = {
  '0x40be1cba6c5b47cdf9da7f963b6f761f4c60627d': 'Koi v2 Factory',
  '0x488a92576da475f7429bc9dec9247045156144d3': 'Koi v3 Factory',
  '0x31bafe07c2d3bc16e8a826945c7c12fff4302c4d': 'Mute v2 Factory (predecessor)',
};

const MAVERICK_POSITION_NFT = '0xFd54762D435A490405DDa0fBc92b7168934e8525';

const SEL = {
  name:    '0x06fdde03',
  symbol:  '0x95d89b41',
  token0:  '0x0dfe1681',
  token1:  '0xd21220a7',
  factory: '0xc45a0155',
  balanceOf: '0x70a08231',
};

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  return j.error ? { err: j.error.message } : { result: j.result };
}
async function call(to, data) { return rpc('eth_call', [{ to, data }, 'latest']); }
function decodeString(hex) {
  if (!hex || hex.length < 130) return '';
  try {
    const len = Number(BigInt('0x' + hex.slice(2 + 64, 2 + 64 * 2)));
    if (len <= 0 || len > 256) return '';
    return Buffer.from(hex.slice(2 + 64 * 2, 2 + 64 * 2 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}
function decodeAddress(hex) { return hex && hex !== '0x' && hex.length >= 66 ? ('0x' + hex.slice(-40)).toLowerCase() : ''; }
function bal(addr, owner) { return SEL.balanceOf + owner.slice(2).toLowerCase().padStart(64, '0'); }

async function getBalances(wallet) {
  const r = await fetch(`https://block-explorer-api.mainnet.zksync.io/address/${wallet}`);
  const j = await r.json();
  return j.balances ?? {};
}

(async () => {
  // 1. Probe Maverick Position NFT for all 3 wallets
  console.log('=== Maverick Position NFT (per wallet) ===');
  for (const w of WALLETS) {
    const r = await call(MAVERICK_POSITION_NFT, bal(MAVERICK_POSITION_NFT, w));
    const n = r.result ? BigInt(r.result) : 0n;
    console.log(`  ${w}  balanceOf = ${n}`);
  }

  // 2. For each wallet, examine ERC20 balances with non-trivial values and
  //    classify each as: regular token / LP pair (which factory?) / unknown.
  for (const w of WALLETS) {
    console.log(`\n=== Wallet ${w} — non-trivial ERC20 holdings ===`);
    const balances = await getBalances(w);
    for (const [addr, b] of Object.entries(balances)) {
      const balance = BigInt(b.balance || '0');
      if (balance === 0n) continue;
      // Skip clearly named airdrop spam.
      const sym = b.token?.symbol ?? '';
      if (sym.toLowerCase().includes('claim on') || sym.includes('airdrop')) continue;

      // Try to identify LP pair via token0/token1/factory.
      const [t0r, t1r, facr, nmr, syr] = await Promise.all([
        call(addr, SEL.token0),
        call(addr, SEL.token1),
        call(addr, SEL.factory),
        call(addr, SEL.name),
        call(addr, SEL.symbol),
      ]);
      const t0 = decodeAddress(t0r.result ?? '');
      const t1 = decodeAddress(t1r.result ?? '');
      const fac = decodeAddress(facr.result ?? '');
      const nm = decodeString(nmr.result ?? '');
      const syStr = decodeString(syr.result ?? '');

      if (t0 && t1 && fac) {
        const facName = KNOWN_FACTORIES[fac] || `unknown factory ${fac}`;
        console.log(`  ${addr}  LP-pair  bal=${balance}  name="${nm}" sym="${syStr}"  factory=${facName}  token0=${t0} token1=${t1}`);
      } else {
        // Regular token — only log if not in token registry from explorer
        if (b.token === null || (b.token && !b.token.l1Address && !b.token.iconURL)) {
          console.log(`  ${addr}  ERC20    bal=${balance}  name="${nm}" sym="${syStr}"  (unindexed)`);
        }
      }
    }
  }
})();

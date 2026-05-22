const RPC = 'https://mainnet.era.zksync.io';

const CANDIDATES = [
  { name: 'docs.koi.finance says NPM', addr: '0xa459EbF3E6A6d5875345f725bA3F107340b67732' },
  { name: 'Maverick Position NFT (wallet 1 owns)', addr: '0xFd54762D435A490405DDa0fBc92b7168934e8525' },
];

const SELECTORS = {
  'name()':         '0x06fdde03',
  'symbol()':       '0x95d89b41',
  'totalSupply()':  '0x18160ddd',
  'factory()':      '0xc45a0155',
  // NFT-enumerable: tokenByIndex(0)
  'tokenByIndex(0)':'0x4f6ccce700000000000000000000000000000000000000000000000000000000' + '0'.repeat(0),
};

async function call(to, data) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await res.json();
  if (j.error) return { err: j.error.message };
  return { result: j.result };
}

function decodeString(hex) {
  if (!hex || hex.length < 130) return '';
  try {
    const lenHex = '0x' + hex.slice(2 + 64, 2 + 64 * 2);
    const len = Number(BigInt(lenHex));
    if (len <= 0 || len > 256) return '';
    return Buffer.from(hex.slice(2 + 64 * 2, 2 + 64 * 2 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}

function decodeUint(hex) { if (!hex || hex === '0x') return 0n; return BigInt(hex); }
function decodeAddress(hex) { if (!hex || hex === '0x' || hex.length < 66) return ''; return '0x' + hex.slice(-40); }

(async () => {
  for (const { name, addr } of CANDIDATES) {
    console.log(`\n=== ${name} ===`);
    console.log(`  addr: ${addr}`);
    const nameR = await call(addr, SELECTORS['name()']);
    const symR  = await call(addr, SELECTORS['symbol()']);
    const tsR   = await call(addr, SELECTORS['totalSupply()']);
    const facR  = await call(addr, SELECTORS['factory()']);
    console.log(`  name():        "${decodeString(nameR.result ?? '')}"`);
    console.log(`  symbol():      "${decodeString(symR.result ?? '')}"`);
    console.log(`  totalSupply(): ${tsR.result ? decodeUint(tsR.result) : `ERR ${tsR.err}`}`);
    console.log(`  factory():     ${facR.result && facR.result !== '0x' ? decodeAddress(facR.result) : '(none — not a V3 NPM)'}`);
  }
})();

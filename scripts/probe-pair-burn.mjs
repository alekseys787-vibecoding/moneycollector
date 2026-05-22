// Confirm the Koi/Mute v2 pair exposes burn(address) and check the exact
// router contract + signatures for removeLiquidity, so we know which exit
// path is cleanest.
const RPC = 'https://mainnet.era.zksync.io';

const PAIR = '0xDFAaB828f5F515E104BaaBa4d8D554DA9096f0e4';
const KOI_V2_ROUTER = '0x8B791913eB07C32779a16750e3868aA8495F5964';

// Just fetch the pair's runtime bytecode and search for known function selectors.
async function getCode(addr) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [addr, 'latest'] }),
  });
  const j = await res.json();
  return j.result ?? '';
}

const SELECTORS = {
  // Standard UniV2 pair
  'burn(address)': '0x89afcb44',
  'mint(address)': '0x6a627842',
  'swap(uint256,uint256,address,bytes)': '0x022c0d9f',
  'token0()': '0x0dfe1681',
  'token1()': '0xd21220a7',
  'getReserves()': '0x0902f1ac',
  // Possible Mute extensions
  'pairFee()': '0x9d4d7b1c',
  'stable()': '0xb375a0c2',
  // Router suspects
  'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)': '0xbaa2abde',
  'removeLiquidity(address,address,bool,uint256,uint256,uint256,address,uint256)': '0x5b0d5984',
  // Burn-based with helper
  'burnLiquidity(address,address,address,uint256)': '0x33fd28b6',
};

(async () => {
  console.log(`=== Pair ${PAIR} ===`);
  const pairCode = await getCode(PAIR);
  console.log(`bytecode length: ${pairCode.length} chars (${pairCode.length / 2 - 1} bytes)`);
  for (const [name, sel] of Object.entries(SELECTORS)) {
    const has = pairCode.toLowerCase().includes(sel.slice(2));
    console.log(`  ${has ? 'YES' : 'no '}  ${sel}  ${name}`);
  }

  console.log(`\n=== Router ${KOI_V2_ROUTER} ===`);
  const routerCode = await getCode(KOI_V2_ROUTER);
  console.log(`bytecode length: ${routerCode.length} chars (${routerCode.length / 2 - 1} bytes)`);
  for (const [name, sel] of Object.entries(SELECTORS)) {
    const has = routerCode.toLowerCase().includes(sel.slice(2));
    console.log(`  ${has ? 'YES' : 'no '}  ${sel}  ${name}`);
  }
})();

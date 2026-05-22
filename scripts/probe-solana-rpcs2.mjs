const EXTRA = [
  'https://solana-mainnet.rpc.extrnode.com',
  'https://solana.api.onfinality.io/public',
  'https://rpc.shyft.to',
  'https://solana-rpc.web3api.com',
  'https://api.solana.fm',
  'https://api.tatum.io/v3/blockchain/node/solana-mainnet',
  'https://free.rpcpool.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://solana.api.tatum.io',
  'https://floral-spring-mountain.solana-mainnet.quiknode.pro',
];
const TEST_OWNER = 'H1Zqh2LgHy5B1XykU1yuGUdux74DBuNe2tZDKKLMoj1e';
const TIMEOUT = 7000;

async function rpc(url, method, params = []) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const s = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, ms: Date.now() - s, err: `HTTP ${r.status}` };
    const j = await r.json();
    if (j.error) return { ok: false, ms: Date.now() - s, err: j.error.message };
    return { ok: true, ms: Date.now() - s, result: j.result };
  } catch (e) {
    return { ok: false, ms: Date.now() - s, err: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

(async () => {
  for (const url of EXTRA) {
    const b = await rpc(url, 'getBalance', [TEST_OWNER]);
    if (!b.ok) { console.log(`FAIL ${url}  getBalance: ${b.err}`); continue; }
    const t = await rpc(url, 'getTokenAccountsByOwner', [TEST_OWNER, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]);
    if (!t.ok) { console.log(`FAIL ${url}  tokens: ${t.err}`); continue; }
    const count = (t.result?.value ?? []).length;
    console.log(`OK   ${url}  bal=${b.ms}ms tokens=${t.ms}ms count=${count}`);
  }

  // Burst test on mainnet-beta to see actual rate cap.
  console.log('\n--- mainnet-beta burst test (10 getBalance in 1s) ---');
  const start = Date.now();
  const results = await Promise.all(Array.from({ length: 10 }, () => rpc('https://api.mainnet-beta.solana.com', 'getBalance', [TEST_OWNER])));
  const ok = results.filter(r => r.ok).length;
  console.log(`  ${ok}/10 succeeded in ${Date.now() - start}ms`);
})();

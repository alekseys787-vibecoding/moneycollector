// Probe public Solana RPCs: getHealth + getBalance + getTokenAccountsByOwner.
// Last is the one that hits 429 hardest. Pick top-3 keyless responders.
const CANDIDATES = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.publicnode.com',
  'https://solana.drpc.org',
  'https://rpc.ankr.com/solana',
  'https://solana-mainnet.public.blastapi.io',
  'https://endpoints.omniatech.io/v1/sol/mainnet/public',
  'https://api.metaplex.solana.com',
  'https://solana-api.projectserum.com',
  'https://mainnet.helius-rpc.com',
  'https://api.solanavibestation.com',
  'https://wider-quaint-meme.solana-mainnet.quiknode.pro',
];

const TEST_OWNER = 'H1Zqh2LgHy5B1XykU1yuGUdux74DBuNe2tZDKKLMoj1e';
const TIMEOUT = 8000;

async function rpc(url, method, params = []) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, err: `HTTP ${res.status}` };
    const j = await res.json();
    if (j.error) return { ok: false, ms, err: j.error.message ?? JSON.stringify(j.error).slice(0, 80) };
    return { ok: true, ms, result: j.result };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, err: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  for (const url of CANDIDATES) {
    const h = await rpc(url, 'getHealth');
    if (!h.ok) {
      console.log(`FAIL ${url}  getHealth: ${h.err}`);
      continue;
    }
    const b = await rpc(url, 'getBalance', [TEST_OWNER]);
    if (!b.ok) {
      console.log(`FAIL ${url}  getBalance: ${b.err}`);
      continue;
    }
    const tokens = await rpc(url, 'getTokenAccountsByOwner', [
      TEST_OWNER,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed' },
    ]);
    if (!tokens.ok) {
      console.log(`FAIL ${url}  getTokenAccountsByOwner: ${tokens.err}`);
      continue;
    }
    const tokenCount = (tokens.result?.value ?? []).length;
    console.log(`OK   ${url}  health=${h.ms}ms balance=${b.ms}ms tokens=${tokens.ms}ms count=${tokenCount}`);
  }
})();

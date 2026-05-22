// Probe candidate RPC endpoints per chain.
// Writes a report to stdout: which RPCs respond with correct chainId in time.
// Usage:  & "C:\Program Files\nodejs\node.exe" .\scripts\probe-rpcs.mjs

const TIMEOUT_MS = 6000;

// Candidate pools per chain. Order ≈ historical reliability, but every one
// is verified live below before being recommended.
const CANDIDATES = {
  ethereum: {
    chainId: 1,
    rpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
      'https://rpc.ankr.com/eth',
      'https://eth.drpc.org',
      'https://1rpc.io/eth',
      'https://cloudflare-eth.com',
      'https://eth.merkle.io',
    ],
  },
  arbitrum: {
    chainId: 42161,
    rpcs: [
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.llamarpc.com',
      'https://arbitrum.drpc.org',
      'https://1rpc.io/arb',
      'https://rpc.ankr.com/arbitrum',
    ],
  },
  optimism: {
    chainId: 10,
    rpcs: [
      'https://optimism-rpc.publicnode.com',
      'https://mainnet.optimism.io',
      'https://optimism.llamarpc.com',
      'https://optimism.drpc.org',
      'https://1rpc.io/op',
      'https://rpc.ankr.com/optimism',
    ],
  },
  base: {
    chainId: 8453,
    rpcs: [
      'https://base-rpc.publicnode.com',
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://base.drpc.org',
      'https://1rpc.io/base',
      'https://rpc.ankr.com/base',
    ],
  },
  polygon: {
    chainId: 137,
    rpcs: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon-rpc.com',
      'https://polygon.llamarpc.com',
      'https://polygon.drpc.org',
      'https://1rpc.io/matic',
      'https://rpc.ankr.com/polygon',
    ],
  },
  bsc: {
    chainId: 56,
    rpcs: [
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed.bnbchain.org',
      'https://bsc-dataseed1.defibit.io',
      'https://bsc-dataseed1.ninicoin.io',
      'https://binance.llamarpc.com',
      'https://bsc.drpc.org',
      'https://1rpc.io/bnb',
    ],
  },
  opbnb: {
    chainId: 204,
    rpcs: [
      'https://opbnb-rpc.publicnode.com',
      'https://opbnb-mainnet-rpc.bnbchain.org',
      'https://opbnb.drpc.org',
      'https://1rpc.io/opbnb',
      'https://opbnb.publicnode.com',
    ],
  },
  avalanche: {
    chainId: 43114,
    rpcs: [
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://api.avax.network/ext/bc/C/rpc',
      'https://avalanche.drpc.org',
      'https://1rpc.io/avax/c',
      'https://rpc.ankr.com/avalanche',
      'https://avax.meowrpc.com',
    ],
  },
  fantom: {
    chainId: 250,
    rpcs: [
      'https://rpcapi.fantom.network',
      'https://fantom-rpc.publicnode.com',
      'https://fantom.drpc.org',
      'https://1rpc.io/ftm',
      'https://rpc.fantom.network',
      'https://rpc2.fantom.network',
      'https://rpc3.fantom.network',
    ],
  },
  celo: {
    chainId: 42220,
    rpcs: [
      'https://forno.celo.org',
      'https://celo-rpc.publicnode.com',
      'https://rpc.ankr.com/celo',
      'https://celo.drpc.org',
      'https://1rpc.io/celo',
    ],
  },
  linea: {
    chainId: 59144,
    rpcs: [
      'https://rpc.linea.build',
      'https://linea-rpc.publicnode.com',
      'https://linea.drpc.org',
      'https://1rpc.io/linea',
      'https://linea.decubate.com',
    ],
  },
  scroll: {
    chainId: 534352,
    rpcs: [
      'https://rpc.scroll.io',
      'https://scroll-rpc.publicnode.com',
      'https://scroll.drpc.org',
      'https://1rpc.io/scroll',
      'https://rpc-scroll.icecreamswap.com',
    ],
  },
  zksync: {
    chainId: 324,
    rpcs: [
      'https://mainnet.era.zksync.io',
      'https://zksync-era-rpc.publicnode.com',
      'https://zksync.drpc.org',
      'https://1rpc.io/zksync2-era',
      'https://zksync.meowrpc.com',
    ],
  },
  zora: {
    chainId: 7777777,
    rpcs: [
      'https://rpc.zora.energy',
      'https://zora.drpc.org',
      'https://7777777.rpc.thirdweb.com',
    ],
  },
  mode: {
    chainId: 34443,
    rpcs: [
      'https://mainnet.mode.network',
      'https://mode.drpc.org',
      'https://1rpc.io/mode',
      'https://34443.rpc.thirdweb.com',
    ],
  },
  blast: {
    chainId: 81457,
    rpcs: [
      'https://rpc.blast.io',
      'https://blast-rpc.publicnode.com',
      'https://blast.drpc.org',
      'https://rpc.ankr.com/blast',
      'https://blastl2-mainnet.public.blastapi.io',
    ],
  },
  abstract: {
    chainId: 2741,
    rpcs: [
      'https://api.mainnet.abs.xyz',
      'https://abstract.drpc.org',
      'https://2741.rpc.thirdweb.com',
    ],
  },
};

async function rpcCall(url, method, params = []) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
    if (j.error) return { ok: false, ms, err: j.error.message ?? JSON.stringify(j.error) };
    return { ok: true, ms, result: j.result };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, err: e.name === 'AbortError' ? 'timeout' : (e.message ?? String(e)) };
  } finally {
    clearTimeout(t);
  }
}

async function probeOne(url, expectedChainId) {
  // 1) eth_chainId  — quick sanity check (and confirms it's the right network)
  const cid = await rpcCall(url, 'eth_chainId');
  if (!cid.ok) return { url, ok: false, ms: cid.ms, err: `chainId: ${cid.err}` };
  const got = parseInt(cid.result, 16);
  if (got !== expectedChainId)
    return { url, ok: false, ms: cid.ms, err: `chainId mismatch: got ${got}, want ${expectedChainId}` };
  // 2) eth_blockNumber — confirms it's not stuck / actually returns state
  const bn = await rpcCall(url, 'eth_blockNumber');
  if (!bn.ok) return { url, ok: false, ms: cid.ms + bn.ms, err: `blockNumber: ${bn.err}` };
  return { url, ok: true, ms: cid.ms + bn.ms, block: parseInt(bn.result, 16) };
}

async function probeChain(name, cfg) {
  const results = await Promise.all(cfg.rpcs.map((u) => probeOne(u, cfg.chainId)));
  // Sort: working first (by latency), then failing.
  results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return a.ms - b.ms;
  });
  return results;
}

(async () => {
  const out = {};
  for (const [name, cfg] of Object.entries(CANDIDATES)) {
    process.stderr.write(`probing ${name}...\n`);
    const rs = await probeChain(name, cfg);
    out[name] = rs;
    for (const r of rs) {
      const tag = r.ok ? `OK  ${String(r.ms).padStart(5)}ms  blk=${r.block}` : `FAIL            ${r.err}`;
      process.stderr.write(`  ${tag.padEnd(40)}  ${r.url}\n`);
    }
  }
  console.log(JSON.stringify(out, null, 2));
})();

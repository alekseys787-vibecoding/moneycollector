const TIMEOUT_MS = 6000;

const CANDIDATES = {
  optimism: {
    chainId: 10,
    rpcs: [
      'https://op-pokt.nodies.app',
      'https://optimism.meowrpc.com',
      'https://endpoints.omniatech.io/v1/op/mainnet/public',
      'https://optimism-mainnet.public.blastapi.io',
      'https://gateway.tenderly.co/public/optimism',
      'https://optimism.gateway.tenderly.co',
    ],
  },
  polygon: {
    chainId: 137,
    rpcs: [
      'https://polygon.meowrpc.com',
      'https://endpoints.omniatech.io/v1/matic/mainnet/public',
      'https://polygon-mainnet.public.blastapi.io',
      'https://gateway.tenderly.co/public/polygon',
      'https://polygon-pokt.nodies.app',
      'https://polygon-mainnet.gateway.tatum.io',
    ],
  },
  zksync: {
    chainId: 324,
    rpcs: [
      'https://zksync-mainnet.public.blastapi.io',
      'https://zksync-era.blockpi.network/v1/rpc/public',
      'https://endpoints.omniatech.io/v1/zksync-era/mainnet/public',
      'https://zksync-era.rpc.thirdweb.com',
      'https://324.rpc.thirdweb.com',
      'https://zksync.rpc.thirdweb.com',
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
  const cid = await rpcCall(url, 'eth_chainId');
  if (!cid.ok) return { url, ok: false, err: `chainId: ${cid.err}` };
  const got = parseInt(cid.result, 16);
  if (got !== expectedChainId) return { url, ok: false, err: `chainId mismatch ${got}` };
  const bn = await rpcCall(url, 'eth_blockNumber');
  if (!bn.ok) return { url, ok: false, err: `blockNumber: ${bn.err}` };
  return { url, ok: true, ms: cid.ms + bn.ms, block: parseInt(bn.result, 16) };
}

(async () => {
  for (const [name, cfg] of Object.entries(CANDIDATES)) {
    process.stderr.write(`extra ${name}...\n`);
    const rs = await Promise.all(cfg.rpcs.map((u) => probeOne(u, cfg.chainId)));
    rs.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : (a.ms ?? 0) - (b.ms ?? 0)));
    for (const r of rs) {
      const tag = r.ok ? `OK  ${String(r.ms).padStart(5)}ms` : `FAIL  ${r.err}`;
      process.stderr.write(`  ${tag.padEnd(40)}  ${r.url}\n`);
    }
  }
})();

// Stand-alone dry run of the Koi v2 scan logic — no ts-node, no env vars,
// no full wallet derivation. Just enumerates the factory pairs once and
// reports which of the user's three test wallets have any LP balance.
const RPC = 'https://mainnet.era.zksync.io';
const KOI_V2_FACTORY = '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const WALLETS = [
  '0xDF5A735C63c726e9Ba46bF5FdAbB7Dc10bb87293',
  '0x14e4687B89EF0903a1d5B182e8DFd569F17D7b61',
  '0x435978194E8343048db3AbF2577Ac6EC23Becdca',
];

const SEL_ALL_PAIRS_LENGTH = '0x574f2ba3';
const SEL_ALL_PAIRS = (i) => '0x1e3dd18b' + BigInt(i).toString(16).padStart(64, '0');
const SEL_BALANCE_OF = (addr) => '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0');

// Multicall3.aggregate3 selector: encode using minimal hand-rolled ABI encoder
// because we want zero dependencies.
function encodeMulticallAggregate3(calls) {
  // ABI: aggregate3((address,bool,bytes)[]) — selector 0x82ad56cb
  const sel = '82ad56cb';
  const numCalls = calls.length;
  let body = '';
  body += (32).toString(16).padStart(64, '0'); // offset to array
  body += BigInt(numCalls).toString(16).padStart(64, '0'); // array length
  // Inner offsets (each tuple has dynamic bytes, so each tuple is itself dynamic)
  const tupleOffsets = [];
  let tupleEncoded = '';
  let cursor = numCalls * 32;
  for (const c of calls) {
    tupleOffsets.push(cursor);
    const cdLen = (c.callData.length - 2) / 2; // bytes length
    const cdHex = c.callData.slice(2);
    const padCd = cdHex.padEnd(Math.ceil(cdHex.length / 64) * 64, '0');
    // tuple: address (32), bool (32), bytes-offset (32), bytes-length (32), bytes-data (padded)
    const tuple =
      c.target.slice(2).toLowerCase().padStart(64, '0') +
      (c.allowFailure ? 1 : 0).toString(16).padStart(64, '0') +
      (96).toString(16).padStart(64, '0') +
      BigInt(cdLen).toString(16).padStart(64, '0') +
      padCd;
    tupleEncoded += tuple;
    cursor += tuple.length / 2;
  }
  for (const o of tupleOffsets) body += BigInt(o).toString(16).padStart(64, '0');
  body += tupleEncoded;
  return '0x' + sel + body;
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function call(to, data) {
  return rpc('eth_call', [{ to, data }, 'latest']);
}

function decodeMulticallResults(hex, numCalls) {
  // [offset 32][length 32][element offsets...][elements...]
  // each element: (bool, bytes) — both dynamic? bool is fixed; bytes is dynamic.
  // Tuple layout: offset to (bool, bytes), where bool sits inline and bytes is at offset.
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  // skip first 32 bytes (offset to array) and next 32 (length)
  const elementOffsetsStart = 64 + 64;
  const elements = [];
  for (let i = 0; i < numCalls; i++) {
    const offHex = body.slice(elementOffsetsStart + i * 64, elementOffsetsStart + (i + 1) * 64);
    const off = Number(BigInt('0x' + offHex));
    // off is from the start of the array body (after length word)
    const tupleStart = 64 + off * 2;
    const success = BigInt('0x' + body.slice(tupleStart, tupleStart + 64)) === 1n;
    // bytes offset (relative to tuple start)
    const bytesOffHex = body.slice(tupleStart + 64, tupleStart + 128);
    const bytesOff = Number(BigInt('0x' + bytesOffHex));
    const bytesLenStart = tupleStart + bytesOff * 2;
    const bytesLen = Number(BigInt('0x' + body.slice(bytesLenStart, bytesLenStart + 64)));
    const bytesData = '0x' + body.slice(bytesLenStart + 64, bytesLenStart + 64 + bytesLen * 2);
    elements.push({ success, returnData: bytesData });
  }
  return elements;
}

(async () => {
  console.log('Querying Koi v2 factory.allPairsLength()...');
  const lenHex = await call(KOI_V2_FACTORY, SEL_ALL_PAIRS_LENGTH);
  const N = Number(BigInt(lenHex));
  console.log(`  total pairs: ${N}`);

  console.log(`\nEnumerating all ${N} pair addresses via multicall...`);
  const allPairs = [];
  const BATCH = 500;
  for (let start = 0; start < N; start += BATCH) {
    const end = Math.min(start + BATCH, N);
    const calls = [];
    for (let i = start; i < end; i++) {
      calls.push({ target: KOI_V2_FACTORY, allowFailure: true, callData: SEL_ALL_PAIRS(i) });
    }
    const reqData = encodeMulticallAggregate3(calls);
    const resHex = await call(MULTICALL3, reqData);
    const parsed = decodeMulticallResults(resHex, calls.length);
    for (const r of parsed) {
      if (r.success && r.returnData !== '0x') {
        allPairs.push('0x' + r.returnData.slice(-40));
      } else {
        allPairs.push(null);
      }
    }
    process.stdout.write(`  fetched ${end}/${N}\r`);
  }
  console.log(`\n  pairs decoded: ${allPairs.filter(Boolean).length}`);

  for (const w of WALLETS) {
    console.log(`\n=== Wallet ${w} ===`);
    const calls = allPairs.filter(Boolean).map((p) => ({
      target: p,
      allowFailure: true,
      callData: SEL_BALANCE_OF(w),
    }));
    const found = [];
    for (let start = 0; start < calls.length; start += BATCH) {
      const slice = calls.slice(start, start + BATCH);
      const resHex = await call(MULTICALL3, encodeMulticallAggregate3(slice));
      const parsed = decodeMulticallResults(resHex, slice.length);
      for (let j = 0; j < parsed.length; j++) {
        const r = parsed[j];
        if (r.success && r.returnData !== '0x') {
          const bal = BigInt(r.returnData);
          if (bal > 0n) found.push({ pair: slice[j].target, balance: bal });
        }
      }
    }
    if (found.length === 0) console.log('  (no Koi v2 LP positions)');
    else for (const f of found) console.log(`  ${f.pair}  bal=${f.balance}`);
  }
})();

const RPC = 'https://mainnet.era.zksync.io';

const NFT_CONTRACTS = [
  // Common to wallet 1 AND 2 — these are the most likely Koi LP candidates
  '0x3A05397404B1B51d22B375E0622e6942c915bafF',
  '0x53eC17BD635F7A54B3551E76Fd53Db8881028fC3',
  '0xCc788c0495894C01F01cD328CF637c7C441Ee69E',
  // Wallet-1-only NFTs
  '0x10b5C621850dC3Db54b500991579CB96F624b21E',
  '0x17D9B864AF82c6B83fa6330D65BFE61f3e944Fff',
  '0x44DB5de936f2254fB2988e419D01E9A83DbbAbd2',
  '0x955AE6B7005eFA49F23cCFcb385cdcf542C06276',
  '0xcAF741840240E6aB1a010D13368C2d15774487D3',
  '0xEE0D4A8F649D83F6BA5e5c9E6c4D4F6ae846846A',
  '0xF27e53EDC24Be11B4C5dc4631Fd75EA0Ed896D64',
  '0xF77bd7c05598E094bc06e34bB81C07Bd3B091dB1',
  '0xFd54762D435A490405DDa0fBc92b7168934e8525',
  // Wallet-2-only
  '0x06d52C7E52E9F28e3AD889ab2083fE8Dba735D52',
  '0x7B34797015FcDebb1E3eD8CdA1757ce2D87867Ac',
  '0x82413f72155Ab5A53cCCeA64de8cae7501077f1C',
];

const SEL_NAME = '0x06fdde03';   // name()
const SEL_SYMBOL = '0x95d89b41'; // symbol()
const SEL_FACTORY = '0xc45a0155'; // factory()  (Uni-V3 NPM exposes this)

async function call(to, data) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await res.json();
  if (j.error) return null;
  return j.result;
}

function decodeString(hex) {
  if (!hex || hex.length < 130) return '';
  try {
    const lenHex = '0x' + hex.slice(2 + 64, 2 + 64 * 2);
    const len = Number(BigInt(lenHex));
    if (len <= 0 || len > 256) return '';
    const dataHex = hex.slice(2 + 64 * 2, 2 + 64 * 2 + len * 2);
    return Buffer.from(dataHex, 'hex').toString('utf8').replace(/\0/g, '');
  } catch {
    return '';
  }
}

function decodeAddress(hex) {
  if (!hex || hex === '0x' || hex.length < 66) return '';
  return '0x' + hex.slice(-40);
}

(async () => {
  for (const addr of NFT_CONTRACTS) {
    const [nameRes, symbolRes, factoryRes] = await Promise.all([
      call(addr, SEL_NAME),
      call(addr, SEL_SYMBOL),
      call(addr, SEL_FACTORY),
    ]);
    const name = decodeString(nameRes ?? '');
    const symbol = decodeString(symbolRes ?? '');
    const factory = factoryRes && factoryRes !== '0x' ? decodeAddress(factoryRes) : '';
    console.log(`${addr}  name="${name}"  symbol="${symbol}"  factory=${factory || '(none)'}`);
  }
})();

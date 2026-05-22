// Test the actual koi adapter (V2 + V3) against the user's three wallets,
// using the production code path (ethers-based). No transactions — only scan.
import 'dotenv/config';
import { koiV2Adapter, koiV3Adapter } from '../src/protocols/koi';

const WALLETS = [
  '0xDF5A735C63c726e9Ba46bF5FdAbB7Dc10bb87293',
  '0x14e4687B89EF0903a1d5B182e8DFd569F17D7b61',
  '0x435978194E8343048db3AbF2577Ac6EC23Becdca',
];

(async () => {
  for (const w of WALLETS) {
    console.log(`\n=== ${w} ===`);

    console.log('koi-v3:');
    const v3 = await koiV3Adapter.scan(w, ['zksync']);
    if (v3.length === 0) console.log('  (none)');
    for (const p of v3) console.log('  ' + p.description);

    console.log('koi-v2:');
    const v2 = await koiV2Adapter.scan(w, ['zksync']);
    if (v2.length === 0) console.log('  (none)');
    for (const p of v2) console.log('  ' + p.description);
  }
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});

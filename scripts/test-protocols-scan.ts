// Smoke test for the new --mode protocols --scan-only flow.
// Calls scan() per adapter, applies USD prices via CoinGecko, prints the
// summary table — without touching the seeds file (avoids depending on the
// user's local data/).
import 'dotenv/config';
import { ALL_CHAIN_KEYS } from '../src/config/chains';
import { ADAPTERS, Position } from '../src/protocols';
import { priceUnderlyingUsd } from '../src/utils/prices';

const WALLETS = [
  '0xDF5A735C63c726e9Ba46bF5FdAbB7Dc10bb87293',
  '0x14e4687B89EF0903a1d5B182e8DFd569F17D7b61',
  '0x435978194E8343048db3AbF2577Ac6EC23Becdca',
];

(async () => {
  // 1. Scan
  const all: { addr: string; positions: Position[] }[] = [];
  for (const w of WALLETS) {
    const positions: Position[] = [];
    for (const a of ADAPTERS) {
      try {
        positions.push(...(await a.scan(w, ALL_CHAIN_KEYS)));
      } catch (e: any) {
        console.error(`[${a.name}] scan failed for ${w}: ${e.message}`);
      }
    }
    all.push({ addr: w, positions });
  }

  // 2. Per-underlying USD lookup (cached so common tokens are fetched once)
  for (const { positions } of all) {
    for (const p of positions) {
      if (!p.value) continue;
      let sum = 0;
      let allPriced = true;
      for (const u of p.value.underlying) {
        const px = await priceUnderlyingUsd(p.chain, u.symbol, u.address);
        if (px == null) { allPriced = false; break; }
        sum += u.amountHuman * px;
      }
      p.value.usdTotal = allPriced ? sum : null;
    }
  }

  // 4. Print
  let grand = 0;
  for (const { addr, positions } of all) {
    if (positions.length === 0) {
      console.log(`\n${addr}  (no positions)`);
      continue;
    }
    console.log(`\n${addr}`);
    for (const p of positions) {
      const usd = p.value?.usdTotal;
      const usdStr = usd == null ? '   ?  ' : `$${usd.toFixed(4)}`;
      console.log(`  ${p.chain.padEnd(10)} [${p.protocol}]  ${usdStr}  ${p.description}`);
      if (usd != null) grand += usd;
    }
  }
  console.log(`\nTotal: $${grand.toFixed(4)}`);
})();

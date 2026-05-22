// Verify computeMaxUpfrontFeeWei: ask Relay for a fresh zkSync USDC→Base
// quote and compare upfront (gas×maxFeePerGas) vs quote.fees.gas (USD).
import 'dotenv/config';
import { formatEther } from 'ethers';
import { relayQuote, summarise, predictUpfrontWei } from '../src/swap/relay';
import { CHAINS } from '../src/config/chains';
import { getProvider } from '../src/discovery/evm';
import { priceUnderlyingUsd } from '../src/utils/prices';

(async () => {
  const wallet = '0xDF5A735C63c726e9Ba46bF5FdAbB7Dc10bb87293';
  // Same swap that failed in the user's run: 1.029305 USDC.e on zkSync → ETH on Base.
  const q = await relayQuote({
    user: wallet,
    recipient: wallet,
    originChainId: CHAINS.zksync.chainId,
    destinationChainId: CHAINS.base.chainId,
    originCurrency: '0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4', // USDC.e on zksync
    destinationCurrency: '0x0000000000000000000000000000000000000000',
    amount: '1029305', // 1.029305 USDC (6 decimals)
    slippageBps: 100,
  });

  const s = summarise(q);
  const provider = getProvider(CHAINS.zksync);
  const fd = await provider.getFeeData();
  const ethersMaxFee = fd.maxFeePerGas ?? fd.gasPrice ?? 0n;
  const upfront = await predictUpfrontWei(q, provider);
  const ethPrice = (await priceUnderlyingUsd('zksync', 'WETH', '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91')) ?? 0;

  console.log('Quote analysis:');
  console.log(`  Relay quote.fees.gas (USD)      = $${s.gasUsd.toFixed(4)}`);
  console.log(`  ethers feeData.maxFeePerGas     = ${ethersMaxFee} (${(Number(ethersMaxFee) / 1e9).toFixed(4)} gwei)`);
  console.log(`  predictUpfrontWei (what ethers will submit needs):`);
  console.log(`     = ${upfront} wei = ${formatEther(upfront)} ETH = $${(Number(formatEther(upfront)) * ethPrice).toFixed(4)}`);
  console.log(`  → funder target (×1.2) = $${(Number(formatEther(upfront)) * ethPrice * 1.2).toFixed(4)}`);

  // Per-step breakdown — both Relay-reported AND what ethers will use.
  console.log('\nStep breakdown (Relay → ethers transform):');
  for (const step of q.steps) {
    if (step.kind && step.kind !== 'transaction') continue;
    for (const item of (step.items || [])) {
      const d = item.data;
      if (!d) continue;
      const gas = d.gas ? BigInt(d.gas) : 0n;
      const relayMfpg = d.maxFeePerGas ? BigInt(d.maxFeePerGas) : 0n;
      const value = d.value ? BigInt(d.value) : 0n;
      const relayFee = gas * relayMfpg;
      const ethersFee = gas * ethersMaxFee;
      console.log(
        `  ${step.id || step.action} → ${d.to.slice(0,10)}…  gas=${gas}  value=${formatEther(value)} ETH`,
      );
      console.log(
        `     Relay maxFee=${(Number(relayMfpg) / 1e9).toFixed(4)} gwei  → reservation ${formatEther(relayFee)} ETH (not used: ethers overrides)`,
      );
      console.log(
        `     ethers maxFee=${(Number(ethersMaxFee) / 1e9).toFixed(4)} gwei → reservation ${formatEther(ethersFee)} ETH`,
      );
    }
  }
})().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});

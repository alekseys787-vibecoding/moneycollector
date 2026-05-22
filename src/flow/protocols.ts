import chalk from 'chalk';
import prompts from 'prompts';
import { ALL_CHAIN_KEYS } from '../config/chains';
import { EvmAccount } from '../wallet/derive';
import { WalletSources, loadEvmAccounts } from '../wallet/source';
import { log } from '../utils/logger';
import { priceUnderlyingUsd } from '../utils/prices';
import { registerExtraToken } from '../config/tokens';
import { ADAPTERS, Position } from '../protocols';

interface WalletPositions {
  wallet: EvmAccount;
  positions: Position[];
}

async function applyUsdPrices(positions: Position[]): Promise<void> {
  // Resolve each (chain, symbol, address) once. priceUnderlyingUsd uses the
  // shared TTL cache, so a wallet that holds WETH on zkSync and another
  // wallet that also holds WETH on zkSync share one CoinGecko request.
  for (const p of positions) {
    if (!p.value) continue;
    let sum = 0;
    let allPriced = true;
    for (const u of p.value.underlying) {
      const px = await priceUnderlyingUsd(p.chain, u.symbol, u.address);
      if (px == null) {
        allPriced = false;
        break;
      }
      sum += u.amountHuman * px;
    }
    p.value.usdTotal = allPriced ? sum : null;
  }
}

function formatUsd(n: number | null | undefined): string {
  if (n == null) return chalk.gray('     ?  ');
  if (n < 0.01) return chalk.gray(`$${n.toFixed(4)}`);
  return chalk.bold(`$${n.toFixed(2).padStart(6)}`);
}

function printSummary(walletPositions: WalletPositions[]): number {
  let grandUsd = 0;
  let unpricedCount = 0;
  let positionsCount = 0;

  for (const wp of walletPositions) {
    if (wp.positions.length === 0) continue;
    console.log(chalk.bold(`\n${wp.wallet.address}`));
    for (const p of wp.positions) {
      positionsCount++;
      const usd = p.value?.usdTotal ?? null;
      if (usd != null) grandUsd += usd;
      else unpricedCount++;

      console.log(
        `  ${p.chain.padEnd(10)} ${chalk.magenta(`[${p.protocol}]`)} ` +
          `${formatUsd(usd)}  ${p.description}`,
      );
    }
  }

  console.log(chalk.bold(`\nTotal across all wallets: ~$${grandUsd.toFixed(2)} ` +
    `(${positionsCount} positions` +
    (unpricedCount > 0 ? `, ${unpricedCount} unpriced` : '') + `)`));
  return grandUsd;
}

async function scanAllWallets(wallets: EvmAccount[]): Promise<WalletPositions[]> {
  const out: WalletPositions[] = [];
  // Scan wallets sequentially. Adapter session-caches (e.g., koi-v2 pair
  // enumeration) amortize over all wallets, but per-wallet calls still take
  // a few RPC roundtrips. Parallelizing across wallets would multiply load
  // on the same RPC endpoints — usually counterproductive on public RPCs.
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    process.stdout.write(`  scanning ${i + 1}/${wallets.length} ${w.address}... `);
    const positions: Position[] = [];
    for (const adapter of ADAPTERS) {
      try {
        const found = await adapter.scan(w.address, ALL_CHAIN_KEYS);
        positions.push(...found);
      } catch (e: any) {
        log.warn(`\n  [${adapter.name}] scan crashed: ${e.message}`);
      }
    }
    out.push({ wallet: w, positions });
    process.stdout.write(positions.length > 0 ? chalk.green(`${positions.length} pos\n`) : chalk.gray('—\n'));
  }
  return out;
}

async function enrichWithUsd(walletPositions: WalletPositions[]): Promise<void> {
  for (const wp of walletPositions) {
    await applyUsdPrices(wp.positions);
  }
}

async function exitAllPositions(walletPositions: WalletPositions[]): Promise<void> {
  for (const wp of walletPositions) {
    if (wp.positions.length === 0) continue;
    log.step(`exiting ${wp.positions.length} position(s) on ${wp.wallet.address}`);

    // Index adapters by name for lookup-during-exit.
    const adapterByName = new Map(ADAPTERS.map((a) => [a.name, a]));

    for (const pos of wp.positions) {
      const adapter = adapterByName.get(pos.protocol);
      if (!adapter) {
        log.warn(`  no adapter registered for protocol="${pos.protocol}"; skipping`);
        continue;
      }
      try {
        const r = await adapter.exit(wp.wallet, pos);
        if (r.ok) {
          log.ok(
            `  exited ${pos.description}` +
              (r.txHashes.length ? ` (tx: ${r.txHashes.join(', ')})` : ''),
          );
          if (r.freedTokens) {
            for (const ft of r.freedTokens) {
              registerExtraToken(pos.chain, {
                address: ft.address,
                symbol: ft.symbol,
                decimals: ft.decimals,
              });
            }
          }
        } else {
          log.warn(`  failed ${pos.description}: ${r.error}`);
        }
      } catch (e: any) {
        log.err(`  crash exiting ${pos.description}: ${e.message}`);
      }
    }
  }
}

export async function runProtocolsMode(opts: {
  sources: WalletSources;
  scanOnly: boolean;
}): Promise<void> {
  log.step(`Protocol-adapter mode (${opts.scanOnly ? 'scan-only' : 'real'})`);
  const wallets = loadEvmAccounts(opts.sources);
  log.info(`Loaded ${wallets.length} wallets`);
  log.info(`Adapters registered: ${ADAPTERS.map((a) => a.name).join(', ')}`);

  console.log('\nScanning…');
  const walletPositions = await scanAllWallets(wallets);

  const withAny = walletPositions.filter((w) => w.positions.length > 0);
  if (withAny.length === 0) {
    log.ok('No positions found across any wallet. Nothing to do.');
    return;
  }

  console.log('\nFetching USD prices…');
  await enrichWithUsd(walletPositions);

  console.log(chalk.bold('\n========== Positions summary =========='));
  const totalUsd = printSummary(walletPositions);

  if (opts.scanOnly) {
    console.log(chalk.gray('\nScan-only mode — no transactions sent. Re-run without --scan-only to exit positions.'));
    return;
  }

  const answer = await prompts({
    type: 'confirm',
    name: 'go',
    message: `Exit all ${withAny.length} wallets' positions (~$${totalUsd.toFixed(2)} total)?`,
    initial: false,
  });
  if (!answer.go) {
    log.warn('User declined. No exits performed.');
    return;
  }

  await exitAllPositions(walletPositions);
  log.ok('All exits attempted. Freed tokens registered in tokens.ts cache for this session.');
  console.log(
    chalk.gray(
      '\nTip: tokens that were unwound are NOT bridged by this mode. Run `npm run evm` ' +
        'next to sweep them as part of the normal dust collection flow.',
    ),
  );
}

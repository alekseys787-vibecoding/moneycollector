import * as bip39 from 'bip39';
import fs from 'fs';
import path from 'path';
import { deriveEvm, deriveSolana } from './derive';

export interface GeneratedRecipient {
  index: number;
  mnemonic: string;
  evmAddress: string;
  solAddress: string;
}

export interface GenerateResult {
  recipients: GeneratedRecipient[];
  // Absolute path of the per-run keys file (idx | mnemonic | evm | sol).
  // This is the file the user MUST save — it's not regenerated.
  keysFile: string;
  // Absolute paths of the recipient-address lists the existing flow reads.
  evmListFile: string;
  solListFile: string;
}

// Used by the wizard's default count prompt.
export const DEFAULT_RECIPIENT_COUNT = 5;

// Generate `count` BIP39 mnemonics (12 words / 128-bit entropy), derive an EVM
// address and a Solana address per mnemonic, and write three files into
// `dataDir`:
//   - generated-recipients-<timestamp>.txt: idx | mnemonic | evm | sol
//     (USER MUST SAVE — not regenerated)
//   - recipients-evm.txt: one EVM address per line (appended)
//   - recipients-sol.txt: one Solana base58 per line (appended)
//
// `addressOnly`: when true (used in pure-Solana / pure-EVM runs) only the
// relevant address-list file is appended; the keys file still contains BOTH
// derivations so the user can reuse the wallet for the other chain later.
export function generateRecipientWallets(
  count: number,
  dataDir: string,
  opts: { onlyChain?: 'evm' | 'sol' } = {},
): GenerateResult {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`Recipient count must be a positive integer, got ${count}`);
  }
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const recipients: GeneratedRecipient[] = [];
  for (let i = 1; i <= count; i++) {
    const mnemonic = bip39.generateMnemonic(128); // 12 words
    const evm = deriveEvm(mnemonic);
    const sol = deriveSolana(mnemonic);
    recipients.push({
      index: i,
      mnemonic,
      evmAddress: evm.address,
      solAddress: sol.address,
    });
  }

  // Filename-safe timestamp (no `:` for Windows).
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/T/, '_')
    .slice(0, 19);
  const keysFile = path.join(dataDir, `generated-recipients-${ts}.txt`);

  const header = [
    '# Generated recipient wallets — SAVE THIS FILE.',
    '# Mnemonics are NOT regenerated. Lose this file, lose access to these wallets.',
    '# Format: idx | mnemonic | evm_address | sol_address',
    '',
  ];
  const rows = recipients.map(
    (r) => `${r.index} | ${r.mnemonic} | ${r.evmAddress} | ${r.solAddress}`,
  );
  fs.writeFileSync(keysFile, header.concat(rows).join('\n') + '\n', 'utf8');

  const evmListFile = path.join(dataDir, 'recipients-evm.txt');
  const solListFile = path.join(dataDir, 'recipients-sol.txt');

  if (opts.onlyChain !== 'sol') {
    const evmBlock = recipients.map((r) => r.evmAddress).join('\n') + '\n';
    appendListFile(evmListFile, evmBlock);
  }
  if (opts.onlyChain !== 'evm') {
    const solBlock = recipients.map((r) => r.solAddress).join('\n') + '\n';
    appendListFile(solListFile, solBlock);
  }

  return { recipients, keysFile, evmListFile, solListFile };
}

// Append a block of lines to a list file. Ensures the existing content (if any)
// ends with a newline so addresses don't get glued onto a prior line.
function appendListFile(file: string, block: string): void {
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    if (existing.length > 0 && !existing.endsWith('\n')) {
      fs.appendFileSync(file, '\n');
    }
  }
  fs.appendFileSync(file, block, 'utf8');
}

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import prompts from 'prompts';
import chalk from 'chalk';

import { log, LOG_FILE_PATH } from './utils/logger';
import { WalletSources, loadEvmAccounts, loadSolanaAccounts } from './wallet/source';
import {
  readSeedsFile,
  readEvmPrivkeyFile,
  readSolanaSecretFile,
  deriveEvmFromPrivateKey,
  deriveSolanaFromSecret,
} from './wallet/derive';
import {
  generateRecipientWallets,
  DEFAULT_RECIPIENT_COUNT,
} from './wallet/generateRecipients';
import { runEvmMode, runEvmScan } from './flow/evm';
import { runSolanaMode, runSolanaScan, SOL_ACTIVATION_LAMPORTS } from './flow/solana';
import { ALL_CHAIN_KEYS, CHAINS, ChainKey } from './config/chains';
import { TokenInfo, clearTokensCache } from './config/tokens';
import { getProvider, rpcRetry } from './discovery/evm';
import * as bip39 from 'bip39';
import { Contract, isAddress as isEvmAddress, getAddress } from 'ethers';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

type Mode = 'evm-scan' | 'evm-real' | 'sol-scan' | 'sol-real';

const DATA_DIR = path.resolve(process.cwd(), 'data');
// Per-mode wallet files. Mnemonics are split EVM/Solana because the same
// BIP39 phrase derives DIFFERENT addresses on each chain — sharing one file
// across modes is a footgun (paste Sol-intent mnemonic → run EVM mode →
// derive empty EVM addresses → "where's my money?" confusion).
const EVM_SEEDS_FILE = path.join(DATA_DIR, 'seeds-evm.txt');
const SOL_SEEDS_FILE = path.join(DATA_DIR, 'seeds-sol.txt');
const EVM_PRIVKEYS_FILE = path.join(DATA_DIR, 'privkeys-evm.txt');
const SOL_PRIVKEYS_FILE = path.join(DATA_DIR, 'privkeys-sol.txt');
const RECIPIENTS_EVM_FILE = path.join(DATA_DIR, 'recipients-evm.txt');
const RECIPIENTS_SOL_FILE = path.join(DATA_DIR, 'recipients-sol.txt');
const FUNDERS_EVM_FILE = path.join(DATA_DIR, 'funders-evm.txt');
const FUNDERS_SOL_FILE = path.join(DATA_DIR, 'funders-sol.txt');

const ABORT_MSG = chalk.gray('  (cancelled — exiting wizard)');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Read non-empty / non-comment lines from a text file. Returns [] if missing.
function countNonEmptyLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#')).length;
}

// Read pasted lines from stdin until a blank line. Used for mnemonics, privkeys,
// addresses, funders — any free-form bulk input. Returns trimmed non-empty lines.
function readUntilBlank(label: string): Promise<string[]> {
  console.log();
  console.log(chalk.bold(label));
  console.log(chalk.gray('  (one entry per line; submit an empty line to finish)'));
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    const lines: string[] = [];
    rl.on('line', (line) => {
      const t = line.trim();
      if (t === '') {
        rl.close();
        return;
      }
      lines.push(t);
    });
    rl.on('close', () => resolve(lines));
  });
}

// Append `block` to `file`, ensuring the existing content ends with a newline
// so entries don't get glued onto a prior line.
function appendBlock(file: string, lines: string[]): void {
  if (lines.length === 0) return;
  ensureDataDir();
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    if (existing.length > 0 && !existing.endsWith('\n')) {
      fs.appendFileSync(file, '\n');
    }
  }
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

function writeFresh(file: string, lines: string[], header?: string): void {
  ensureDataDir();
  const body = lines.join('\n') + '\n';
  fs.writeFileSync(file, (header ?? '') + body);
}

// Validators per format. Each returns { ok, error? } so we can show the user
// exactly which line failed and why.
function validateMnemonic(line: string): string | null {
  const words = line.toLowerCase().trim().split(/\s+/);
  const ok = [12, 15, 18, 21, 24].includes(words.length);
  if (!ok) return `expected 12/15/18/21/24 words, got ${words.length}`;
  if (!bip39.validateMnemonic(words.join(' '))) return 'BIP39 checksum failed';
  return null;
}
function validateEvmPrivkey(line: string): string | null {
  try {
    deriveEvmFromPrivateKey(line);
    return null;
  } catch (e: any) {
    return e.message;
  }
}
function validateSolSecret(line: string): string | null {
  try {
    deriveSolanaFromSecret(line);
    return null;
  } catch (e: any) {
    return e.message;
  }
}

// Validate a pasted block, collect first-line errors. If any fail, ask user
// whether to keep only the valid ones or abort.
async function validateBatch(
  lines: string[],
  validator: (s: string) => string | null,
  label: string,
): Promise<string[] | null> {
  const valid: string[] = [];
  const errors: { line: number; value: string; err: string }[] = [];
  lines.forEach((l, i) => {
    const err = validator(l);
    if (err) errors.push({ line: i + 1, value: l, err });
    else valid.push(l);
  });
  if (errors.length === 0) return valid;

  console.log(chalk.red(`\n${errors.length} of ${lines.length} ${label} are invalid:`));
  for (const e of errors.slice(0, 5)) {
    const short = e.value.length > 30 ? e.value.slice(0, 27) + '…' : e.value;
    console.log(chalk.red(`  line ${e.line}: "${short}" — ${e.err}`));
  }
  if (errors.length > 5) console.log(chalk.gray(`  …and ${errors.length - 5} more.`));

  const a = await prompts({
    type: 'select',
    name: 'go',
    message: `Keep only the ${valid.length} valid one(s)?`,
    choices: [
      { title: `Yes — drop bad ${label}`, value: 'keep' },
      { title: 'No — re-enter from scratch', value: 'retry' },
      { title: 'Cancel wizard', value: 'abort' },
    ],
  });
  if (a.go === 'keep') return valid;
  if (a.go === 'abort') return null;
  return [];
}

// ---------------------------------------------------------------------------
// Wallets stage. Per-mode files (mnemonics + privkeys), single-paste UX with
// auto-detection of each line as mnemonic / EVM-hex / Sol-base58 / Sol-JSON.
// Wrong-format entries are REJECTED for the current mode (e.g. you can't paste
// a Solana secret while running EVM mode — that's the footgun we're fixing).
// ---------------------------------------------------------------------------

type DetectedKind = 'mnemonic' | 'evm-privkey' | 'sol-secret';
interface DetectedLine {
  kind: DetectedKind | 'invalid';
  value: string; // normalised (lowercased mnemonic; raw hex/base58/JSON)
  error?: string;
}

// Classify one pasted line. Order matters: multi-word → mnemonic; `[…]` → Sol
// JSON; 64-hex → EVM; otherwise try Sol base58. Each branch fully validates
// (e.g. checksum, key-length) before returning.
function detectFormat(raw: string): DetectedLine {
  const t = raw.trim();
  if (!t) return { kind: 'invalid', value: t, error: 'empty' };

  // Multi-word → BIP39 mnemonic.
  if (/\s/.test(t)) {
    const words = t.toLowerCase().split(/\s+/);
    if (![12, 15, 18, 21, 24].includes(words.length)) {
      return {
        kind: 'invalid',
        value: t,
        error: `${words.length} words is not a valid BIP39 length (12/15/18/21/24)`,
      };
    }
    const phrase = words.join(' ');
    if (!bip39.validateMnemonic(phrase)) {
      return { kind: 'invalid', value: t, error: 'BIP39 checksum failed' };
    }
    return { kind: 'mnemonic', value: phrase };
  }

  // `[…]` → Solana JSON-array secret.
  if (t.startsWith('[')) {
    try {
      deriveSolanaFromSecret(t);
      return { kind: 'sol-secret', value: t };
    } catch (e: any) {
      return { kind: 'invalid', value: t, error: `JSON not a valid Solana secret: ${e.message}` };
    }
  }

  // 64-hex (with or without 0x) → EVM private key.
  const stripped = t.toLowerCase().startsWith('0x') ? t.slice(2) : t;
  if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
    try {
      deriveEvmFromPrivateKey(t);
      return { kind: 'evm-privkey', value: t };
    } catch (e: any) {
      return { kind: 'invalid', value: t, error: e.message };
    }
  }

  // Fallback: try as Solana base58 secret (Phantom export is ~88 chars).
  try {
    deriveSolanaFromSecret(t);
    return { kind: 'sol-secret', value: t };
  } catch (e: any) {
    return {
      kind: 'invalid',
      value: t,
      error: `not recognised as mnemonic / EVM 0x-hex / Solana secret (${e.message})`,
    };
  }
}

function humanKind(k: DetectedKind | 'invalid'): string {
  switch (k) {
    case 'mnemonic': return 'BIP39 mnemonic';
    case 'evm-privkey': return 'EVM private key';
    case 'sol-secret': return 'Solana secret';
    default: return 'invalid';
  }
}

async function setupWallets(mode: Mode): Promise<WalletSources> {
  const isEvmMode = mode === 'evm-scan' || mode === 'evm-real';
  const isSolMode = mode === 'sol-scan' || mode === 'sol-real';

  const seedsFile = isEvmMode ? EVM_SEEDS_FILE : SOL_SEEDS_FILE;
  const privkeysFile = isEvmMode ? EVM_PRIVKEYS_FILE : SOL_PRIVKEYS_FILE;
  const wrongFormat: DetectedKind = isEvmMode ? 'sol-secret' : 'evm-privkey';

  console.log(chalk.bold('\n== Wallets =='));
  console.log(
    chalk.gray(
      `  ${isEvmMode ? 'EVM' : 'Solana'} mode — separate files from the other chain.\n` +
        `    ${path.basename(seedsFile)}    BIP39 mnemonics (will be derived as ${isEvmMode ? 'EVM' : 'Solana'} addresses)\n` +
        `    ${path.basename(privkeysFile)} ${isEvmMode ? 'raw EVM private keys (32-byte hex)' : 'raw Solana secrets (base58 or JSON array)'}\n` +
        `  Paste both formats mixed — wizard sorts each line automatically.`,
    ),
  );

  const counts = {
    mnemonics: countNonEmptyLines(seedsFile),
    privkeys: countNonEmptyLines(privkeysFile),
  };
  const total = counts.mnemonics + counts.privkeys;
  console.log(
    chalk.gray(
      `  Currently saved: ${counts.mnemonics} mnemonic${counts.mnemonics === 1 ? '' : 's'}, ` +
        `${counts.privkeys} ${isEvmMode ? 'EVM' : 'Solana'} private key${counts.privkeys === 1 ? '' : 's'}.`,
    ),
  );

  let action: 'use' | 'add' | 'replace';
  if (total > 0) {
    const a = await prompts({
      type: 'select',
      name: 'a',
      message: 'What now?',
      choices: [
        { title: `Use existing as-is (${total} wallet${total === 1 ? '' : 's'})`, value: 'use' },
        { title: 'Add more (paste mix of mnemonics + private keys)', value: 'add' },
        { title: 'Replace (clear both files, start fresh)', value: 'replace' },
      ],
    });
    if (!a.a) throw new Error('cancelled');
    action = a.a;
  } else {
    console.log(chalk.yellow('  No wallets yet — paste them now.'));
    action = 'add';
  }

  if (action === 'use') return makeSources(mode, seedsFile, privkeysFile);

  if (action === 'replace') {
    if (fs.existsSync(seedsFile)) fs.writeFileSync(seedsFile, '');
    if (fs.existsSync(privkeysFile)) fs.writeFileSync(privkeysFile, '');
    console.log(chalk.gray(`  Cleared ${path.basename(seedsFile)} and ${path.basename(privkeysFile)}.`));
  }

  // Paste loop — keeps retrying until we have at least one valid entry (or
  // user aborts). Each pass classifies every pasted line and reports.
  while (true) {
    const promptText =
      `Paste ${isEvmMode ? 'EVM' : 'Solana'} wallets ` +
      `(mnemonics ${isEvmMode ? '+ EVM private keys' : '+ Solana secrets'}, mixed OK):`;
    const lines = await readUntilBlank(promptText);
    if (lines.length === 0) {
      if (total > 0 && action === 'add') {
        console.log(chalk.gray('  (nothing pasted — keeping existing)'));
        return makeSources(mode, seedsFile, privkeysFile);
      }
      console.log(chalk.red('  No input. Try again or Ctrl+C to abort.'));
      continue;
    }

    const buckets = { mnemonic: [] as string[], privkey: [] as string[] };
    const invalids: { lineNo: number; raw: string; error: string }[] = [];
    const wrongMode: { lineNo: number; raw: string }[] = [];

    lines.forEach((raw, i) => {
      const d = detectFormat(raw);
      if (d.kind === 'invalid') {
        invalids.push({ lineNo: i + 1, raw, error: d.error || 'unknown' });
        return;
      }
      if (d.kind === wrongFormat) {
        wrongMode.push({ lineNo: i + 1, raw });
        return;
      }
      if (d.kind === 'mnemonic') buckets.mnemonic.push(d.value);
      else buckets.privkey.push(d.value);
    });

    // Report what was detected.
    const detectedParts: string[] = [];
    if (buckets.mnemonic.length > 0) detectedParts.push(`${buckets.mnemonic.length} mnemonic${buckets.mnemonic.length === 1 ? '' : 's'}`);
    if (buckets.privkey.length > 0) {
      detectedParts.push(
        `${buckets.privkey.length} ${isEvmMode ? 'EVM' : 'Solana'} private key${buckets.privkey.length === 1 ? '' : 's'}`,
      );
    }
    if (detectedParts.length > 0) {
      console.log(chalk.green(`  Detected: ${detectedParts.join(', ')}.`));
    }

    if (wrongMode.length > 0) {
      const wrong = humanKind(wrongFormat);
      console.log(
        chalk.red(
          `  ${wrongMode.length} line(s) look like a ${wrong} — won't be used in ${isEvmMode ? 'EVM' : 'Solana'} mode.`,
        ),
      );
      for (const w of wrongMode.slice(0, 3)) {
        const short = w.raw.length > 40 ? w.raw.slice(0, 37) + '…' : w.raw;
        console.log(chalk.red(`    line ${w.lineNo}: "${short}"`));
      }
      if (wrongMode.length > 3) console.log(chalk.gray(`    …and ${wrongMode.length - 3} more.`));
      console.log(
        chalk.gray(
          `  These will be ignored. To use them, re-run wizard and pick ${isEvmMode ? 'Solana' : 'EVM'} mode.`,
        ),
      );
    }

    if (invalids.length > 0) {
      console.log(chalk.red(`  ${invalids.length} line(s) didn't match any supported format:`));
      for (const e of invalids.slice(0, 5)) {
        const short = e.raw.length > 30 ? e.raw.slice(0, 27) + '…' : e.raw;
        console.log(chalk.red(`    line ${e.lineNo}: "${short}" — ${e.error}`));
      }
      if (invalids.length > 5) console.log(chalk.gray(`    …and ${invalids.length - 5} more.`));
    }

    const totalNew = buckets.mnemonic.length + buckets.privkey.length;
    if (totalNew === 0) {
      const a = await prompts({
        type: 'select',
        name: 'a',
        message: 'Nothing usable was parsed. What now?',
        choices: [
          { title: 'Try pasting again', value: 'retry' },
          { title: 'Cancel wizard', value: 'abort' },
        ],
      });
      if (a.a === 'abort' || !a.a) throw new Error('cancelled');
      continue;
    }

    if (invalids.length > 0 || wrongMode.length > 0) {
      const a = await prompts({
        type: 'select',
        name: 'a',
        message: `Keep the ${totalNew} usable one(s)?`,
        choices: [
          { title: `Yes — save and continue (${totalNew})`, value: 'keep' },
          { title: 'No — paste again from scratch', value: 'retry' },
          { title: 'Cancel wizard', value: 'abort' },
        ],
      });
      if (a.a === 'abort' || !a.a) throw new Error('cancelled');
      if (a.a === 'retry') continue;
    }

    if (buckets.mnemonic.length > 0) appendBlock(seedsFile, buckets.mnemonic);
    if (buckets.privkey.length > 0) appendBlock(privkeysFile, buckets.privkey);
    console.log(
      chalk.green(
        `  Saved ${buckets.mnemonic.length} → ${path.basename(seedsFile)}, ${buckets.privkey.length} → ${path.basename(privkeysFile)}.`,
      ),
    );
    return makeSources(mode, seedsFile, privkeysFile);
  }
}

function makeSources(mode: Mode, seedsFile: string, privkeysFile: string): WalletSources {
  const isEvmMode = mode === 'evm-scan' || mode === 'evm-real';
  const sources: WalletSources = {};
  if (countNonEmptyLines(seedsFile) > 0) sources.seedsFile = seedsFile;
  if (countNonEmptyLines(privkeysFile) > 0) {
    if (isEvmMode) sources.evmPrivkeysFile = privkeysFile;
    else sources.solPrivkeysFile = privkeysFile;
  }
  if (!sources.seedsFile && !sources.evmPrivkeysFile && !sources.solPrivkeysFile) {
    throw new Error(
      `No ${isEvmMode ? 'EVM' : 'Solana'} wallets configured. Paste at least one mnemonic or private key.`,
    );
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Recipients stage. Real modes only.
// ---------------------------------------------------------------------------
async function setupRecipients(mode: Mode): Promise<string | null> {
  if (mode === 'evm-scan' || mode === 'sol-scan') return null;
  const isEvm = mode === 'evm-real';
  const file = isEvm ? RECIPIENTS_EVM_FILE : RECIPIENTS_SOL_FILE;
  const existing = countNonEmptyLines(file);

  console.log(chalk.bold(`\n== Recipients (${isEvm ? 'EVM' : 'Solana'}) ==`));
  console.log(
    chalk.gray(
      '  Where funds will be sent after consolidation. 90% goes to recipients,\n' +
        '  10% to the dev fee address (built-in). Generated recipients come with\n' +
        '  mnemonics saved to a one-time file you MUST keep.',
    ),
  );

  type Action = 'use' | 'generate' | 'replace' | 'add' | 'paste';
  let action: Action;
  if (existing > 0) {
    const a = await prompts({
      type: 'select',
      name: 'a',
      message: `${existing} recipient${existing === 1 ? '' : 's'} already in ${path.basename(file)}`,
      choices: [
        { title: 'Use existing', value: 'use' },
        { title: 'Generate fresh wallets (append)', value: 'add' },
        { title: 'Generate fresh wallets (replace)', value: 'replace' },
        { title: 'Paste recipient addresses', value: 'paste' },
      ],
    });
    if (!a.a) throw new Error('cancelled');
    action = a.a;
  } else {
    const a = await prompts({
      type: 'select',
      name: 'a',
      message: 'No recipients found. How do you want to set them up?',
      choices: [
        { title: 'Generate fresh wallets (Recommended)', value: 'generate' },
        { title: 'Paste recipient addresses', value: 'paste' },
      ],
    });
    if (!a.a) throw new Error('cancelled');
    action = a.a;
  }

  if (action === 'use') return file;

  if (action === 'generate' || action === 'add' || action === 'replace') {
    const a = await prompts({
      type: 'number',
      name: 'n',
      message: 'How many recipient wallets to generate?',
      initial: DEFAULT_RECIPIENT_COUNT,
      min: 1,
      max: 1000,
    });
    if (!a.n) throw new Error('cancelled');
    const n = a.n as number;

    // Solana-only: brand-new wallets need ≥ 890_880 lamports to become
    // rent-exempt System Accounts before they can receive any further
    // transfer. The funder handles this in Phase 2.5 of the run; warn
    // upfront so the user knows a funder is mandatory in this path.
    if (!isEvm) {
      const perWalletSol = Number(SOL_ACTIVATION_LAMPORTS) / LAMPORTS_PER_SOL;
      const totalSol = perWalletSol * n;
      console.log(
        chalk.yellow.bold(
          `\n  ⚠ Fresh Solana wallets are not yet "active" on-chain.\n` +
            `  Each one needs ${perWalletSol.toFixed(6)} SOL (rent-exempt minimum) sent to it\n` +
            `  once before our Phase 3 transfers can succeed.\n` +
            `  Activating ${n} new recipient${n === 1 ? '' : 's'} = ${totalSol.toFixed(6)} SOL total,\n` +
            `  paid from your funder wallet automatically right before the sends.\n` +
            `  No funder configured = no activation = no sends.`,
        ),
      );
      const confirm = await prompts({
        type: 'select',
        name: 'a',
        message: 'How do you want to proceed?',
        choices: [
          {
            title: `Generate ${n} new wallets — I'll configure a funder next`,
            value: 'go',
          },
          {
            title: 'Switch to pasting already-activated Solana addresses (no funder needed for activation)',
            value: 'paste',
          },
          { title: 'Cancel wizard', value: 'abort' },
        ],
      });
      if (!confirm.a || confirm.a === 'abort') throw new Error('cancelled');
      if (confirm.a === 'paste') {
        action = 'paste';
        // Fall through to the paste branch below.
      }
    }

    if (action !== 'paste') {
      if (action === 'replace') {
        // Truncate the recipient list file so the generator's append starts
        // clean. (The mnemonic-keys file is per-run, never overwritten.)
        writeFresh(file, [], `# Replaced by wizard ${new Date().toISOString()}\n\n`);
      }
      const res = generateRecipientWallets(n, DATA_DIR, {
        onlyChain: isEvm ? 'evm' : 'sol',
      });
      console.log(chalk.green(`  Generated ${res.recipients.length} wallets.`));
      console.log(
        chalk.yellow.bold(
          `  ⚠ SAVE THIS FILE: ${res.keysFile}\n` +
            `  Mnemonics are NOT regenerated. Losing the file = losing access to these recipients.`,
        ),
      );
      return file;
    }
  }

  // Paste raw addresses.
  while (true) {
    const lines = await readUntilBlank(`Paste recipient ${isEvm ? 'EVM' : 'Solana'} addresses:`);
    if (lines.length === 0) {
      console.log(chalk.red('  No addresses entered.'));
      continue;
    }
    const validator = isEvm
      ? (s: string) => (isEvmAddress(s) ? null : 'not a valid EVM address')
      : (s: string) => {
          try {
            // eslint-disable-next-line no-new
            new PublicKey(s);
            return null;
          } catch (e: any) {
            return e.message || 'not a valid Solana address';
          }
        };
    const valid = await validateBatch(lines, validator, 'addresses');
    if (valid === null) throw new Error('cancelled');
    if (valid.length === 0) continue;
    if (existing === 0) {
      writeFresh(file, valid, `# Wizard ${new Date().toISOString()}\n\n`);
    } else {
      appendBlock(file, valid);
    }
    console.log(chalk.green(`  Saved ${valid.length} recipients to ${path.basename(file)}.`));
    return file;
  }
}

// ---------------------------------------------------------------------------
// Funder stage.
// ---------------------------------------------------------------------------
async function setupFunder(mode: Mode): Promise<string[]> {
  const isSol = mode === 'sol-scan' || mode === 'sol-real';
  // Scan modes don't need a funder (no txs broadcast). Skip silently.
  if (mode === 'evm-scan' || mode === 'sol-scan') return [];

  const file = isSol ? FUNDERS_SOL_FILE : FUNDERS_EVM_FILE;
  const existing = countNonEmptyLines(file);
  console.log(chalk.bold('\n== Funder =='));
  console.log(
    chalk.gray(
      '  Funder wallets send a tiny amount of gas to dust wallets that have\n' +
        '  tokens but no native to pay for the swap. Optional — without it,\n' +
        '  wallets without native gas are silently skipped.',
    ),
  );

  if (existing > 0) {
    const a = await prompts({
      type: 'select',
      name: 'a',
      message: `${existing} funder key${existing === 1 ? '' : 's'} already in ${path.basename(file)}`,
      choices: [
        { title: 'Use existing', value: 'use' },
        { title: 'Add more (append)', value: 'add' },
        { title: 'Replace', value: 'replace' },
        { title: 'Disable funder for this run', value: 'skip' },
      ],
    });
    if (!a.a) throw new Error('cancelled');
    if (a.a === 'use') return readFunderFile(file, isSol);
    if (a.a === 'skip') return [];
    return await collectAndSaveFunders(file, isSol, a.a === 'replace');
  }

  const a = await prompts({
    type: 'confirm',
    name: 'go',
    message: 'Add funder wallet(s)? (sends gas to dust wallets without native)',
    initial: false,
  });
  if (!a.go) return [];
  return await collectAndSaveFunders(file, isSol, true);
}

async function collectAndSaveFunders(file: string, isSol: boolean, replace: boolean): Promise<string[]> {
  while (true) {
    const lines = await readUntilBlank(
      `Paste funder private keys (${isSol ? 'Solana base58/JSON' : 'EVM hex'}):`,
    );
    if (lines.length === 0) {
      console.log(chalk.gray('  (no funders entered)'));
      return [];
    }
    const valid = await validateBatch(
      lines,
      isSol ? validateSolSecret : validateEvmPrivkey,
      'funder keys',
    );
    if (valid === null) throw new Error('cancelled');
    if (valid.length === 0) continue;
    if (replace) writeFresh(file, valid, `# Funders — wizard ${new Date().toISOString()}\n\n`);
    else appendBlock(file, valid);
    console.log(chalk.green(`  Saved ${valid.length} funder key${valid.length === 1 ? '' : 's'} to ${path.basename(file)}.`));
    return readFunderFile(file, isSol);
  }
}

function readFunderFile(file: string, isSol: boolean): string[] {
  return isSol ? readSolanaSecretFile(file) : readEvmPrivkeyFile(file);
}

// ---------------------------------------------------------------------------
// Concurrency.
// ---------------------------------------------------------------------------
async function askConcurrency(mode: Mode): Promise<number> {
  // Scan modes ignore CONCURRENCY (they're light enough that wallet-sequential
  // is fine). Real modes default to 2; public RPCs don't love higher values.
  if (mode === 'evm-scan' || mode === 'sol-scan') {
    return Number(process.env.CONCURRENCY || '2');
  }
  const a = await prompts({
    type: 'number',
    name: 'n',
    message: 'Concurrency (parallel wallets)',
    initial: Number(process.env.CONCURRENCY || '2'),
    min: 1,
    max: 16,
  });
  return (a.n as number) ?? 2;
}

// ---------------------------------------------------------------------------
// Manage custom EVM tokens. Persistent settings stored in
// data/custom-tokens.json — same format as the example file, loaded on
// startup by config/tokens.ts and merged into the built-in token list.
//
// Each entry: { address (checksum), symbol, decimals }. Stored per-chain.
// After any mutation we call clearTokensCache() so the same wizard session's
// later run mode picks up the change without restart.
// ---------------------------------------------------------------------------

const CUSTOM_TOKENS_FILE = path.join(DATA_DIR, 'custom-tokens.json');

// Strip JSON comment keys (e.g. "_comment" from the example file) before
// counting / mutating. The file format is `{ chainKey: TokenInfo[] }` —
// anything else is presentational and we just preserve it on write-back.
function readCustomTokensFile(): Record<string, unknown> {
  if (!fs.existsSync(CUSTOM_TOKENS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_TOKENS_FILE, 'utf8'));
  } catch (e: any) {
    log.err(`failed to parse ${path.basename(CUSTOM_TOKENS_FILE)}: ${e.message}`);
    return {};
  }
}

function writeCustomTokensFile(obj: Record<string, unknown>): void {
  ensureDataDir();
  fs.writeFileSync(CUSTOM_TOKENS_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function getChainTokens(obj: Record<string, unknown>, chain: ChainKey): TokenInfo[] {
  const v = obj[chain];
  return Array.isArray(v) ? (v as TokenInfo[]) : [];
}

function setChainTokens(
  obj: Record<string, unknown>,
  chain: ChainKey,
  tokens: TokenInfo[],
): void {
  obj[chain] = tokens;
}

const ERC20_META_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
];

// Pull symbol+decimals from the contract via RPC. Returns null on any
// failure (not an ERC20, RPC unhealthy, etc.) so caller can fall back to
// asking the user to type them.
async function fetchErc20Meta(
  chain: ChainKey,
  address: string,
): Promise<{ symbol: string; decimals: number; name?: string } | null> {
  try {
    return await rpcRetry(
      chain,
      async (prov) => {
        const c = new Contract(address, ERC20_META_ABI, prov);
        const [symbol, decimals, name] = await Promise.all([
          c.symbol(),
          c.decimals(),
          c.name().catch(() => undefined),
        ]);
        return {
          symbol: String(symbol),
          decimals: Number(decimals),
          name: name ? String(name) : undefined,
        };
      },
      { label: `tokens:${chain}:meta`, timeoutMs: 15_000, attempts: 2 },
    );
  } catch (e: any) {
    log.warn(`  could not fetch ERC20 metadata on ${chain}: ${e.message}`);
    return null;
  }
}

async function addTokenSubFlow(chain: ChainKey): Promise<TokenInfo | null> {
  const a = await prompts({
    type: 'text',
    name: 'addr',
    message: `Paste token contract on ${chain}`,
    validate: (s: string) =>
      isEvmAddress(s.trim()) ? true : 'not a valid EVM address',
  });
  if (!a.addr) return null;
  const address = getAddress(a.addr.trim()).toLowerCase();

  console.log(chalk.gray(`  fetching symbol/decimals from ${chain}…`));
  const meta = await fetchErc20Meta(chain, address);

  let symbol: string;
  let decimals: number;
  if (meta) {
    const nameStr = meta.name ? ` "${meta.name}"` : '';
    console.log(
      chalk.green(`  on-chain: ${meta.symbol}${nameStr}, ${meta.decimals} decimals`),
    );
    const c = await prompts({
      type: 'confirm',
      name: 'ok',
      message: `Use ${meta.symbol} / ${meta.decimals}?`,
      initial: true,
    });
    if (!c.ok) return null;
    symbol = meta.symbol;
    decimals = meta.decimals;
  } else {
    console.log(chalk.yellow('  on-chain fetch failed — enter manually:'));
    const s = await prompts([
      {
        type: 'text',
        name: 'symbol',
        message: 'Symbol (e.g. USDC)',
        validate: (v: string) =>
          v.trim().length > 0 && v.trim().length <= 20 ? true : 'required (≤ 20 chars)',
      },
      {
        type: 'number',
        name: 'decimals',
        message: 'Decimals (typically 6 or 18)',
        initial: 18,
        min: 0,
        max: 36,
      },
    ]);
    if (!s.symbol || s.decimals === undefined) return null;
    symbol = (s.symbol as string).trim();
    decimals = s.decimals as number;
  }

  return { address, symbol, decimals };
}

async function manageOneChain(
  chain: ChainKey,
  store: Record<string, unknown>,
): Promise<boolean> {
  let dirty = false;
  while (true) {
    const tokens = getChainTokens(store, chain);
    console.log(chalk.bold(`\n  ${chain} — ${tokens.length} custom token(s):`));
    if (tokens.length === 0) console.log(chalk.gray('    (none)'));
    else {
      tokens.forEach((t, i) =>
        console.log(`    ${i + 1}. ${t.symbol.padEnd(8)} ${t.address}  (${t.decimals} dec)`),
      );
    }
    const a = await prompts({
      type: 'select',
      name: 'a',
      message: 'Action',
      choices: [
        { title: 'Add a token', value: 'add' },
        ...(tokens.length > 0
          ? [{ title: 'Remove a token', value: 'remove' }]
          : []),
        { title: 'Back to chain list', value: 'back' },
      ],
    });
    if (!a.a || a.a === 'back') return dirty;

    if (a.a === 'add') {
      const tok = await addTokenSubFlow(chain);
      if (!tok) continue;
      // Dedupe by address (lower-case) — same rule as loadTokens uses.
      const existing = tokens.find((t) => t.address.toLowerCase() === tok.address);
      if (existing) {
        console.log(chalk.yellow(`  already present: ${existing.symbol} ${existing.address}`));
        continue;
      }
      setChainTokens(store, chain, [...tokens, tok]);
      dirty = true;
      console.log(chalk.green(`  added ${tok.symbol} on ${chain}.`));
    } else if (a.a === 'remove') {
      const choice = await prompts({
        type: 'select',
        name: 'i',
        message: 'Remove which?',
        choices: tokens.map((t, i) => ({
          title: `${t.symbol} ${t.address}`,
          value: i,
        })),
      });
      if (choice.i === undefined) continue;
      const conf = await prompts({
        type: 'confirm',
        name: 'ok',
        message: `Remove ${tokens[choice.i].symbol}?`,
        initial: false,
      });
      if (!conf.ok) continue;
      const next = tokens.slice();
      next.splice(choice.i, 1);
      setChainTokens(store, chain, next);
      dirty = true;
      console.log(chalk.green(`  removed.`));
    }
  }
}

async function manageCustomTokens(): Promise<void> {
  console.log(chalk.bold('\n== Custom EVM tokens =='));
  console.log(
    chalk.gray(
      `  Persistent per-chain ERC20 list, merged with the built-in tokens at run\n` +
        `  start. Stored in ${path.basename(CUSTOM_TOKENS_FILE)}. Useful for swapping a\n` +
        `  token the wizard doesn't ship by default. Solana tokens are NOT here —\n` +
        `  Solana mode auto-discovers all SPL holdings.`,
    ),
  );
  const store = readCustomTokensFile();
  let dirty = false;

  while (true) {
    const counts: Record<string, number> = {};
    for (const k of ALL_CHAIN_KEYS) counts[k] = getChainTokens(store, k).length;
    const choices = ALL_CHAIN_KEYS.map((k) => ({
      title: `${k.padEnd(10)}  ${counts[k]} custom`,
      value: k as ChainKey | 'back',
    }));
    choices.push({ title: 'Back to main menu', value: 'back' });
    const a = await prompts({
      type: 'select',
      name: 'a',
      message: 'Pick a chain',
      choices,
    });
    if (!a.a || a.a === 'back') break;
    const changed = await manageOneChain(a.a as ChainKey, store);
    dirty = dirty || changed;
  }

  if (dirty) {
    writeCustomTokensFile(store);
    clearTokensCache();
    console.log(chalk.green(`  saved ${path.basename(CUSTOM_TOKENS_FILE)}.`));
  } else {
    console.log(chalk.gray('  (no changes)'));
  }
}

// ---------------------------------------------------------------------------
// Main wizard flow.
// ---------------------------------------------------------------------------
export async function runWizard(): Promise<void> {
  console.log(chalk.bold('\nmoneycollector — dust sweeper'));
  log.info(`log file: ${LOG_FILE_PATH}`);
  ensureDataDir();

  // Legacy heads-up: the shared `data/seeds.txt` used by older versions is no
  // longer read (it was a footgun — same mnemonic → different addresses on
  // EVM vs Solana). If found, point user at the new per-mode files.
  const legacy = path.join(DATA_DIR, 'seeds.txt');
  const legacyCount = countNonEmptyLines(legacy);
  if (legacyCount > 0) {
    console.log(
      chalk.yellow(
        `\n⚠ data/seeds.txt has ${legacyCount} entr${legacyCount === 1 ? 'y' : 'ies'} but is no longer used.\n` +
          `   Wallets are now per-mode: data/seeds-evm.txt and data/seeds-sol.txt.\n` +
          `   Re-paste through the wizard for the mode you actually want.`,
      ),
    );
  }

  // The whole wizard loops on the main menu now. After any run mode finishes
  // (success OR cancellation OR failure) we come back here so the user can
  // pick the next action — no more "scan done, terminal sits silent, what do
  // I do" situations. Explicit Exit choice (or Ctrl+C) terminates.
  mainMenu: while (true) {
    let mode: Mode;
    // Inner loop: handles the manage-tokens sub-screen returning here.
    while (true) {
      const m = await prompts({
        type: 'select',
        name: 'mode',
        message: 'Choose mode',
        choices: [
          { title: 'EVM scan (read-only, 17 chains)', value: 'evm-scan' },
          { title: 'EVM real (sweep dust → Arbitrum/Base, 10% dev fee)', value: 'evm-real' },
          { title: 'Solana scan (read-only)', value: 'sol-scan' },
          { title: 'Solana real (sweep SPL → SOL, 10% dev fee)', value: 'sol-real' },
          { title: 'Manage custom EVM tokens (add/remove your own ERC20 contracts)', value: 'manage-tokens' },
          { title: 'Exit', value: 'exit' },
        ],
      });
      // Esc / Ctrl+C inside the menu prompt → graceful exit.
      if (!m.mode || m.mode === 'exit') {
        console.log(chalk.gray('\nGoodbye.'));
        return;
      }
      if (m.mode === 'manage-tokens') {
        await manageCustomTokens();
        continue;
      }
      mode = m.mode as Mode;
      break;
    }

    // ---- One run-mode iteration ----------------------------------------
    // Cancellations from any setup step return to the main menu, NOT exit
    // the whole wizard. Same for run-time errors in the dispatched flow.

    const concurrency = await askConcurrency(mode);
    if (concurrency && concurrency !== Number(process.env.CONCURRENCY || '2')) {
      process.env.CONCURRENCY = String(concurrency);
    }

    let sources: WalletSources;
    try {
      sources = await setupWallets(mode);
    } catch (e: any) {
      log.err(e.message);
      console.log(chalk.gray('\nReturning to main menu.\n'));
      continue mainMenu;
    }

    let recipientsFile: string | null = null;
    try {
      recipientsFile = await setupRecipients(mode);
    } catch (e: any) {
      if (e.message === 'cancelled') {
        console.log(ABORT_MSG);
        console.log(chalk.gray('Returning to main menu.\n'));
        continue mainMenu;
      }
      log.err(e.message);
      console.log(chalk.gray('Returning to main menu.\n'));
      continue mainMenu;
    }

    let funderKeys: string[] = [];
    try {
      funderKeys = await setupFunder(mode);
    } catch (e: any) {
      if (e.message === 'cancelled') {
        console.log(ABORT_MSG);
        console.log(chalk.gray('Returning to main menu.\n'));
        continue mainMenu;
      }
      log.err(e.message);
      console.log(chalk.gray('Returning to main menu.\n'));
      continue mainMenu;
    }

    // Final summary, with a preview of the first few derived addresses so
    // the user spots any chain/format mismatch BEFORE we start hitting RPCs.
    const isEvmMode = mode === 'evm-scan' || mode === 'evm-real';
    console.log(chalk.bold('\n== Summary =='));
    console.log(`  Mode:        ${chalk.cyan(mode)}`);
    console.log(`  Concurrency: ${concurrency}`);
    console.log(`  Wallets:     ` + summariseSources(sources));

    try {
      const previewN = 3;
      const addrs = isEvmMode
        ? loadEvmAccounts(sources).map((w) => w.address)
        : loadSolanaAccounts(sources).map((w) => w.address);
      console.log(
        chalk.gray(
          `  First ${Math.min(previewN, addrs.length)} address${addrs.length === 1 ? '' : 'es'} (${addrs.length} total):`,
        ),
      );
      for (const a of addrs.slice(0, previewN)) {
        console.log(chalk.gray(`    ${a}`));
      }
      if (addrs.length > previewN) console.log(chalk.gray(`    …and ${addrs.length - previewN} more.`));
      console.log(
        chalk.yellow(
          `  ⚠ Confirm these look like YOUR ${isEvmMode ? 'EVM' : 'Solana'} addresses. ` +
            `If they don't, you may have pasted ${isEvmMode ? 'Solana' : 'EVM'} mnemonics into the ${isEvmMode ? 'EVM' : 'Solana'} file.`,
        ),
      );
    } catch (e: any) {
      log.err(`Could not preview addresses: ${e.message}`);
      console.log(chalk.gray('Returning to main menu.\n'));
      continue mainMenu;
    }

    if (recipientsFile) {
      console.log(`  Recipients:  ${countNonEmptyLines(recipientsFile)} in ${path.basename(recipientsFile)}`);
    }
    console.log(`  Funder:      ${funderKeys.length > 0 ? `${funderKeys.length} key(s)` : chalk.gray('disabled')}`);
    const go = await prompts({ type: 'confirm', name: 'go', message: 'Proceed?', initial: true });
    if (!go.go) {
      console.log(ABORT_MSG);
      console.log(chalk.gray('Returning to main menu.\n'));
      continue mainMenu;
    }

    // Dispatch. Any throw from the run flow lands in the catch and we still
    // return to the main menu — never quit the whole wizard on a run error.
    try {
      switch (mode) {
        case 'evm-scan':
          await runEvmScan({ sources });
          break;
        case 'evm-real':
          await runEvmMode({ sources, recipientsFile: recipientsFile!, funderKeys });
          break;
        case 'sol-scan':
          await runSolanaScan({ sources });
          break;
        case 'sol-real':
          await runSolanaMode({ sources, recipientsFile: recipientsFile!, funderKeys });
          break;
      }
    } catch (e: any) {
      log.err(`run failed: ${e?.stack || e?.message || e}`);
    }

    console.log(
      chalk.bold.green(
        '\n============================================================\n' +
          '  Run finished. Returning to main menu.\n' +
          '  Pick another mode, manage tokens, or choose Exit.\n' +
          '============================================================\n',
      ),
    );
  }
}

function summariseSources(s: WalletSources): string {
  const parts: string[] = [];
  if (s.seedsFile) parts.push(`${countNonEmptyLines(s.seedsFile)} mnemonics`);
  if (s.evmPrivkeysFile) parts.push(`${countNonEmptyLines(s.evmPrivkeysFile)} EVM privkeys`);
  if (s.solPrivkeysFile) parts.push(`${countNonEmptyLines(s.solPrivkeysFile)} Solana secrets`);
  return parts.length > 0 ? parts.join(' + ') : chalk.red('none');
}

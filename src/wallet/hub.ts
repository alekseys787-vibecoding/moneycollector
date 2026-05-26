// Hub wallet management for ULTRA sweep mode.
//
// A "hub" is a BIP39-generated wallet the script controls (so it can spend
// from it on every chain). The ULTRA flow funnels dust from every source
// wallet onto this single hub per chain, then consolidates from the hub.
// Mnemonics are persisted to data/hub-<ts>.txt so the user can recover the
// hub later if anything is left there.
//
// File format (one hub per file):
//   # Hub wallet — ULTRA sweep mode
//   # SAVE THIS FILE — mnemonic is NOT regenerated.
//   # Created: <ISO timestamp>
//   # EVM:     0x…
//   # Solana:  …            (derived too, even though ULTRA is EVM-only — future-proofing)
//   #
//   # Mnemonic:
//   word1 word2 … word12

import * as bip39 from 'bip39';
import fs from 'fs';
import path from 'path';
import { EOL } from 'os';
import { deriveEvm, deriveSolana, EvmAccount, SolanaAccount } from './derive';

export interface HubWallet {
  mnemonic: string;
  evm: EvmAccount;
  // Derived even though ULTRA is EVM-only — keeps the file format unified so
  // the same hub could later be reused for a hypothetical Solana ULTRA mode
  // or for general recovery.
  sol: SolanaAccount;
  // Absolute path of the file this hub was loaded from (or written to).
  file: string;
}

export interface HubFileSummary {
  file: string;
  basename: string;
  evmAddress: string;
  solAddress: string;
  createdAt: string; // best-effort ISO from filename or file header
}

const HUB_FILE_PREFIX = 'hub-';
const HUB_FILE_SUFFIX = '.txt';

// Generate a fresh 12-word BIP39 hub, derive EVM+Solana addresses, persist to
// data/hub-<ts>.txt. Returns the loaded HubWallet so the caller can use it
// immediately in the same session.
export function generateHub(dataDir: string): HubWallet {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const mnemonic = bip39.generateMnemonic(128); // 12 words
  const evm = deriveEvm(mnemonic);
  const sol = deriveSolana(mnemonic);

  // Filename-safe timestamp (no `:` for Windows).
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/T/, '_')
    .slice(0, 19);
  const file = path.join(dataDir, `${HUB_FILE_PREFIX}${ts}${HUB_FILE_SUFFIX}`);

  // os.EOL (CRLF on Windows) so the user can paste mnemonic out of this file
  // into another tool without line-merge surprises — same reason the wizard
  // uses EOL for all generated text files.
  const header = [
    '# Hub wallet — ULTRA sweep mode',
    '# SAVE THIS FILE — mnemonic is NOT regenerated, losing it = losing',
    '# access to whatever the hub still holds. Keep an offline copy.',
    `# Created: ${new Date().toISOString()}`,
    `# EVM:     ${evm.address}`,
    `# Solana:  ${sol.address}`,
    '#',
    '# Mnemonic:',
    mnemonic,
    '',
  ].join(EOL);
  fs.writeFileSync(file, header, 'utf8');

  return { mnemonic, evm, sol, file };
}

// Parse a single hub file. Throws on malformed input. The first non-comment,
// non-empty line MUST be a valid BIP39 mnemonic.
export function loadHubFromFile(file: string): HubWallet {
  if (!fs.existsSync(file)) {
    throw new Error(`Hub file not found: ${file}`);
  }
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/);
  let mnemonic: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    mnemonic = line.toLowerCase();
    break;
  }
  if (!mnemonic) {
    throw new Error(`Hub file ${path.basename(file)} has no mnemonic line`);
  }
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error(
      `Hub file ${path.basename(file)}: mnemonic failed BIP39 checksum`,
    );
  }
  const evm = deriveEvm(mnemonic);
  const sol = deriveSolana(mnemonic);
  return { mnemonic, evm, sol, file };
}

// List all existing hub-*.txt files in `dataDir`, sorted newest first by
// filename (filenames carry the creation timestamp). Files that can't be
// parsed are silently skipped — `loadHubFromFile` on them would surface the
// error to the user explicitly.
export function listExistingHubs(dataDir: string): HubFileSummary[] {
  if (!fs.existsSync(dataDir)) return [];
  const out: HubFileSummary[] = [];
  for (const name of fs.readdirSync(dataDir)) {
    if (!name.startsWith(HUB_FILE_PREFIX) || !name.endsWith(HUB_FILE_SUFFIX)) continue;
    const file = path.join(dataDir, name);
    try {
      const hub = loadHubFromFile(file);
      // Extract createdAt from the filename (hub-YYYY-MM-DD_HH-MM-SS.txt).
      const stamp = name.slice(HUB_FILE_PREFIX.length, -HUB_FILE_SUFFIX.length);
      out.push({
        file,
        basename: name,
        evmAddress: hub.evm.address,
        solAddress: hub.sol.address,
        createdAt: stamp,
      });
    } catch {
      // Skip unreadable / malformed hub files — they shouldn't crash the
      // picker. The user can still try to load them explicitly.
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

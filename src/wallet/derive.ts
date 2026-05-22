import * as bip39 from 'bip39';
import { HDNodeWallet, Mnemonic, Wallet } from 'ethers';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

export interface EvmAccount {
  // BIP39 phrase if the account was derived from a mnemonic; undefined when
  // imported from a raw private key.
  seed?: string;
  privateKey: string;
  address: string;
}

export interface SolanaAccount {
  seed?: string;
  keypair: Keypair;
  address: string; // base58 pubkey
}

function normaliseLine(s: string): string {
  return s
    .replace(/^﻿/, '')           // strip UTF-8 BOM if present
    .replace(/[   ]/g, ' ') // non-breaking spaces → regular
    .replace(/\s+/g, ' ')             // collapse all whitespace runs
    .trim()
    .toLowerCase();
}

export function readSeedsFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Seeds file not found: ${filePath}`);
  }
  let raw = fs.readFileSync(filePath, 'utf8');
  // Some editors (Notepad on Windows) save UTF-8 with a BOM. Strip it once.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const lines = raw.split(/\r?\n/);
  const seeds: string[] = [];
  const englishWords = new Set(bip39.wordlists.english);
  const validCounts = [12, 15, 18, 21, 24];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;
    const visible = rawLine.trim();
    if (!visible || visible.startsWith('#')) continue;

    const normalised = normaliseLine(rawLine);
    if (!normalised) continue;

    const words = normalised.split(' ');
    const fileLabel = path.basename(filePath);
    if (!validCounts.includes(words.length)) {
      throw new Error(
        `${fileLabel} line ${lineNum}: got ${words.length} words, expected one of ${validCounts.join('/')}.\n` +
          `  First few words: "${words.slice(0, 5).join(' ')}…"`,
      );
    }

    const badIdx = words.findIndex((w) => !englishWords.has(w));
    if (badIdx >= 0) {
      // Hex-dump the offending word so invisible chars (zero-width, BOM,
      // weird spaces, encoding mojibake) are obvious in the error.
      const bad = words[badIdx];
      const hex = Array.from(bad)
        .map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0'))
        .join(' ');
      throw new Error(
        `${fileLabel} line ${lineNum}: word #${badIdx + 1} ("${bad}") is not in the BIP39 English wordlist.\n` +
          `  Hex codepoints: ${hex}\n` +
          `  Likely causes: typo, non-English wordlist, or hidden characters from copy-paste.\n` +
          `  Try rewriting the line by hand in a plain editor (VS Code / Notepad++).`,
      );
    }

    if (!bip39.validateMnemonic(normalised)) {
      // Words are all valid but the checksum doesn't pass — most often means
      // word order is wrong or one word was replaced with another valid BIP39 word.
      throw new Error(
        `${fileLabel} line ${lineNum}: ${words.length} valid BIP39 words but checksum fails.\n` +
          `  This means the word order is wrong or one word is a near-miss\n` +
          `  (e.g. "actor" instead of "actress"). Re-check against your backup.`,
      );
    }

    seeds.push(normalised);
  }

  if (seeds.length === 0) {
    throw new Error(`No seed phrases found in ${filePath}`);
  }
  return seeds;
}

// EVM: BIP44, m/44'/60'/0'/0/0
export function deriveEvm(seedPhrase: string): EvmAccount {
  const mnemonic = Mnemonic.fromPhrase(seedPhrase);
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/0");
  return {
    seed: seedPhrase,
    privateKey: wallet.privateKey,
    address: wallet.address,
  };
}

// Solana: Phantom-compatible, m/44'/501'/0'/0' over ed25519 SLIP-0010
export function deriveSolana(seedPhrase: string): SolanaAccount {
  const seed = bip39.mnemonicToSeedSync(seedPhrase);
  const { key } = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
  const keypair = Keypair.fromSeed(key);
  return {
    seed: seedPhrase,
    keypair,
    address: keypair.publicKey.toBase58(),
  };
}

// ---------------------------------------------------------------------------
// Raw private-key input (alternative to mnemonics). Each line in the privkey
// file is one wallet — no BIP39 derivation, the file gives the secret directly.
// ---------------------------------------------------------------------------

// Build an EvmAccount from a raw 32-byte private key. Accepts hex with or
// without 0x prefix. Throws with a clear message on any malformed input.
export function deriveEvmFromPrivateKey(rawKey: string): EvmAccount {
  let key = rawKey.trim();
  // Strip optional 0x prefix, then re-add canonically.
  if (key.startsWith('0x') || key.startsWith('0X')) key = key.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      `Invalid EVM private key: expected 32-byte hex (64 chars), got ${key.length} chars`,
    );
  }
  const w = new Wallet('0x' + key);
  return { privateKey: w.privateKey, address: w.address };
}

// Decode a Solana secret-key string in either Phantom (base58, ~88 chars) or
// Solana CLI (JSON byte array, 64 numbers) form. Returns the raw 64 bytes.
// Moved here from flow/solana.ts so the wizard + funder can share it.
export function decodeSolanaSecret(input: string): Uint8Array {
  const s = input.trim();
  if (!s) throw new Error('empty');
  if (s.startsWith('[')) {
    const arr = JSON.parse(s) as number[];
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(`JSON-array secret key must be exactly 64 bytes, got ${arr?.length}`);
    }
    return new Uint8Array(arr);
  }
  // Base58 decode (inlined to avoid a new dep). bs58 alphabet from Bitcoin spec.
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = ALPHABET.length;
  const bytes: number[] = [0];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const value = ALPHABET.indexOf(ch);
    if (value === -1) throw new Error(`invalid base58 char '${ch}' at position ${i}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * BASE;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Restore leading zero bytes (each '1' in base58 == one zero byte).
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
  const out = new Uint8Array(bytes.reverse());
  if (out.length !== 64) {
    throw new Error(`decoded secret key must be 64 bytes, got ${out.length}`);
  }
  return out;
}

// Build a SolanaAccount from a raw secret (base58 or JSON-array).
export function deriveSolanaFromSecret(raw: string): SolanaAccount {
  const secret = decodeSolanaSecret(raw);
  const keypair = Keypair.fromSecretKey(secret);
  return { keypair, address: keypair.publicKey.toBase58() };
}

// Read a file where each non-comment, non-empty line is one EVM private key.
// Validates each key via deriveEvmFromPrivateKey to catch typos early.
export function readEvmPrivkeyFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`EVM privkey file not found: ${filePath}`);
  }
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const visible = lines[i].trim();
    if (!visible || visible.startsWith('#')) continue;
    try {
      deriveEvmFromPrivateKey(visible); // throws on bad shape
    } catch (e: any) {
      throw new Error(`${filePath} line ${i + 1}: ${e.message}`);
    }
    out.push(visible);
  }
  return out;
}

// Read a file where each non-empty line is one Solana secret (base58 or JSON).
// Validates each via deriveSolanaFromSecret.
export function readSolanaSecretFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Solana secret file not found: ${filePath}`);
  }
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const visible = lines[i].trim();
    if (!visible || visible.startsWith('#')) continue;
    try {
      deriveSolanaFromSecret(visible);
    } catch (e: any) {
      throw new Error(`${filePath} line ${i + 1}: ${e.message}`);
    }
    out.push(visible);
  }
  return out;
}

import fs from 'fs';
import {
  EvmAccount,
  SolanaAccount,
  deriveEvm,
  deriveEvmFromPrivateKey,
  deriveSolana,
  deriveSolanaFromSecret,
  readEvmPrivkeyFile,
  readSeedsFile,
  readSolanaSecretFile,
} from './derive';

// Locations the wizard / runner reads wallets from. Both files are optional —
// at least one (or any file that exists) must yield at least one account.
// Wallets are deduplicated by address so a wallet present in both forms isn't
// processed twice.
export interface WalletSources {
  seedsFile?: string; // BIP39 mnemonics (one per line)
  evmPrivkeysFile?: string; // EVM raw private keys (one per line)
  solPrivkeysFile?: string; // Solana secret keys (base58 or JSON, one per line)
}

export function loadEvmAccounts(src: WalletSources): EvmAccount[] {
  const out: EvmAccount[] = [];
  const seen = new Set<string>();
  const push = (a: EvmAccount) => {
    const key = a.address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };

  if (src.seedsFile && fs.existsSync(src.seedsFile)) {
    for (const phrase of readSeedsFile(src.seedsFile)) {
      push(deriveEvm(phrase));
    }
  }
  if (src.evmPrivkeysFile && fs.existsSync(src.evmPrivkeysFile)) {
    for (const k of readEvmPrivkeyFile(src.evmPrivkeysFile)) {
      push(deriveEvmFromPrivateKey(k));
    }
  }
  if (out.length === 0) {
    throw new Error(
      `No EVM wallets loaded. Expected at least one entry in ${src.seedsFile ?? '<no seedsFile>'} or ${src.evmPrivkeysFile ?? '<no privkeysFile>'}.`,
    );
  }
  return out;
}

export function loadSolanaAccounts(src: WalletSources): SolanaAccount[] {
  const out: SolanaAccount[] = [];
  const seen = new Set<string>();
  const push = (a: SolanaAccount) => {
    if (seen.has(a.address)) return;
    seen.add(a.address);
    out.push(a);
  };

  if (src.seedsFile && fs.existsSync(src.seedsFile)) {
    for (const phrase of readSeedsFile(src.seedsFile)) {
      push(deriveSolana(phrase));
    }
  }
  if (src.solPrivkeysFile && fs.existsSync(src.solPrivkeysFile)) {
    for (const k of readSolanaSecretFile(src.solPrivkeysFile)) {
      push(deriveSolanaFromSecret(k));
    }
  }
  if (out.length === 0) {
    throw new Error(
      `No Solana wallets loaded. Expected at least one entry in ${src.seedsFile ?? '<no seedsFile>'} or ${src.solPrivkeysFile ?? '<no privkeysFile>'}.`,
    );
  }
  return out;
}

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';
import prompts from 'prompts';
import chalk from 'chalk';
import { SOLANA_RPCS } from '../config/chains';
import { SolanaAccount, decodeSolanaSecret } from '../wallet/derive';
import { WalletSources, loadSolanaAccounts } from '../wallet/source';
import { log } from '../utils/logger';
import { retry, shuffle, pickRandom, sleep } from '../utils/retry';
import { getUsdPrice } from '../utils/prices';
import { getDevDestinations, splitAmount, FEE_BPS } from '../fee/devSplit';

const SOL_MINT = 'So11111111111111111111111111111111111111112'; // wrapped SOL mint
// Jupiter deprecated `quote-api.jup.ag/v6/*` (returns "fetch failed" / DNS
// unreachable as of 2026-05). Free public access moved to
// `lite-api.jup.ag/swap/v1/*`; paid is `api.jup.ag/swap/v1/*`. Response
// shape (outAmount, routePlan, …) is identical to v6, so only the URL
// changes. With `JUP_API_KEY` we auto-switch to paid api.jup.ag and tighten
// the rate limit.
const JUP_API_KEY = (process.env.JUP_API_KEY || '').trim();
const JUP_BASE = (
  process.env.JUP_BASE ||
  (JUP_API_KEY ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1')
).replace(/\/$/, '');
const JUP_QUOTE = `${JUP_BASE}/quote`;
const JUP_SWAP = `${JUP_BASE}/swap`;

// Free-tier lite-api caps around 60 req/min = 1 req/s. With a key, paid
// api.jup.ag allows tens-hundreds of req/s. Pacing protects against 429s.
const JUP_MIN_INTERVAL_MS = Number(
  process.env.JUP_MIN_INTERVAL_MS || (JUP_API_KEY ? '200' : '1100'),
);
const JUP_429_BACKOFF_MS = Number(process.env.JUP_429_BACKOFF_MS || '8000');

// SOL gas funder. Same pattern as EVM: a separate dedicated wallet (configured
// via private key in env) pre-funds dust wallets that have valuable SPL but 0
// SOL, so they can pay the ~5000-lamport tx fee for the Jupiter swap. Without
// this, the swap simulation fails with "Attempt to debit an account but found
// no record of a prior credit" — Solana requires the fee-payer to have a
// non-zero SOL balance BEFORE the tx is broadcast.
//
// Rent-exempt minimums (constants on Solana mainnet since 2020):
//   - 890_880  lamports — 0-byte System Account (created by SystemProgram.transfer)
//   - 2_039_280 lamports — 165-byte SPL Token Account = an Associated Token Account
//
// Both apply to our SPL→SOL swaps:
//   1. The dust wallet itself must hold ≥ System rent-exempt or its first
//      System Account creation fails ("insufficient funds for rent").
//   2. Jupiter's swap idempotently creates a temporary WSOL ATA mid-tx to
//      receive the swap output before unwrapping. The wallet pays
//      2_039_280 lamports upfront for that ATA's rent-exempt allocation,
//      gets it refunded when the ATA is closed at the end of the same tx.
//      So the wallet must HOLD ≥ 2_039_280 lamports + tx fee at simulation
//      time, even though net cost is just ~5-10k lamports of fees.
//
// The funder therefore tops up to at least ATA-rent-exempt + slack.
//
// Slack sizing (2026-05-22): the original 60_000 lamports was NOT enough.
// Observed live: Jupiter's swap tx burned 103_872 lamports of base+priority fee
// BEFORE the WSOL ATA Transfer instruction ran, leaving 1_996_128 of the
// 2_100_000 floor — short of the 2_039_280 ATA rent target by 43_152.
// Bumped slack to 200_000 (~$0.017 at $86/SOL) which leaves ~96k headroom
// for the worst priority-fee Jupiter has produced in our runs.
const SOL_RENT_EXEMPT_LAMPORTS = 890_880n;
const SOL_WSOL_ATA_RENT_EXEMPT_LAMPORTS = 2_039_280n;
const SOL_LAMPORTS_FLOOR = SOL_WSOL_ATA_RENT_EXEMPT_LAMPORTS + 200_000n;

// Amount the funder sends to a fresh destination address (recipient or dev
// fee target) to make it a rent-exempt System Account on first contact.
// EXPORTED for the wizard's cost preview before recipient generation.
// Why exactly 890_880: that's the rent-exempt floor for a 0-byte account;
// sending less creates an account stuck below the floor → Solana rejects
// the tx with "Transaction results in an account (N) with insufficient
// funds for rent". Any amount ≥ 890_880 works; we send exactly that to
// minimise funder drain.
export const SOL_ACTIVATION_LAMPORTS = SOL_RENT_EXEMPT_LAMPORTS;

const SOL_MIN_FOR_SWAP_LAMPORTS = (() => {
  const requested = BigInt(process.env.SOL_MIN_FOR_SWAP_LAMPORTS || '2240000');
  return requested < SOL_LAMPORTS_FLOOR ? SOL_LAMPORTS_FLOOR : requested;
})();
const SOL_FUNDER_TOPUP_LAMPORTS = (() => {
  const requested = BigInt(process.env.SOL_FUNDER_TOPUP_LAMPORTS || '2300000');
  return requested < SOL_MIN_FOR_SWAP_LAMPORTS ? SOL_MIN_FOR_SWAP_LAMPORTS : requested;
})();

export interface SolGasFunderOptions {
  // Explicit list of Solana secret keys (base58 or JSON). Overrides env when
  // non-empty. Wizard collects these from user input.
  privateKeys?: string[];
}

class SolGasFunder {
  enabled: boolean;
  private readonly keypairs: Keypair[] = [];
  private cursor = 0;

  constructor(opts: SolGasFunderOptions = {}) {
    let raw =
      opts.privateKeys?.map((s) => s.trim()).filter((s) => s.length > 0) ?? [];
    if (raw.length === 0) {
      const envKey = (process.env.SOL_GAS_FUNDER_PRIVATE_KEY || '').trim();
      if (envKey) raw = [envKey];
    }
    for (const r of raw) {
      try {
        const secret = decodeSolanaSecret(r);
        this.keypairs.push(Keypair.fromSecretKey(secret));
      } catch (e: any) {
        log.err(`Skipping invalid Solana funder key: ${e.message}`);
      }
    }
    this.enabled = this.keypairs.length > 0;
  }

  get addresses(): string[] {
    return this.keypairs.map((kp) => kp.publicKey.toBase58());
  }

  async topUp(target: PublicKey): Promise<string | null> {
    if (!this.enabled || this.keypairs.length === 0) return null;
    const current = BigInt(
      await solCall((c) => c.getBalance(target, 'confirmed'), `solFunder:bal(target)`),
    );
    if (current >= SOL_MIN_FOR_SWAP_LAMPORTS) return null;

    const deficit = SOL_MIN_FOR_SWAP_LAMPORTS - current;
    let amount = deficit > SOL_FUNDER_TOPUP_LAMPORTS ? SOL_FUNDER_TOPUP_LAMPORTS : deficit;
    // Hard guard: resulting balance MUST be ≥ the ATA rent-exempt threshold
    // (2_039_280 lamports + slack), or Jupiter's swap fails mid-simulation
    // when creating the temporary WSOL ATA with
    // "Transfer: insufficient lamports X, need 2039280".
    if (current + amount < SOL_LAMPORTS_FLOOR) {
      amount = SOL_LAMPORTS_FLOOR - current;
    }
    return this._sendAmount(target, amount);
  }

  // Send a precise additional amount to `target` — bypasses the floor logic
  // used by topUp(). Intended for the "swap sim ran out of gas, top up the
  // exact deficit and retry" path in the per-token swap loop.
  //
  // Safety cap (SOL_FUNDER_RETRY_CAP_LAMPORTS, default 0.001 SOL ≈ $0.09)
  // prevents runaway funding if the deficit math is wrong — better to abort
  // one swap than spray funder SOL into a misconfigured wallet.
  async topUpBy(target: PublicKey, amount: bigint): Promise<string | null> {
    if (!this.enabled || this.keypairs.length === 0) return null;
    if (amount <= 0n) return null;
    if (amount > SOL_FUNDER_RETRY_CAP_LAMPORTS) {
      log.warn(
        `sol gas retry refused: requested ${Number(amount) / LAMPORTS_PER_SOL} SOL ` +
          `> cap ${Number(SOL_FUNDER_RETRY_CAP_LAMPORTS) / LAMPORTS_PER_SOL} SOL ` +
          `(set SOL_FUNDER_RETRY_CAP_LAMPORTS to raise)`,
      );
      return null;
    }
    return this._sendAmount(target, amount);
  }

  // Round-robin send `amount` lamports to `target`. Tries each funder once
  // starting at the cursor; falls through on "funder too low" instead of
  // bailing. Advances the cursor on success. Returns the tx sig or null when
  // no funder has enough.
  private async _sendAmount(target: PublicKey, amount: bigint): Promise<string | null> {
    const targetStr = target.toBase58();
    for (let i = 0; i < this.keypairs.length; i++) {
      const kp = this.keypairs[(this.cursor + i) % this.keypairs.length];
      const addr = kp.publicKey.toBase58();
      const funderBal = BigInt(
        await solCall(
          (c) => c.getBalance(kp.publicKey, 'confirmed'),
          `solFunder:bal(funder)`,
        ),
      );
      // Funder needs amount + ~5000 lamports for its own tx fee.
      if (funderBal <= amount + 10000n) {
        log.warn(
          `sol funder ${addr} low: ${Number(funderBal) / LAMPORTS_PER_SOL} SOL ≤ ${
            Number(amount + 10000n) / LAMPORTS_PER_SOL
          } SOL — trying next`,
        );
        continue;
      }
      const recent = await solCall(
        (c) => c.getLatestBlockhash('confirmed'),
        `solFunder:getLatestBlockhash`,
      );
      const tx = new Transaction({
        feePayer: kp.publicKey,
        recentBlockhash: recent.blockhash,
      });
      tx.add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: target,
          lamports: Number(amount),
        }),
      );
      tx.sign(kp);
      const sig = await solCall(
        (c) => c.sendRawTransaction(tx.serialize(), { skipPreflight: false }),
        `solFunder:send`,
      );
      await solCall(
        (c) =>
          c.confirmTransaction(
            {
              signature: sig,
              blockhash: recent.blockhash,
              lastValidBlockHeight: recent.lastValidBlockHeight,
            },
            'confirmed',
          ),
        `solFunder:confirm`,
      );
      log.step(
        `sol gas funder ${addr} → ${targetStr}: ${Number(amount) / LAMPORTS_PER_SOL} SOL`,
      );
      this.cursor = (this.cursor + i + 1) % this.keypairs.length;
      return sig;
    }

    log.err(
      `all ${this.keypairs.length} sol funder(s) insufficient for ${
        Number(amount) / LAMPORTS_PER_SOL
      } SOL`,
    );
    return null;
  }
}

// Hard cap on a single retry-top-up. Default ~0.001 SOL (covers worst-case
// Jupiter priority fees) — guards against runaway top-ups if the deficit
// parser misreads the error message.
const SOL_FUNDER_RETRY_CAP_LAMPORTS = BigInt(
  process.env.SOL_FUNDER_RETRY_CAP_LAMPORTS || '1000000',
);

// Per-session cache of mints Jupiter has already declared not tradable.
// A typical dust wallet set has the same airdrop-spam tokens (`Aw9sfw…`,
// `9rfVc8…`, etc.) repeated across many wallets — re-quoting them for each
// wallet just burns rate-limit budget. After the first 400/TOKEN_NOT_TRADABLE
// response we cache the mint and skip without an API call for the rest of
// the run.
const NOT_TRADABLE = new Set<string>();
let lastJupCallAt = 0;

async function throttleJup(): Promise<void> {
  const now = Date.now();
  const wait = JUP_MIN_INTERVAL_MS - (now - lastJupCallAt);
  if (wait > 0) await sleep(wait);
  lastJupCallAt = Date.now();
}

function jupHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (JUP_API_KEY) h['x-api-key'] = JUP_API_KEY;
  return h;
}

const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || '100');
const MIN_TOKEN_USD = Number(process.env.MIN_TOKEN_USD || '0');

// Per-wallet pacing in the scan/collect loop. `api.mainnet-beta.solana.com`
// allows only ~2 heavy `getTokenAccountsByOwner` calls before issuing a 429
// that lasts several seconds. Default 1500ms keeps us under the cap with
// public RPCs; override to 100-300ms if RPC_SOLANA is a paid endpoint.
const SOL_PACE_MS = Number(process.env.SOLANA_PACE_MS || '1500');
// Backoff when 429 is seen. Mainnet-beta typically lifts the ban after ~5s.
const SOL_429_BACKOFF_MS = Number(process.env.SOLANA_429_BACKOFF_MS || '5000');

// Build one Connection per RPC URL with the SDK's built-in retry disabled so
// we own the rotation logic. `disableRetryOnRateLimit` suppresses the
// "Server responded with 429 Too Many Requests. Retrying after Xms..." log
// spam — we react with rotation+sleep instead.
const CONNECTIONS: Connection[] = SOLANA_RPCS.map(
  (url) =>
    new Connection(url, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    }),
);
let connIdx = 0;

function isRateLimitError(e: any): boolean {
  const msg = String(e?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit');
}

// Run `fn` against the current Solana Connection, rotating to the next URL
// on 429 and sleeping `SOL_429_BACKOFF_MS` between rotations. Max attempts =
// `CONNECTIONS.length × 3`, so with 1 URL we still get 3 retries with 5s
// pacing between them.
async function solCall<T>(fn: (c: Connection) => Promise<T>, label = 'solana'): Promise<T> {
  let lastErr: unknown;
  const maxAttempts = Math.max(3, CONNECTIONS.length * 3);
  for (let i = 0; i < maxAttempts; i++) {
    const conn = CONNECTIONS[connIdx];
    try {
      return await fn(conn);
    } catch (e: any) {
      lastErr = e;
      if (isRateLimitError(e)) {
        const oldUrl = CONNECTIONS[connIdx].rpcEndpoint;
        if (CONNECTIONS.length > 1) {
          connIdx = (connIdx + 1) % CONNECTIONS.length;
          log.warn(
            `solana ${label}: 429 on ${oldUrl}; rotating to ${CONNECTIONS[connIdx].rpcEndpoint}`,
          );
        } else {
          log.warn(`solana ${label}: 429 on ${oldUrl}; backing off ${SOL_429_BACKOFF_MS}ms`);
        }
        await sleep(SOL_429_BACKOFF_MS);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function warnIfNoPaidSolanaRpc(): void {
  const looksPaid = SOLANA_RPCS.some(
    (u) =>
      u.includes('?api-key=') ||
      u.includes('helius') ||
      u.includes('alchemy') ||
      u.includes('quicknode') ||
      u.includes('triton') ||
      /\/v\d+\//.test(u),
  );
  if (!looksPaid) {
    log.warn(
      `Solana: only public RPCs configured (${SOLANA_RPCS.join(', ')}). ` +
        `api.mainnet-beta is heavily rate-limited; expect slow scans with pacing of ${SOL_PACE_MS}ms/wallet. ` +
        `For production set RPC_SOLANA=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY in .env ` +
        `(free tier at https://www.helius.dev → \"Get free API key\").`,
    );
  }
}

interface SplBalance {
  mint: string;
  decimals: number;
  rawAmount: bigint;
  ataPubkey: string;
}

function loadSolanaRecipients(filePath: string): string[] {
  if (!fs.existsSync(filePath)) throw new Error(`Recipients file not found: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: string[] = [];
  for (const rl of raw.split(/\r?\n/)) {
    const line = rl.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      // Will throw on invalid base58 / wrong length.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _pk = new PublicKey(line);
      out.push(line);
    } catch {
      throw new Error(`Invalid Solana address in recipients file: "${line}"`);
    }
  }
  if (out.length === 0) throw new Error(`No recipients in ${filePath}`);
  return out;
}

async function listSplBalances(_conn: Connection, owner: PublicKey): Promise<SplBalance[]> {
  const out: SplBalance[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const resp = await solCall(
      (c) => c.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed'),
      `getTokenAccounts(${programId.toBase58().slice(0, 8)}…)`,
    );
    // Brief inter-call pacing so the two consecutive heavy queries don't
    // burn through mainnet-beta's burst quota in one shot.
    await sleep(Math.min(600, SOL_PACE_MS / 2));
    for (const { account, pubkey } of resp.value) {
      const info: any = (account.data as any).parsed?.info;
      if (!info) continue;
      const mint = info.mint as string;
      const amount = info.tokenAmount?.amount as string;
      const decimals = info.tokenAmount?.decimals as number;
      if (!amount || amount === '0') continue;
      out.push({
        mint,
        decimals,
        rawAmount: BigInt(amount),
        ataPubkey: pubkey.toBase58(),
      });
    }
  }
  return out;
}

interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: any[];
  swapUsdValue?: string;
  contextSlot?: number;
  // Extras Jupiter sometimes adds:
  inUsd?: string;
  outUsd?: string;
}

async function jupQuote(inputMint: string, outputMint: string, amount: bigint): Promise<JupQuote> {
  if (NOT_TRADABLE.has(inputMint)) {
    throw new Error('not tradable (cached)');
  }
  const url =
    `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amount.toString()}&slippageBps=${SLIPPAGE_BPS}` +
    `&onlyDirectRoutes=false&asLegacyTransaction=false`;

  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    await throttleJup();
    try {
      const res = await fetch(url, { headers: jupHeaders() });
      if (res.status === 429) {
        log.warn(`  jup 429; backing off ${JUP_429_BACKOFF_MS}ms`);
        await sleep(JUP_429_BACKOFF_MS);
        lastErr = new Error('jup /quote 429: Rate limit exceeded');
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        if (t.includes('TOKEN_NOT_TRADABLE')) {
          NOT_TRADABLE.add(inputMint);
          throw new Error('not tradable');
        }
        throw new Error(`jup /quote ${res.status}: ${t.slice(0, 200)}`);
      }
      return (await res.json()) as JupQuote;
    } catch (e: any) {
      lastErr = e;
      // Non-retryable: TOKEN_NOT_TRADABLE was cached, no point retrying.
      if (String(e?.message || '').startsWith('not tradable')) break;
      if (i === 2) break;
      await sleep(600 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function jupSwapTx(quote: JupQuote, userPubkey: string): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    await throttleJup();
    try {
      const res = await fetch(JUP_SWAP, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...jupHeaders() },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: userPubkey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });
      if (res.status === 429) {
        log.warn(`  jup /swap 429; backing off ${JUP_429_BACKOFF_MS}ms`);
        await sleep(JUP_429_BACKOFF_MS);
        lastErr = new Error('jup /swap 429: Rate limit exceeded');
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`jup /swap ${res.status}: ${t.slice(0, 200)}`);
      }
      const j = (await res.json()) as { swapTransaction: string };
      return j.swapTransaction;
    } catch (e: any) {
      lastErr = e;
      if (i === 2) break;
      await sleep(600 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function executeSwap(
  _conn: Connection,
  account: SolanaAccount,
  swapTxB64: string,
): Promise<string> {
  const buf = Buffer.from(swapTxB64, 'base64');
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([account.keypair]);
  const sig = await solCall(
    (c) => c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
    'sendRawTransaction',
  );
  const latest = await solCall((c) => c.getLatestBlockhash('confirmed'), 'getLatestBlockhash');
  await solCall(
    (c) =>
      c.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed',
      ),
    'confirmTransaction',
  );
  return sig;
}

// Parse Solana "Transfer: insufficient lamports X, need Y" out of the
// SendTransactionError. The simulation logs are included in the error message
// or attached as `.logs`; we check both.
function parseInsufficientLamports(e: any): { have: bigint; need: bigint } | null {
  const haystack =
    String(e?.message ?? '') +
    ' ' +
    (Array.isArray(e?.logs) ? e.logs.join(' ') : '');
  const m = /insufficient lamports (\d+),\s*need (\d+)/i.exec(haystack);
  if (!m) return null;
  return { have: BigInt(m[1]), need: BigInt(m[2]) };
}

// Pre-activate destination addresses (recipients + dev fee target). Each
// brand-new Solana address must hold ≥ 890_880 lamports (rent-exempt) before
// any non-rent-exempt amount can be sent to it — otherwise Phase 3 fails
// with "Transaction results in an account (N) with insufficient funds for
// rent". This function checks each unique destination via getAccountInfo
// and uses the funder to send SOL_ACTIVATION_LAMPORTS to any that don't
// exist yet. Already-existing addresses are skipped.
//
// If unactivated addresses exist but the funder is disabled, we throw — the
// user should either configure a funder or paste already-activated
// recipients.
async function preActivateAccounts(
  funder: SolGasFunder,
  addresses: string[],
): Promise<void> {
  const unique = Array.from(new Set(addresses));
  const inactive: string[] = [];
  for (const addr of unique) {
    const info = await solCall(
      (c) => c.getAccountInfo(new PublicKey(addr), 'confirmed'),
      `preActivate:info:${addr.slice(0, 6)}`,
    );
    if (!info) inactive.push(addr);
  }
  if (inactive.length === 0) {
    log.info(
      `pre-activation: all ${unique.length} destination address(es) already exist on-chain.`,
    );
    return;
  }
  if (!funder.enabled) {
    throw new Error(
      `${inactive.length} destination address(es) not yet on Solana and no funder configured. ` +
        `Either restart the wizard and add funder keys, or paste already-activated recipient addresses.`,
    );
  }
  const totalCost = SOL_ACTIVATION_LAMPORTS * BigInt(inactive.length);
  log.step(
    `Pre-activating ${inactive.length} address(es) at ${
      Number(SOL_ACTIVATION_LAMPORTS) / LAMPORTS_PER_SOL
    } SOL each (total ${Number(totalCost) / LAMPORTS_PER_SOL} SOL from funder)`,
  );
  for (const addr of inactive) {
    const sig = await funder.topUpBy(new PublicKey(addr), SOL_ACTIVATION_LAMPORTS);
    if (!sig) {
      throw new Error(
        `activation send refused for ${addr} (funder cap or all funders low). ` +
          `Top up the funder or raise SOL_FUNDER_RETRY_CAP_LAMPORTS.`,
      );
    }
    log.ok(`  activated ${addr}: ${sig}`);
  }
}

// Build + execute one swap, with a single retry path for the "WSOL ATA rent
// shortfall" failure mode. If sim returns insufficient-lamports, we ask the
// funder to send EXACTLY the deficit + 50k slack and retry the swap once.
// All other failures bubble up to the caller's catch (and skip the token).
async function swapWithGasRetry(
  conn: Connection,
  funder: SolGasFunder,
  account: SolanaAccount,
  q: JupQuote,
  mint: string,
): Promise<string> {
  try {
    const swapTx = await jupSwapTx(q, account.address);
    return await executeSwap(conn, account, swapTx);
  } catch (e: any) {
    const shortfall = parseInsufficientLamports(e);
    if (!shortfall || !funder.enabled) throw e;
    const deficit = shortfall.need - shortfall.have + 50_000n; // 50k slack
    log.warn(
      `  swap ${mint.slice(0, 6)}… sim short by ${Number(
        shortfall.need - shortfall.have,
      )} lamports — funder topping up ${Number(deficit)} and retrying once`,
    );
    const topupSig = await funder.topUpBy(account.keypair.publicKey, deficit);
    if (!topupSig) {
      throw new Error(
        `retry top-up refused (cap or all funders low); original error: ${e.message}`,
      );
    }
    // Fresh swap tx — quote is still good for a few seconds, but we need a
    // fresh blockhash inside the signed tx.
    const swapTx2 = await jupSwapTx(q, account.address);
    return await executeSwap(conn, account, swapTx2);
  }
}

interface SolSummary {
  wallet: SolanaAccount;
  finalLamports: bigint;
  swapped: { mint: string; outSol: number; tx: string }[];
  skipped: { mint: string; reason: string }[];
}

async function collectOneSolWallet(
  conn: Connection,
  account: SolanaAccount,
  solPriceUsd: number,
  funder: SolGasFunder,
  progress?: { index: number; total: number },
): Promise<SolSummary> {
  const prefix = progress ? `[${progress.index + 1}/${progress.total}] ` : '';
  log.step(`${prefix}wallet ${account.address}`);
  const sum: SolSummary = { wallet: account, finalLamports: 0n, swapped: [], skipped: [] };

  const balances = await listSplBalances(conn, account.keypair.publicKey);
  log.info(`  ${balances.length} SPL token accounts with non-zero balance`);

  for (const b of balances) {
    if (b.mint === SOL_MINT) continue; // wSOL — will be unwrapped automatically by Jupiter
    if (NOT_TRADABLE.has(b.mint)) {
      // Already learned this mint isn't tradable on Jupiter; skip the API call.
      sum.skipped.push({ mint: b.mint, reason: 'not tradable (cached)' });
      continue;
    }
    try {
      const q = await jupQuote(b.mint, SOL_MINT, b.rawAmount);
      const outLamports = BigInt(q.outAmount);
      const outSol = Number(outLamports) / LAMPORTS_PER_SOL;
      const outUsd = outSol * solPriceUsd;
      // Solana tx fee: ~5000 lamports base + priority. Be generous: assume 0.0005 SOL total.
      const txFeeUsd = 0.0005 * solPriceUsd;
      const netUsd = outUsd - txFeeUsd;
      const inUsdStr = (q as any).swapUsdValue ?? '?';
      log.info(
        `  quote ${b.mint.slice(0, 6)}…: out=${outSol.toFixed(6)} SOL ($${outUsd.toFixed(
          4,
        )}) fee≈$${txFeeUsd.toFixed(4)} net=$${netUsd.toFixed(4)} (in=$${inUsdStr})`,
      );
      if (MIN_TOKEN_USD > 0 && outUsd < MIN_TOKEN_USD) {
        sum.skipped.push({ mint: b.mint, reason: `below MIN_TOKEN_USD ($${outUsd.toFixed(4)})` });
        continue;
      }
      if (netUsd <= 0) {
        sum.skipped.push({ mint: b.mint, reason: `unprofitable (net=$${netUsd.toFixed(4)})` });
        continue;
      }
      // Ensure the wallet has enough SOL to pay tx fees. If it has 0 SOL,
      // Jupiter's swap simulation fails before broadcast with "Attempt to
      // debit an account but found no record of a prior credit". The funder
      // tops up only once per wallet — subsequent swaps in the same loop
      // benefit from the SOL that the first swap produces.
      if (funder.enabled) {
        try {
          await funder.topUp(account.keypair.publicKey);
        } catch (e: any) {
          log.warn(`  sol gas top-up failed: ${e.message}`);
        }
      }
      // Single attempt with a top-up-and-retry fallback: when Jupiter's sim
      // returns "Transfer: insufficient lamports X, need Y" the funder upfront
      // floor wasn't enough (priority fee on this tx exceeded our buffer).
      // Parse the deficit, send EXACTLY that amount + 50k slack, and retry
      // once. Capped by SOL_FUNDER_RETRY_CAP_LAMPORTS so a parser error can't
      // burn the funder. If retry also fails, give up on this token.
      const sig = await swapWithGasRetry(conn, funder, account, q, b.mint);
      log.ok(`  swap ${b.mint.slice(0, 6)}… → SOL: ${sig}`);
      sum.swapped.push({ mint: b.mint, outSol, tx: sig });
      await sleep(400); // gentle pacing on public RPC
    } catch (e: any) {
      log.warn(`  skip ${b.mint.slice(0, 6)}…: ${e.message}`);
      sum.skipped.push({ mint: b.mint, reason: e.message });
    }
  }

  sum.finalLamports = BigInt(
    await solCall((c) => c.getBalance(account.keypair.publicKey, 'confirmed'), 'getBalance:final'),
  );
  log.ok(`  done. final: ${Number(sum.finalLamports) / LAMPORTS_PER_SOL} SOL`);
  return sum;
}

export async function runSolanaMode(opts: {
  sources: WalletSources;
  recipientsFile: string;
  // Solana funder private keys (base58 or JSON-array). Optional; if absent
  // falls back to env SOL_GAS_FUNDER_PRIVATE_KEY inside the constructor.
  funderKeys?: string[];
}): Promise<void> {
  log.step('Solana mode');
  const wallets = loadSolanaAccounts(opts.sources);
  log.info(`Loaded ${wallets.length} wallets`);

  const recipients = loadSolanaRecipients(opts.recipientsFile);
  log.info(`Loaded ${recipients.length} recipient addresses`);

  warnIfNoPaidSolanaRpc();
  // Conn is just for old function signatures; actual RPC calls go through solCall().
  const conn = CONNECTIONS[0];
  const solPrice = await getUsdPrice('solana');
  log.info(`SOL price: $${solPrice.toFixed(2)} (CoinGecko)`);

  const funder = new SolGasFunder({ privateKeys: opts.funderKeys });
  if (funder.enabled) {
    log.info(
      `SOL gas funder${funder.addresses.length > 1 ? 's' : ''} enabled (${funder.addresses.length}): ${funder.addresses.join(', ')} ` +
        `(min wallet bal ${Number(SOL_MIN_FOR_SWAP_LAMPORTS) / LAMPORTS_PER_SOL} SOL, ` +
        `top-up cap ${Number(SOL_FUNDER_TOPUP_LAMPORTS) / LAMPORTS_PER_SOL} SOL/wallet)`,
    );
  } else {
    log.warn(
      `SOL gas funder DISABLED — wallets with valuable SPL but 0 SOL will fail swap simulation. ` +
        `Add funder keys via the wizard (or set SOL_GAS_FUNDER_PRIVATE_KEY in .env for power-user runs).`,
    );
  }

  // Map: shuffle wallets, assign recipients round-robin.
  const shuffled = shuffle(wallets);
  const assignment = shuffled.map((w, i) => ({ wallet: w, recipient: recipients[i % recipients.length] }));

  console.log(chalk.bold('\nPlanned mapping (will be confirmed before sends):'));
  for (const a of assignment) {
    console.log(`  ${chalk.cyan(a.wallet.address)} → ${chalk.green(a.recipient)}`);
  }

  // Phase 1: collect. Pacing between wallets keeps mainnet-beta under its
  // burst cap; ignored if RPC_SOLANA is a paid endpoint (cap is much higher).
  const summaries: SolSummary[] = [];
  for (let i = 0; i < assignment.length; i++) {
    const a = assignment[i];
    try {
      summaries.push(
        await collectOneSolWallet(conn, a.wallet, solPrice, funder, {
          index: i,
          total: assignment.length,
        }),
      );
    } catch (e: any) {
      log.err(`[${i + 1}/${assignment.length}] wallet ${a.wallet.address} failed: ${e.message}`);
      summaries.push({ wallet: a.wallet, finalLamports: 0n, swapped: [], skipped: [] });
    }
    if (i < assignment.length - 1) await sleep(SOL_PACE_MS);
  }

  // Phase 2: summary + confirm.
  console.log(chalk.bold('\nBalances ready to send:'));
  let totalUsd = 0;
  const sendPlan: { wallet: SolanaAccount; recipient: string; lamports: bigint }[] = [];
  for (let i = 0; i < assignment.length; i++) {
    const a = assignment[i];
    const s = summaries[i];
    const sol = Number(s.finalLamports) / LAMPORTS_PER_SOL;
    const usd = sol * solPrice;
    totalUsd += usd;
    console.log(`  ${a.wallet.address}: ${sol.toFixed(6)} SOL (~$${usd.toFixed(2)}) → ${a.recipient}`);
    if (s.finalLamports > 0n) {
      sendPlan.push({ wallet: a.wallet, recipient: a.recipient, lamports: s.finalLamports });
    }
  }
  console.log(chalk.bold(`Total: ~$${totalUsd.toFixed(2)} across ${sendPlan.length} wallets`));

  if (sendPlan.length === 0) {
    log.warn('Nothing to send.');
    return;
  }

  const ans = await prompts({
    type: 'confirm',
    name: 'go',
    message: 'Proceed with sending these balances to the recipients?',
    initial: false,
  });
  if (!ans.go) {
    log.warn('User declined. No transfers will be made.');
    return;
  }

  // Phase 2.5: pre-activate destination addresses. Fresh wallets (our
  // generator or any address that's never held SOL) need a one-time
  // rent-exempt deposit before any send to them can succeed. We check all
  // unique destination addresses (recipients in the plan + dev fee target)
  // and fund the missing ones from the funder. If a fresh address slips
  // through without funder support, the whole run aborts here — better
  // than discovering the problem inside Phase 3 after partial sends.
  const devSolAddr = getDevDestinations().sol;
  const devSolPubkey = new PublicKey(devSolAddr);
  const allDestinations = [...new Set(sendPlan.map((p) => p.recipient)), devSolAddr];
  log.step(`Phase 2.5: checking on-chain existence of ${allDestinations.length} destination address(es)`);
  try {
    await preActivateAccounts(funder, allDestinations);
  } catch (e: any) {
    log.err(`pre-activation failed: ${e.message}`);
    return;
  }

  // Phase 3: send. ONE tx per wallet with TWO transfer instructions
  // (user 90% + dev 10%). Atomic: either both transfers commit or neither
  // does, so we can't end up "dev paid, user didn't" — and the sender goes
  // from `live` to 0 in a single step, avoiding the rent-exempt zone-of-death
  // (0 < balance < 890_880) that broke the previous 2-tx flow.
  // Anti-Sybil mixing is preserved: chain explorers show both transfers
  // exactly as before, just inside one tx envelope.
  log.step(`Phase 3: send SOL to recipients (90% user / ${FEE_BPS / 100}% fee, atomic 1 tx/wallet)`);
  const FEE_RESERVE = 5000n; // base fee per signature on Solana

  for (let i = 0; i < sendPlan.length; i++) {
    const p = sendPlan[i];
    try {
      const live = BigInt(
        await solCall(
          (c) => c.getBalance(p.wallet.keypair.publicKey, 'confirmed'),
          'getBalance:live',
        ),
      );
      if (live <= FEE_RESERVE) {
        log.warn(`skip ${p.wallet.address}: balance ${live} ≤ fee reserve ${FEE_RESERVE}`);
        continue;
      }
      const sendable = live - FEE_RESERVE;
      const { devShare, userShare } = splitAmount(sendable);

      const recent = await solCall(
        (c) => c.getLatestBlockhash('confirmed'),
        `[${i + 1}]:blockhash`,
      );
      const tx = new Transaction({
        feePayer: p.wallet.keypair.publicKey,
        recentBlockhash: recent.blockhash,
      });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      // userShare can never realistically be 0 here (sendable > 0 and we take
      // 90%), but check anyway — Solana System Program rejects 0-lamport
      // transfers in some validator versions.
      if (userShare > 0n) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: p.wallet.keypair.publicKey,
            toPubkey: new PublicKey(p.recipient),
            lamports: Number(userShare),
          }),
        );
      }
      if (devShare > 0n) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: p.wallet.keypair.publicKey,
            toPubkey: devSolPubkey,
            lamports: Number(devShare),
          }),
        );
      }
      tx.sign(p.wallet.keypair);
      const sig = await solCall(
        (c) => c.sendRawTransaction(tx.serialize(), { skipPreflight: false }),
        `[${i + 1}]:sendRaw`,
      );
      await solCall(
        (c) =>
          c.confirmTransaction(
            { signature: sig, blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight },
            'confirmed',
          ),
        `[${i + 1}]:confirm`,
      );
      log.ok(
        `  [${i + 1}/${sendPlan.length}] ${p.wallet.address} → ${
          Number(userShare) / LAMPORTS_PER_SOL
        } SOL user / ${
          Number(devShare) / LAMPORTS_PER_SOL
        } SOL fee  (${sig})`,
      );
    } catch (e: any) {
      log.err(`[${i + 1}/${sendPlan.length}] send failed for ${p.wallet.address}: ${e.message}`);
    }
    if (i < sendPlan.length - 1) await sleep(SOL_PACE_MS);
  }
  log.ok('All done.');
}

// ---------------------------------------------------------------------------
// Read-only Solana scan. No transactions.
// ---------------------------------------------------------------------------

export async function runSolanaScan(opts: { sources: WalletSources }): Promise<void> {
  log.step('Solana scan (no transactions)');
  const wallets = loadSolanaAccounts(opts.sources);
  log.info(`Loaded ${wallets.length} wallets`);

  warnIfNoPaidSolanaRpc();
  const conn = CONNECTIONS[0];
  const solPrice = await getUsdPrice('solana');
  log.info(`SOL price: $${solPrice.toFixed(2)}`);

  let totalSolUsd = 0;
  let totalSplUsd = 0;
  let walletsWithSomething = 0;
  let tradableTokensCount = 0;
  let untradableTokensCount = 0;
  // Disable with SOLANA_SCAN_QUOTES=0 if user wants a fast read-only scan
  // without Jupiter (rate limit is the bottleneck on free tier).
  const quoteTokens = (process.env.SOLANA_SCAN_QUOTES || '1') !== '0';

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    console.log(chalk.bold(`\nWallet ${i + 1}/${wallets.length}: ${w.address}`));

    const lamports = BigInt(
      await solCall((c) => c.getBalance(w.keypair.publicKey, 'confirmed'), 'getBalance'),
    );
    const sol = Number(lamports) / LAMPORTS_PER_SOL;
    const solUsd = sol * solPrice;
    totalSolUsd += solUsd;
    console.log(`  SOL: ${sol.toFixed(6)} ($${solUsd.toFixed(3)})`);

    let balances: SplBalance[] = [];
    try {
      balances = await listSplBalances(conn, w.keypair.publicKey);
    } catch (e: any) {
      log.warn(`  SPL fetch failed: ${e.message}`);
    }

    if (balances.length === 0) {
      console.log(chalk.gray('  no SPL tokens'));
    } else {
      for (const b of balances) {
        const amount = Number(b.rawAmount) / Math.pow(10, b.decimals);
        const shortMint = `${b.mint.slice(0, 6)}…${b.mint.slice(-4)}`;
        const amountStr = `${amount} ${chalk.gray(`(d=${b.decimals})`)}`;

        if (b.mint === SOL_MINT) {
          console.log(`  ${shortMint}: ${amountStr} ${chalk.cyan('[wSOL — Jupiter unwraps]')}`);
          continue;
        }
        // NOT_TRADABLE cache hit (mint already failed in an earlier wallet).
        if (NOT_TRADABLE.has(b.mint)) {
          untradableTokensCount++;
          console.log(`  ${shortMint}: ${amountStr} ${chalk.gray('not tradable')}`);
          continue;
        }
        if (!quoteTokens) {
          console.log(`  ${shortMint}: ${amountStr} ${chalk.gray('(quotes disabled)')}`);
          continue;
        }
        // Live quote → SOL. Errors get pretty-printed in the same line.
        try {
          const q = await jupQuote(b.mint, SOL_MINT, b.rawAmount);
          const outSol = Number(BigInt(q.outAmount)) / LAMPORTS_PER_SOL;
          const outUsd = outSol * solPrice;
          totalSplUsd += outUsd;
          tradableTokensCount++;
          const usdLabel = outUsd >= 0.01 ? chalk.green(`$${outUsd.toFixed(3)}`) : chalk.gray(`$${outUsd.toFixed(4)}`);
          console.log(`  ${shortMint}: ${amountStr} ${usdLabel} ${chalk.gray(`(${outSol.toFixed(6)} SOL)`)}`);
        } catch (e: any) {
          const msg = String(e?.message || '');
          if (msg.startsWith('not tradable')) {
            untradableTokensCount++;
            console.log(`  ${shortMint}: ${amountStr} ${chalk.gray('not tradable')}`);
          } else {
            console.log(`  ${shortMint}: ${amountStr} ${chalk.yellow(`quote failed: ${msg.slice(0, 60)}`)}`);
          }
        }
      }
    }

    if (balances.length > 0 || solUsd > 0.01) walletsWithSomething++;
    if (i < wallets.length - 1) await sleep(SOL_PACE_MS);
  }

  console.log(chalk.bold('\n========== Summary =========='));
  console.log(
    `  ${walletsWithSomething}/${wallets.length} wallets have something.\n` +
      `  Total native SOL across all wallets: ~$${totalSolUsd.toFixed(2)}\n` +
      `  Total tradable SPL value (Jupiter quotes):  ~$${totalSplUsd.toFixed(2)}\n` +
      `  Grand total: ~$${(totalSolUsd + totalSplUsd).toFixed(2)}\n` +
      `  Tradable tokens: ${tradableTokensCount}, not tradable: ${untradableTokensCount}`,
  );
  console.log(
    chalk.gray(
      '\nNote: SPL USD values are gross (before swap fees / tx fees / slippage).\n' +
        'Run without --scan-only to actually execute the sweep.\n' +
        'Set SOLANA_SCAN_QUOTES=0 in .env to skip per-token Jupiter quotes (faster scan).',
    ),
  );
}

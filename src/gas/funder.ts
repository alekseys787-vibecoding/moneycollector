import { Wallet, parseEther, formatEther } from 'ethers';
import { ChainConfig } from '../config/chains';
import { rpcRetry, waitForTxWithRotation } from '../discovery/evm';
import { getUsdPrice } from '../utils/prices';
import { log } from '../utils/logger';
import { deriveEvmFromPrivateKey } from '../wallet/derive';

export interface GasFunderOptions {
  // Explicit list of EVM private keys. If non-empty, overrides env-supplied key.
  // The wizard collects these from user input and passes them here.
  privateKeys?: string[];
  // Per-top-up USD cap. Defaults to env GAS_FUNDER_MAX_USD_PER_TOPUP or $0.50.
  maxUsdPerTopUp?: number;
}

interface Funder {
  pkey: string;
  address: string;
}

export class GasFunder {
  readonly enabled: boolean;
  readonly maxUsdPerTopUp: number;
  private readonly funders: Funder[];
  // Round-robin cursor. We advance on EVERY top-up attempt (success OR
  // insufficient-balance fallthrough) so we don't keep hammering the same
  // funder when there are several.
  private cursor = 0;

  constructor(opts: GasFunderOptions = {}) {
    let rawKeys =
      opts.privateKeys?.map((k) => k.trim()).filter((k) => k.length > 0) ?? [];
    if (rawKeys.length === 0) {
      const envKey = (process.env.GAS_FUNDER_PRIVATE_KEY || '').trim();
      if (envKey) rawKeys = [envKey];
    }
    this.funders = [];
    for (const k of rawKeys) {
      try {
        const acc = deriveEvmFromPrivateKey(k);
        this.funders.push({ pkey: acc.privateKey, address: acc.address });
      } catch (e: any) {
        log.err(`Skipping invalid EVM funder key: ${e.message}`);
      }
    }
    this.enabled = this.funders.length > 0;
    this.maxUsdPerTopUp =
      opts.maxUsdPerTopUp ??
      Number(process.env.GAS_FUNDER_MAX_USD_PER_TOPUP || '0.50');
  }

  // Public read-only view of the funder addresses (for log lines / scan summary).
  get addresses(): string[] {
    return this.funders.map((f) => f.address);
  }

  // Aggregate native balance across all funders on a chain. Returns total + a
  // per-funder breakdown so the scan-mode summary can show users which funder
  // has what on each chain.
  async balanceUsd(
    chain: ChainConfig,
  ): Promise<{
    totalWei: bigint;
    totalUsd: number;
    perFunder: Array<{ address: string; wei: bigint; usd: number }>;
  }> {
    if (!this.enabled) {
      return { totalWei: 0n, totalUsd: 0, perFunder: [] };
    }
    const price = await getUsdPrice(chain.nativeCoingeckoId);
    const perFunder: Array<{ address: string; wei: bigint; usd: number }> = [];
    let totalWei = 0n;
    for (const f of this.funders) {
      const wei = await rpcRetry(chain.key, (p) => p.getBalance(f.address), {
        label: `funder:${chain.key}:getBalance(${f.address.slice(0, 8)})`,
        timeoutMs: 15_000,
      });
      const usd = Number(formatEther(wei)) * price;
      perFunder.push({ address: f.address, wei, usd });
      totalWei += wei;
    }
    return { totalWei, totalUsd: Number(formatEther(totalWei)) * price, perFunder };
  }

  /**
   * Top up `target` so it holds at least `neededWei` native on `chain`. With
   * multiple funders we try them in round-robin order: if one has insufficient
   * balance we advance to the next, returning null only when ALL are too low.
   * The top-up amount is capped by `maxUsdPerTopUp`.
   */
  async topUp(
    target: string,
    chain: ChainConfig,
    neededWei: bigint,
  ): Promise<string | null> {
    if (!this.enabled) {
      log.warn(`gas funder disabled; cannot top up ${target} on ${chain.key}`);
      return null;
    }
    const current = await rpcRetry(chain.key, (p) => p.getBalance(target), {
      label: `funder:${chain.key}:getBalance(target)`,
      timeoutMs: 15_000,
    });
    if (current >= neededWei) return null;

    const deficit = neededWei - current;
    const price = await getUsdPrice(chain.nativeCoingeckoId);
    const maxNative = this.maxUsdPerTopUp / price;
    const maxWei = parseEther(maxNative.toFixed(18));
    const amount = deficit > maxWei ? maxWei : deficit;
    if (amount <= 0n) return null;

    // Try each funder once in round-robin order starting from `cursor`. Fall
    // through to the next on insufficient balance; bail out only when all N
    // funders are too low.
    for (let i = 0; i < this.funders.length; i++) {
      const f = this.funders[(this.cursor + i) % this.funders.length];
      const funderBalance = await rpcRetry(
        chain.key,
        (p) => p.getBalance(f.address),
        {
          label: `funder:${chain.key}:getBalance(funder)`,
          timeoutMs: 15_000,
        },
      );
      if (funderBalance <= amount) {
        log.warn(
          `funder ${f.address} low on ${chain.key}: ${formatEther(
            funderBalance,
          )} ≤ ${formatEther(amount)} — trying next`,
        );
        continue;
      }
      log.step(
        `gas funder ${f.address} → ${target}: ${formatEther(amount)} ${chain.nativeSymbol} on ${chain.key}`,
      );
      const tx = await rpcRetry(
        chain.key,
        (prov) => {
          const signer = new Wallet(f.pkey, prov);
          return signer.sendTransaction({ to: target, value: amount });
        },
        { label: `funder:${chain.key}:sendTransaction`, timeoutMs: 30_000 },
      );
      const rcpt = await waitForTxWithRotation(chain.key, tx.hash);
      if (!rcpt || rcpt.status !== 1) {
        throw new Error(`gas top-up tx failed: ${tx.hash}`);
      }
      // Advance the round-robin cursor so the NEXT top-up tries the next funder.
      this.cursor = (this.cursor + i + 1) % this.funders.length;
      return tx.hash;
    }

    log.err(
      `all ${this.funders.length} funder(s) insufficient on ${chain.key} for ${formatEther(
        amount,
      )} ${chain.nativeSymbol}`,
    );
    return null;
  }
}

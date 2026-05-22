# moneycollector

Interactive dust collector for ex-airdrop-farmers and traders with leftover "pyl'" across many wallets. Sweeps small balances on **17 EVM chains + Solana**, swaps everything to native ETH (Arb/Base) or SOL, then forwards to recipient addresses you control.

Designed to be useful **out of the box** — no JSON / config-file editing. A built-in wizard walks you through every step.

## What you get

- **17 EVM chains**: Ethereum, Arbitrum, Optimism, Base, Polygon, BSC, opBNB, Avalanche, Fantom, Celo, Linea, Scroll, zkSync, Zora, Mode, Blast, Abstract.
- **Solana**: full SPL token discovery + Jupiter swap → SOL.
- **Multi-bridge routing**: Relay.link by default; LI.FI for chains Relay can't (opBNB, Fantom).
- **Gas-funding rotation**: optional sponsor wallets that send tiny gas top-ups to dust wallets with no native. Multiple funders supported with round-robin.
- **Auto-generated recipient wallets**: wizard can derive N fresh BIP39 wallets for you. Mnemonics saved to a per-run file.
- **Pre-activation pass on Solana**: brand-new Solana recipient addresses get the rent-exempt minimum funded automatically before any send.
- **Custom EVM tokens**: add your own ERC20 contracts via wizard. Persists in `data/custom-tokens.json`.

## Monetization disclosure

**10% of each sweep goes to the developer wallet automatically.** 90% goes to your recipient addresses. This is the service fee.

For context: anti-drain services and similar "rescue" tools typically charge **20–30%**. We charge 10%.

The fee logic is in `src/fee/devSplit.ts` and the addresses are obfuscated in the prebuilt `.exe`. If you'd rather not pay, you can fork the repo and patch that module — the code is open. We just ask: if you find the tool useful, pay the fee or keep using the public service.

## Requirements

- Windows 10/11 x64 (for the prebuilt `.exe`)
- OR Node.js 18.18+ on any OS (to run from source)

## Quick start (prebuilt `.exe`)

1. Download `moneycollector.exe` from the [Releases](../../releases) page.
2. Create an empty folder, drop the `.exe` inside. The program will create `data/` and `logs/` next to it.
3. Open Command Prompt or PowerShell in that folder and run:
   ```
   moneycollector.exe
   ```
4. Follow the wizard:
   - Pick a mode (EVM scan / EVM real / Sol scan / Sol real).
   - Paste your wallet mnemonics or private keys (mixed OK — the wizard sorts them).
   - Generate fresh recipient wallets, or paste your own addresses.
   - Add funder wallet(s) if your dust wallets have no native gas.
   - Confirm the summary → run.

The first run on a fresh folder takes ~1 minute to scan. Real runs ask for explicit confirmation before sending anything.

## Quick start (from source)

```powershell
git clone https://github.com/alekseys787-vibecoding/moneycollector.git
cd moneycollector
npm install
npm start
```

That launches the same interactive wizard.

## Build your own `.exe`

```powershell
npm install
npm run build:exe
# → dist/moneycollector.exe
```

The build script:
1. compiles TypeScript → `dist/`
2. obfuscates `dist/fee/devSplit.js` (where the fee addresses live)
3. packages everything into a single Win-x64 executable via `@yao-pkg/pkg`

## How it works (in plain English)

**EVM real mode**, per wallet:
1. Pick a destination chain at random — Arbitrum or Base (configurable via `DEST_CHAINS` env).
2. For each ERC20 the wallet holds (curated list + your custom additions): ask Relay/LI.FI for a quote that swaps the token to native ETH on the destination chain. Skip if Relay's `net = output_usd - gas_usd ≤ 0`.
3. For each chain's remaining native: bridge to the destination chain (skip if net ≤ 0).
4. After all wallets are processed: re-read final balances, show a summary, ask **"Proceed?"**.
5. On confirmation: each wallet sends two transactions on the destination chain — 90% to your recipient (random round-robin from your list), 10% to the dev wallet. Anti-Sybil mixing preserved.

**Solana real mode**, per wallet:
1. List every SPL token account (Token + Token-2022) with non-zero balance.
2. Quote each via Jupiter v6 → SOL. Execute when profitable.
3. After all wallets: pre-activate any non-existent recipient or dev address (funder sends rent-exempt minimum), then **one atomic tx per wallet** with two `SystemProgram.transfer` instructions (user 90% + dev 10%).

**Scan modes** are read-only: they tell you what's where, what each chain's funder would need, and how much dust value is sitting around. No transactions.

## Safety notes

- Mnemonics / private keys you paste during the wizard are saved to `data/seeds-evm.txt`, `data/seeds-sol.txt`, `data/privkeys-evm.txt`, `data/privkeys-sol.txt` in **plain text** on your disk. Run on a machine you trust. Delete the files when done.
- The wizard always shows the **first 3 derived addresses** in the summary so you can spot if you pasted Solana mnemonics into the EVM file by mistake.
- Real-mode runs always require explicit `Proceed?` confirmation before any send.
- Solana recipient wallets generated by the wizard are written to `data/generated-recipients-<timestamp>.txt`. **Save that file** — mnemonics are not regenerated.
- The script never sends your seeds or private keys over the network. It only contacts public RPCs, Relay.link, LI.FI, Jupiter, and CoinGecko.

## Optional environment variables

Most things are wizard-driven, but a few advanced knobs live in `.env` (copy from `.env.example`):

| Variable | Default | What it does |
|---|---|---|
| `RPC_<CHAIN>` | public RPC | Override a specific chain's RPC URL (e.g. `RPC_ETHEREUM=https://...`). Add `_2`, `_3` for backups. |
| `RPC_SOLANA` | mainnet-beta | **Strongly recommended** to set to your free Helius URL. Without it, Solana scans are throttled. |
| `DEST_CHAINS` | `arbitrum,base` | Comma-separated list of EVM destination chains. One picked at random per wallet. |
| `CONCURRENCY` | `2` | Parallel wallets in real mode. Raise if you use paid RPCs. |
| `SLIPPAGE_BPS` | `100` | Swap slippage in basis points (100 = 1%). |
| `MIN_TOKEN_USD` | `0` | Hard USD threshold. `0` = let Relay's net-profit check decide. |
| `GAS_FUNDER_MAX_USD_PER_TOPUP` | `0.50` | Per-top-up cap for EVM gas funding. Bump if zkSync sweeps hit `INSUFFICIENT_FUNDS`. |
| `SOL_FUNDER_RETRY_CAP_LAMPORTS` | `1000000` | Cap on the auto-retry top-up when a Solana swap simulation runs out of gas. |

## Limitations

- **Token discovery is list-based** on EVM (Solana auto-discovers all SPL). Exotic / airdropped tokens not in the curated list are invisible unless you add them via the wizard's "Manage custom EVM tokens" menu.
- **Abstract / Zora / Mode** have thin ERC20 ecosystems — expect mostly native ETH.
- **Solana token-account rent reclamation** is not automated. Closing empty ATAs is a follow-up.
- **NFTs are ignored** on both EVM and Solana.

## Disclaimer

This software is provided as-is, with no warranty. **Test with small amounts first.** The author is not responsible for funds lost due to RPC outages, bridge failures, user error, or any other reason. By using this tool you acknowledge that you understand what each step does.

## License

MIT — see `LICENSE`.

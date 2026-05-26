# Changelog

## v0.2.0 — 2026-05-26

This release introduces **ULTRA sweep mode** (a new aggregator-style flow that
captures sub-gas dust the per-wallet flow can't profitably handle), adds
**Squid Router** as a third bridge provider so Fantom remains reachable after
LI.FI / Relay / Stargate / deBridge all dropped it, and hardens dozens of
robustness corners observed across live runs.

### ⭐ New features

#### EVM ULTRA sweep mode
A new mode in the wizard alongside the standard sweep. Three-phase pipeline:

- **Phase 1 — sweep**: each source wallet, on each of 17 chains, transfers its
  ERC20s and native residual to a single **hub wallet** on the same chain.
  Plain transfers (~50-65k gas) instead of swap+bridge (~300k+) — captures
  dust whose value is below the swap+bridge profitability threshold but above
  the per-chain transfer cost.
- **Phase 2 — consolidate**: hub now holds aggregated dust on every chain;
  runs the standard `collectOneWallet` pass (Relay/LI.FI/Squid swap+bridge)
  to convert everything to ETH on the destination chain.
- **Phase 3 — dispatch**: hub splits the consolidated balance across N
  recipients (90% userShare ÷ N) + dev fee (10%), as N+1 sequential txs.

UI:
- Wizard mode picker: `EVM ULTRA sweep (hub-aggregate → Arbitrum/Base, captures sub-gas dust, 10% dev fee — Sybil link)`
- Mandatory **Sybil warning** before the run with explicit y/N confirm.
  Explains that the hub becomes a common counterparty linking all source
  wallets on-chain — opt-in only.
- Hub-wallet setup step: generate fresh BIP39 or reuse an earlier hub.
  Mnemonic persisted to `data/hub-<timestamp>.txt`.
- Per-wallet completion log so empty-wallet runs don't look hung:
  `[N/total] done — empty (0 balance across all 17 chains)`.
- Zero-balance hint at end of Phase 1: nudges the user toward the
  "Reuse most recent hub" option if everything was empty.

New files:
- `src/flow/evmUltra.ts` — orchestrator (`runEvmUltraMode`).
- `src/wallet/hub.ts` — `generateHub` / `loadHubFromFile` / `listExistingHubs`.
- `src/flow/evmGas.ts` — extracted gas-reserve / OP-Stack L1-fee helpers,
  shared between standard and ULTRA modes.

#### Squid Router integration (Fantom bridge)
Fantom Opera (chainId 250) lost its bridge providers in 2026:

| Provider | Fantom 250 |
|---|---|
| Relay.link | ❌ never supported |
| LI.FI | ❌ dropped (`/fromChain not in allowed values`) |
| Stargate | ❌ pools wound down via DAO vote |
| deBridge | ❌ excluded from their 18-chain set |
| **Squid (Axelar)** | ✅ **NEW** |

Implementation:
- `src/swap/squid.ts` — REST v2 client mirroring the LI.FI / Relay shape.
- `src/swap/bridge.ts` — replaced `LIFI_FORCED_CHAINS: Set` with a generic
  `BRIDGE_ROUTE_BY_SRC_CHAIN: Partial<Record<ChainKey, 'relay' | 'lifi' | 'squid'>>`.
  `opbnb → lifi`, `fantom → squid`, everything else → relay (default).
- `SQUID_INTEGRATOR_ID` env required (apply at https://squidrouter.typeform.com/integrator-id to get yours or use default).
  Without it, Squid's `/v2/route` throws a clean error → caught as a per-token
  skip; rest of the sweep is unaffected.

### Robustness fixes

#### Funder safety
- **Funder addresses excluded from source-wallet list** in both
  `runEvmMode` and `runEvmUltraMode`. Without this, pasting the same key into
  both `funders-evm.txt` and `seeds-evm.txt` would sweep the funder's own
  balance into the hub (observed live: ~$30 drained that way).
- **ERC20 profitability pre-check before funder top-up** in ULTRA Phase 1.
  Previously the funder topped up whenever any ERC20 existed; if that ERC20
  then failed the per-token profit check the unused gas was forwarded to hub
  — net zero for the user, pure loss for the funder. Now: pre-evaluate all
  tokens, skip top-up entirely if no profitable token exists, and refuse to
  forward "funder-gift" residuals.

#### Transaction execution
- **Bridge execute retries** in `trySwapAndBridge` (= ULTRA Phase 2 too).
  Up to 3 attempts on on-chain reverts (`Step "X" failed on-chain` from Relay,
  `deposit reverted` from LI.FI / Squid). Last attempt **re-quotes with
  slippage bumped by `BRIDGE_SLIPPAGE_BUMP_BPS`** (default +200 bps → 3% from
  1%). Only retries error patterns where EVM rollback restored funds; never
  on partially-successful multi-step quotes.
- **INSUFFICIENT_FUNDS retry** in ULTRA Phase 1 native sends. Public-RPC load
  balancers can serve stale `getBalance` reads (observed: BSC node showed
  ~33µBNB at read time, ~1µBNB at submit). On INSUFFICIENT_FUNDS we re-read
  via `rpcRetry` (which can rotate to a different RPC), recompute sendable
  with the fresh balance, retry once. Skips cleanly if the new balance still
  doesn't cover gas.
- **Chain-aware gas limits** for ULTRA Phase 1 transfers. zkSync and Abstract
  (both zkStack forks) need 10-15× more gas for AA-validator-bearing simple
  transfers than vanilla EVM. Defaults: 32k native / 80k ERC20. zkSync &
  Abstract overrides: 500k / 800k. Without this: `Account validation error:
  Failed to check if 'from' is an account. Most likely not enough gas`.
- **Race condition fix in `withConcurrency`**. Both `flow/evm.ts` and
  `flow/evmUltra.ts` had `while (idx < items.length)` followed by `await
  checkPause()` then `const my = idx++`. Multiple workers could pass the
  pre-await bounds check and race the increment, ending up with
  `items[my] === undefined` and "Cannot read properties of undefined" tail
  crashes. Bounds check moved post-increment.

#### RPC & API providers
- **Polygon `getFeeData` plugin crash**. Ethers v6 auto-attaches a
  `PolygonGasStationPlugin` to chainId 137, which calls
  `https://gasstation.polygon.technology/v2` outside our RPC rotation.
  That endpoint is unreliable; when it 5xx'd, every Polygon call crashed
  with `SERVER_ERROR` and our rotator couldn't recover. Fix: construct
  `new Network(name, chainId)` manually and pass it as `staticNetwork`,
  bypassing the auto-plugin chain.
- **Ethereum RPC refresh**: dropped `eth.merkle.io` (returns 400 "batch
  requests are limited to 1 on the free Merkle endpoint" + Cloudflare 403),
  added `eth-mainnet.public.blastapi.io` (fastest tested: ~700ms).
- **BSC RPC refresh**: dropped `bsc.drpc.org` (now requires paid tier:
  "Request timeout on the free tier" / HTTP 408), added
  `bsc-dataseed1.bnbchain.org` as backup.
- **CoinGecko hardening**: in-flight request coalescing (N parallel callers
  for the same coin share one fetch — was the root cause of the 429 spam
  during concurrent sweeps), 90s negative cache on failures, positive TTL
  bumped from 5 min to 30 min.

#### Control flow
- **Cooperative pause for Ctrl+C**. Old handler only printed a warning; the
  async workers kept running at full speed. New design:
  - `src/utils/pause.ts` exposes a shared `requestPause(ms)` / `checkPause()`
    primitive.
  - SIGINT handler flips the flag for 3s.
  - Workers call `await checkPause()` at safe checkpoints (between wallets,
    between chains, between Phase 1/2 boundaries) and freeze there.
  - Second Ctrl+C within the 3s window → exit (code 130).
  - **Stdin listener during pause**: any input on stdin (Enter, any key)
    also exits — handles users who type into the terminal after pressing
    Ctrl+C.
  - **`SIGBREAK` handler** for power-user escape hatch (immediate exit).
  - Documented Windows-cmd quirk in the warning text: cmd.exe's "Terminate
    batch job (Y/N)?" prompt is a separate mechanism and answering Y there
    kills only the `npm.cmd` batch wrapper, not the Node process.

### Performance

- **Parallel quote fetching** in Phase A/B. Old loop quoted serially: 17
  chains × 1-3s/quote = 17-51s of API wall-time per wallet. New design:
  - Refactor `trySwapAndBridge` into `prepareBridge` (parallelizable: quote +
    gas sanity + profit check, no side effects) and `executeBridge` (serial:
    funder top-up + execute-with-retry).
  - `mapWithSemaphore(jobs, BRIDGE_QUOTE_CONCURRENCY, ...)` parallelizes
    **at chain level** with default semaphore=5. Within a chain, tokens stay
    serial — so any individual RPC sees only one in-flight request at a time.
  - Execution stays strictly serial in input-preserved order, so funder
    coordination and Avalanche-before-Base ordering are unaffected.
  - **Result: 30-50s saved per wallet** on 17-chain sweeps.
  - Env override: `BRIDGE_QUOTE_CONCURRENCY=5` (lower to 2 if you ever hit
    aggregator rate limits).

### UX polish

- **Mode names**: "EVM real" → "EVM normal", "Solana real" → "Solana normal".
- **Paste recipients**: previous "Paste recipient addresses" option appended
  silently when a list existed. Split into two distinct menu items:
  `Paste recipient addresses (append)` and `Paste recipient addresses (replace)`.
- **Paste auto-recovery (`expandStuckPaste`)**: some Windows terminals
  (PSReadLine, certain Windows Terminal configurations) deliver a multi-line
  paste as a single newline-stripped chunk. Safety net: if pasted "line" has
  > 24 whitespace-separated BIP39-valid words, greedy-split into back-to-back
  valid mnemonics; if it's a hex run of `N × 64` chars, split into N EVM
  privkeys. Recovers transparently from the most common paste-glue failure.
- **Generated files use `os.EOL`** (CRLF on Windows). Affected:
  `seeds-evm-active.txt`, `generated-recipients-*.txt`, `hub-*.txt`, and any
  wizard-managed file. Eliminates the paste-glue bug at the source —
  LF-only files were the upstream cause.
- **`prompts`-after-`readUntilBlank` stdin state reset**. Previously the
  built-in `readline` reader could see a multi-line paste as one chunk after
  a `prompts()` call because `prompts` left stdin in raw mode. Replaced with
  a direct `stdin.on('data')` reader that explicitly resets raw mode and
  splits on `\r\n|\r|\n`.

### Developer experience

- `SQUID_INTEGRATOR_ID` documented in `.env.example` with the Typeform URL.
- `BRIDGE_EXECUTE_MAX_ATTEMPTS`, `BRIDGE_SLIPPAGE_BUMP_BPS`,
  `BRIDGE_QUOTE_CONCURRENCY`, `MIN_TRANSFER_NET_USD` — new tunables.

### Changes that may affect users

- **Hub wallet files** (`data/hub-*.txt`) — new sensitive file class, added
  to `.gitignore`. Keep backups: losing the file = losing access to whatever
  the hub holds mid-run.
- **Concurrency model** unchanged from user's perspective (`CONCURRENCY`
  still controls parallel wallet processing; new `BRIDGE_QUOTE_CONCURRENCY`
  is the internal quote-fetch semaphore inside each wallet's work).

## v0.1.0 — 2026-05-22

Initial public release.

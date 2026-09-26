# Changelog

All notable changes to MPGR HUB are documented in this file.

The project follows a milestone-based development roadmap.

---

# Unreleased

## MPGR Agent fee — collected inside the MPGR Executor swap (no separate fee transaction)

### Fixed

- The browser swap flow no longer creates a third wallet transaction for the
  0.25% MPGR Agent fee. The Confirm & Swap UI showed "MPGR fee (0.25%) —
  Paid separately after the swap", which produced approve → swap → separate
  fee transfer. The fee is now taken by the **MPGR Executor** from the gross
  sell amount inside the swap transaction:
  `fee = floor(gross * 25 / 10_000)`, `swapAmount = gross - fee`, recipient =
  the executor's configured `feeRecipient()` — never the connected wallet.

### Changed

- `POST /api/trade/quote` routes pairs with a proven executor route
  (Base mainnet USDC <-> WETH, incl. native ETH in/out) through
  `lib/trade/trade-executor-quote.ts`: the proposal's transaction is the
  executor's `swapUniswapV3ExactInputSingle` call, quoted for the post-fee
  amount, and the approval (when the standing allowance is short) is for the
  **gross** amount to the executor. First-time ERC-20 = approve + swap;
  afterwards = swap only. A failed executor quote is an error — never a
  silent fall-back to a fee-less venue.
- The confirmation modal shows a single fee row ("MPGR fee (0.25%) —
  0.005 USDC") and nothing else: no "Paid separately after the swap", no fee
  step, no fee explorer link, no fee-payment error banner.
- Routes without a proven executor route (B20 tokenized stocks via Aerodrome
  Slipstream, other ERC-20s via CDP/0x) are quoted with
  `agentFee.status = "skipped"` and no fee row: a fee is only ever charged
  where the executor can take it inside the swap.
- `lib/trade/trade-execution.ts` refuses to sign an applied fee whose
  transaction does not target the MPGR Executor with exactly
  `expectedFeeAmount == floor(gross * 25 / 10_000)`.

### Removed

- `buildAgentFeeTransfer` / `resolveExecutionAgentFee` and the
  `feeHash` / `feeError` execution-snapshot fields (the separate-transfer
  architecture). `MPGR_AGENT_FEE_RECIPIENT` /
  `NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT` remain, but only for the MCP
  0x-native-fee fallback.

### Unchanged (explicitly)

- `contracts/executor/MPGRExecutor.sol`, its deployed addresses, `feeBps`,
  the router configuration and the swap logic are untouched.
- Approval, quote, slippage, routing, wallet and non-custodial behaviour are
  unchanged apart from where the fee is collected.

## MPGR Executor — B20 tokenized stocks are executor-routed (fee inside the swap)

### Changed

- Every supported USDC <-> B20 tokenized-stock swap (AAPLc, AMZNc, COINc,
  CRCLc, GOOGLc, INTCc, METAc, MSFTc, MSTRc, NVDAc, SNDKc, SPCXc, TSLAc)
  now goes through the **MPGR Executor** with the 25 bps fee taken inside
  that same transaction — `fee = floor(gross * 25 / 10_000)`,
  `swapAmount = gross - fee`, recipient = the executor's configured
  `feeRecipient()`. Max wallet transactions stay at **approve + swap**
  (approve only when the standing allowance is short; swap only when it
  is sufficient). Before this, the fee was a **separate post-swap ERC-20
  transfer** and the swap went straight to the router.
- `lib/executor/executor-config.ts` registers exactly what the deployed
  contract can execute: USDC/WETH on Uniswap V3 (fee 3000) **and**
  USDC <-> each B20 stock on Aerodrome Slipstream, **tickSpacing 10** —
  the same router (`0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F`), pool key
  and tokens the app's executed B20 swap used (tx `0x0f52a3b3…`: 2 USDC ->
  0.00587536 AAPLc). The Slipstream router and all 15 tokens were
  allowlisted at construction; no contract change, no owner transaction,
  no new fee mechanism.
- The tokenized-stock prepare path (`prepareTokenizedStockSwap`) is
  executor-first: if the executor quote for a registered pair fails, the
  trade is refused — it never falls back to the direct (fee-less) router.
- `mpgr_list_tokens` / `mpgr_get_capabilities` / `/llm.txt` describe the
  registered pairs and the in-swap fee; the "B20 are never routed through
  the executor" copy is gone everywhere.

### Fixed (documentation / live state)

- The Base Mainnet record's `routerAllowlist` is a deploy-time snapshot;
  the owner has since executed `setRouter(SwapRouter02, 2)` (tx
  `0x2341ff2234d9a58401fc3c3e0a4e3d26aa56cb62fd574ce48f8c3929dab964d1`,
  block 51792513, 2026-09-25). Docs that claimed "no owner transaction was
  executed / Uniswap V3 is not yet allowlisted" now state the live facts.

### Added

- Regression tests: `lib/trade/__tests__/trade-executor-quote.test.ts`
  (USDC -> AAPLc one-tx Slipstream fee-in-swap; AAPLc -> USDC fee at 8
  decimals; approval-for-gross / swap-only; slippage on the post-fee
  output with the exact `amountOutMinimum` of the real trade; quote
  failure refuses instead of re-routing; WETH <-> B20 stays
  non-executor), `app/api/trade/quote/executor-fee-route.test.ts` (route
  level, buy + sell + allowance-covered + fail-closed), plus the registry
  and MCP suites updated to assert the full live route set.

### Unchanged (explicitly)

- `contracts/executor/MPGRExecutor.sol`, deployed addresses, `feeBps`
  (25), router configuration and swap logic: untouched.
- Non-executor pairs keep their existing providers and exact fees; the
  UI/copy rules (single fee row, no "Paid separately", no fee step) are
  unchanged.

## MPGR Executor — Base Mainnet route migration: Aerodrome Slipstream → official Uniswap V3

### Changed

- The Base Mainnet (8453) executor route for **USDC <-> WETH** (incl. native ETH in/out) now targets the official Base Uniswap V3 deployment instead of the app's Aerodrome Slipstream pool: SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`, QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`, factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, WETH/USDC **0.30% (fee 3000)** pool `0x6c561B446416E1A00E8E93E221854d6eA4171372`. `mpgr_list_tokens`, `mpgr_get_quote` and `/llm.txt` now advertise `uniswap-v3 fee 3000`.
- `lib/executor/uniswap-v3-pool.ts` derives the pool with CREATE2 (`keccak256(0xff ++ factory ++ keccak256(token0, token1, fee) ++ POOL_INIT_CODE_HASH)`) so the registered pool is proven against the factory instead of being copy-pasted. The derivation is cross-checked in the tests against the well-known Base WETH/USDC 0.05% pool.

### Added

- `lib/executor/__tests__/uniswap-v3-mainnet-route.test.ts` (offline): V3/3000 route selection in both directions, CREATE2 pool verification, byte-exact QuoterV2 quote calldata, exact 25 bps fee math incl. the `FEE_ROUNDS_TO_ZERO` refusal, byte-exact `swapUniswapV3ExactInputSingle` calldata, exact-amount approval (never unlimited), the registered USDC <-> B20 Slipstream routes, and the unchanged fallback of pairs with no registered route to the 0x path.
- `script/prepare-uniswap-v3-allowlist.mjs`: prepare-only owner tooling. It re-checks the committed deployment record, re-derives the pool, optionally verifies (read-only `eth_call`) that the router is bound to the official factory and which `routerKind` the live executor currently reports, and prints the unsigned `setRouter(SwapRouter02, 2)` transaction plus the `cast` commands to send and verify it. It never reads, accepts or uses a private key, never signs and never broadcasts.

### Unchanged (explicitly)

- `contracts/executor/MPGRExecutor.sol` is untouched — no redeploy; executor `0xD982726e28275661F8aB64054E6b17a70a63505A`, owner, fee recipient and the 15-token allowlist are unchanged.
- The **exact 25 bps** sell-token fee (`floor(sellAmount * 25 / 10_000)`, collected inside the same transaction) is unchanged.
- The non-custodial flow is unchanged: exact-amount `approve(executor, gross)`, EIP-2612 and Permit2 signing by the user's wallet, recipient == taker, single-hop `exactInputSingle`.
- Fallback routes are unchanged: every non-proven pair (incl. B20 tokenized stocks) still goes through the 0x native-fee path, and the app UI keeps its CDP/B20 Slipstream flows.

### Notes

- **No owner transaction was executed.** The deployed executor still has the Aerodrome Slipstream router allowlisted (kind 1); the Uniswap V3 router is **not** allowlisted on chain yet, so the new registry route is inert until the owner sends `setRouter(0x2626664c…e481, 2)`. Mainnet MCP trading stays OFF regardless until `MPGR_MCP_ENABLE_BASE_MAINNET=true` is set.
- Wording correction: the old Slipstream route's evidence was **fork/simulation** (CI Base-mainnet fork suite plus the smoke script, whose `rehearsal` mode runs on a local anvil fork and broadcasts nothing). No confirmed live mainnet trade through the executor was ever recorded, so it is no longer described as a live 71/71 mainnet smoke test.

## MPGR MCP — Base Mainnet go-live preparation

### Added

- Registered the deployed Base Mainnet MPGR Executor (`0xD982726e28275661F8aB64054E6b17a70a63505A`, deploy tx `0xf17fcaef…99d01`, block 51767139) in `lib/executor/executor-config.ts` — a deployed fact mirrored field-for-field from `deployments/base-mainnet/mpgr-executor.json` (enforced by `lib/executor/__tests__/executor-registry.test.ts`). Only the proven **USDC <-> WETH** route is registered; the contract's B20 tokenized-stock allowlist is deliberately excluded because no USDC<->B20 swap through the executor has ever been executed. That route was the Aerodrome Slipstream pool (tickSpacing 50, pool `0x3FE04A59…392A`) at the time — superseded below by the official Base Uniswap V3 0.30% pool.
- MCP Base mainnet provider dispatch: with `MPGR_MCP_ENABLE_BASE_MAINNET=true`, proven executor pairs (USDC <-> WETH, incl. native ETH in/out) quote through the executor (live on-chain fee, quoter, HMAC quoteId, exact-amount APPROVAL / EIP-2612 / Permit2, one atomic tx with the exact 25 bps sell-token fee); every other ERC-20 pair falls back to the existing 0x native-fee path (unchanged, exact-fee-verified). USDC <-> B20 tokenized-stock pairs quote through the executor on its Aerodrome Slipstream route (tickSpacing 10) with the fee inside the swap (see the B20 section below).
- `mpgr_get_capabilities` / `mpgr_list_tokens` now report the deployed mainnet executor, the operator trading state (`tradingEnabled`), the proven mainnet pair and the dispatch rules. `/llm.txt` and `/llms.txt` advertise the deployed mainnet executor, its route and the operator gate (no stale "not deployed" claims; still built only from committed public config).

### Fixed

- `script/e2e-preview-mcp.mjs` mainnet assertions updated for the new reality: the 8453 registry entry is a deployed fact while MCP trading stays off (`BASE_MAINNET_DISABLED` until the flag is set).

### Notes

- Trading stays OFF: the flag is not set by this change. Enabling requires the operator to set `MPGR_MCP_ENABLE_BASE_MAINNET=true` (plus `ZERO_EX_API_KEY` + `MPGR_AGENT_FEE_RECIPIENT` for the 0x fallback) in Vercel Production and redeploy — see the environment table in `docs/EXECUTOR.md`.
- Base Sepolia behavior is unchanged (Sepolia regression suite green); the app UI and the 0x client are untouched.

## Task 8 — referral abuse hardening

### Fixed

- Referral rewards (the +100 XP `REFERRAL_SUCCESS` ledger grant — the largest single award in the system) were paid to the referrer **instantly on attribution**, uncapped. Rate limits key on the request sender — the *referred* wallet — so a sybil farm of throwaway wallets arriving through one `?ref=` link minted unlimited XP for one referrer with zero genuine activity. Now the reward is stored as a durable pending record at registration and settles only when the referred wallet earns a genuine server-awarded activity event (daily check-in), the referrer already exists in the server XP ledger, and the per-referrer daily reward cap (`REFERRAL_REWARDS_PER_REFERRER_PER_DAY`, default 5, fail-closed) has room. Cap check + claim are atomic in one Lua script; the permanent ledger event key keeps every replay/race at-most-once.
- Self-referral, attribution-steal attempts and cap saturations are now logged (`referral.abuse.*` / `referral.reward.daily-cap`) and counted per wallet/day in `mpgrhub:referral:abuse:{wallet}:{day}` for operator review.
- Attribution itself is unchanged: permanent, first-write-wins, referred identity always taken from the authenticated session (never the request body), all existing `mpgrhub:referral:referredby:*` / `referrals:*` keys and values keep their format, and referral counts stay capped to real attributed wallets. No migration needed; records written by the old immediate-pay path are never re-paid (same ledger event id) and never invalidated.
- Regression tests: `lib/referral/referral-store.test.ts` (real Lua via the fengari Redis double: idempotency, atomic caps, concurrent claims, corrupt records, Redis-failure paths, legacy data), `app/api/referral/route.security.test.ts` (real route + session + origin + guard: farming window, cap, replays, multi-session, steal, tampering, fail-closed), `app/api/referral/route.ratelimit.test.ts` (real dual-bucket limiter on the endpoint).

## Task 4 — next.config.mjs hardening

### Fixed

- `images.remotePatterns` no longer allows `hostname: "**"`. The always-on `/_next/image` route would fetch and re-serve any https URL a caller named (open image proxy / quota abuse). The repo has no `next/image` usage — first-party or in bundled dependencies — and every image is a local `/public` file rendered with `<img>`, so the allowlist is now explicitly empty. Local images through `/_next/image` keep working.
- Framing policy (owner-approved 2026-09-20): page and static routes now send `Content-Security-Policy: frame-ancestors 'self' https://farcaster.xyz` instead of `X-Frame-Options: DENY`. The Farcaster **web** client loads Mini Apps in an iframe, which `DENY` refused (mobile clients use a WebView and were unaffected). `/api/*` keeps `X-Frame-Options: DENY` and additionally sends `frame-ancestors 'none'`. The CSP contains only the framing directive. Allowlist lives in `FRAME_ANCESTORS` in `next.config.mjs`.
- Regression tests: `lib/__tests__/next-config.test.ts` (runs Next's real config loader, image-optimizer validation and header-route compiler).

---

# Version 0.6.1

## Remaining August 2026 audit closeout

### Fixed

- XP ledger Lua uses `redis.call` with event TTLs and an atomic daily game-XP cap.
- `useXP` displays server-ledger totals; local storage is a cache.
- Trade price keeps its original `{ from, to, slippageBps, price, provider, network }` body and binds taker to the session. Tokenized-stock quotes do the same.
- MPGR Run records live heartbeats and rejects uncovered durations; physics helpers are shared.
- Foundry remappings match CI `.forge-deps` clones. CI uses `npm ci`, a 4 GB heap, and Foundry `stable`.
- README no longer claims Docker, pnpm, BullMQ, Prometheus, or production-ready financial rewards.

### Still open (honest)

- Independent contract audit, real replay anti-cheat, referral sybil, vault settlement idempotency, full 204MB art conversion, `RunGame.tsx` split.

---

# Version 0.6.0

## Tokenized-stock execution

### Changed

- Coinbase B20 buy/sell now routes through Aerodrome Slipstream USDC pools (Gauges V3 factory / QuoterV2 / SwapRouter). Coinbase CDP Trade API and 0x Swap API legally reject these tokens and are not used as a fallback.
- Regular ERC-20 swaps (ETH, USDC, MPGR, …) are unchanged: CDP Trade API, then 0x AllowanceHolder.
- Tokenized-stock research probes Aerodrome directly and no longer requires CDP credentials.
- ETH/WETH ↔ B20 is rejected with a convert-to-USDC-first message (no direct pool in v1).

---

# Version 0.1.0

## Foundation

### Completed

- Project initialization
- Next.js architecture
- TypeScript setup
- Tailwind CSS integration
- Wallet connection
- RainbowKit integration
- Wagmi integration
- Base network support

---

# Version 0.2.0

## Gamification

### Added

- Daily Check-In
- XP System
- Levels
- Achievements
- Lucky Spin
- Mini Games
- Memory Challenge
- Tap Challenge
- Leaderboards
- Season Points

---

# Version 0.3.0

## Dashboard

### Added

- Premium Dashboard
- Wallet Overview
- Profile
- Statistics
- Responsive UI
- Performance improvements

---

# Version 0.4.0

## Reward System

### Added

- Reward Center
- Weekly Rewards
- Reward History
- Reward Analytics
- Claim Center

---

# Version 0.5.0

## Token Utility

### Added

- Staking UI
- Token Lock UI
- Treasury foundation
- Holder tiers
- Premium framework

---

# Version 0.6.0

## AI Foundation

### Added

- AI architecture
- Event Bus
- Task Queue
- Logger
- Performance Monitor
- Background Sync
- Refresh Manager
- Service Layer

---

# Version 0.7.0

## Phase 3E

### Part 1

Completed

- MPGR Token Integration
- B20 Foundation
- Contract Client
- Balance Reads
- Token Metadata
- Transaction Utilities

### Part 2

Completed

- Portfolio Engine
- Live Portfolio
- Wallet Balances
- Holdings
- Portfolio Sync
- Event Listeners
- Mock Removal

### Part 3

In Progress

- Live Staking
- Live Rewards

### Part 4

Planned

- Token Lock
- Premium Integration

### Part 5

Planned

- On-Chain Intelligence
- Analytics
- Activity Feed

### Part 6

Planned

- Production Audit
- Security Review
- Performance Optimization
- Final Production Release

---

# Future

- Governance
- AI Expansion
- Mobile Support
- DAO
- Advanced Analytics
- Cross-Chain Features
- Developer SDK

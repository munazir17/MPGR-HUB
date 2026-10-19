# PR #113 — Swap Phase A: qualification and registered-route admission

Date: 2026-10-18. Starting PR head: `b23ad2c577a1a9dae68a8b1c3562dd8b6dafd483`.
Scope: code-only assisted Swap. No additional executable registration, signing, broadcast, wallet creation, permission/contract change, production setting, Agent change or merge.

## Read-only qualification result — no new live execution claim

The fresh public-RPC attempts to `https://mainnet.base.org` and `https://base-rpc.publicnode.com` failed from this sandbox. No reachable configured RPC was supplied. Consequently **no current block-pinned mapping, amount-specific pool quote, Executor simulation or new settlement was verified**. A missing read is **unknown**, not denied or illiquid.

Machine-readable result: [`evidence/pr113-swap-phase-a/route-qualification.json`](evidence/pr113-swap-phase-a/route-qualification.json). The read-only CLI exited **2 (incomplete evidence)**, not success. It inventories:

- 50 exact ERC-20 identities: existing 15 registered tokens plus 35 unregistered catalog assets. Native ETH is an alias, not an ERC-20 permission target.
- All 14 existing pool registrations, BOTH directions, two gross sizes each; plus native ETH alias cases: **60 direction/amount rows**. WETH/ETH gross sizes are 0.001 and 0.01; other sell tokens 0.1 and 1 in registered decimals. These are requested audit sizes, **not successful quotes**.
- 35 historical candidate-pool annotations from the preceding audit, each expressly unverified this run. No annotation is consumed by the runtime executable registry.
- **0 complete current execution-evidence cases.** All current permissions remain unknown in this run. Historical receipts, explorer displays and DEX listings are not substituted for current RPC evidence.

Registered coverage stays USDC↔WETH/native ETH and USDC↔the existing 13 registered B20 contracts. COINc/CRCLc/INTCc remain excluded from catalog discovery under the existing lifecycle rules. Nothing newly establishes these pairs as live executable. All **35 unregistered assets, including MPGR, remain blocked**. The preceding discovery inventory includes 28 stock/USDC and six wrapped-asset candidate pools; MPGR's discovered market is native-ETH/V4. None is promoted here.

### Reproduce without signing

Using repository Node 20 and locked dependencies:

```sh
NODE_OPTIONS=--conditions=react-server npx --yes tsx@4.20.6 scripts/audit-swap-routes.ts --out /tmp/swap-route-audit.json
```

The process-local Node resolver condition permits the existing `server-only` marker for this CLI; it is not an application/production setting. `tsx` is an isolated runner, not a new dependency or lockfile change. Optional `--candidates /path/to/discovery.json` attaches data-only annotations (`asset`, `token`, `pool`, `routeEvidence`, `source`). Optional `--taker <public Base address>` attempts `eth_call` of the exact existing Executor swap at the audit block using that public address's **actual** state. No account/key is created, no wallet/signing client is constructed, no allowance/state override is used, and no transaction is sent. Omitting it explicitly leaves Executor calls unrun. A successful call still does not supply receipt or fee-recipient transfer evidence, so `executionEvidenceComplete` and `liveSettlementVerified` remain false. Exit 2 means the evidence is incomplete; output must not be advertised as live acceptance.

## Implementation

### Registered route selection and pinned admission

`lib/swap/swap-route-selection.ts` selects only an exact existing registration from `BASE_MAINNET_EXECUTOR_DEPLOYMENT`. It cannot accept routes from imports, discovery JSON, UI or models. There is currently **one registered route per pair**: selection is deterministic, not a claim of comparative “best price.” Multiple registrations fail closed until explicit comparison plus matching calldata/policy support is reviewed. No multihop/provider/V4/typed-module fallback is introduced.

For each Swap quote, including cache hits, the Swap-only endpoint:

1. Preserves origin, authenticated wallet/session, rate, request, chain and mandatory-fee guards.
2. Pins a fresh numeric Base block and observes its hash. All route admission and proposal-builder reads/quotes share this block.
3. Requires both token permissions, exact router kind, approved owner, unpaused state, exactly 25bps and the unchanged approved fee recipient.
4. Checks both registered decimals; resolves the precise pool from the canonical venue factory; verifies pool factory, token identities, fee tier/tick spacing and nonempty Executor/router/quoter/factory/pool code. A positive quote is still required from the real builder for net input after the fee. Slipstream fee is not inferred from tick spacing.
5. Injects only a block-pinned read-only `ChainReader` into the unchanged existing builder. Shared Agent/default readers and registries are untouched. The existing metadata resolver may perform additional current reads; its resulting decimals must also match the registration/pinned checks.
6. Keys the strict cache by height AND hash, as well as wallet, exact assets, atomic amount, decimals and slippage. Re-checks the pinned hash/freshness after slow quote/impact reads; revalidates quote expiry without extending it.
7. Retains independent transaction/minimum/25bps policy validation. Unknown/mismatched evidence stops with sanitized, actionable errors. Pool identity admission is not an Executor execution/settlement certification.

The bounds are one existing registered single-hop route, a 30-second block-snapshot age and existing 30-second quote expiry; up to 15 seconds future timestamp tolerance. No arbitrary discovered pool, caller-selected destination or broadcaster is introduced. More admission reads can increase RPC load; production RPC latency/rate limits have not been measured here. On provider outage/rate limits, admission fails closed rather than silently dropping checks.

### Import/capability status

The existing flow remains `TokenSelector → importBaseToken → /api/trade/token → resolveSwapToken`. There is no invented “More Tokens” contract method. The metadata endpoint and shared Agent behavior are unchanged.

- Registered pair: **“Registered route — fresh quote and live permission checks required.”** Selection is possible, but is not a readiness/settlement claim.
- Validated unregistered import: **“Metadata validated — not executable: route registration and Executor permission verification required. Pool discovery is not execution support.”** Disabled.
- Other unregistered catalog entry: **“Discovery only — not executable…”** Disabled; metadata/permission/liquidity is not guessed.
- Registered asset with the wrong counterasset: lists actual registered counterassets and asks the user to change the other asset explicitly. Pay never silently reverses.
- Same underlying ETH/WETH: disabled before quoting. Unknown imports retain neutral artwork and cannot inherit symbol-based capability.

## Fee-recipient / owner-change race: residual on-chain limit

The approved recipient remains `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`. The strict Swap requires `floor(grossSellAtomic × 25 / 10000)`, quoted net input, exact minimum and current 25bps configuration; no separate/post-swap fee transaction exists.

Verified source: `contracts/executor/MPGRExecutor.sol`, especially `SwapParams`, `_begin`, `_finish`, `_validate`, `setFeeBps`, `setFeeRecipient`, `setTokenAllowed`, `setRouter`. External source/ABI: https://basescan.org/address/0xD982726e28275661F8aB64054E6b17a70a63505A#code .

- `expectedFeeAmount` commits to an integer fee amount, **not to an expected fee recipient, exact feeBps or owner**. The recipient and fee are owner-configurable; neither is immutable.
- Owner/recipient/fee/pause/permission checks at quote admission, current fee checks before wallet prompts, gas estimation and receipt verification reduce stale-state risk but cannot stop an authorized owner changing configuration **after the final check/signature and before execution**.
- Even a feeBps change can sometimes preserve the rounded expectedFeeAmount (e.g. gross 400 atomic units yields fee 1 at both 25 and 26bps). `FeeMismatch` alone therefore does not bind exactly 25bps.
- Receipt verification remains authoritative and rejects inconsistent fee recipient/bps/event evidence. It detects a discrepancy; it **cannot undo a transaction that already settled**. No quote, successful `eth_call` or computed fee is labeled a collected fee.
- Exact input-receipt checks reject mismatching sell transfers, but arbitrary token behavior and exact fee-recipient delivery still need per-token compatibility/transfer evidence. A listing or nonempty bytecode is not sufficient.

**This race cannot be fully fixed by code-only checks against this ABI.** An on-chain expected-recipient/exact-bps guard (or an independently audited guard adapter that reverts the whole call) would require separately approved contract work. No guard, replacement Executor, V4 adapter, fee/owner/recipient change or new permission is deployed/proposed as implicitly authorized by Phase A. No complete immutable-fee/recipient guarantee is claimed.

## Remaining authorization and proof gates

- Refresh mapping/owner/fee/pool reads on a reachable trusted Base RPC; confirm the block and hash. Re-run actual sizes in both directions.
- Prove candidate pool type and canonical factory/pool key, exact metadata, transfer compatibility and fee delivery. Prepare no permission action solely from a DEX listing.
- Missing permission requires separate explicit owner authorization; no on-chain pair setter exists in this assisted ABI. Register a new application route only after permission and compatibility evidence is reviewed, in a Swap-only scope.
- MPGR: no compatible direct USDC route has been verified. The discovered V4 pool ID cannot be passed to the current V3/Slipstream `exactInputSingle` ABI. Keep it blocked; either prove a compatible direct pool or separately review an adapter architecture.
- Do not broaden shared `lib/executor/executor-config.ts`: Agent also consumes it. No Agent provider/runtime/API/wallet change is part of this implementation.

## Verification and rollback

Tests and actual final command results are recorded below after execution. Offline/mocked boundary tests are **not** physical-wallet, current-liquidity, transaction or settlement acceptance.

Rollback is application-only: revert this Phase A commit on the tracked PR branch after review. No migration, contract/permission rollback, production flag, wallet or fee-recipient action is needed. Existing quote/confirmation/approval/settlement safeguards must not be removed to work around missing evidence.

### Actual checks

- Repository checks re-run sequentially on **Node 20.20.2** after correcting typing in the new tests: `npm run lint` **0 errors / 61 warnings**, `npm run typecheck` **pass**, `npx vitest run --maxWorkers=1` **4,006 passed / 24 skipped** (299 passing / 5 skipped files). Existing Agent/autonomy tests were run unchanged. The skipped live/fork/opt-in cases were not silently enabled or counted as passes.
- `npm run build` **pass** with an isolated, process-local `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` fixture serving a real Inter WOFF2 from an external temporary font server. TypeScript, route generation and all 34 static pages completed. `npm run typecheck` **passed again after generated build types**. This verifies an optimized build, not external Google-font availability; a normal unmocked font-network build was not repeated in this Phase A. No application font/config/package/lockfile changed. The existing optional bigint native-binding warning used its JS fallback.
- Initial complete Playwright run: **108 passed** across Swap, native-ETH UI and desktop files under the default Node 22 harness. Viewports are 360×800, 390×844 and explicit 1280×900 desktop. Actual production Swap components/controllers were used with mocked HTTP/EIP-1193/RPC fixtures, isolated Chromium 138 and bundled Linux libraries. This is not a physical wallet or live-chain test. Final **Node 20** reruns also passed: **90 Swap/desktop + 18 native-ETH = 108 cases**, sequentially, across `swap.spec.ts`, `swap-desktop.spec.ts` and `swap-native-ui.spec.ts`. The pre-existing Vite CommonJS configuration warning was not suppressed or changed.
- Read-only audit CLI executed twice: **exit 2**, null block identity, 50 unknown token permissions, 35 unregistered assets/annotations, 60 unavailable amount-direction cases, zero complete execution evidence. This is a **blocked verification result**, not a green live test.
- Focused pre-final implementation run: **317 tests / 12 files passed**; the final full 4,006-test result includes the subsequent reorg, slow-read and ambiguity tests. The empty-code API fixture now rejects earlier with `422 / POOL_UNVERIFIED` rather than reaching metadata parsing; it still asserts no pool quote was attempted.
- Incremental unrelated-diff review is against the starting PR head above, **not** a claim that the entire historical PR is Swap-only. No changes in Agent APIs/components, `lib/autonomy`, `lib/architecture`, shared `lib/trade` / `lib/executor`, contracts, deployments, dependencies, production/environment configuration or secrets. `git diff --check` passed. No new HTTP endpoint, request field, application environment variable or credential is introduced; current quote output remains the same, with explicit rejection reasons for failed admission.

### Exact incremental file scope (12)

```text
app/api/swap/quote/route.ts
app/api/swap/quote/route.test.ts
components/features/swap/TokenSelector.tsx
lib/swap/swap-capability.ts
lib/swap/__tests__/swap-capability.test.ts
lib/swap/swap-route-selection.ts
lib/swap/__tests__/swap-route-selection.test.ts
scripts/audit-swap-routes.ts
scripts/audit-swap-routes.test.ts
tests/mobile/swap.spec.ts
docs/PR113-SWAP-PHASE-A.md
docs/evidence/pr113-swap-phase-a/route-qualification.json
```

Keep PR #113 **OPEN / UNMERGED**. A commit/push of these application-only changes is not a deployment or an owner permission approval.

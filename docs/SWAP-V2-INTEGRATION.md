# MPGR Swap V2 — Execution Surface Integration

**Status: implemented and unit-tested. V2 routing is DORMANT.**

```
V2_ROUTING_STATUS:              OFF   (lib/swap/v2/discovery.ts: `export const V2_DEPLOYMENT = null;`)
LIVE_TRANSACTIONS_BROADCAST:    NO
CONTRACTS_DEPLOYED_OR_CHANGED:  NO
V1_MODIFIED:                    NO
ACTIVATION_APPROVED:            NO
```

Nothing in this document is a claim that universal trading works. Read
[Evidence tiers](#evidence-tiers-what-is-actually-proven) before believing any part of it.

---

## 1. What this adds

Before this change the V2 surface could *discover* and *preview* a quote but could not
produce anything a wallet could sign. `/api/swap/v2/quote` returned
`executable: false, transaction: null` unconditionally, and no module validated the
deployed executor's live posture, encoded a conforming call, or verified settlement.

This adds the missing execution half — still gated off:

| Module | Responsibility |
| --- | --- |
| `lib/swap/v2/posture-abi.ts` | Hand-written ABI for governance surface absent from the generated artifact: `paused`, `pendingFeeBps`, `pendingFeeRecipient`, `pendingEffectiveAt`, `FEE_TIMELOCK_SECONDS`, `PINNED_FEE_RECIPIENT`, `GOVERNANCE_SAFE`, `V4_POOL_MANAGER`, and the `SwapPathExecuted` event. |
| `lib/swap/v2/deployment.ts` | Typed copy of the sealed manifest, `swapV2Executor()` — **the single activation gate** — plus `swapV2DeploymentShapeError()` structural validation. |
| `lib/swap/v2/preflight.ts` | Read-only live posture and venue-registration verification. Fails **closed**. |
| `lib/swap/v2/intent.ts` | Independent re-derivation and validation of the exact calldata a wallet would sign. |
| `lib/swap/v2/transaction.ts` | (modified) `intentId` threaded into `SwapParams`. |
| `lib/swap/v2/execution.ts` | `prepareV2Execution()` — posture → venues → intent id → build → simulate → inspect. |
| `lib/swap/v2/settlement.ts` | Receipt decoding and post-trade economic verification against the committed intent. |
| `app/api/swap/v2/quote/route.ts` | (modified) activation branch; dormant response is byte-identical to before. |

`lib/swap/v2/abi.ts` is a generated artifact and was **not** hand-edited. Additions live in
`posture-abi.ts` and are pinned against the deployed source by `abi-parity.test.ts`.

## 2. The executor being wired

Sealed manifest: `deployments/base-mainnet/mpgr-swap-executor-v2.json`.

| Field | Value |
| --- | --- |
| Executor | `0x4be1154440b26145d76608D41d403a33e76b9d0A` |
| Chain | Base Mainnet (8453) |
| Owner | Safe `0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B` |
| Fee recipient | `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4` |
| Fee | 25 bps (cap 100, timelock 172800 s) |
| Deploy block / tx | 52820895 / `0xb8682c02…` |
| Runtime code hash | `0x53896cc37145121436fb4372c6814deb98345261b8ea6e0a6343234dd55e3e39` (21963 bytes) |
| Enabled venues | slipstream (1), uniswapV3 (2), uniswapV2 (3), aerodromeClassic (4), uniswapV4 (7) |
| Disabled venues | `pancakeV3`, `zerox` — no passing fork proof; must stay off |

**No new executor was deployed. The deployment gate was not consumed or recreated.**
Identity is taken from the committed manifest, cross-checked against
`deployments/base-mainnet/deploy-v2-config.json` by `deployment.test.ts`, and re-verified
**live at every request** by `preflight.ts` before any transaction is built.

### Live-chain verification from this environment: UNVERIFIED

The sandbox cannot reach `mainnet.base.org`, `api.basescan.org` or any Base RPC (TLS
handshake fails; egress is allowlisted to GitHub/npm/PyPI). Foundry could not be installed
either. Therefore the following were **not** independently confirmed here and must be
re-checked before activation:

- runtime bytecode hash and size at the executor address;
- on-chain `owner`, `feeBps`, `feeRecipient`, `paused`, `routerKind`, `routerFactory`;
- BaseScan verification status (a "Prepare BaseScan input" workflow succeeding is **not**
  proof that verification succeeded).

`preflight.ts` performs all of these checks at request time, so activation does not depend
on trusting this document — but a human should confirm them once against a real RPC.

## 3. The activation gate

There is exactly one choke point:

```ts
// lib/swap/v2/deployment.ts
export function swapV2Executor(): SwapV2ExecutorDeployment | null {
  const active = testDeployment !== undefined ? testDeployment : (V2_DEPLOYMENT as SwapV2ExecutorDeployment | null);
  return active ?? null;
}
```

`V2_DEPLOYMENT` is `null`, so `swapV2Executor()` returns `null` and the quote route takes the
dormant branch. `__setSwapV2ExecutorForTests` is guarded by `NODE_ENV !== "test"` and is how
the activated path is exercised without activating production.

The dormant response is unchanged, key for key, and asserts no executor-facing RPC happens:

```json
{ "quote": {…}, "blockNumber": "…", "blockHash": "…",
  "preview": true, "executable": false,
  "executionSimulation": "not-run-unreleased", "transaction": null }
```

## 4. What the activated path enforces

`prepareV2Execution()` runs these in order and **throws before returning anything signable**:

1. `validateV2Quote` — single 25 bps fee on **gross**, legs allocate exactly `net`,
   ≤4 legs, ≤3 pools per leg, typed pool shape, hop tokens contiguous and unique.
2. `verifyV2Posture` — chain id 8453; runtime code present at the pinned block; not paused;
   fee cap 100; timelock 172800; governed fee == 25; live `feeRecipient` == pinned treasury;
   owner == governance Safe; v4 PoolManager pin canonical. A governance fee change whose
   timelock has **already elapsed** at the pinned block fails closed (`PENDING_FEE_CHANGE`);
   one still inside its timelock is surfaced but does not block the quote.
3. `verifyV2Venues` — every enabled venue still registered on-chain with the expected
   adapter kind and factory binding. A de-registered venue is `VENUE_NOT_REGISTERED`, because
   the executor would revert `RouterNotAllowed`.
4. `v2IntentId` — deterministic id binding chain, executor, taker, pair, gross, quoted output,
   slippage, pinned block number **and** hash, and every leg's pool address.
5. `buildV2Transaction` — `swapExactInput` for one path, `swapExactInputSplit` for 2–4.
6. `eth_call` the deployed executor **as the real taker at the pinned block**; the simulated
   output must satisfy both the committed minimum and the quoted output.
7. `inspectV2SwapTransaction` — independent re-derivation of the calldata, mirroring the
   contract's own `_validatePath`/`_begin` rules (router allowlist per kind, v4 PoolKey
   ordering and currency match, native-in requires `tokenIn == WETH` and `msg.value ==
   grossAmountIn` with `APPROVAL` auth, unwrap requires WETH out, split legs sum to net).

A provider failure is `ROUTE_VERIFICATION_UNAVAILABLE` (503, retryable) and is never reported
as "no liquidity" or "unsupported token". No pool is still `LIQUIDITY_UNAVAILABLE` with no
transaction. Nothing is fabricated or silently substituted.

### Failure attribution

| Condition | Code | HTTP |
| --- | --- | --- |
| Paused executor | `EXECUTOR_PAUSED` | 503 |
| Fee/cap/timelock drift | `FEE_POLICY_INVALID` | 422 |
| Redirected fee recipient | `FEE_RECIPIENT_CHANGED` | 422 |
| Owner not the Safe | `OWNER_CHANGED` | 422 |
| Fee change past timelock | `PENDING_FEE_CHANGE` | 422 |
| Venue de-registered / bad v4 pin | `VENUE_NOT_REGISTERED` | 422 |
| Wrong chain | `UNSUPPORTED_NETWORK` | 503 |
| No runtime code | `EXECUTOR_NOT_DEPLOYED` | 503 |
| RPC/index failure | `ROUTE_VERIFICATION_UNAVAILABLE` | 503 |
| Simulation misses minimum | `EXECUTION_UNAVAILABLE` | 503 |
| Malformed provider block hash | `PROVIDER_ERROR` | 503 |
| Pinned block moved | `QUOTE_CHANGED` | 409 |

## 5. Evidence tiers: what is actually proven

**Tier 1 — unit-simulated (this change).** 116 tests across 9 files exercise the whole
activated path against *fabricated* read-only readers: arbitrary imported pairs, split routes,
genuine three-hop routes through non-major intermediates, v4 PoolKey routes, native-ETH sells,
deterministic intent ids, fee arithmetic, and every fail-closed drift case above.
`app/api/swap/v2/quote/route.activation.test.ts` proves the HTTP boundary in both states.
These are **not** fork tests and **not** live tests. No RPC was contacted.

**Tier 2 — fork-tested (pre-existing, contract-level).** GitHub Actions
`swap-v2-fork-proof.yml` runs `test/swap-fork/MPGRSwapExecutorV2BaseFork.t.sol` against a real
Base fork. Last known green: run `39261269154`, 13 passed / 0 failed / 0 skipped at fork block
52813757. That proves **contract** behaviour. It does not execute the TypeScript in this
change, so it is not evidence that the app-side encoding matches the deployed contract at a
current block.

> **This branch has NOT produced a fork proof — three attempts, all failed identically.**
> Runs `39396256493` (`3660dbf`), `39397504180` (`436a078`) and `39398352775` (`7330bdc`) all
> failed at the "Discover MPGR pool key from real Initialize event" step, so the forge suite was
> **skipped** every time and no fork evidence exists for this change. The script failed closed
> and claimed nothing:
>
> ```text
> MPGR code prefix: 0xef
> MPGR v4 hint count: 0
> ::error::V2 real-pool discovery failed: MPGR/ETH or MPGR/WETH real v4 Initialize event not
> found; no proof claimed
> ```
>
> **This is reproducible, not a flake** — the same step, the same `hint count: 0`, the same error
> text, on three consecutive commits spanning ~1.5 hours. Diagnosis: the cause is a
> **third-party hint API**, not this change.
> - `MPGR code prefix: 0xef` printed every time, so the Base RPC was healthy (`eth_chainId`,
>   `eth_getCode`, `eth_blockNumber` all succeeded).
> - `hint count: 0` means `api.dexscreener.com/token-pairs/v1/base/<mpgr>` returned an array
>   (otherwise the script throws "Pool discovery hints unavailable") containing **no** entry with
>   `dexId === "uniswap"` and a 64-hex `pairAddress`. Discovery therefore never reached
>   `eth_getLogs` or forge. The exact API response could not be inspected from the dev sandbox
>   (that host is not reachable there), so its precise shape is **UNVERIFIED**.
> - This change touches only `lib/swap/v2/**`, `app/api/swap/v2/**` and `docs/**` — never
>   `scripts/swap-deploy-v2/**`, `contracts/**` or `test/swap-fork/**`.
>
> **Bounded regression window.** The last green runs were PR #123 (branch
> `arena/5e28bc30-mpgr-hub`), runs `39302375665`/`39302603928`/`39303607931`/`39304185332`,
> 2026-10-19T18:25–18:38Z. Each logged `hint count: 1`, independently verified the real on-chain
> Initialize event, and reported `Suite result: ok. 13 passed; 0 failed; 0 skipped`:
>
> ```text
> poolId        0xfc151dc0278bc0b2e2ad5404e14f8e3a43e77f176537c29e25f179262ad1cc44
> currency0     0x0000000000000000000000000000000000000000 (native)
> currency1     0xb2000000000000000000008d204203177a78af01 (MPGR)
> fee 0   tickSpacing 200   hooks 0x985c14baa2a18316ffda0aefb3a632fadfca2acc
> initializeBlock 48631199   initializeTx 0x4403d04d2136576c65c60581c8bdf34b592bf00d7ea2564f2c78c5e35d2f7abc
> ```
>
> That matches `docs/SWAP-EXECUTOR-V2-STATUS.md` exactly, so the MPGR v4 pool facts are
> corroborated by Actions evidence — but at 2026-10-19T18:38Z, **not** against this branch.
> The hint source therefore degraded somewhere between 2026-10-19T18:38Z and 2026-10-20T08:50Z.
>
> **Do not loop on re-pushes.** Note that `paths:` filtering on a `pull_request` event is
> evaluated against the PR's **cumulative** diff versus base, not the last commit — so even a
> docs-only push re-runs this workflow, which is exactly how run `39398352775` happened. Every
> further push to this PR will produce the same failure until the external hint source recovers
> or the discovery step gains an on-chain fallback; do not push again merely to retry the proof.
> Re-triggering by other means is blocked here: `gh run rerun --failed` was refused ("cannot be
> rerun") and `workflow_dispatch` returned HTTP 403 (`Resource not accessible by integration` — the
> token lacks `actions: write`). A maintainer with sufficient permissions can dispatch it
> manually, or set/verify `secrets.BASE_MAINNET_RPC_URL`.
>
> **The discovery script was deliberately NOT modified to force a pass.** Making the fork proof
> green by hardcoding the known pool id or block would manufacture evidence and defeat the
> script's stated design ("Dexscreener supplies search hints only: the Initialize event and pool
> ID are independently verified on chain"). The honest state is: no fork proof for this branch.

**Tier 3 — live-verified.** **None.** No transaction has been broadcast, simulated against
live state, or settled. No claim in this document is live-verified.

> **Universal trading is NOT proven.** What is proven is that the app-side surface is
> internally consistent with the deployed contract's ABI and invariants, and fails closed when
> live state disagrees. Token coverage on Base is a liquidity fact, not a code fact, and has
> not been measured.

## 6. Remaining limitations and blockers

1. **No live verification** of executor posture or bytecode (Tier 3 empty; sandbox has no
   chain access).
2. **No fork proof for this branch — blocking for merge.** Runs `39396256493` and `39397504180`
   both failed identically at the Dexscreener-dependent discovery step (see Tier 2 above), so the
   contract-level fork suite never ran for this change. It must be re-triggered successfully
   before merge, once the external hint source recovers or the step gains an on-chain fallback.
   That fallback should preserve independent verification rather than hardcode a pool id or
   block. This is the single largest gap in the evidence for this PR.
3. **No end-to-end app-level fork test.** Even when green, the Foundry suite covers the
   *contract* only. A vitest fork harness that drives `prepareV2Execution` against a real Base
   archive node would close the remaining gap between Tier 1 (fabricated readers) and Tier 2.
4. **Settlement verification is not wired into a route.** `settlement.ts` is complete and
   tested, but no API endpoint calls it yet; receipt verification after broadcast still needs a
   surface.
5. **Front-end not wired.** `components/features/swap/SwapForm.tsx` still calls the V1
   endpoint and hardcodes `sellSideQuoted: null` (line 47). Activation without front-end work
   would expose the V2 API but not the V2 UX.
6. **Coverage matrix not produced.** No measurement exists of which Base pairs actually have
   compatible liquidity, so "code restriction" vs "no liquidity" cannot yet be distinguished
   per token. MPGR itself still has only the Uniswap V4 MPGR/native-ETH pool, so USDC↔MPGR
   depends on a multi-hop route existing through it.
7. **V1 defects deliberately left alone** (deferred by instruction): `swapPathHopKey` omits
   `tokenOut`, so WETH- and USDC-bridge two-hop candidates collide and the WETH bridge is
   dropped (observed 16 candidates instead of 19); V1 generates only 1–2 hops despite
   `SWAP_MAX_PATH_HOPS = 3`; V1 has no v4 adapter. **Do not** add `tokenOut` to that key
   without updating `lib/swap/swap-path-token-pairs.test.ts`, whose regexes
   (`/:100($|>)/`, `/:500($|>)/`) encode the current format.
8. **Pancake V3 and 0x Settler stay disabled.** Neither has a passing fork proof. Settler must
   never be called directly.

## 7. Activation plan

Requires separate explicit approval. Do not perform these steps as part of this change.

1. **Independently verify the executor against a real Base RPC** (outside this sandbox):
   chain id, `getCode` hash == `0x53896cc3…` and size 21963, `owner()` == the Safe,
   `feeBps()` == 25, `MAX_FEE_BPS()` == 100, `feeRecipient()` == `PINNED_FEE_RECIPIENT()` ==
   `0x96F7fb5C…`, `paused()` == false, `FEE_TIMELOCK_SECONDS()` == 172800,
   `V4_POOL_MANAGER()` == `0x498581fF…`, and `routerKind`/`routerFactory` for all five enabled
   venues. Record block numbers.
2. **Re-run the fork proof** (`swap-v2-fork-proof.yml`) and confirm green at a current block.
3. **Flip the gate**: set `V2_DEPLOYMENT` in `lib/swap/v2/discovery.ts` to the sealed manifest
   (typed via `deployment.ts`).
4. **Update the four dormant assertions that legitimately must change** — this is expected, and
   reviewing that diff is part of reviewing the activation:
   - `lib/swap/v2/discovery.test.ts:13` — `expect(V2_DEPLOYMENT).toBeNull()`
   - `lib/swap/v2/__tests__/deployment.test.ts:20-23` — dormancy + literal-source assertion
   - `app/api/swap/v2/quote/route.activation.test.ts:112-113` — dormant HTTP shape
   - `scripts/swap-v2-finalize-recovery.test.ts:251` — asserts `discovery.ts` contains the
     literal `export const V2_DEPLOYMENT = null;`
   Leave `scripts/swap-v2-finalize-recovery.test.ts:213` alone: it asserts the *recovery
   workflow text*, not `discovery.ts`.
5. **Wire the front end** (limitation 5) and a **settlement route** (limitation 4) before
   exposing V2 to users.
6. **Ship behind a reversible flag or canary** if possible; monitor `feeRecipient` balance
   deltas to confirm the 25 bps fee lands once per swap.
7. **Full `npm run check`** (lint + typecheck + tests) plus CI green before merge.

## 8. Rollback plan

Activation is a single constant, so rollback is a revert:

1. Set `V2_DEPLOYMENT` back to `null` (revert the activation commit). `swapV2Executor()`
   returns `null`, the route takes the dormant branch, and `/api/swap/v2/quote` returns
   `executable: false, transaction: null` again.
2. **V1 is untouched by this change and remains the live baseline** — the live swap path and
   executor `0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E` need no rollback.
3. No contract action is required or permitted: do not pause, unpause, change ownership, or
   alter fee configuration. Pausing the executor is a governance decision for the Safe, not a
   deploy-time reflex.
4. Transactions already broadcast settle on-chain regardless; verify their receipts with
   `settlement.ts` rather than assuming a rollback cancels them.

## 9. Invariants that must survive any future change

- Fee is 25 bps on **gross sell**, computed **exactly once**, including split routes. A quote
  that skips the fee is rejected; there is no fee-less swap.
- `recipient` and the approval `spender` are both the executor the transaction targets; BUY and
  SELL agree on spender, intent and settlement.
- Integer arithmetic only; decimals handled per token; no floating point in fee or amount math.
- Direct pool first; multi-hop only when no direct pool quotes; max 3 hops. WETH and USDC are
  **optional** intermediates, never mandatory. No catalog veto: any two distinct Base tokens.
- A venue is never advertised as supported unless its calldata and execution are proven.
- Never fabricate a quote, never silently substitute a route, never report an RPC failure as
  missing liquidity, and never describe an unrun test as passed.

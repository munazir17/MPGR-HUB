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

### Journey wiring (added after the execution surface)

Producing an executable transaction was not enough: **seven dispatchers keyed off the
transaction target recognised only the V1 swap-path executor and the legacy Agent executor**, so
a V2 swap was rejected by the fee rule, mispriced at quote expiry, approved against the wrong
spender, and never verified at settlement. One shared client-safe discriminant
(`lib/swap/v2/v2-target.ts`, mirroring V1's `swapPathTarget`) now feeds a V2 branch in each:

| Dispatcher | What V2 needed |
| --- | --- |
| `lib/trade/trade-agent-fee.ts` | accept the V2 executor as a legitimate 25 bps collector |
| `lib/swap/swap-lifecycle.ts` | read the deadline from V2 calldata (it decoded as 0, so a V2 quote was never "fresh") |
| `lib/swap/swap-policy.ts` | fee admission, and receipt settlement via the V2 intent and events |
| `lib/swap/swap-allowance.ts` | approval spender = the V2 executor the transaction targets |
| `lib/swap/swap-wallet.ts` | fee terms read with the V2 ABI, an on-chain `paused` check before the wallet prompt, and gas estimated for an approval to the correct spender |
| `lib/trade/trade-execution.ts` | the pre-signature calldata gate re-derives the V2 intent |

Plus the client and API surface: `v2-proposal.ts` (adapt to the shared `TradeProposal` so the
existing engine works unchanged), `v2-evidence.ts` (optional `swapV2Routing` binding, mirroring
V1's `swapPathRouting`), `v2-quote-client.ts` (V2 primary when activated, V1 fallback otherwise),
`v2-settlement-client.ts` with `app/api/swap/v2/settlement` (the client sends only a hash; the
server re-fetches the receipt, reads live posture at the mined block, and requires the sender and
output recipient to be the signed-in wallet), `app/api/swap/v2/status` (public activation probe),
and `coverage.ts` with `scripts/swap-v2-coverage-matrix.test.ts`.

`intent.ts` and `settlement.ts` dropped their `server-only` marker: both are pure (viem decoding
plus local constants, no I/O, no secrets), and V1 already inspects calldata in the browser via
`swap-executor-intent.ts`. Every module that performs RPC stays server-only.

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

**Tier 1 — unit-simulated (this change): 187 tests across 15 files, plus the full
suite at 4525 passed / 25 skipped (339 files).** All of it runs against *fabricated*
read-only readers and encoded fixtures — no RPC was contacted, so these are **not** fork
tests and **not** live tests.

They cover: arbitrary imported pairs, split routes, genuine three-hop routes through
non-major intermediates, v4 PoolKey routes, native-ETH sells, deterministic intent ids, fee
arithmetic, and every fail-closed posture-drift case above; the quote and settlement HTTP
boundaries in both gate states (`route.activation.test.ts`, `settlement/route.test.ts`);
the client dispatch that keeps the dormant path byte-identical to V1
(`quote-client.test.ts`); and the end-to-end wiring of a real V2 quote through proposal
adaptation, fee policy, quote freshness/expiry, evidence binding, spender selection, the
agent-fee target rule and receipt settlement for **both a SELL and a BUY**
(`wiring.test.ts`). The discovery fallback has its own offline tests
(`fork-fixture-discovery.test.ts`), which feed synthetic pool ids and assert they come back
out — proving nothing is hardcoded.

**Tier 2 — fork-tested (GitHub Actions, contract-level): GREEN on this branch.**
`.github/workflows/swap-v2-fork-proof.yml` runs
`test/swap-fork/MPGRSwapExecutorV2BaseFork.t.sol` against a real Base fork.

| Run | Commit | Result |
| --- | --- | --- |
| `39411451593` | `90c3343` | **ok. 13 passed; 0 failed; 0 skipped** at fork block 52852228 |
| `39414446575` | `4b54093` | **ok. 13 passed; 0 failed; 0 skipped** at fork block 52852998 |

Both runs recovered the pool **without any third-party hint**. Dexscreener again
returned `MPGR v4 hint count: 0`, and the new hint-free on-chain search took over:

```text
[discovery] no fixture from hints; searching on chain by indexed currency
[discovery] MPGR runtime code first present at block 48631199; scanning forward to 52852998
[discovery] wide-range query refused (Free tier caps eth_getLogs at a 10 block range);
            falling back to windowed scan
[discovery] windowed currency search matched at blocks 48631199-48631208 after 2 window(s)
[discovery] on-chain currency search: verified Initialize at block 48631199
poolId 0xfc151dc0278bc0b2e2ad5404e14f8e3a43e77f176537c29e25f179262ad1cc44
```

That `poolId` is identical to the value recorded from the hint-driven runs of
2026-10-19, but this time it was derived **entirely from Base chain data**: a
binary search on `eth_getCode` for the token's deployment block, then an
`eth_getLogs` query filtered on the `Initialize` event's *indexed currencies*. No
pool id, PoolKey, block or transaction hash is hardcoded anywhere in the
discovery path, and the Foundry suite still verifies the pool independently.

**History, recorded because it explains the design.** Four earlier runs
(`39396256493`, `39397504180`, `39398352775`, `39398810617`) all failed at the
discovery step with `hint count: 0`, so the forge suite was skipped and this branch
had no fork proof at all. A third-party search API had become a single point of
failure for our fork evidence. That is the problem the fallback removes. Note that
`paths:` filtering on a `pull_request` event matches the PR's **cumulative** diff,
so any push to this PR re-runs the proof.

**Tier 2b — coverage matrix (GitHub Actions, discovery-level): BUILT, but NOT MEASURED.**
`.github/workflows/swap-v2-coverage-matrix.yml` runs the app's real discovery stack
(`RpcV2LiquiditySource` + `discoverV2Quote`) against Base and classifies each pair.
Run `39414446827` (commit `4b54093`) completed successfully at block 52853024 using
`secrets.BASE_MAINNET_RPC_URL`, and reported:

```text
Pairs probed: 212 · measured: 0 · unmeasured: 212
EXECUTABLE_ROUTE 0 | MISSING_LIQUIDITY 0 | UNSUPPORTED_TOKEN_INFRASTRUCTURE 0
UNSUPPORTED_VENUE 0 | INVALID_REQUEST 2 | FEE_INVARIANT_DEFECT 0
UNMEASURED_PROVIDER_FAILURE 212
```

Every pair failed with `Canonical pool log query unavailable`,
`Venue quote unavailable`, or the 45 s per-pair timeout. **This is an RPC
capability limit, not a liquidity finding** — and the classifier correctly refused
to record any of it as `MISSING_LIQUIDITY`. The two `INVALID_REQUEST` rows are the
ETH↔WETH pair, which discovery rightly rejects as one asset.

So: the matrix machinery works and is honest, but **no token-coverage evidence
exists yet**. Broad historical `eth_getLogs` scanning is what discovery needs and
what the available RPC will not serve; the fork proof needs only a narrow targeted
query near a known block, which is why it succeeds on the same RPC. Closing this
needs either an RPC/archive tier with a wide log range or a pool index.


**Tier 3 — live-verified.** **None.** No transaction has been broadcast, simulated against
live state, or settled. No claim in this document is live-verified.

> **Universal trading is NOT proven.** What is proven is that the app-side surface is
> internally consistent with the deployed contract's ABI and invariants, and fails closed when
> live state disagrees. Token coverage on Base is a liquidity fact, not a code fact, and has
> not been measured.

## 6. Remaining limitations and blockers

1. **No live verification** of executor posture or bytecode (Tier 3 empty; sandbox has no
   chain access).
2. **Token-coverage evidence does not exist yet — the largest remaining gap.** The matrix
   machinery is built, runs in CI, and classified 212 real pairs at block 52853024, but **0 were
   measurable**: every pair hit `Canonical pool log query unavailable`, `Venue quote
   unavailable`, or the 45 s per-pair timeout on the configured RPC. The classifier correctly
   recorded all of it as `UNMEASURED_PROVIDER_FAILURE` and never as missing liquidity. Discovery
   needs broad historical `eth_getLogs`; the fork proof needs only a narrow query near a known
   block, which is why one succeeds and the other cannot. Closing this needs an RPC/archive tier
   with a wide log range, or a pool index. **Until then, no claim about which Base tokens are
   tradeable is supported by evidence.**
3. **No end-to-end app-level fork test.** The Foundry suite proves the *contract*. Nothing yet
   drives `prepareV2Execution` or the new wiring against a real Base archive node, so the gap
   between fabricated readers (Tier 1) and contract behaviour (Tier 2) is still closed only by
   reasoning plus ABI-parity assertions. The same RPC log-range limit in item 2 currently blocks
   building it.
4. **Settlement is wired but unexercised against a real receipt.** `/api/swap/v2/settlement` and
   `v2-settlement-client.ts` are complete and tested against encoded fixtures, and
   `useSwapExecution` now calls the server route for V2 receipts. No real V2 transaction has ever
   been broadcast, so that path has never run end-to-end in production.
5. **Front-end is wired but dormant.** `SwapForm` and `useSwapExecution` now dispatch through
   `requestSwapQuoteWithV2`, and all seven V1-only dispatchers recognise V2. While
   `V2_DEPLOYMENT` is null none of it can execute: the status probe reports `activated:false`, so
   the live surface is today's V1 path with one extra cached GET per minute. This has not been
   exercised in a real browser session against an activated backend.
6. **V1 defects deliberately left alone** (deferred by instruction): `swapPathHopKey` omits
   `tokenOut`, so WETH- and USDC-bridge two-hop candidates collide and the WETH bridge is
   dropped (observed 16 candidates instead of 19); V1 generates only 1–2 hops despite
   `SWAP_MAX_PATH_HOPS = 3`; V1 has no v4 adapter. **Do not** add `tokenOut` to that key
   without updating `lib/swap/swap-path-token-pairs.test.ts`, whose regexes
   (`/:100($|>)/`, `/:500($|>)/`) encode the current format.
7. **Pancake V3 and 0x Settler stay disabled.** Neither has a passing fork proof. Settler must
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
5. **Exercise the wired front end and settlement path against an activated backend** (limitations 4 and 5) before
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

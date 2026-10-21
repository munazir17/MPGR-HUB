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

### Universal discovery and coverage measurement (added after the journey wiring)

Wiring an executable transaction is worthless if discovery cannot find the pool. Four modules
close that gap, and they are the reason this document can talk about *measured* coverage at all:

| Module | Responsibility |
| --- | --- |
| `lib/swap/v2/rpc-index.ts` | Bounded per-venue factory enumeration (`getPair` / `getPool` / `poolByPair` shapes) for the venues that expose a getter. `PARTIAL_INDEX_VENUE_KINDS = [1]` records that Slipstream is only probed at tick spacing 10, because no ABI-verified spacing-set getter exists — a partial index may add routes, never justify a negative. |
| `lib/swap/v2/rpc-v4.ts` | Bounded, **hint-free** Uniswap v4 discovery from canonical `Initialize` logs. Derives a sound search floor by binary-searching `eth_getCode` for the token's first block with runtime code, probes the log span the provider will actually serve, then windows the scan. Every accepted PoolKey is re-derived and must equal the log's own indexed pool id. No pool id, hook, fee, tick spacing or block number is hardcoded as a result. |
| `lib/swap/v2/coverage-plan.ts` | The pure, deterministic probe plan: which tokens, which pairs, which direction, which shard. Shared by the shard jobs and by the offline aggregator, so the two cannot disagree about what was supposed to be attempted. |
| `lib/swap/v2/coverage-merge.ts` | Merges shard artifacts into exactly one row per planned pair. A pair no shard reported becomes an explicit `UNMEASURED_PROVIDER_FAILURE` gap rather than silently disappearing, and a shard may never overwrite another's measurement with a gap. |

`scripts/swap-v2-coverage-matrix.test.ts` measures one shard; `scripts/swap-v2-coverage-aggregate.test.ts`
merges them offline and fails if fewer shards reported than the plan expects. Both are env-gated
(`MPGR_V2_COVERAGE=1`, `MPGR_V2_COVERAGE_AGGREGATE=1`) so `npm test` never contacts Base.

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

### Routing failure attribution

The table above is about the execution path. Discovery failures used to have no equivalent: a
revert, a zero answer, an RPC outage, an exhausted budget and "no pool was ever found" all
collapsed into the same silent `null` from `quoteLeg`, so a pair was reported as an
undifferentiated provider failure whichever of them happened. That is why `SELL MPGR → WETH`
could only be described as a provider failure while `BUY WETH → MPGR` measured executable through
the *same* pool.

`discoverV2Quote` now records a `RouteAttemptTrace` — how many pools discovery returned, which
were dropped by executor validation and why, and what every quotable candidate actually did — and
`attributeRouteFailure()` turns it into one of these classes. The trace rides on the thrown
`V2QuoteError`, and `classifyPairOutcome` copies the class and a one-line evidence scope onto the
coverage row, so a whole matrix can be grouped by *where the measurement stopped*.

| Class | Meaning | Verdict |
| --- | --- | --- |
| `BUDGET_EXHAUSTED` | A read/log/wall-clock cap was hit, or the bounded search could not finish, so the venue was never asked | `DISCOVERY_UNAVAILABLE` — unmeasured |
| `QUOTE_RPC_FAILED` | A pool **was** discovered and validated, but the quote call failed at the provider | `DISCOVERY_UNAVAILABLE` — unmeasured |
| `HOOK_OR_TOKEN_INCOMPATIBLE` | A pool was discovered and validated, but a **Uniswap v4 pool with a hooks contract in its call path** reverted. The refusal is attributable to that hook or to the token's own transfer rules, and is not isolated further without a state trace | `DISCOVERY_UNAVAILABLE` — unmeasured |
| `VENUE_REJECTED_SWAP` | Same, on a pool with no hooks contract to blame | `DISCOVERY_UNAVAILABLE` — unmeasured |
| `QUOTE_ZERO_OUTPUT` | A pool was discovered and validated and the venue **answered zero** | `LIQUIDITY_UNAVAILABLE` if the search was complete, otherwise `DISCOVERY_UNAVAILABLE` |
| `EXECUTOR_VALIDATION_REJECTED` | Discovery returned pools the deployed executor could not address (disabled venue kind, a v4 pool whose tokens disagree with its own PoolKey, currencies out of order, tick spacing out of range) | as above, per completeness |
| `POOL_NOT_DISCOVERED` | Nothing connecting this pair was found | as above, per completeness |

**The governing rule is that a refusal is not a fact about liquidity.** A venue that reverts, a
provider that errors and a budget that runs out all leave the pair UNMEASURED. Only a venue that
*answers* — with zero — has said something about liquidity, and even then only when discovery was
complete enough to prove a negative, which `RpcV2LiquiditySource.negativeProvable(input, output)`
now reports **per pair** (a single mutable diagnostics field was not enough: the coverage matrix
probes pairs concurrently, so one pair's attribution would otherwise read whichever load finished
last).

Two further consequences worth knowing when reading a report:

- Candidate quotes are attempted independently. The old `Promise.all` let one venue's outage reject
  the whole batch and erase another venue's good quote; every candidate's outcome is now recorded,
  and a route is built from whichever venues answered.
- Multi-hop failing no longer masks the direct attempt. For a token whose only pool is a
  native-side v4 pool, the direct attribution is the answer and the multi-hop outage is recorded as
  context on the same trace.

`lib/swap/v2/__tests__/mpgr-direction-attribution.test.ts` (23 tests, SIMULATED tier) pins all of
this down for an MPGR-shaped pair with a **fabricated** PoolKey — fee 3000, tick spacing 60, a
made-up hooks address, a made-up deployment block — so no real pool id, hook, fee, tick spacing or
block number is encoded as an expected result anywhere. Discovery has to derive the PoolKey from
the fabricated `Initialize` log, exactly as it does on chain.

### The user-facing quote path: ordered discovery

A pasted address has to produce an answer, not a multi-minute log scan. Discovery is therefore
**staged**, and `discoverV2Quote` stops at the first stage that produces a quotable direct pool:

| Stage | Venues | Cost | Complete? |
| --- | --- | --- | --- |
| 1. `factory-index` | Uniswap v2, Uniswap v3 (all four canonical fee tiers), Aerodrome Classic (both `stable` values), Aerodrome Slipstream | one `eth_call` per candidate, **no `eth_getLogs` at all** | v2 and Classic yes; v3 yes over the pinned tier set; **Slipstream PARTIAL** — only the tick spacing this repo pins, because the factory's spacing set was never verified from its ABI and is not invented |
| 2. `v4-canonical-logs` | Uniswap v4 via the PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b` | bounded `Initialize` search from a chain-derived deployment floor, two-sided, capped at `MPGR_SWAP_V2_V4_LOG_CALLS` | only when the scan reached the pinned block |
| 3. `canonical-sweep` | the four getter-backed venues from block 0 | up to `maxSweepCalls` `eth_getLogs`, bisecting under a range cap | **disabled by default on the quote path** |

The consequences, all of them deliberate:

- A pair that a factory getter can answer is quoted with **zero `eth_getLogs` calls**. Every provider
  refuses wide ranges, so this is the difference between a quote a user can wait for and one they
  cannot. Asserted in `lib/swap/v2/__tests__/staged-quote-path.test.ts`, and asserted *falsifiably*:
  removing `directStages` turns 10 of those 24 tests red.
- **v4 is searched only after the getters fail.** MPGR↔ETH still quotes, because no getter knows that
  pair and stage 2 finds the native-side PoolKey. The trade is route *quality*, not route *truth*: a
  better-priced v4 pool is not compared against a getter pool that already quoted.
- **The whole-chain sweep does not run on the quote path** (`MPGR_SWAP_V2_MAX_SWEEP_CALLS`, default 0).
  It cannot be served by a range-capped provider and it is not needed to quote a direct pool. The
  consequence is honest and load-bearing: a pair with no pool anywhere is reported as
  `DISCOVERY_UNAVAILABLE`, **never** `LIQUIDITY_UNAVAILABLE`, because absence is not provable without
  a complete enumeration. An operator whose RPC serves a wide log range can raise the variable and
  negatives become provable again — there is a test for exactly that transition.
- Multi-hop (max 3 hops) is attempted only when no direct pool quotes, and neighbour enumeration is
  still the sweep's job, so with the sweep disabled it fails fast and says so instead of spending a
  budget to reach the same verdict.
- The fee is unchanged and unskippable: 25 bps on **gross**, computed once, to
  `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`. `validateV2Quote` rejects a quote that skips it, and
  an amount too small for the fee to exist is rejected before any venue is asked.
- Calldata targets only the executor `0x4be1154440b26145d76608D41d403a33e76b9d0A`, and the route is
  simulated **as the taker** at the pinned block before any transaction is returned; a simulation that
  misses the committed minimum returns no transaction at all. A v4 hop's `pool`, `router` and
  `factory` are all the PoolManager inside the calldata, while `transaction.to` is still only the
  executor — routing target and transaction target are deliberately different things, and both are
  asserted.

`swapV2QuoteSource(client, blockNumber)` is the single place that configuration lives, so the quote
path cannot drift from it. Its v4 cache is per quote, because the cache is keyed by `token@block` and
a shared one would grow without bound in a long-lived server while every quote pins a fresh block.

## 5. Evidence tiers: what is actually proven

**Tier 1 — unit-simulated (this change): 268 tests across 20 files on the V2 surface,
plus the full suite at 4606 passed / 26 skipped (344 files).** All of it runs against
*fabricated* read-only readers and encoded fixtures — no RPC was contacted, so these are
**not** fork tests and **not** live tests. The two skipped files are the live coverage
matrix and its aggregator, which stay gated behind their env flags by design.

They cover: arbitrary imported pairs, split routes, genuine three-hop routes through
non-major intermediates, v4 PoolKey routes, native-ETH sells, deterministic intent ids, fee
arithmetic, and every fail-closed posture-drift case above; the quote and settlement HTTP
boundaries in both gate states (`route.activation.test.ts`, `settlement/route.test.ts`);
the client dispatch that keeps the dormant path byte-identical to V1
(`quote-client.test.ts`); v4 discovery itself — invalid logs, missing pools, RPC caps,
duplicate candidates, provider-span reuse, and a discovered PoolKey carried all the way
through quoting into a signable transaction (`rpc-v4.test.ts`, `rpc-source.test.ts`); the
coverage plan and merge contracts (`coverage-plan.test.ts`, `coverage-merge.test.ts`,
`coverage.test.ts`); and the end-to-end wiring of a real V2 quote through proposal
adaptation, fee policy, quote freshness/expiry, evidence binding, spender selection, the
agent-fee target rule and receipt settlement for **both a SELL and a BUY**
(`wiring.test.ts`). The discovery fallback has its own offline tests
(`fork-fixture-discovery.test.ts`), which feed synthetic pool ids and assert they come back
out — proving nothing is hardcoded.

**Tier 2 — fork-tested (GitHub Actions, contract-level): GREEN on this branch.**
`.github/workflows/swap-v2-fork-proof.yml` runs
`test/swap-fork/MPGRSwapExecutorV2BaseFork.t.sol` against a real Base fork.

Green on **ten consecutive commits** of this branch, most recently:

| Run | Commit | Result |
| --- | --- | --- |
| `39411451593` | `90c3343` | **ok. 13 passed; 0 failed; 0 skipped** at fork block 52852228 |
| `39414446575` | `4b54093` | **ok. 13 passed; 0 failed; 0 skipped** at fork block 52852998 |
| `39416407672` | `5d1f587` | **ok. 13 passed; 0 failed; 0 skipped** |
| `39431366193` | `d11bed8` | **ok. 13 passed; 0 failed; 0 skipped** |
| `39447617381` | `d5bed71` | **ok. 13 passed; 0 failed; 0 skipped** at fork block 52860173 |
| `39454970912` | `4f4c3a4` | **ok. 13 passed; 0 failed; 0 skipped** at fork block 52861625 |
| `39556393561` | `9947ee0` | **ok. 13 passed; 0 failed; 0 skipped** |
| `39561249441` | `fe005ee` | **ok. 13 passed; 0 failed; 0 skipped** |

The runs on `90c3343` and `4b54093` recovered the pool **without any third-party
hint**. Dexscreener returned `MPGR v4 hint count: 0`, and the hint-free on-chain search
took over:

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

Later runs (`39447617381`, `39454970912`) got `MPGR v4 hint count: 1` — Dexscreener
answered again — and the hint path verified the **same** PoolKey:
`currency0 0x0000…0000` (native), `currency1 0xb2000000000000000000008d204203177a78af01`,
`fee 0`, `tickSpacing 200`, `hooks 0x985c14baa2a18316ffda0aefb3a632fadfca2acc`,
`poolId 0xfc151dc0…1cc44`, `initializeBlock 48631199`. Both discovery routes agreeing on
one canonical answer, on different commits and different fork blocks, is the point: the
hint is an optimisation, never a source of truth.

`testForkMPGRV4FeeAndMinimum` is the load-bearing test here. It swaps **MPGR → WETH**
through that pool in a single hop and passes on a real fork, which proves two things the
app-side discovery has to match: the deployed executor accepts a v4 PoolKey whose
`currency0` is the zero address, and it settles that hop into WETH (`h[0].tokenOut = WETH`).
`lib/swap/v2/rpc-v4.ts` therefore normalises a pool's native side to canonical WETH exactly
as `discovery.ts`, `rpc-index.ts` and the sweep in `rpc-source.ts` already did — a v4 pool
against native ETH *is* a WETH route, and treating it as anything else makes real liquidity
invisible.

**History, recorded because it explains the design.** Four earlier runs
(`39396256493`, `39397504180`, `39398352775`, `39398810617`) all failed at the
discovery step with `hint count: 0`, so the forge suite was skipped and this branch
had no fork proof at all. A third-party search API had become a single point of
failure for our fork evidence. That is the problem the fallback removes. Note that
`paths:` filtering on a `pull_request` event matches the PR's **cumulative** diff,
so any push to this PR re-runs the proof.

**Tier 2b — coverage matrix (GitHub Actions, discovery-level): PARTIALLY MEASURED.**
`.github/workflows/swap-v2-coverage-matrix.yml` runs the app's real discovery stack
(`RpcV2LiquiditySource` + `discoverV2Quote`) against Base and classifies each pair.
It is sharded: `coverage-plan.ts` produces one deterministic plan of 210 pairs, the plan
is split into disjoint batches **grouped by subject token**, each shard measures its own
batch inside its own wall-clock budget and uploads a shard artifact, and an offline
`aggregate` job merges them into exactly one row per planned pair — failing loudly if
fewer shards report than the plan expects.

The progression matters, because each row is a defect that was found by measuring rather
than by reasoning:

| Run | Commit | Shape | Result |
| --- | --- | --- | --- |
| `39414446827` | `4b54093` | one job, block-0 sweep | 212 probed · **0 measured** — every pair hit `Canonical pool log query unavailable` or the 45 s timeout |
| `39421479108` | `f9d77dc` | + bounded factory index | 212 probed · **1 measured** |
| `39424722053` | `3aca0f1` | + sweep-call bound | **RED** — `ETH routed despite unsupported infrastructure` (a real classifier bug, fixed) |
| `39431366188` | `d11bed8` | + routability split from metadata | 212 probed · **54 measured** · 158 UNMEASURED · venue kinds 1, 4 and 7 all produced executable routes, including two-leg and mixed-venue multi-hop |
| `39447617536` | `d5bed71` | 4 shards + hint-free v4 | all 4 shards green, **first MPGR route ever measured** — but the aggregate job merged nothing and still reported success |
| `39454971188` | `4f4c3a4` | + loud aggregation | all 4 shards green with proven handoff files · **aggregate RED: collected 0 of 4 shard artifacts** |
| `39556393443` | `9947ee0` | handoff moved to `coverage-out/` | **collected 4 of 4**, merged 210 pairs, 58 measured · aggregate RED on my own over-strict assertion (two correct ETH≡WETH rejections) |
| `39561249672` | `fe005ee` | 6 shards, 120 s per pair | **GREEN end to end.** 6 of 6 shards · 210 planned pairs · 69 measured, all `EXECUTABLE_ROUTE` · 141 UNMEASURED · merged matrix published |
| `39565200296` | `2f0eb69` | docs-only re-trigger | **GREEN, reproduced.** 6 of 6 shards · 65 measured, all executable · 145 UNMEASURED · `BUY WETH→MPGR` executable again at a different block |
| **`39575818040`** | **`4562b23`** | **+ routing failure attribution** | **GREEN. 6 of 6 shards · 41 measured, all executable · 169 UNMEASURED · MPGR → WETH SELL resolved to `QUOTE_ZERO_OUTPUT`** |

**Defect 1 — a green aggregate job that had merged nothing.** Run `39447617536` reported
`aggregate: success` while producing no merged matrix and no PR comment: the shard matrices
were written into `deployments/.local/`, which is both dot-prefixed and git-ignored, and the
uploaded artifacts arrived without them. The aggregation test treated "no shards found" as a
*skip*, and vitest discards console output from a skipped test, so nothing surfaced anywhere.
A silent green here is the worst available outcome — it reads as "every planned pair was
attempted" when none was. Aggregation that is switched on with nothing to merge now **fails**,
the collect step fails if fewer shard artifacts arrive than the plan expects and prints the
downloaded tree in the error, each shard publishes the files it is handing over with their byte
sizes as a notice, and the handoff directory is a plain `coverage-out/` rather than an ignored
path. Verified offline before pushing: four shard fixtures → collected 4 of 4 → merged 210
planned pairs → a 52 KB report that fits inside GitHub's 65 536-character comment limit.

**Defect 2 — round-robin sharding multiplied the expensive work by four.** Dealing pairs
round-robin gives every shard an equal *pair* count and every shard the *whole token
catalogue*. But the costly part of a measurement is per token, not per pair: a deployment floor
is a ~26-step `eth_getCode` binary search and a v4 `Initialize` scan is up to 64 sequential
ten-block `eth_getLogs` round-trips. Run `39454971188` paid that four times over, and the
shard annotations show where the budget went — the buckets below are per shard and are the
only evidence from that run, since its aggregate job (correctly) refused to publish a matrix:

| Shard | Handoff written | Visible UNMEASURED buckets | MPGR rows in that shard |
| --- | --- | --- | --- |
| 1 | JSON 48 928 B, MD 24 076 B | 24 read-budget exhausted · 13 never attempted · 9 timeouts · 1 neighbour · 1 incomplete · 1 ETH≡WETH | `SELL MPGR→USDC` UNMEASURED, 3 token-pairs UNMEASURED |
| 2 | JSON 49 012 B, MD 24 637 B | 24 read-budget exhausted · 17 never attempted · 5 timeouts · 5 neighbour · 1 incomplete · 1 ETH≡WETH | `BUY USDC→MPGR` UNMEASURED, 3 token-pairs UNMEASURED |
| 3 | JSON 41 792 B, MD 16 506 B | 11 timeouts · 4 read-budget · 4 neighbour | `SELL MPGR→WETH` UNMEASURED, 3 token-pairs UNMEASURED |
| 4 | JSON 38 542 B, MD 15 444 B | 25 never attempted · 14 timeouts | **`BUY WETH→MPGR` EXECUTABLE_ROUTE**, 3 token-pairs UNMEASURED |

**The merged result — run `39561249672`, commit `fe005ee`, blocks 52888960–52888969, RPC
`secrets.BASE_MAINNET_RPC_URL`, 6 of 6 shards reported.** This is the first complete merged
matrix this branch has produced, and it is the only coverage table in this document that may be
quoted as measured:

```text
Pairs probed: 210 · measured: 69 · unmeasured: 141
EXECUTABLE_ROUTE 69 | MISSING_LIQUIDITY 0 | UNSUPPORTED_TOKEN_INFRASTRUCTURE 0
UNSUPPORTED_VENUE 0 | INVALID_REQUEST 2 | FEE_INVARIANT_DEFECT 0
UNMEASURED_PROVIDER_FAILURE 141
Per shard: #1 16 measured/32 unmeasured (budget exhausted) · #2 13/21 (exhausted)
           #3 8/24 (exhausted) · #4 7/25 (exhausted) · #5 19/13 · #6 6/26 (exhausted)
```

**By venue** — venues that actually quoted a route, as distinct from venues merely registered on
the executor:

| Kind | Venue | Executable routes | Of which mixed-venue |
| --- | --- | --- | --- |
| 1 | Aerodrome Slipstream | 55 | 4 |
| 7 | Uniswap v4 | 15 | 4 |
| 4 | Aerodrome Classic | 2 | 0 |
| 2 | Uniswap v3 | 1 | 0 |

(The columns sum to more than 69 because a multi-hop route is counted under each venue it uses;
8 routes used two venues.) **By token and direction**, 35 distinct tokens produced at least one
executable route, and every one of the 69 was a token↔WETH or token↔USDC pair: none of the 12
sampled token/token pairs was reached, because the shard that owns them ran out of wall clock
first. Direction is measured separately and is often asymmetric — `AAPLc` sells executable in
both quote assets but buys in one, `AVGOc`/`CAKEc`/`LLYc`/`MRVLc`/`MUc`/`cbDOGE` executable in
one direction only.

**MPGR specifically:**

| Pair | Direction | Verdict | Evidence |
| --- | --- | --- | --- |
| WETH → MPGR | BUY | **EXECUTABLE_ROUTE** | 1 hop, 1 leg, venue kind 7 — quoted through a canonically re-derived v4 PoolKey |
| MPGR → WETH | SELL | UNMEASURED_PROVIDER_FAILURE — **now attributed** | `Pools exist for this pair but none quoted a positive output … Direct candidates: 0x498581ff…2b2b:0xfc151dc0…1cc44 (Uniswap v4, hooks 0x985C…2AcC) answered zero output` → class `QUOTE_ZERO_OUTPUT` |
| MPGR → USDC | SELL | UNMEASURED_PROVIDER_FAILURE | `v4 search capped — Matched 1 v4 pool(s) for 0xb200…af01 by block 48631238; stopped after a 3-window tail, so blocks 48631239-52888968 were not scanned` |
| USDC → MPGR | BUY | UNMEASURED_PROVIDER_FAILURE | same as above |
| MPGR ↔ 12 B20 tokens | TOKEN_PAIR | UNMEASURED_PROVIDER_FAILURE | `Probe budget exhausted before this pair was measured (shard 1/6, 1260000ms)` |

So **MPGR is tradeable in one measured direction** — buying MPGR with WETH through its native-side
v4 pool — and that is the first time this matrix has measured an MPGR route at all. The three
unmeasured MPGR quote-asset rows are instructive rather than discouraging: the v4 search *did*
match a pool for MPGR at block 48631238 in the USDC rows, and the verdict stayed UNMEASURED
because a scan that stops before the pinned block cannot support a negative.

### MPGR → WETH SELL: resolved, and it was never a liquidity problem

Run `39575818040` (commit `4562b23`, blocks 52892489–52892497) is the first with routing
attribution, and it settled the SELL direction outright. The row no longer says "provider
failure"; it says exactly what happened:

```text
Pools exist for this pair but none quoted a positive output, and discovery was not complete
enough to prove no better pool exists. Direct candidates:
  0x498581ff718922c3f8e6a244956af099b2652b2b:0xfc151dc0278bc0b2e2ad5404e14f8e3a43e77f176537c29e25f179262ad1cc44
  (Uniswap v4, hooks 0x985C14BAa2a18316ffdA0aeFB3a632fAdfcA2AcC) answered zero output.
Discovery could not finish: canonical event sweep unavailable / factory index complete for every
venue with a getter (partial by construction for kind(s) 1) / v4 Initialize search capped:
Matched 1 v4 pool(s) … by block 48631238; stopped after a 3-window tail …
Multi-hop was also unavailable: … This is UNMEASURED, not missing liquidity.
```

Four things follow, and each is checkable:

1. **The pool WAS discovered.** Its id in that message was derived on chain by `rpc-v4.ts` and is
   byte-identical to the `poolId` the fork suite independently verifies with
   `assertEq(keccak256(abi.encode(key)), fixtures.mpgr.poolId)`. Nothing is hardcoded.
2. **The venue answered zero — it did not revert.** So the class is `QUOTE_ZERO_OUTPUT`, not
   `HOOK_OR_TOKEN_INCOMPATIBLE`. The hooks contract `0x985C…2AcC` is named in the evidence and is
   *not* the cause; had the pool reverted, the attribution would have said so and blamed the hook
   or the token's transfer rules.
3. **The zero is the probe amount, arithmetically.** The matrix probes every pair with a fixed
   `PROBE_AMOUNT = 1_000_000` raw units regardless of decimals, so the SELL leg asked the quoter
   about `997_500` wei of MPGR (gross less 25 bps). The fork proof measured the same direction at
   the same block height — `testForkMPGRV4FeeAndMinimum`, fork block **52892463**, 26 blocks
   before the coverage run pinned its block — and got `GROSS 1e18`, `FEE_AMOUNT 2500000000000000`
   (exactly 25 bps), `NET_OUTPUT 5997618925` wei of WETH, `HOPS 1`, PASS. That is a rate of
   `5.9976e-9` wei WETH per wei MPGR, so the probe's expected output is
   `997_500 × 5.9976e-9 = 0.00598` wei — **which floors to zero**. The BUY direction at the same
   probe size expects `997_500 / 5.9976e-9 ≈ 1.66e14` wei of MPGR, comfortably positive, which is
   precisely why BUY measured executable and SELL did not.
4. **The verdict stays UNMEASURED, correctly.** A zero answer is only a liquidity fact when the
   search was complete enough to prove a negative, and here the v4 scan was capped and the sweep
   unavailable — so `negativeProvable` was false and the classifier refused to record
   `MISSING_LIQUIDITY`.

**SELL verdict, tiers kept separate.** At the **fork tier** MPGR → WETH executes: one hop through
the canonical PoolManager and the real PoolKey, 25 bps charged once on gross to
`0x96F7…64A4`, positive output, green on thirteen consecutive commits. At the **coverage tier** it
is UNMEASURED, for a harness reason that is now identified and quantified rather than guessed. It
is **not** missing liquidity, **not** a hook rejection, **not** unsupported token infrastructure,
and **not** an executor-validation rejection. Nothing has been broadcast, so there is still no
live-verified tier.

The consequence reaches beyond MPGR: a fixed 1e6-raw-unit probe is `1.00 USDC` (6 decimals) but
`10^-12` of any 18-decimal token, so **every one-directional result in this matrix is suspect until
the probe is sized per token**. That is very likely why `AVGOc`, `CAKEc`, `LLYc`, `MRVLc`, `MUc`
and `cbDOGE` measured executable in one direction only. It is a one-line harness change and it is
deliberately **not** made here, because this pass was scoped to attribution; it is the highest-value
next change to the matrix.

**It reproduced.** The docs-only commit `2f0eb69` re-triggered the same pipeline as run
`39565200296` at blocks 52889955–52889972: 6 of 6 shards again, 210 planned pairs, **65 measured
and again every one an `EXECUTABLE_ROUTE`**, 145 UNMEASURED, venue kinds 1 (53), 7 (11), 4 (2) and
2 (1). `WETH → MPGR BUY` came back `EXECUTABLE_ROUTE`, 1 hop, 1 leg, venue kind 7, with the same
evidence string, at a different block — so that row is a property of the chain and not of one
lucky run. The measured total moved 69 → 65 and the timeout bucket 16 → 19: **run-to-run variance
is real and is reported as such**, because five of six shards still exhaust their 21-minute budget
and which pairs they reach depends on provider latency that day. Any coverage number quoted from
this branch must be quoted with its run id.

**Where the 141 gaps come from**, exactly as the merged report records them (the reproduction run
differed only in the split: 69 never attempted, 43 capped searches, 19 timeouts, 10 multi-hop,
2 incomplete, 2 correct rejections):

| Cause | Pairs | Whose fault |
| --- | --- | --- |
| Probe budget exhausted before this pair was measured | 64 | harness wall clock — never attempted |
| Discovery call budget exhausted mid-search | 45 | provider: ten blocks per `eth_getLogs` cannot cover 4.2 M blocks |
| Per-pair wall-clock timeout | 16 | provider latency (was 39 at 60 s; the 120 s timeout recovered 23) |
| Liquidity-neighbour enumeration needs a historical log range | 11 | harness: `maxSweepCalls = 0` disables the multi-hop sweep |
| Discovery incomplete: sweep and/or v4 scan did not finish | 2 | provider |
| ETH and WETH are the same asset | 2 | correct rejection (`INVALID_REQUEST`) |
| HTTP 429 from the RPC | 1 | provider rate limit, six shards on one endpoint |

The attributed run `39575818040` reports the same 210 pairs as 41 measured and 169 UNMEASURED, and
its gap table is the first that says *where* each measurement stopped rather than only that it
stopped: 93 never attempted (wall clock), 34 `Discovery could not finish: a budget, log-range cap or
provider refusal`, 34 per-pair timeouts, **4 `Pool discovered and valid, but the venue rejected the
swap`**, 2 `Pool discovered and valid, but it quoted zero output` (one of them MPGR → WETH SELL) and
2 correct ETH≡WETH rejections. Those last two classes were not reportable categories before this
pass: a reverted venue and a zero answer were both invisible inside one "provider failure" bucket.
Measured counts across the three green runs were 69, 65 and 41 — **the variance is provider latency
and rate limiting, not chain state**, and all six shards reported budget exhaustion in the last run,
so these numbers are a floor on what the matrix managed to attempt, not a ceiling on what Base
offers.

Not one of the 141 is a liquidity finding. Raising the per-pair timeout from 60 s to 120 s and
going from four shards to six moved measured pairs from 58 to 69 and timeouts from 39 to 16,
which is the expected direction but not the end of it: five of six shards still exhausted their
21-minute budget, so the next levers are more shards or more minutes, and an RPC tier whose
`eth_getLogs` range is wider than ten blocks — that single limit accounts for 45 gaps on its own
and cannot be scheduled away.

**`MISSING_LIQUIDITY` is still 0, and legitimately so.** A definitive negative requires the
getter-backed sweep to complete *and* the v4 scan to reach the pinned block. With
`maxSweepCalls: 0` and a provider that serves ten blocks per `eth_getLogs`, neither happens, so
the honest verdict is `DISCOVERY_UNAVAILABLE`, which the classifier records as UNMEASURED.
**No Base pair has been proven to lack liquidity, and none has been proven to have it, except
where a row says `EXECUTABLE_ROUTE`.** The two `INVALID_REQUEST` rows in every run are ETH↔WETH,
which discovery correctly rejects as one asset.

### Probe sizing: the artefact, fixed

Run `39607488924` (commit `9022a80`, blocks 52899840–52899851) is the first with decimals-derived
probe amounts, and it answered the question the attribution pass raised:

```text
Pairs probed: 210 · measured: 97 · unmeasured: 113
EXECUTABLE_ROUTE 97 | MISSING_LIQUIDITY 0 | UNSUPPORTED_* 0 | INVALID_REQUEST 2
FEE_INVARIANT_DEFECT 0 | UNMEASURED_PROVIDER_FAILURE 113
Executable routes by venue kind: 1 → 64 · 7 → 13 · 2 → 9 · 4 → 8 · 3 → 4
```

- **`MPGR → WETH SELL` measured `EXECUTABLE_ROUTE`** — 1 hop, 1 leg, venue kind 7, at a probe of
  `1e12` raw units (1e-6 of one 18-decimal token). `WETH → MPGR BUY` measured executable at the same
  size. Both directions of the same native-side v4 pool, in one run, with the amount each verdict was
  measured at printed beside it.
- **The `QUOTE_ZERO_OUTPUT` bucket went to zero matrix-wide.** Every "the venue answered zero" row in
  earlier runs was a dust-rounding artefact of the fixed probe. The class did not shrink, it
  disappeared — which is the strongest confirmation available that the diagnosis was right.
- **All five enabled venue kinds measured for the first time**, including Uniswap v2 (kind 3), which
  no previous run had quoted a single route through.
- **Direction symmetry improved**: tokens executable in *both* directions 32 → **37**; tokens
  executable in *neither* 10 → **4**; and MPGR left the "one direction only" list.

How sizing works now (`lib/swap/v2/coverage-probe.ts`, harness-only — production always quotes the
amount the user actually asked for): the ladder is `1e-6 → 1e-4 → 1e-2` of one unit of the token
being **sold**, as exact powers of ten derived from that token's on-chain `decimals()`, never floats.
Every rung is clamped into `[400, 1e24]` raw units — 400 is the smallest gross whose 25 bps fee is a
whole wei, below which `discoverV2Quote` rejects the probe before any venue is asked, and `1e24`
keeps a probe inside `uint128`, away from overflow, and far below any size where the quoted rate
would stop meaning anything. Rungs that clamp to the same amount collapse, so a 6-decimal token is
not asked one question three times. When `decimals()` is unreadable the ladder assumes 18 — the
common Base case and, of the plausible choices, the one yielding the *largest* raw amounts, which is
the safe direction — and marks every such row as assumed.

Escalation is deliberately narrow: a larger probe is tried **only** when the failure is a resolution
failure (the venue answered zero, or reverted the way a venue reverts when its computed output rounds
below its own minimum). A provider failure, an exhausted budget, a pool the executor could not
address, or "no pool discovered" are not sizing problems, and escalating those would spend a shard's
remaining budget dressing an honest UNMEASURED up as something it is not. A healthy pair still costs
exactly one quote.

The caveat that comes with the improvement: the residual one-direction-only list changed *membership*
between runs (`AVGOc`, `MSTRc`, `RDDTc`, `cbBTC` resolved; `MRNAc`, `NVAXc`, `NVDAc`, `PMc`, `TTWOc`,
`cbETH` appeared). Most remaining asymmetry is therefore **which pairs a shard reached before its
budget ran out**, not a routing fact about the token. With 32–102 pairs never attempted per run, an
asymmetric row is not yet evidence of an asymmetric route.

### Two-sided v4 search: a measured tuning curve

The ten-block `eth_getLogs` cap is the largest single cause of unmeasured pairs. The scan now runs
**forward from a token's chain-derived deployment floor and backward from the pinned block**,
alternating window by window, and issues windows with bounded parallelism. Nothing is skipped: each
side's windows tile its own range exactly, a window is committed to its side's edge only once *all*
of its topic positions have been read, `state` is `complete` only when the two contiguous sides
actually met, and every incomplete path names the blocks it never reached — including the
budget-exhausted path, which previously described only what it *had* reached.

The budget was then tuned from measurements rather than from reasoning, and the measurements
refuted the reasoning:

| Run | Commit | Scan budget | Measured | Discovery could not finish | Timeouts | Never attempted |
| --- | --- | --- | --- | --- | --- | --- |
| `39580750408` | `9b3a107` | 64 calls, forward only, sequential | 81 | 57 | 13 | 42 |
| `39607488924` | `9022a80` | 64 calls, forward only, sequential + probe fix | **97** | 64 | **11** | **32** |
| `39610667933` | `0caae3e` | 256 calls, two-sided, 4 in flight | 34 | **26** | 41 | 102 |
| `39616446107` | `c0bf291` | 96 calls, two-sided, 2 in flight | 75 | 54 | 18 | 55 |
| `39621664624` | `777067b` | 128 calls, two-sided, 2 in flight | 68 | 53 | 25 | 56 |
| **`39626429104`** | **`809387d`** | **64 calls, two-sided, 2 in flight — shipped** | **85** | 60 | **14** | 43 |

Two conclusions, both contrary to the model the first two tunings assumed:

1. **Concurrency does not buy back what a bigger call budget spends.** Per-pair timeouts track
   *total call count* and essentially ignore parallelism — 11 at 64 calls, 18 at 96, 25 at 128, 41 at
   256 — which is what a rate-limited endpoint looks like when it queues requests server-side. The
   256/4 run also logged `HTTP request failed` and left shards 3, 4 and 6 measuring 1–2 pairs each.
2. **Reach costs attempts.** A shard has 21 minutes, and a token with no discoverable pool spends its
   whole budget scanning. The extra reach *worked* — "discovery could not finish" fell from 64 rows
   to 26 — and it was paid for in pairs never attempted, which rose from 32 to 102.

So the budget is back to **64 calls**, the total that measured best, now spent at *both* ends of the
range (~320 blocks forward and ~320 backward) instead of ~640 at one end, with concurrency left at 2
because that is not what the data blames. Run `39626429104` (commit `809387d`, blocks
52903683–52903700) is that configuration and is the state this branch ships: **6 of 6 shards, 85 of
210 pairs measured and every one an `EXECUTABLE_ROUTE`, all five venue kinds on the board
(Slipstream 60, v4 12, v3 7, Aerodrome Classic 4, Uniswap v2 3), 125 UNMEASURED, and MPGR executable
in both directions against WETH at a recorded probe of `1e12`.**

Two honest readings of that last row, because the numbers invite an over-claim in either direction:

- **Splitting a fixed budget across two ends did not measurably cost throughput.** At 64 calls the
  forward-only runs measured 41, 65, 69, 81 and 97 pairs across five attempts; the two-sided run
  measured 85, inside that spread. What the data does say is that *raising* the budget to 256 cost
  dearly (34 measured, 41 timeouts), and that the 256-call run's reach gain was real — 26 rows of
  "discovery could not finish", the lowest of any run.
- **The backward side has not yet earned its keep on chain.** It is proven by test to find a pool a
  forward-only scan cannot reach, and no run so far has measured a pair *because* of it — every pool
  found has still been near its token's deployment floor. Its value is insurance against a pool
  created long after launch, not a measured coverage gain. If measured count is what matters most,
  the next tuning to try is weighting the budget toward the forward side rather than splitting it
  evenly; that is a knob, not a redesign, and it is deliberately not guessed at here.

**What the two-sided scan is still not:** a way to cross 4.2 M blocks on a ten-block provider. That
is 420 000 calls and remains infeasible, so a token whose only v4 pool was initialized in the middle
of that range is still out of reach, and still reported as `capped` with the uncovered blocks named.
The real remedy for the middle of the range is a wider-log-range RPC, not a cleverer scan.

**Tier 3 — live-verified.** **None.** No transaction has been broadcast, simulated against
live state, or settled. No claim in this document is live-verified.

> **Universal trading is NOT proven.** What is proven is that the app-side surface is
> internally consistent with the deployed contract's ABI and invariants, and fails closed when
> live state disagrees. Token coverage on Base is a liquidity fact, not a code fact, and it is
> only **partially** measured: run `39607488924` measured **97 of 210 planned pairs**, every one of
> them an `EXECUTABLE_ROUTE`, across **all five enabled venue kinds** — including **both** directions
> of MPGR against WETH through a canonically re-derived native-side v4 PoolKey, each verdict printed
> beside the exact probe amount that produced it. The other 113 are `UNMEASURED_PROVIDER_FAILURE`,
> and **no pair at all has been proven to *lack* liquidity**. Roughly half the plan unmeasured is not
> universal coverage, an unmeasured row is not a negative, and a token/token pair has still never been
> measured in any run.

## 6. Remaining limitations and blockers

1. **No live verification** of executor posture or bytecode (Tier 3 empty; sandbox has no
   chain access).
2. **Token coverage is only partially measured — still the largest remaining gap.** The matrix runs
   in CI as six parallel shards plus an offline aggregate job, and it now produces real verdicts.
   The shipped configuration's run is `39626429104` (commit `809387d`, blocks 52903683–52903700):
   6 of 6 shards, 210 planned pairs, **85 measured and every one of them an executable route**, 125
   UNMEASURED, across **all five enabled venue kinds** (Slipstream 60, v4 12, v3 7, Aerodrome
   Classic 4, Uniswap v2 3) and including **both** directions of MPGR against WETH at a recorded
   probe of `1e12` raw units. The best single run observed was `39607488924` at 97 of 210. **Even
   that is 46% of the plan, and it is not universal coverage.** Every gap is harness- or provider-side: 32 pairs were never
   attempted because a shard's wall clock ran out, 64 died on a ten-block `eth_getLogs` range that
   cannot cover 4.2 M blocks, 11 timed out, 3 were venue rejections and 1 a provider error. None is
   a liquidity finding. All 85 executable routes are still token↔WETH or token↔USDC; **not one
   token/token pair has been measured in any run**, because the shard that owns those probes has
   never reached them. Measured counts across the six most recent green runs were 81, 97, 34, 75, 68
   and 85 — a spread driven by provider latency, rate limiting and scan budget, not by chain state,
   so **any coverage number quoted from this branch must be quoted with its run id**. Closing the rest needs an RPC tier
   whose `eth_getLogs` range is wider than ten blocks (the fork proof succeeds on the same RPC only
   because it needs a narrow query near a known block), plus more shards or more minutes. **Until
   then no claim about which Base tokens are tradeable is supported beyond the measured rows.**
3. **Discovery completeness is bounded, and a bounded search cannot prove absence.** Three
   concrete limits, all recorded in code rather than papered over:
   - *Slipstream (venue kind 1) is enumerated partially.* Only tick spacing 10 is probed, because
     no ABI-verified getter for the spacing set exists and inventing one is how a fabricated
     negative happens. `PARTIAL_INDEX_VENUE_KINDS = [1]` marks it, and `rpc-source.ts` refuses to
     treat an index-only result as proof that no pool exists.
   - *v4 discovery is bounded by `maxLogCalls` (64) per token.* On a ten-block-range provider a
     pool initialized long after its token's deployment block is out of reach; the search returns
     `capped`, which is UNMEASURED, never "no v4 pool".
   - *Consequently `MISSING_LIQUIDITY` cannot currently be produced at all.* A definitive negative
     needs the sweep complete **and** the v4 scan to reach the pinned block. Reporting 0 missing
     liquidity is therefore not a claim that liquidity exists everywhere — it is a claim that
     absence was never provable.
4. **No end-to-end app-level fork test.** The Foundry suite proves the *contract*. Nothing yet
   drives `prepareV2Execution` or the new wiring against a real Base archive node, so the gap
   between fabricated readers (Tier 1) and contract behaviour (Tier 2) is still closed only by
   reasoning plus ABI-parity assertions. The same RPC log-range limit in item 2 currently blocks
   building it.
5. **Settlement is wired but unexercised against a real receipt.** `/api/swap/v2/settlement` and
   `v2-settlement-client.ts` are complete and tested against encoded fixtures, and
   `useSwapExecution` now calls the server route for V2 receipts. No real V2 transaction has ever
   been broadcast, so that path has never run end-to-end in production.
6. **Front-end is wired but dormant.** `SwapForm` and `useSwapExecution` now dispatch through
   `requestSwapQuoteWithV2`, and all seven V1-only dispatchers recognise V2. While
   `V2_DEPLOYMENT` is null none of it can execute: the status probe reports `activated:false`, so
   the live surface is today's V1 path with one extra cached GET per minute. This has not been
   exercised in a real browser session against an activated backend.
7. **V1 defects deliberately left alone** (deferred by instruction): `swapPathHopKey` omits
   `tokenOut`, so WETH- and USDC-bridge two-hop candidates collide and the WETH bridge is
   dropped (observed 16 candidates instead of 19); V1 generates only 1–2 hops despite
   `SWAP_MAX_PATH_HOPS = 3`; V1 has no v4 adapter. **Do not** add `tokenOut` to that key
   without updating `lib/swap/swap-path-token-pairs.test.ts`, whose regexes
   (`/:100($|>)/`, `/:500($|>)/`) encode the current format.
8. **Pancake V3 and 0x Settler stay disabled.** Neither has a passing fork proof. Settler must
   never be called directly.
9. **CI's `quality` job is red on `npm run audit:high`, and this branch did not cause it.** Lint,
   typecheck and the full test suite all pass in that job; only the security gate fails, on two
   findings published upstream after the last green run on `main`:
   - `vite` — a **direct devDependency pinned at exactly `8.3.0`**, inside the affected range
     `8.3.0 - 8.3.2`. `8.3.5` is published and `vitest@4.1.11` accepts `^8.0.0`, so the fix is a
     one-line bump.
   - `follow-redirects` — transitive via `axios@^1.20.0` (which requires `^1.16.0`); `1.16.0` is
     installed and affected, `1.16.1` is published and satisfies the same range, so the fix is a
     lockfile update with no override needed.

   `git diff 05e7fbc HEAD -- package.json package-lock.json scripts/audit-high.mjs` is **empty**:
   this branch adds no dependencies and does not touch the gate. The same lockfile passed CI on
   `main` at `05e7fbc`, so the failure is date-dependent and applies to `main` equally. It is
   deliberately **not** fixed here, and deliberately **not** silenced by adding either package to
   `scripts/audit-high.mjs`'s allowlist — adding an allowlist entry for a new high-severity
   advisory is the dependency equivalent of excluding a Slither detector. Both fixes belong in a
   separate, reviewable dependency PR.
10. **RESOLVED — probe sizing, and what it changed.** The fixed `PROBE_AMOUNT = 1_000_000` is gone;
    `lib/swap/v2/coverage-probe.ts` now sizes each probe from the sold token's on-chain `decimals()`
    as exact powers of ten (`1e-6 → 1e-4 → 1e-2` of one unit, clamped to `[400, 1e24]`), sizes each
    direction independently, escalates only on a resolution failure, and records the exact amount
    behind every verdict in a `Probe` column. Run `39607488924` measured **97 of 210** pairs against
    81 before the change, took tokens executable in *both* directions from 32 to **37**, took tokens
    executable in *neither* from 10 to **4**, put all five venue kinds on the board for the first
    time, and turned **`MPGR → WETH SELL` into a measured `EXECUTABLE_ROUTE`** — with the
    `QUOTE_ZERO_OUTPUT` bucket going to zero matrix-wide, which is the diagnosis confirming itself.
11. **A residual asymmetry in the matrix is an attempt-order artefact, not a routing fact.** The
    "executable in one direction only" list changed *membership* between runs (`AVGOc`, `MSTRc`,
    `RDDTc`, `cbBTC` resolved; `MRNAc`, `NVAXc`, `NVDAc`, `PMc`, `TTWOc`, `cbETH` appeared) because
    32–102 pairs per run are never attempted at all. No one-directional row should be read as
    evidence of a one-directional route until the shard budget stops being the binding constraint.
12. **The v4 search budget is tuned from a measured curve, and the curve refuted the model.** Five
    runs are tabulated in §5: per-pair timeouts track *total `eth_getLogs` call count* and essentially
    ignore concurrency (11 at 64 calls, 18 at 96, 25 at 128, 41 at 256), so parallelism does not buy
    back what a larger budget spends, and reach costs attempts — the 256-call run cut "discovery could
    not finish" from 64 rows to 26 and paid for it with pairs never attempted rising from 32 to 102.
    The budget is therefore 64 calls, spent at both ends of the range. **Still infeasible:** crossing
    4.2 M blocks at ten blocks per call is 420 000 calls, so a token whose only v4 pool was
    initialized in the middle of that range stays out of reach and stays reported as `capped` with the
    uncovered blocks named. Only a wider-log-range RPC changes that.

## 7. Activation plan

Requires separate explicit approval. **None of this has been done.** The exact diff exists, is
committed inert, and was verified — see [`activation/V2-ACTIVATION-RUNBOOK.md`](activation/V2-ACTIVATION-RUNBOOK.md)
and [`activation/v2-activation.patch`](activation/v2-activation.patch).

1. **Run the private canary and verify both receipts.** `scripts/swap-v2-canary.test.ts` is
   read-only until `MPGR_V2_CANARY=1`, builds the two swaps without signing or sending when
   additionally given `CANARY=1 CANARY_WALLET=<public address>`, and verifies a receipt the
   operator already broadcast when given `CANARY_VERIFY_TX=<hash>`. The two swaps are
   `1.00 USDC → WETH` and `1 MPGR → native ETH` (the same size the fork proof executes). Both
   receipts must show `status success`, `to` equal to the sealed executor, exactly one
   `SwapExecuted` with `feeBps 25` and `feeAmount == grossAmountIn * 25 / 10000` to
   `0x96F7fb5C…64A4`, plus a `SwapPathExecuted` for any multi-leg route. **If a verification
   fails, stop; do not broadcast a second time.** The harness holds no key and its first test
   audits its own source to prove it.
2. **Independently verify the executor against a real Base RPC** (outside this sandbox): chain
   id, `getCode` hash == `0x53896cc3…` and size 21963, `owner()` == the Safe, `feeBps()` == 25,
   `MAX_FEE_BPS()` == 100, `feeRecipient()` == `PINNED_FEE_RECIPIENT()` == `0x96F7fb5C…`,
   `paused()` == false, `FEE_TIMELOCK_SECONDS()` == 172800, `V4_POOL_MANAGER()` == `0x498581fF…`,
   and `routerKind`/`routerFactory` for all five enabled venues. Record block numbers. The
   canary's posture step already does this through the production `verifyV2Posture` /
   `verifyV2Venues`, so a human should confirm the printed values rather than trust a green tick.
3. **Re-run the fork proof** (`swap-v2-fork-proof.yml`) and confirm green at a current block.
4. **Apply the patch**: `git apply docs/activation/v2-activation.patch`. Nine files change —
   **one** is behaviour (`V2_DEPLOYMENT` becomes `SWAP_V2_SEALED_MANIFEST`, imported from
   `./sealed-manifest`) and **eight** are assertions that were written to pin the dormant state:
   `discovery.test.ts`, `__tests__/deployment.test.ts`, `__tests__/wiring.test.ts`,
   `quote/route.test.ts`, `quote/route.activation.test.ts`, `settlement/route.test.ts`,
   `scripts/swap-v2-finalize-recovery.test.ts` and `scripts/swap-v2-canary.test.ts`. An earlier
   revision of this plan said four; applying the flip and running the suite is what produced the
   real list, and the dormant-shape tests are kept — injected through
   `__setSwapV2ExecutorForTests(null)` — because the dormant shape *is* the rollback shape and
   must stay covered after activation. Leave `swap-v2-finalize-recovery.test.ts:213` alone: it
   asserts the recovery workflow's text, not `discovery.ts`.
5. **`npm run check`**, then commit the activation on its own with both canary receipt hashes in
   the message, and review it there. Verified before this document was written: with the patch
   applied the full suite is **4692 passed / 32 skipped across 348 files**, `tsc --noEmit` clean,
   `eslint .` 0 errors.
6. **Exercise the wired front end and settlement path against an activated backend** (limitations
   5 and 6) before exposing V2 to users, and monitor `feeRecipient` balance deltas to confirm the
   25 bps fee lands exactly once per swap.
7. **Nothing is deployed at any point.** The executor is sealed and its one-shot gate is
   consumed; activation reads that deployment and never recreates it.

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
- **Positives and negatives are not symmetric in discovery.** An incomplete search may return
  the pools it did verify — every one of them came from a canonical source, so an unfinished
  scan costs route *quality*, never route *truth*. Claiming that **no** compatible pool exists
  is a different act, and is only permitted when the getter-backed sweep completed *and* the v4
  scan reached the pinned block. Anything less is `DISCOVERY_UNAVAILABLE`.
- **A v4 PoolKey is trusted only if it re-derives.** `keccak256(abi.encode(PoolKey))` must equal
  the `Initialize` log's own indexed `id`, which is how the PoolManager computes a pool id and how
  the fork suite checks its fixture. A log that fails the check is rejected, not believed.
- **A v4 pool against native ETH is a WETH route.** `currency0 == address(0)` normalises to
  canonical WETH in discovery, the factory index and the sweep alike — the deployed executor
  settles such a hop into WETH, and the fork suite proves it.
- **A search budget is a statement about the searcher, not the chain.** Running out of calls,
  time or provider tolerance produces `capped` / `unavailable`, never `complete`.
- **The coverage plan owns the denominator.** Shards report verdicts; they do not get to redefine
  which pairs existed. A pair no shard reported is an explicit gap in the merged matrix, and an
  aggregation that is switched on with nothing to merge is a failure, not a pass.
- **A refusal is not a fact about liquidity.** A venue that reverts, a provider that errors and a
  budget that runs out all leave a pair UNMEASURED. Only a venue that *answers* — with zero — has
  said something about liquidity, and then only when the search was complete enough to prove a
  negative. That ordering is `attributeRouteFailure`'s priority list, and it is tested as policy.
- **A verdict carries the amount it was measured at.** A quoted route means nothing without the size
  it was quoted for: too small and integer arithmetic floors the answer to zero, too large and the
  rate stops being meaningful. Every coverage row records its probe, and a probe is sized from the
  sold token's on-chain decimals — never from a constant that happens to suit one token.
- **A bounded scan names the blocks it never reached.** Every incomplete path says which range was
  not scanned; an unnamed gap is how a bounded search starts to read as an exhaustive one, and a
  search that reads as exhaustive is how "we found nothing" becomes "there is nothing".
- **A check must exercise the code it claims to verify.** `shardPartitionDefects` used to re-derive
  ownership with its own round-robin loop instead of calling `coverageShard`, so it agreed with
  itself and returned "no defects" for any assignment whatsoever — including after sharding became
  subject-grouped and the two disagreed on nearly every pair. A green check that cannot fail is
  worse than no check, because it gets read as a proof.

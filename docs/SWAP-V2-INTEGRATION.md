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
| **`39561249672`** | **`fe005ee`** | **6 shards, 120 s per pair** | **GREEN end to end. 6 of 6 shards reported · 210 planned pairs · 69 measured, all `EXECUTABLE_ROUTE` · 141 UNMEASURED · merged matrix published** |

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
| MPGR → WETH | SELL | UNMEASURED_PROVIDER_FAILURE | `Liquidity-neighbour enumeration needs a historical log range, and the canonical sweep is disabled (maxSweepCalls=0); multi-hop discovery for this token is unmeasured, not absent` |
| MPGR → USDC | SELL | UNMEASURED_PROVIDER_FAILURE | `v4 search capped — Matched 1 v4 pool(s) for 0xb200…af01 by block 48631238; stopped after a 3-window tail, so blocks 48631239-52888968 were not scanned` |
| USDC → MPGR | BUY | UNMEASURED_PROVIDER_FAILURE | same as above |
| MPGR ↔ 12 B20 tokens | TOKEN_PAIR | UNMEASURED_PROVIDER_FAILURE | `Probe budget exhausted before this pair was measured (shard 1/6, 1260000ms)` |

So **MPGR is tradeable in one measured direction** — buying MPGR with WETH through its native-side
v4 pool — and that is the first time this matrix has measured an MPGR route at all. The three
unmeasured MPGR quote-asset rows are instructive rather than discouraging: the v4 search *did*
match a pool for MPGR at block 48631238 in the USDC rows, and the verdict stayed UNMEASURED
because a scan that stops before the pinned block cannot support a negative. The SELL row failed
later, in multi-hop, after the direct attempt produced nothing quotable; **the current reason
string does not distinguish "no pool found" from "pool found but the quote reverted", and that
attribution gap is the single most useful next diagnostic** — it is the difference between a hook
that refuses sells and a search that never reached the pool.

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

**Tier 3 — live-verified.** **None.** No transaction has been broadcast, simulated against
live state, or settled. No claim in this document is live-verified.

> **Universal trading is NOT proven.** What is proven is that the app-side surface is
> internally consistent with the deployed contract's ABI and invariants, and fails closed when
> live state disagrees. Token coverage on Base is a liquidity fact, not a code fact, and it is
> only **partially** measured: run `39561249672` measured **69 of 210 planned pairs**, every one
> of them an `EXECUTABLE_ROUTE`, across 35 tokens and four venue kinds — including
> `BUY WETH → MPGR` through a canonically re-derived v4 PoolKey. The other 141 are
> `UNMEASURED_PROVIDER_FAILURE`, and **no pair at all has been proven to *lack* liquidity**.
> Two thirds of the plan unmeasured is not universal coverage, and an unmeasured row is not a
> negative.

## 6. Remaining limitations and blockers

1. **No live verification** of executor posture or bytecode (Tier 3 empty; sandbox has no
   chain access).
2. **Token coverage is only partially measured — still the largest remaining gap.** The matrix
   runs in CI as four parallel shards plus an offline aggregate job, and it now produces real
   verdicts: run `39431366188` measured 54 of 212 pairs across venue kinds 1, 4 and 7 including
   multi-hop and mixed-venue routes, and run `39454971188` measured `BUY WETH → MPGR` as an
   `EXECUTABLE_ROUTE` through a canonically re-derived v4 PoolKey. Run `39561249672` is the first
   green end-to-end merged matrix: 6 of 6 shards, 210 planned pairs, **69 measured and every one
   of them an executable route**, 141 UNMEASURED, across 35 distinct tokens and four venue kinds
   (Slipstream 55, v4 15, Aerodrome Classic 2, v3 1, including 8 mixed-venue multi-hop routes).
   **That is 33% of the plan, and it is not universal coverage.** Every one of the 141 gaps is
   harness- or provider-side: 64 pairs were never attempted because a shard's wall clock ran out,
   45 died on a ten-block `eth_getLogs` range that cannot cover 4.2 M blocks, 16 timed out, 11
   needed the multi-hop sweep that `maxSweepCalls = 0` disables, and 1 hit an HTTP 429. None is a
   liquidity finding. All 69 executable routes are token↔WETH or token↔USDC; **not one
   token/token pair was measured**, and MPGR is measured in one direction only (BUY from WETH).
   Closing this needs an RPC tier whose `eth_getLogs` range is wider than ten blocks — the fork
   proof succeeds on the same RPC only because it needs a narrow query near a known block — plus
   more shards or more minutes. **Until then, no claim about which Base tokens are tradeable is
   supported beyond the 69 measured rows.**
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

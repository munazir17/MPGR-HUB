# PHASE 6 — BASE MAINNET ADVERSARIAL AUDIT + FORK REHEARSAL (REPORT)

**Status: COMPLETE (read-only audit + local-fork rehearsal). STOP after fork rehearsal, per task.**
**Mainnet remains LOCKED. No Sepolia or Mainnet transaction was executed by this phase. No deploy, no Vercel change, no key provisioning. Autonomous execution remains OFF by default.**

Evidence base:

- Offline audit suite: `lib/executor/__tests__/phase6-mainnet-audit.test.ts` — **18/18 green** (§A deployment pins, §B chain separation, §C F-9 prepare seam, §D execution boundary + assisted pins, §E policy limits, §F concurrent-execution + replay refusal).
- Fork rehearsal suite: `lib/autonomy/__tests__/phase6-fork-rehearsal.test.ts` — **6/6 green in CI** on a **local anvil fork of Base mainnet** (workflow **`Phase 6 Fork Rehearsal`** run **36862941046**, conclusion **success**, commit `35d01d5`; nothing broadcast to any real chain — the fork lived and died inside the runner). Per-tx evidence lines (`PHASE6_FORK …` with tx hashes) are emitted as run annotations. An earlier full run also succeeded at `1c413bc` (run `36851073285`).
- Full local gates at `35d01d5`: vitest **2342 passed / 0 failed** (16 env-gated skips: 10 Phase 5 + 6 fork-gated), `tsc --noEmit` clean, lint 0 errors / 59 warnings (unchanged baseline), `audit:high` PASS.
- **F-13 closure (post-report addendum)**: `test/fork/B20StockBytecodeFork.t.sol` — **13/13 stock bytecode verified on the Base mainnet fork**, CI run `36873265024` @ `75157ec`, contracts-fork green (`4 passed, 0 skipped, 0 failed` for the f13 suite); offline lockstep pin §G green (audit suite **19/19**). Full gates at `75157ec`: vitest **2343 passed / 0 failed** (17 env-gated skips incl. the disarmed canary), tsc clean, lint 0 errors, audit:high PASS.
- **Mainnet canary PREPARED (not executed)**: `docs/MAINNET-CANARY-RUNBOOK.md` + `.github/workflows/mainnet-canary.yml` (armed defaults to **false**; preflight/reconcile jobs are strictly read-only) + `scripts/mainnet-canary-preflight.mjs` (read-only) + `scripts/mainnet-canary-reconcile.mjs` (read-only) + `lib/autonomy/__tests__/mainnet-canary.execution.test.ts` (OFF unless explicitly armed with the dedicated canary key; exactly ONE 1-USDC BUY). No Mainnet transaction has been sent; autonomous execution remains OFF by default.
- Phase 5 evidence (accepted, frozen at `f11f1c0`) untouched; delegated contract `0xa9568499…58F9` unchanged.

---

## 1. Mainnet executor / config audit (§A, + on-chain fork reads)

Pinned in code and re-read **live from the fork**:

| Fact | Value | Proof |
|---|---|---|
| Executor | `0xD982726e28275661F8aB64054E6b17a70a63505A` | code present on fork; deploy tx `0xf17fcaef…999d01`, block 51767139 |
| Owner | `0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e` | `owner()` read on fork == pin |
| Fee recipient | `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4` | `feeRecipient()` read on fork == pin |
| Fee | **25 bps** (`EXECUTOR_DEFAULT_FEE_BPS`) | `feeBps()` read on fork == 25 |
| Permit2 | canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `PERMIT2()` read on fork == pin |
| WETH | canonical `0x4200…0006` | registry pin |
| Routes | USDC/WETH → official Uniswap V3 SwapRouter02 (fee 3000, CREATE2 pool `0x6c561B…71372`); USDC↔13 B20 stocks → Aerodrome Slipstream (tickSpacing 10) | §A pins + `uniswap-v3-mainnet-route.test.ts` (pre-existing) |
| Token registry | USDC + WETH + 13 Coinbase B20 stocks; **no Sepolia delegated tokens** | §A/§B |

Production deps (`lib/mcp/mcp-deps.ts`): `registry = MPGR_EXECUTOR_DEPLOYMENTS` (per-chain map), `delegatedRegistry` has **84532 only** (8453 absent), `mainnetEnabled` flag-gated, optional 0x fallback disabled unless keyed.

## 2. Execution-path trace (Mainnet, v1)

`Goal (store) → Scheduler.tick → fresh quote (real QuoterV2/Slipstream via chain reader) → deterministic condition check → policy gate (limits + daily ledger claim) → adapter authorization → idempotency claim (execution guard) → quote-freshness re-check → gateway.prepare (v1 intent — the F-9 seam) → unsigned transactionRequest → adapter (only signature path) → broadcast → receipt verification (executor event facts, never blind) → audit chain on AgentEventBus → goal state machine`.

Every stage audited: `QUOTE_CREATED → CONDITION_CHECKED → CONDITION_MET → POLICY_APPROVED → AUTHORIZATION_CHECKED → TRADE_PREPARED → TRANSACTION_SUBMITTED → EXECUTION_VERIFIED` (order enforced by test; secrecy greps: no keys/signatures in audit).

## 3–4. Fork BUY and SELL results (local anvil fork of Base mainnet)

Rehearsed end-to-end with a **test-only impersonation adapter** (production Mainnet adapter refuses all actions — see §6):

- **BUY 1 USDC → AAPLc**: `EXECUTION_SUBMITTED` exactly once → receipt success → verification from receipt facts → goal **COMPLETED**, stock balance increased. Exact **25 bps** fee reconciled from the **real `SwapExecuted` event**: `feeAmount == grossAmountIn × 25 / 10000`, recipient == pinned fee wallet, `fee + swapAmountIn == gross`, `amountOut ≥ minOut`.
- **SELL full received AAPLc → USDC**: through a second runtime/store — `EXECUTION_SUBMITTED` once → verified → **COMPLETED**; round-trip cost = fees + spread (`usdcEnd < usdcBefore`).
- **Duplicate scheduler tick immediately after submit**: `evaluated == 0` (due-gate), still exactly **one** broadcast.
- **Slippage/minOut enforced ON-CHAIN (adversarial)**: a real executor intent for 1 USDC → AAPLc whose `expectedBuyAmount` claims ~30,000× the live price (so `minOut = expected × (1 − slippage) = 9.7e23`, immutable in the calldata) is **mined but REVERTED** by the executor/venue; the revert is atomic — **zero stock received, USDC balance byte-identical** (no partial fill, no fee skim). A broadcaster cannot force a bad fill; the correctly-derived-minOut BUY in the same suite succeeds (positive control).
- Funding was storage-level (`anvil_deal` + slot fallback, exact-balance asserted) — the same approach as the green Solidity fork tests; the executor's own swap path against the live USDC/AAPLc Slipstream pool is exercised for real (pool + live quoter quote proven in the warm-up gate).

## 5. Authorization / replay results

Mainnet path is the **v1 approval model** (not delegated):

- **Authorization**: policy grant + session-authoritative wallet; the ONLY production Mainnet adapter (`noDelegationAdapter`) refuses every autonomous action (`NO_DELEGATION_MECHANISM` / `AUTHORIZATION_MISSING`) — **autonomous Mainnet execution is structurally OFF**; the rehearsal used a clearly-marked test adapter standing in for a future signing mechanism.
- **Idempotency/replay (v1)**: deterministic per-slot `idempotencyKey` (`exec-<goalId>:<nextEvaluationAt>`) claimed under an 86 400 s execution guard → a consumed slot can never re-broadcast (`DUPLICATE_PREVENTED`); daily action ledger claimed atomically before broadcast; per-slot due-gate prevents double-tick. **No blind rebroadcast anywhere.**
- **Same-slot replay is impossible (§F, deterministic)**: the execution guard refuses a replayed per-slot idempotency key (`claimExecution(key)` → `true` then `false`).
- **Concurrent execution is single-broadcast (§F)**: two simultaneous `evaluateGoal` calls on the same goal → exactly ONE quote, ONE broadcast; the loser is `SKIPPED (LEASE_BUSY)` before it even quotes.
- **Delegated-specific mechanisms (actionId / Permit2 unordered nonce / witness replay binding) are Sepolia-scoped** and were **mapped, not reused on Mainnet**: `delegatedActionId` (signed-witness binding), `permitWitnessTransferFrom` nonce consumption (wordPos/bitPos, xor-flip before signature check, reuse → `InvalidNonce`) apply only when `adapter.id == "delegated-permit2-sepolia"` and chain == 84532. The Mainnet runtime path pins `expectedIntentId` to the v1 intent and verifies `exactly one SwapExecuted for intentId` on the receipt.
- **Broadcaster cannot modify signed fields (v1)**: the adapter receives an UNSIGNED `transactionRequest` and signs it as-is; verification re-derives taker/router/tokens/gross/fee/minOut/intentId from the executor's own event and compares against the saved intent — any tampering with amount/minOut/owner/executor/destination fails ≥1 check → not VERIFIED. (The delegated equivalent — broadcaster-bound `expectedSender` + event `taker` binding — is Phase-5-proven and Sepolia-scoped.)

## 6. Policy-limit results (§E, deterministic, Mainnet-chain proposals)

| Rule | Result |
|---|---|
| maxPerTradeRaw | at-cap allowed (inclusive); over → `OVER_PER_TRADE_LIMIT` |
| maxDailyRaw | crossing cap → `OVER_DAILY_LIMIT` |
| maxSlippageBps | over → `OVER_SLIPPAGE_LIMIT` (runtime also clamps goal slippage to policy cap before quoting) |
| maxActionsPerDay | at cap → `OVER_ACTION_RATE` (atomic ledger claim before broadcast) |
| Wrong-chain proposal | 84532 proposal vs Mainnet policy → `CHAIN_MISMATCH` (both directions fail closed) |
| Absolute ceilings | `maxPerTradeHuman 10000` / `maxDailyHuman 100000` surfaced unchanged |

## 7. Emergency stop (fork rehearsal)

With `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true`: the kill switch fires **inside the evaluation loop, post quote/policy, pre authorization** → goal **PARKED** (`EXECUTION_UNAVAILABLE`, "globally disabled… Nothing was signed or sent."), audit carries `EMERGENCY_DISABLE`, **zero signatures/broadcasts**. Manual/assisted trading unaffected by the flag.

## 8. RPC timeout / uncertain broadcast / reverted tx (fork rehearsals)

- **Uncertain broadcast**: fabricated hash → verification polls (receipt lookup) → `PENDING_VERIFICATION` until the attempt budget (10 × 30 s) is exhausted → **UNCERTAIN → goal FAILED, pendingExecution cleared, exactly 0 re-broadcasts ever** (requests length pinned at 1). The `TIMEOUT` disclosure reaches the user.
- **Reverted transaction** (approval deliberately skipped → on-chain revert): broadcast lands, receipt `reverted` → classified **`TX_REVERTED`** → no retry on the slot, pendingExecution cleared.
- **RPC failure semantics** (code-pinned, Phase 5 carry): status lookup failure → `PENDING_VERIFICATION` (never success); ≥10 attempts → UNCERTAIN; verification never fabricates success (`VERIFIED` only on full receipt-fact match).
- **Stale quote**: quote must be unexpired at broadcast start, else `QUOTE_STALE` — nothing is broadcast (pinned Phase 4/5; re-checked in trace).

## 9. Fee reconciliation (fork, real events)

`SwapExecuted`: `grossAmountIn = 1_000_000` raw (exact intent amount), `feeAmount = gross × 25 / 10 000` **exact** (floor), `feeAmount + swapAmountIn == gross`, `feeRecipient == pinned wallet`, `feeBps == 25`, `routerKind`/native `flags` match the intent, `amountOut ≥ minBuyAmount`. Verification requires **exactly one** executor-emitted event for the intentId (look-alike events from other contracts are filtered by emitter address).

## 10. Chain-separation proof (both directions, offline + on-chain)

- Registry map is strictly per-chain; **production `delegatedRegistry` has no 8453 entry** → delegated executor unselectable on Mainnet; Mainnet token registry excludes Sepolia tUSD/tSTOCK → `buildExecutorIntent` → `TOKEN_NOT_ALLOWED`.
- `delegateSwap(8453)` → `UNSUPPORTED_CHAIN`; Mainnet policy → `selectDelegatedSlot` → `CHAIN_MISMATCH`; a delegated-executor receipt can never verify as a Mainnet success (verify-seam refusal).
- **On-chain (fork)**: the delegated Sepolia executor has **no code** on the Base mainnet fork while the pinned Mainnet executor's code/owner/fee/feeBps/Permit2 all match the pins.
- **F-9 prepare seam audited ON Mainnet**: the v1 runtime path **must** call `gateway.prepare` (proven by spy); the delegated skip is gated on `adapter.id == DELEGATED_ADAPTER_ID` and cannot leak.

## 11. Findings (honest classification)

| ID | Severity | Finding |
|---|---|---|
| F-13 | **CLOSED (was MEDIUM process gap)** | **Closed by `test/fork/B20StockBytecodeFork.t.sol` (runs in `contracts-fork` on every push): all 13 configured stock tokens — AAPLc, AMZNc, COINc, CRCLc, GOOGLc, INTCc, METAc, MSFTc, MSTRc, NVDAc, SNDKc, SPCXc, TSLAc — are PROVEN deployed contracts (code.length > 0) on a live Base mainnet fork, plus executor/Permit2/USDC/WETH/Slipstack supporting code and USDC(6)/WETH(18) decimals.** Evidence: CI run `36873265024` @ `75157ec`, contracts-fork `4 passed, 0 skipped, 0 failed` (test_f13_b20_bytecode_01_to_05, _06_to_09, _10_to_13, test_f13_supporting_mainnet_stack_is_deployed). Registry↔fork lockstep is pinned offline by §G (`phase6-mainnet-audit.test.ts`), and the fork-rehearsal warm-up probes decimals==8 for all 13. |
| F-14 | **LOW** | Public Base RPCs under anvil-fork load degrade unpredictably (observed across CI iterations: 429 storms, lazy-fork reads that transiently reported contracts as codeless — reproducing as `QUOTE_FAILED`, which is the correct fail-closed production behavior — and one upstream (llamarpc) serving Cloudflare 525). Production mitigations already in place: dedicated `BASE_RPC_URL` → single transport with **no silent fallback**, quote fail-closed, verification via receipt facts. Test-side mitigations that made the rehearsal deterministic: per-job **pinned fork block** (`latest − 300`), anvil's default remote storage caching, eager warm-up with per-contract code+state probes, and a four-upstream retry ladder. **Residual**: a degraded public RPC can pause autonomous quoting (honest `QUOTE_FAILED`) — acceptable; never a wrong trade. |
| F-14a | INFORMATIONAL (test-infra) | Two CI hardening lessons are encoded in the workflow: (1) this anvil build rejects `--storage-caching`/`--cache-path` (it crashed startup silently until the annotation tail exposed it) — remote storage caching is the default; (2) run-log download via the Actions API is chronically flaky (EOF), so all evidence is deliberately emitted as `::error::PHASE6_FORK …` annotations, which are reliably readable. |
| F-15 | INFORMATIONAL | Autonomous Mainnet execution is refused by design (`noDelegationAdapter`); enabling it later requires a deliberate operator decision + a real signing mechanism — there is no accidental path. |
| F-16 | INFORMATIONAL | The 0x native-fee fallback on Mainnet is disabled unless keyed; executor routes cover every registered pair. |
| — | Verified non-issue | F-9 (prepare seam) is safe on Mainnet (§C). Broadcaster/owner binding, fee exactness, minOut immutability, idempotency, duplicate-tick rejection, emergency stop, and no-blind-rebroadcast all held under adversarial rehearsal. |

No BLOCKER and no HIGH finding. No unexpected production behavior change (all new files are additive tests + a new workflow; production code untouched this phase).

## 12. Exact blockers before a Mainnet canary

No code blockers. Operator/infrastructure decisions required (all deliberate gates, in order):

1. **Operator go/no-go** for enabling autonomous execution on Mainnet (`mainnetEnabled` / `MPGR_AUTONOMOUS_AGENT_ENABLED` in prod envs — never set by this phase).
2. **Signing mechanism decision**: a Mainnet execution adapter + dedicated **Mainnet broadcaster key** provisioned as a secret (never the user's wallet; broadcaster ≠ test user ≠ deployer) — currently nothing on Mainnet can sign.
3. **Dedicated Mainnet RPC** secret (`BASE_MAINNET_RPC_URL`) — F-14.
4. ~~F-13 follow-up: contracts-fork asserts bytecode for all 13 registered stock tokens.~~ **DONE (closed)** — `test/fork/B20StockBytecodeFork.t.sol`, green in contracts-fork run `36873265024`.
5. Canary runbook: tiny-value USDC→AAPLc only, reconcile script equivalent for 8453 (Phase 5's reconciler is Sepolia-scoped), kill-switch + rollback checked, monitoring on `SwapExecuted`/goal states.
6. Assisted-path freeze check at canary time (byte-identical assisted trading is pinned by existing suites and was not modified).

**Canary preparation is complete** — the exact configuration requirements, preflight checklist, one-transaction procedure, kill-switch procedure and reconciliation checklist now live in `docs/MAINNET-CANARY-RUNBOOK.md`. Executing the canary requires the operator's explicit approval plus the three operator-side secrets (dedicated canary key, its address, dedicated Mainnet RPC); nothing is provisioned or executed by this repo.

**STOP here per task** — fork rehearsal complete; no canary executed.

---

*Commits (this phase, all additive/new files): `93515f0` audit + fork suite + workflow → `fa8c000` funding/tx fixes → `3aeffe1` clock+warm-up → `cea4251` eth_call warm-up probes + multi-upstream → `cb4f6f3` hook budget → `1c413bc` per-contract warm-up probes (fork run 36851073285 SUCCESS) → `994ed13` report → `d0f8c17` §F concurrency/replay + fork minOut proof → `5d24d5e`/`044278c`/`35d01d5` pinned fork block + diagnostics + anvil-flag fix (fork run 36862941046 SUCCESS, 6/6) → `20da459` F-13 closure + canary prep → `b5e11fd`/`75157ec` f13 fork-test fixes (CI 36873265024 SUCCESS, 6/6 jobs).*

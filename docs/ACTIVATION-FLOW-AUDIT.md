# ACTIVATION-FLOW AUDIT — "Authorize & activate goal" with no on-chain popup

**Date:** 2026-10-04 · **Branch:** `arena/01a105ea-mpgr-hub` · **Base commit:** `8c69a06`

**VERDICT: INTENTIONAL AND SAFE. The behaviour you observed is correct by design, not a
bypassed approval.** "Authorize & activate goal" is an off-chain control-plane write. It
cannot produce an ERC-20 approval or a trade, and an `ACTIVE` goal cannot silently execute.
There is **no** mainnet autonomous execution path in the web application at all.

**No execution or security logic was changed by this audit.** The only additions are two
test files that *pin* the properties below, plus this report. Nothing was enabled, loosened,
or made to "show success". See [§8](#8-what-was-not-changed).

Evidence: `lib/autonomy/__tests__/activation-flow-audit.test.ts` (19 tests) and
`app/api/agent/autonomy/activation-route-audit.test.ts` (10 tests) — 29 new tests, all
green. Full suite: **243 files / 2513 tests passed, 0 failed** (baseline 2484 → +29). `tsc --noEmit` clean.
`eslint` 0 errors.

> **PHASE 2 UPDATE (same branch, later commits): MC-1, MC-2 and MC-3 are implemented;
> MC-4's authenticated tick endpoint is ready, but unattended scheduling is an operator
> prerequisite.** Vercel's per-minute cron registration is intentionally omitted on Hobby;
> an external scheduler/VPS must call the endpoint every minute. §1–§8 below are the original
> audit and are preserved as the record of what was found and why. [§9](#9-remediation-what-was-built-on-top-of-this-audit)
> documents the bounded Base **mainnet** autonomous execution path, its security model,
> tests, and the external-scheduler handoff. Where §4 says "none applied", read "applied in
> §9". No finding below was weakened to make the new path pass: the audit tests that pinned
> the *gaps* were updated in place to pin the *remediated* behaviour, and every safety
> property they asserted still holds.

---

## 1. What the UI state you saw actually means

| UI line | Real meaning | Source |
|---|---|---|
| `Goal ACTIVE` | A goal row exists in Redis and its policy is live. **No execution capability is implied by this status.** | `app/api/agent/autonomy/goals/route.ts` (`status: policyLive ? "ACTIVE" : "DRAFT"`) |
| `0 triggered · 0 verified` | No evaluation has ever reached a broadcast. Correct and expected. | `goal.stats` |
| `No transaction hash` | Nothing was submitted. `pendingExecution` is `null`. | `publicGoal()` |
| `Delegated Execution · Base Sepolia: NOT CONFIGURED` | `autonomyStatus().executionAvailable === false`, i.e. the resolved adapter's `canDelegate` is false. **This is a truthful fail-closed signal, not a UI bug.** | `AgentAutonomyPanel.tsx:253`, `lib/autonomy/index.ts` |

One nuance worth knowing: `ACTIVE` is the *pre-first-evaluation* state. There is **no
Vercel cron scheduled for the tick endpoint** (`vercel.json` retains only the two `mpgr-run`
settlement jobs). Evaluation happens via the 60 s client heartbeat while the tab is visible,
a manual session `POST /api/agent/autonomy/tick`, or—when unattended evaluation is required—
an operator-provided external scheduler/VPS issuing the authenticated `GET` every minute
(see §9.5). After the first tick the goal will read `WAITING` with:

> Last check …: **Authorization missing** — No valid autonomous authorization
> (NO_DELEGATION_MECHANISM). Review and authorize this goal to enable execution — until
> then it keeps observing.

That message is the honest, designed outcome. It is pinned by test **B2**.

---

## 2. Question-by-question findings

### Q1 — Does "Authorize & activate goal" only create the off-chain policy, without trading?

**CONFIRMED — yes, and it is two writes, nothing more.**

`hooks/useAgentAutonomy.ts:297-350` (`authorizeGoal`) performs exactly:

1. `ensureSession()` — establish/confirm the SIWE session (a signature over a *login
   message*, via the pre-existing wallet-auth flow), and
2. `POST /api/agent/autonomy/policy` with `authorized: true` → one Redis policy row +
   `POLICY_CREATED` audit event, and
3. `POST /api/agent/autonomy/goals` → one Redis goal row + `GOAL_CREATED` audit event.

Both routes are pure store writes. Neither imports the MCP trade service, the executor ABI,
the broadcaster, or any wallet client. Proven three ways:

- **Dynamically** (test A1): after activation the store holds exactly 1 policy + 1 goal +
  **0 delegated slots**; `stats == {evaluations:0, triggered:0, verified:0,
  consecutiveFailures:0}`; `pendingTxHash == null`; `recentActions == []`; and the spied
  broadcaster seam (`createDelegatedBroadcaster` / its `broadcast`) was **never constructed,
  never called**.
- **Response hygiene** (test A1): neither response body contains a 32-byte tx-hash-shaped
  or 65-byte signature-shaped value, nor the words `approval`/`allowance`/`permit2`.
- **Statically** (test B6): `policy/route.ts` and `goals/route.ts` match none of
  `signTypedData | signTransaction | sendTransaction | writeContract | createWalletClient |
  privateKey | approve( | approval | permit2 | delegated-broadcaster | delegateSwap |
  mpgr-executor-abi | encodeFunctionData`.

The `goals/[id]` PATCH route cannot be used as a back door either: it only supports
`pause | resume | cancel | limits`, every mutation is a CAS through the goal state machine,
`sellAmount` edits are explicitly refused (`AMOUNT_FIXED`), and the token pair is not
editable — it derives from the policy.

### Q2 — Does activation perform any ERC-20 approval or trade transaction?

**CONFIRMED — no. Not during activation, and not at any point on the mainnet path.**

- Activation: see Q1. There is no signing call of any kind in `authorizeGoal`.
- The only signature anywhere in the autonomy hook is in the **separate, explicit**
  `signDelegatedSlots` seam (`hooks/useAgentAutonomy.ts:380-484`), reached only from the
  "Sign *n* slots with wallet" button in the *Delegated execution · Base Sepolia* section.
  Test B6 pins this structurally: the first `signTypedDataAsync(` in the file occurs
  **after** `authorizeGoal` ends, inside `signDelegatedSlots`.
- Even that seam is a **Permit2 witness permit signature** (an EIP-712 authorization), not
  an `approve()` transaction. It sends no transaction and spends no gas from the user.
- The mainnet assisted/manual trade path (`lib/trade/trade-execution.ts`) is a different
  code path entirely and is untouched by autonomy.

### Q3 — Is SIWE sufficient for the off-chain policy, and is it being confused with token approval?

**CONFIRMED — sufficient, and not confused. The two are separate concepts in the type model.**

- The policy's only credential-derived field is `authorizationRef`, built by
  `lib/autonomy/api-helpers.ts#authorizationRef` as `${sessionId}:${sha256(sessionId:wallet)[:16]}`.
  Test A2 pins the shape (`/^a{32}:[0-9a-f]{16}$/`), confirms it does not contain the key
  material, and confirms `publicPolicy()` **never echoes it** to the client.
- `AutonomyPolicy` has **no** `spender`, `nonce`, or `signature` field (asserted in A2). It
  structurally cannot represent an allowance.
- Token approval authority lives in a completely different type —
  `DelegatedAuthorizationSlot` (`lib/autonomy/delegated-authorization.ts`) — which carries
  `permit{token,amount,nonce,deadline}` + `witness{owner,buyToken,minAmountOut,deadline,
  actionId,policyHash}` + a 65-byte signature, is created **only** by
  `POST /api/agent/autonomy/authorization`, and whose signature is **recovered server-side**
  and required to equal the SIWE wallet (`SIGNATURE_INVALID` otherwise).
- Authorization is explicit opt-in: omitting `authorized: true` is a `400
  AUTHORIZATION_NOT_GRANTED` (test A3), and a goal cannot be created without an existing
  authorized policy (`400 POLICY_REQUIRED`). A client-supplied `wallet` field is ignored —
  the policy binds to the **session** wallet (test A2).

So: SIWE proves *who you are*; a Permit2 witness slot proves *what you allow to be spent*.
Activation obtains the first and never claims the second.

### Q4 — Can an ACTIVE goal silently execute without a valid execution/delegation capability?

**CONFIRMED — no. Three independent fail-closed layers, each proven.**

The runtime's authorization stage (`lib/autonomy/runtime.ts:386-401`) calls
`adapter.checkAuthorization(...)` **before** any prepare, any idempotency claim, any ledger
claim, and any CAS to `EXECUTING`. If it is not `authorized`, the goal is **parked** to
`WAITING` with an honest reason. There is no branch that skips it.

| Layer | Gate | Result for a UI-activated goal |
|---|---|---|
| 1 — Adapter registry | `getAutonomousExecutionAdapter()` (`execution-adapter.ts:95`) returns `noDelegationAdapter` when the env is unset/`none`; **throws** on an unknown id; **throws** if `delegated-permit2-sepolia` is configured but not installed | `canDelegate: false`, `checkAuthorization → NO_DELEGATION_MECHANISM`, `executeSwap → AUTHORIZATION_MISSING`. Tests B1, B2, B7 |
| 2 — Policy engine chain | `evaluatePolicyAgainstAction` rejects `proposed.chainId !== policy.chainId` | `CHAIN_MISMATCH` in **both** directions (8453 policy vs 84532 proposal, and the reverse). Test B4 |
| 3 — Delegated adapter chain | `DelegatedExecutionAdapter.checkAuthorization` requires `policy.chainId === 84532` | `CHAIN_MISMATCH` for an 8453 policy — **even when the adapter is fully warmed and `canDelegate === true`**. Test B3 |

Additional gates behind those, all already in the codebase and re-confirmed here:

- `MCP delegateSwap` refuses `chainId !== 84532` (`mcp-trade-service.ts:892`,
  `UNSUPPORTED_CHAIN`) and refuses with no broadcaster (`:895`, `BROADCASTER_NOT_CONFIGURED`).
- The operator broadcaster itself refuses any chain other than 84532
  (`lib/delegated/delegated-broadcaster.ts`) and is `null` without
  `MPGR_BROADCASTER_PRIVATE_KEY`.
- The emergency stop (`MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true`) fires **inside** the loop,
  post-quote/policy and pre-authorization → parked `EXECUTION_UNAVAILABLE`, "Nothing was
  signed or sent." Test B5.
- The feature flag off → `SKIPPED(DISABLED)` before even a quote is fetched.
- On-chain, `MPGRExecutorDelegated._validate` re-enforces every signed binding
  (`tokenIn == permit.token`, `grossAmountIn == permit.amount`, `tokenOut == witness.buyToken`,
  `amountOutMinimum == witness.minAmountOut`, `intentId == witness.actionId`, triple deadline
  equality, `recipient == witness.owner`), so a broadcaster cannot widen what was signed.

**Test B2 is the decisive one.** It runs the REAL `AutonomyRuntime` against the REAL MCP
trade service with a quote that genuinely satisfies the trigger (2:1 quote → price 50 ≤
threshold 200), using the production adapter resolution. The audit trail reaches
`QUOTE_CREATED → CONDITION_CHECKED → CONDITION_MET → POLICY_APPROVED → AUTHORIZATION_CHECKED`
and then **stops**: no `TRADE_PREPARED`, no `TRANSACTION_SUBMITTED`, no `EXECUTION_VERIFIED`.
Final state: `WAITING`, `pendingExecution: null`, `triggered: 0`, `verified: 0`, no action
record with a tx hash. A second B2 test repeats this across 6 consecutive ticks — it never
"eventually leaks" an execution.

### Q5 — What is the current Mainnet autonomous execution path? Can this goal reach the Mainnet executor?

**NO. It cannot. There is no mainnet autonomous execution path reachable from the application.**

`getAutonomousExecutionAdapter()` has exactly three possible outcomes:

1. `noDelegationAdapter` — `canDelegate: false`, refuses everything (env unset or `"none"`);
2. the installed `delegated-permit2-sepolia` adapter — **Base Sepolia 84532 only**;
3. **throw** — unknown id, or configured-but-not-installed.

`installAutonomousExecutionAdapter()` (`execution-adapter.ts:84`) throws for any adapter id
other than `delegated-permit2-sepolia`, so no third adapter can be registered (test B7).
And `executionChainId(adapter)` (`runtime.ts:43`) returns `84532` for the delegated adapter
and `8453` for anything else — but the only "anything else" that exists is the adapter that
refuses. **The set of adapters that can broadcast on 8453 is empty.**

When the delegated adapter *is* configured and installed, a UI-activated mainnet goal fails
even earlier than the authorization stage: the runtime quotes chain `84532` (because
`adapter.id === DELEGATED_ADAPTER_ID`), and the delegated executor's allowlist does not
contain Base mainnet USDC → **`TOKEN_NOT_ALLOWED`** at OBSERVE. Test B3 pins exactly this,
and asserts the pipeline never emits `QUOTE_CREATED`, `CONDITION_MET`, or `POLICY_APPROVED`,
and the broadcast spy is never called.

The **only** code in this repository that can sign and broadcast an autonomous mainnet swap
is `lib/autonomy/__tests__/mainnet-canary.execution.test.ts`. It is not reachable from the
server:

- `describe.skipIf(!ARMED)` where `ARMED = MPGR_MAINNET_CANARY === "true" &&
  MPGR_MAINNET_CANARY_PRIVATE_KEY` is set (`:60`, `:69`);
- the key must derive to the pinned `0xBF6c574b9543967f0D528ae49603b0A7574a280b`, else it
  throws before signing/reading/broadcasting anything (`:77-79`);
- it constructs its own local adapter (`id: "mainnet-canary"`) **inside the test process** —
  it is never installed into the production registry;
- `.github/workflows/mainnet-canary.yml` defaults `armed: false` and requires a manual
  `workflow_dispatch`; the default run is read-only preflight.

This matches the repository's own prior conclusion (`docs/PHASE6-MAINNET-AUDIT.md`, F-15):
*"Autonomous Mainnet execution is refused by design (`noDelegationAdapter`) … there is no
accidental path."*

### Q6 — Was execution enabled or bypassed to make the UI show success?

**No.** Nothing in the execution or security surface was modified. See [§8](#8-what-was-not-changed).

---

## 3. Exactly what happens when the trigger condition becomes true

Full trace for a goal activated through the UI today (Base mainnet pair, default env):

```
TRIGGER
  A tick fires — client heartbeat (60 s, tab visible, goal non-terminal) or
  POST /api/agent/autonomy/tick (SIWE session), or GET via an external scheduler/VPS with
  the CRON_SECRET bearer (see §9.5; no per-minute Vercel cron is registered).
  NOTE: vercel.json does NOT schedule this endpoint — see MC-4.
  Scheduler: flag check -> due-goal selection -> per-goal lease (SET-NX, 120 s)
  -> bounded fan-out (<=20/tick, <=5/wallet, <=3 concurrent).
        lib/autonomy/scheduler.ts:47, lib/autonomy/runtime.ts:88-118

POLICY
  1. Expiry housekeeping: goal.expiresAt passed -> EXPIRED.        runtime.ts:288
  2. OBSERVE: gateway.quote({chainId: executionChainId(adapter), taker: goal.wallet,
     sellToken, buyToken, sellAmountRaw, slippageBps clamped to the policy cap}).
     On the default adapter chainId = 8453, so MCP additionally requires
     MPGR_MCP_ENABLE_BASE_MAINNET=true, else BASE_MAINNET_DISABLED -> MCP_DISABLED.
     Failure -> parkWithFailure, goal WAITING/FAILED with bounded backoff.
     Audit: QUOTE_CREATED.                                          runtime.ts:300-320
  3. UNDERSTAND: evaluateCondition — bigint, decimals-aware. Empty/zero quote data
     => INVALID_CONDITION, never "met". No LLM anywhere in this file.
     Audit: CONDITION_CHECKED, then CONDITION_MET / CONDITION_NOT_MET.
     NOT MET -> WAITING, nextEvaluationAt = now + cooldownSeconds. STOP.
                                                                        runtime.ts:322-345
  4. POLICY CHECK: evaluatePolicyAgainstAction against the LIVE day ledger
     (dailySpendRaw, actionsToday). Rejects on revoked / disabled / expired policy,
     expired goal, chain mismatch, action not permitted, token mismatch,
     over per-trade / daily / slippage / action-rate.
     Audit: POLICY_REJECTED (-> parked) or POLICY_APPROVED.         runtime.ts:347-385

AUTHORIZATION / DELEGATION   <-- THE GATE THAT STOPS IT TODAY
  5. Emergency stop short-circuits here: MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true
     -> { authorized:false, reason:"EMERGENCY_DISABLE" }.
     Otherwise adapter.checkAuthorization(goal.wallet, decision.policy).
     Audit: AUTHORIZATION_CHECKED.                                   runtime.ts:386-391
  6. Not authorized -> park(): CAS ACTIVE|WAITING -> WAITING,
     lastResult.outcome = AUTHORIZATION_MISSING (or EXECUTION_UNAVAILABLE under the
     kill switch), nextEvaluationAt = now + cooldownSeconds.
     >>> STOP. Nothing below this line is reached. <<<               runtime.ts:392-401

EXECUTION ADAPTER   (unreachable today)
  7. claimExecution(`exec-${goalId}:${nextEvaluationAt}`) SET-NX, 86 400 s guard.
     Duplicate -> DUPLICATE_PREVENTED, parked, never re-submitted.   runtime.ts:404-412
  8. tryRecordDailyAction — atomic append-capped ledger claim; null -> POLICY_REJECTED.
  9. Quote freshness re-check at broadcast time: expired -> QUOTE_STALE, nothing sent.
 10. CAS ACTIVE|WAITING -> EXECUTING (loser releases its claim).     runtime.ts:426-437
 11. Prepare: mainnet/v1 path -> gateway.prepare(quoteId, "APPROVAL") producing an
     UNSIGNED transactionRequest; delegated path skips v1 prepare (PHASE 5 F-9) because
     preparation IS the adapter's re-validation of the signed slot.
     Audit: TRADE_PREPARED.                                          runtime.ts:439-460
 12. adapter.executeSwap(UNSIGNED request + quote snapshot + idempotencyKey).
     Delegated adapter re-checks: operational posture -> LIVE verifyOnChain -> chain
     84532 -> policy -> selectDelegatedSlot (unrevoked, unconsumed, owner binding,
     exact token/amount binding, live-quote minOut >= SIGNED floor, actionId ==
     delegatedActionId(goalId), policyHash == policyHashFor(policy), deadline) ->
     route exists -> markConsumed BEFORE broadcast -> gateway.delegateSwap ->
     MPGRExecutorDelegated.swapOnBehalfOfUniswapV3 -> operator broadcaster.

TRANSACTION
 13. On txHash: CAS -> EXECUTING with pendingExecution{txHash, quoteId, idempotencyKey,
     expected/minBuyAmountRaw, expectedSender = broadcaster for the delegated path},
     stats.triggered += 1, nextEvaluationAt = now + 30 s.
     Audit: TRANSACTION_SUBMITTED. Action record: SUBMITTED/PENDING_VERIFICATION.
                                                                        runtime.ts:496-520

VERIFICATION
 14. verifyPending on the next tick(s): verifyExecution via MCP — receipt status,
     tx.from == expected sender/taker, tx.to == executor, EXACTLY ONE SwapExecuted log
     for the intentId, amountOut >= minOut, exact 25 bps fee to the pinned recipient.
     VERIFIED            -> completeVerified: stats.verified += 1, WAITING (or COMPLETED
                            at maxTrades). Audit TRANSACTION_CONFIRMED, EXECUTION_VERIFIED.
     PENDING_VERIFICATION-> retry, 10 attempts x 30 s; budget exhausted -> UNCERTAIN.
     TX_REVERTED / mismatch -> FAILED honestly, backoff, 5 consecutive -> goal FAILED.
     UNCERTAIN           -> TERMINAL. Goal FAILED, pendingExecution cleared,
                            NEVER re-broadcast. Audit GOAL_FAILED(UNCERTAIN_BROADCAST).
                                                                        runtime.ts:120-280
```

**Where your goal stops today: step 6.** Steps 7-14 are unreachable.

---

## 4. The exact missing capabilities

Identified, not worked around. Each is stated with the precise reason and the fix that
*would* be required. **At the time of writing none were applied; all four were subsequently
implemented — see [§9](#9-remediation-what-was-built-on-top-of-this-audit).**

### MC-1 — No Base Sepolia policy can be created through the API (blocks the delegated path entirely)

`normalizePolicyInput` hardcodes `chainId: AUTONOMY_CHAIN_ID` = **8453**
(`lib/autonomy/policy-engine.ts:177`, `lib/autonomy/types.ts:31`), and `resolveExecutorToken`
resolves tokens **only** from `MPGR_EXECUTOR_DEPLOYMENTS[BASE_MAINNET_CHAIN_ID]`
(`lib/autonomy/api-helpers.ts:48,62`). But:

- `POST /api/agent/autonomy/authorization` requires `policy.chainId === 84532`
  (`route.ts:159-162`) → **`400 POLICY_CHAIN_MISMATCH`**;
- `AgentAutonomyPanel.tsx:306` requires `policy.chainId === 84532` for `eligibleGoals`, and
  renders `null` when that list is empty → **the "Sign slots with wallet" form never appears**.

`app/api/agent/autonomy/policy/route.ts:92` is the **only** production caller of
`createPolicy` (every other caller is a test constructing the store directly). Therefore
**delegated execution capability cannot be attached to any goal a user can create in the
product.** Test A4 proves this with a *genuinely user-signed*, otherwise-perfect Permit2
witness slot (correct owner, `actionId == delegatedActionId(goalId)`,
`policyHash == policyHashFor(policy)`, future deadline, signature recovering to the session
wallet): it is still refused `POLICY_CHAIN_MISMATCH`, and zero slots are stored.

*Fix would require:* an explicit, separately-reviewed way to mint an 84532 policy over the
delegated token allowlist (plus a Sepolia token source for `resolveExecutorToken` and the
`/tokens` picker). This is a product decision, not a bug to patch silently.

### MC-2 — No Mainnet execution adapter exists

Covered in Q5. The registry can only yield the refusing adapter or the Sepolia-only adapter.
*Fix would require:* the operator go/no-go and the signing-mechanism decision already listed
in `docs/PHASE6-MAINNET-AUDIT.md` §12 (a real Mainnet adapter, a dedicated Mainnet
broadcaster key, a dedicated Mainnet RPC). Deliberately not done here.

### MC-3 — The delegated adapter's on-chain posture is never warmed (chicken-and-egg)

`DelegatedExecutionAdapter.checkStatic()` returns `{authorized:false,
reason:"ONCHAIN_CHECK_PENDING"}` whenever the 60 s posture cache is cold
(`delegated-execution-adapter.ts:105`). The cache is populated **only** by `verifyOnChain()`,
whose **only** production caller is `executeSwap()` (`:148`) — which the runtime reaches only
*after* `checkAuthorization()` returned `authorized: true`. Nothing in
`lib/autonomy/index.ts#build()` and no API route calls `verifyOnChain()`.

Consequence: even with `MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-sepolia` **and**
`MPGR_BROADCASTER_PRIVATE_KEY` set **and** MC-1 fixed, a cold server would park every goal at
`AUTHORIZATION_MISSING (ONCHAIN_CHECK_PENDING)` and `autonomyStatus().executionAvailable`
would stay `false` — so the panel would keep reading "not configured". Pinned by tests
**B3b** (both cases, including the real production-shaped adapter with no injected
broadcast/chain).

This is fail-closed and therefore *safe*, but it means the delegated path is inert even when
an operator believes they configured it. *Fix would require:* a warm-up call at bootstrap or
at the top of the authorization stage (with an explicit decision about the 60 s TTL), which
is an execution-logic change and is **not** made here.

### MC-4 — No scheduler is wired for the tick (operational, not a security issue)

`vercel.json` schedules only `/api/games/mpgr-run/settlement` and `.../reconcile`. There is
no cron for `/api/agent/autonomy/tick`, which `docs/AUTONOMY.md` lists as *"(Recommended)"*.
So goals are evaluated only while the user's tab is open (60 s heartbeat). This is why the
goal still reads `ACTIVE / 0 triggered` rather than `WAITING / Authorization missing`.

---

## 5. Security assessment

| Property | Status |
|---|---|
| Activation performs no on-chain write | ✅ proven (A1, B6) |
| Activation performs no ERC-20 approval | ✅ proven (A1, A2, B6) |
| SIWE ≠ token approval; no type confusion | ✅ proven (A2, A3) |
| `ACTIVE` cannot broadcast without a capability | ✅ proven, 3 layers (B1-B4, B7) |
| No mainnet autonomous execution path exists | ✅ proven (B3, B7, Q5) |
| Kill switch fires pre-authorization | ✅ proven (B5) |
| Refusals are honest and surfaced, never silent | ✅ proven (B2, B3, B5) |
| No key material in autonomy modules or responses | ✅ pre-existing suite + A1/A2 |
| Uncertain broadcasts are terminal, never re-sent | ✅ pre-existing `runtime.test.ts` |

**Residual risk: LOW.** The realistic worst case today is *user confusion* — a goal that
reads "ACTIVE" while being permanently watch-only — not unauthorized execution. The
recommended remedy is disclosure, not enablement: the panel should say plainly that a goal
is observing only while `executionAvailable` is false, and the `NOT CONFIGURED` line should
name the missing piece.

---

## 6. Recommendations (none applied — all require an explicit product/operator decision)

1. **Do not** enable execution to make the UI look successful. The current UI is truthful.
2. Make watch-only status explicit in the panel: when `config.executionAvailable === false`,
   label `ACTIVE` goals as *"Observing only — no execution capability configured"* and show
   the refusal reason from `lastResult` prominently.
3. Decide MC-1: either (a) ship an explicit Base Sepolia policy/picker path so the delegated
   capability is reachable, or (b) hide the "Delegated execution · Base Sepolia" section
   entirely until it is, so users are not shown a control that can never render.
4. Decide MC-3 before any delegated go-live: add a posture warm-up at bootstrap or in the
   authorization stage, and re-examine the 60 s TTL against the tick interval.
5. MC-4 for unattended operation: provision an external scheduler/VPS to call
   `GET /api/agent/autonomy/tick` once per minute with `Authorization: Bearer
   <CRON_SECRET>`; Vercel Hobby cannot host this cadence (see §9.5).
6. Keep MC-2 closed pending the `docs/PHASE6-MAINNET-AUDIT.md` §12 operator gates and
   `docs/MAINNET-CANARY-RUNBOOK.md`.

---

## 7. Evidence

New, additive test files (no production code touched):

| File | Tests | Covers |
|---|---|---|
| `app/api/agent/autonomy/activation-route-audit.test.ts` | 10 | A1 activation = 2 off-chain writes, no tx/approval/broadcast, response hygiene · A2 SIWE-only credential, `authorizationRef` shape + non-echo, 401 fail-closed, session-wallet binding · A3 explicit `authorized: true`, `POLICY_REQUIRED` · A4 policy is always 8453 + a genuinely signed slot is refused `POLICY_CHAIN_MISMATCH` + zero slots stored |
| `lib/autonomy/__tests__/activation-flow-audit.test.ts` | 19 | B1 production default posture + `executionAvailable === false` · B2 trigger MET → `AUTHORIZATION_MISSING`, parked, no tx (incl. 6 consecutive ticks) · B3 fully-capable warmed adapter still refuses an 8453 policy; configured+installed via the production seam the mainnet goal never broadcasts (`TOKEN_NOT_ALLOWED`) · B3b cold posture cache refuses; `executionAvailable` stays false with the adapter env **and** broadcaster key set · B4 policy-engine chain separation both directions · B5 emergency stop · B6 source boundary (routes + the `authorizeGoal` slice) · B7 registry fail-closed on unknown/uninstalled ids and on rogue installs |

Gates run for this audit:

```
npx vitest run            -> 243 files passed | 4 skipped, 2513 tests passed | 17 skipped, 0 failed
npx tsc --noEmit          -> clean
npx eslint .              -> 0 errors, 60 warnings (unchanged baseline; the two new files add none)
```

The 17 skipped tests are the pre-existing env-gated suites (Phase 5 live Sepolia and the
Phase 6 fork/mainnet-canary rehearsals). **They remained skipped** — nothing was armed.

---

## 8. What was NOT changed

- No production source file was modified. `git status` shows only two new test files and
  this document.
- No feature flag, env default, or `.env.example` value was altered.
- No adapter was installed, registered, warmed, or made permissive.
- No chain gate, policy gate, authorization gate, idempotency guard, verification rule, or
  on-chain contract was touched.
- No transaction was signed or broadcast; no network call to any chain was made by this
  audit (all chain interaction is the pre-existing in-memory fake reader).
- The UI was not changed to display a different status.

---

## 9. Remediation — what was built on top of this audit

The audit found the activation flow to be **intentional and safe**, and identified four
missing capabilities (MC-1…MC-4) that together made a Base mainnet autonomous goal
watch-only forever. All four are now implemented on this branch. The goal was to make the
path genuinely executable **without moving any safety boundary**, so every change below is
either (a) a new fail-closed gate, or (b) a generalization of an existing gate from one
chain to two, with the original single-chain behaviour preserved exactly.

### 9.1 The decisive architectural constraint

`contracts/executor/MPGRExecutor.sol` (deployed on Base mainnet at
`0xD982726e28275661F8aB64054E6b17a70a63505A`) pulls tokens **only from `msg.sender`**
(`_pullFromTaker`) and `_validate` reverts `InvalidRecipient` unless `p.recipient ==
msg.sender`. It is therefore **structurally incapable of executing on behalf of a user**: an
operator broadcaster calling it would trade its own balance to itself. This is why mainnet
autonomous execution could not simply reuse the existing deployment, and why
`MPGRExecutorDelegated.sol` — already written, already deployed on Base Sepolia — is the
only viable architecture:

- **taker** = the recovered witness signer (`auth.witness.owner`), i.e. the user;
- **msg.sender** = a gas-only broadcaster that never holds or controls user funds;
- `_validate()` re-binds every signed field on-chain;
- two entrypoints: `swapOnBehalfOfUniswapV3(p, uint24 poolFee, auth)` and
  `swapOnBehalfOfSlipstream(p, int24 tickSpacing, auth)`.

### 9.2 MC-1 — chain-aware control plane (fixed)

Previously no 84532 policy could be minted and no 8453 policy could be authorized, so the
two halves could never meet. Now the chain is an explicit, validated, first-class field
end to end:

- `normalizePolicyInput` accepts an optional validated `chainId` (**omitted ⇒ 8453**, so
  existing clients and every prior test are unaffected; an unsupported value is a hard
  normalization error, never a silent default).
- `policyRegistryFor(chainId)`: 8453 ⇒ the deployed v1 mainnet registry (the same allowlist
  and route set the delegated mainnet executor mirrors); 84532 ⇒ the **delegated** Sepolia
  registry (each Sepolia deploy mints fresh test tokens, so the v1 Sepolia registry must not
  be used — PHASE 5 finding F-9).
- Token resolution, route existence, decimals, the token picker and the authorization route
  all resolve from the policy's **own** chain. Reading mainnet decimals for a Sepolia policy
  would have mis-scaled the parsed sell amount.
- **Chain binding is now three-way and cryptographic**, not a single comparison: the slot
  record, the Permit2 EIP-712 domain `chainId` the user signs, and `policyHash` (whose
  canonical tuple carries `uint256 chainId`). `selectDelegatedSlot` and
  `validateNewSlotAgainstPolicy` additionally require `slot.chainId === policy.chainId`.
- The recovery digest is computed over the policy's chain with **that chain's** pinned
  executor as the Permit2 spender, so the recovered signer is bound to
  `(wallet, chain, executor)` — not merely to a wallet.

### 9.3 MC-2 — Base mainnet execution adapter + bounded hot wallet (fixed)

**One class, two instances.** `DelegatedExecutionAdapter` now takes `chainId` in its
constructor (default 84532), *declares* `chainId` on the adapter interface, and derives its
`id` from the chain — so the runtime never infers a chain from an id string. The mainnet
path reuses the identical safety machinery rather than forking it.

**The executor address is operator-pinned, never guessed.** `MPGR_MAINNET_DELEGATED_EXECUTOR`
has no hardcoded default. Because that address is operator-supplied rather than code-pinned,
mainnet posture verification is deliberately **stricter** than Sepolia's. All of the
following must hold on-chain or the adapter refuses:

| Check | Sepolia | Mainnet |
|---|---|---|
| bytecode present at executor and at canonical Permit2 | ✅ | ✅ |
| `feeBps() == 25` | ✅ | ✅ |
| `PERMIT2() == 0x0000…8BA3` | ✅ | ✅ |
| `WITNESS_TYPE_STRING()` exact | ✅ | ✅ |
| `owner() == 0xE0e0…486e` (MPGR governance) | — | ✅ |
| `feeRecipient() == 0x96F7…64A4` | — | ✅ |
| `paused() == false` | — | ✅ |
| both policy tokens in `isTokenAllowed()` | — | ✅ |

**Two independent operator keys.** `MPGR_BROADCASTER_PRIVATE_KEY` (84532) and
`MPGR_MAINNET_BROADCASTER_PRIVATE_KEY` (8453) are separate, so a compromised or
misconfigured testnet key can never gain mainnet reach. The broadcaster resolves **per
chain**; a chain with no key gets a refusing stub.

**Hard canary separation.** The mainnet broadcaster refuses `MPGR_MAINNET_CANARY_PRIVATE_KEY`
and any key deriving to `0xBF6c574b9543967f0D528ae49603b0A7574a280b` outright, so the
one-shot armed canary test can never be promoted into production infrastructure. A source
boundary test asserts that **exactly one** production file reads that env var, and only to
refuse it.

**The bounded hot wallet** (`lib/delegated/broadcast-gate.ts`). An operator gas-payer on
mainnet is a real hot wallet, so it is bounded *structurally, before signing*: the gate
re-decodes the exact calldata the key is about to sign and re-verifies it against the user's
own witness. It refuses (no signature, no broadcast) on: unsupported chain; `to` ≠ the
pinned executor for that chain; any non-zero `msg.value`; any selector other than the two
`swapOnBehalfOf*` entrypoints; decode failure; witness `owner`/`buyToken`/`minAmountOut`/
`deadline`/`actionId`/`policyHash` mismatch; owner ≠ policy wallet; `recipient` ≠ owner;
`intentId`/`deadline`/`amountOutMinimum`/`tokenOut` mismatch; permit token ≠ `tokenIn`;
permit amount ≠ `grossAmountIn`; calldata permit ≠ stored permit; non-positive amounts;
committed fee ≠ canonical `floor(gross × 25bps)`; or a lapsed deadline. It is pure (no I/O,
time injected) and returns a verdict instead of throwing, so a refusal can never be
mistaken for an infrastructure fault. This is defence in depth **on top of** the on-chain
`_validate`, and it is what makes the operator key useless for anything but a user-authorized
swap. The two allowed selectors are **derived from the ABI**, never hand-written, so the gate
and the encoder cannot drift.

> Permit2 semantics note: `TokenPermissions` describes the **sell** side (the token and
> amount pulled *from* the user) while the witness floors the **buy** side. The gate binds
> `permit.token == params.tokenIn` and `permit.amount == params.grossAmountIn` accordingly —
> together these are the two economic bounds the user actually signed.

**Venue is derived, never chosen by the caller.** On mainnet the router and pool key come
from the chain's own delegated registry: USDC↔WETH via Uniswap V3 fee 3000, USDC↔each B20
stock via Aerodrome Slipstream `tickSpacing` 10. The previous UniswapV3-only encoding could
never have expressed a mainnet B20 trade. A caller-supplied router that disagrees with the
registry is refused (`ROUTE_MISMATCH`).

### 9.4 MC-3 — cold-cache posture bootstrap (fixed)

The chicken-and-egg is broken in two places, and **neither makes the adapter optimistic**:

1. `checkStatic()` on a cold/stale cache still returns `ONCHAIN_CHECK_PENDING` for the
   *current* tick — never `true` — but now also kicks a **single-flight background warm-up**,
   so the posture is proven by the next tick. Previously the cache could only be warmed by
   `executeSwap()`, which the runtime reaches only *after* `checkAuthorization()` said yes:
   unreachable on a cold server.
2. `bootstrapPosture()` is awaited eagerly from the composition root and from the tick route
   *before* evaluation, so a cold instance's **first** tick is a real evaluation rather than
   a park. It is single-flight, TTL-cached (60 s), never throws, and a failed bootstrap
   leaves the adapter refused.

### 9.5 MC-4 — external scheduler handoff (Hobby-compatible)

`vercel.json` deliberately does **not** register `/api/agent/autonomy/tick`: Vercel Hobby
supports only daily cron jobs, while MC-4 requires the existing 60 s evaluation cadence.
Do not replace the minute cadence with an hourly/daily Vercel schedule. To evaluate while a
user is away, an operator-provided external scheduler/VPS must call
`GET /api/agent/autonomy/tick` once per minute with
`Authorization: Bearer <CRON_SECRET>`. Keep the secret out of URLs and logs. The GET route
requires the timing-safe bearer check and has no session fallback; POST keeps its original
dual behaviour. The endpoint is ready, but provisioning and monitoring the external
scheduler is a separate operational prerequisite.

Execution still cannot run while autonomous mode is disabled: the route 404s on the feature
flag before any evaluation, and the runtime parks without a policy *and* a valid user-signed
authorization slot.

### 9.6 Boundaries explicitly preserved

Nothing below was loosened, bypassed or re-implemented; all are covered by passing tests:

- per-trade cap, daily cap, `maxActionsPerDay`, `maxTrades`;
- slippage bounds and quote-freshness at broadcast time;
- authorization expiry (slot deadline checked at selection **and** again before broadcast);
- idempotency (`claimExecution`) and CAS status transitions;
- emergency disable, checked at every tick and before every action;
- receipt verification (`EXECUTION_VERIFIED` only on a confirmed, fully-matching receipt);
- uncertain/reverted handling — `UNCERTAIN` is terminal, the slot stays consumed, and a tx is
  **never** re-broadcast;
- the user's private key never reaches the server; no server-side custodial signing of user
  transactions (`privateKeyToAccount` appears in exactly one production file, the operator
  gas-payer broadcaster);
- Base Sepolia behaviour is byte-for-byte unchanged (its pinned venue, its check set, its
  env key, its adapter id, and all pre-existing Sepolia tests).

### 9.7 Tests added for the remediation

| File | Tests | Proves |
|---|---|---|
| `lib/autonomy/__tests__/mainnet-delegated-execution.test.ts` | 20 | the complete mainnet stage chain, and every refusal broadcasts nothing |
| `lib/delegated/__tests__/broadcast-gate.test.ts` | 25 | the bounded hot wallet: the allowed case plus every single-field mutation refused |
| `lib/delegated/__tests__/broadcaster-separation.test.ts` | 13 | per-chain key separation, hard canary refusal, and the key-reading source boundary |

The positive path asserts the **full ordered audit chain** on Base mainnet:
`QUOTE_CREATED → CONDITION_CHECKED → CONDITION_MET → POLICY_APPROVED → AUTHORIZATION_CHECKED
→ TRADE_PREPARED → TRANSACTION_SUBMITTED → TRANSACTION_CONFIRMED → EXECUTION_VERIFIED`,
ending in `COMPLETED` with `triggered == 1`, `verified == 1`, one broadcast on chain 8453 to
the pinned executor carrying the Slipstream selector and zero native value.

Negative cases, **each asserting zero broadcasts**: no authorization (parked
`AUTHORIZATION_MISSING`); wrong chain (a Sepolia slot against a mainnet policy); wrong
wallet; expired authorization; amount above authorization; wrong token; wrong action id;
daily cap exceeded (`POLICY_REJECTED`); stale quote; emergency stop; duplicate concurrent
tick (at most one broadcast); adapter unavailable / executor unpinned
(`EXECUTOR_NOT_CONFIGURED`); unverifiable posture (paused, wrong owner, disallowed token,
RPC error, no bytecode); uncertain broadcast (never re-broadcast, terminal `FAILED`, slot
stays consumed); and broadcast failure.

**No real mainnet transaction is sent by any test.** The new suites contain no
`createWalletClient`, `createPublicClient`, `http()` or `fetch()` at all — the chain is a
fake reader, the posture view is a fake, and the broadcaster is a spy that records calldata
and mines a synthetic receipt. The pre-existing live/canary suites remain env-gated and
still skipped (17 skipped, nothing armed).

### 9.8 Audit tests updated in place (gaps → remediated behaviour)

Three audit assertions pinned the *gaps* and therefore had to change. None was weakened;
each now asserts a stronger property:

- **A4** previously proved a genuinely user-signed witness slot was refused
  `POLICY_CHAIN_MISMATCH` — that *was* MC-1. It now asserts both halves of the fix:
  unpinned ⇒ refused `DELEGATED_EXECUTOR_NOT_CONFIGURED` with nothing stored or broadcast
  (a user must never sign for a contract that does not exist); pinned ⇒ the same genuinely
  user-signed 8453 slot **is** accepted and stored chain-bound to 8453, still with zero
  broadcasts (accepting an authorization remains an off-chain write); plus a new case proving
  a slot signed for the wrong chain's executor is still refused.
- **B3b** (cold cache) rewritten: it still asserts the no-optimism half of the original
  contract (cold ⇒ `ONCHAIN_CHECK_PENDING` for that tick, and a correctly-chained policy
  still refused while cold), and now additionally asserts the single-flight warm-up (three
  concurrent bootstraps ⇒ exactly one chain pass), that `index.ts` and the tick route really
  do warm the posture *before* evaluating (asserted on source, so a refactor cannot silently
  reintroduce the chicken-and-egg), and that an unprovable posture caches a refusal
  (`RPC_ERROR`) rather than flipping optimistic. The block grew from 2 to 4 tests, taking
  `activation-flow-audit.test.ts` from 19 to 22. Its `productionShaped` case now injects a
  chain view so the MC-3 warm-up cannot reach a real RPC from the test suite.
- **B6/B7** updated for the widened install guard (both delegated ids, and the new
  configured-vs-installed mismatch refusal). The B6 source-boundary grep was **not**
  weakened — a comment in the policy route was rephrased instead so the strict grep still
  holds.
- `phase6-mainnet-audit.test.ts` §B previously pinned "mainnet is not a delegated chain".
  It now pins the real cross-chain property in **both directions**: a Sepolia slot can never
  authorize a mainnet policy and a mainnet slot can never authorize a Sepolia policy
  (`CHAIN_MISMATCH`), even when owner, tokens, amount, `policyHash` and deadline all match —
  with a sanity case proving a slot on its *own* chain with those exact fields **is**
  accepted, so the refusals are chain-specific rather than a fixture that could never
  authorize anything.
- `delegated-quote` / `hardening-quotes-verify`: using the **Sepolia** executor on 8453 now
  yields the more precise `EXECUTOR_NOT_CONFIGURED` instead of `UNSUPPORTED_CHAIN`; a
  genuinely non-delegated chain still yields `UNSUPPORTED_CHAIN` (newly asserted).

### 9.9 Verification

- Full suite: **246 files / 2576 tests passed, 0 failed**, 17 skipped (pre-existing
  env-gated live + canary suites; nothing armed). Baseline at the audit commit was 2513,
  so **+63 tests** (58 new + 5 audit tests rewritten in place to assert more).
- Autonomy / delegated / MCP / executor / agent-API suites in isolation: **51 files / 610
  passed, 17 skipped, 0 failed**, with **zero unhandled errors and zero network I/O**.
- `npx tsc --noEmit`: clean.
- `npx eslint .`: **0 errors**, 59 warnings (baseline 60 — one fewer, none new).

A full parallel run additionally reports 4 unhandled `TypeError: fetch failed` rejections
originating in `node_modules/@coinbase/agentkit/dist/analytics/sendAnalyticsEvent.js`,
attributed by Vitest to `lib/architecture/agentkit/__tests__/invoke.test.ts`. That file is
**byte-identical to the audit commit `872e77f`** (untouched by this work), passes cleanly in
isolation, and the call is third-party SDK telemetry — it is pre-existing and unrelated to
the autonomy, delegated or mainnet execution code. No autonomy or delegated test performs
any network call.

### 9.10 Operator checklist to enable mainnet autonomous execution

Mainnet execution stays **off** until an operator explicitly completes all of the following.
Every one is fail-closed, so a partial configuration leaves goals watch-only rather than
half-executable.

1. Deploy `MPGRExecutorDelegated` to Base mainnet (the v1 `MPGRExecutor` cannot be reused —
   see §9.1) and verify its source.
2. Set `MPGR_MAINNET_DELEGATED_EXECUTOR` to that address. The server then proves it live:
   bytecode, governance `owner`, `feeRecipient`, `feeBps == 25`, canonical `PERMIT2`,
   exact `WITNESS_TYPE_STRING`, `!paused`, and the policy tokens allowlisted (§9.3).
3. Set `MPGR_MAINNET_BROADCASTER_PRIVATE_KEY` to a **dedicated** operator gas wallet that is
   not the canary key and does not derive to `0xBF6c574b…280b`. Fund it with ETH for gas
   only — it never needs to hold user funds, because Permit2 pulls from the user.
4. Set `MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-mainnet`. The configured id must
   match the installed adapter or startup refuses.
5. Provision an external scheduler/VPS to call `GET /api/agent/autonomy/tick` once per
   minute with `Authorization: Bearer <CRON_SECRET>`; see §9.5. Vercel Hobby does not
   register this per-minute cron.
6. Leave `MPGR_AUTONOMOUS_AGENT_ENABLED=true` and `MPGR_AUTONOMOUS_EMERGENCY_DISABLE` unset;
   the emergency stop remains the immediate kill switch.

Even with all six, a goal executes only when the user has separately signed a bounded
authorization slot for **that** chain, wallet, token pair, amount and deadline — and the
bounded hot-wallet gate re-verifies all of it against the calldata before the operator key
signs.

### 9.11 Subsequent typed-module and Mainnet preflight status (2026-10-05)

The tables above are the verification record for the earlier remediation snapshot; they must
not be read as test results for later changes. This branch now contains a fixed-selector,
code-hash-pinned typed-module path alongside the two built-in venue paths. See
[`docs/EXECUTOR-ARCHITECTURE-DECISION.md`](EXECUTOR-ARCHITECTURE-DECISION.md) for its trust
boundary, config state, deployment/recording sequence, and current blockers. The Mainnet config
still has `mainnetDelegatedDeployEnabled: false`, and `typedModules` is empty. Neither value was
changed to make the deployment script pass.

GitHub Actions CI run `37226740107` succeeded at commit
`127424c7f22cc207259f26140f6d850e9e5e8ab3`; its `contracts`, `contracts-fork`, `quality`,
`build`, `slither`, and `secret-scan` jobs passed. The contracts check recorded Foundry
`1.8.4` (`50af4efe189dc64bad2b75ed6990b835de66c4ae`) and released Solidity
`0.8.24+commit.e11b9ed9.Linux.g++`, with OpenZeppelin `v5.4.0` and forge-std `v1.9.7`.
This validates the code and tests at that commit, not a live delegated deployment. Manual
workflow dispatch and GitHub Environment secret/variable enumeration remain denied with HTTP
403; detailed raw job-log download returned EOF. No secret values were requested or printed.
`BASE_MAINNET_RPC_URL` is unavailable in this workspace, so there is no secure-runner
`eth_chainId`, deployer nonce, or secret-presence result. The exact Mainnet Forge simulation
was **not** run; there is no predicted address or deployment artifact. No Mainnet transaction,
deployment, activation, or canary occurred. Do not infer go-live readiness from historical
application test totals or the CI green status.

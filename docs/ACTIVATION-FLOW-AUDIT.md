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

---

## 1. What the UI state you saw actually means

| UI line | Real meaning | Source |
|---|---|---|
| `Goal ACTIVE` | A goal row exists in Redis and its policy is live. **No execution capability is implied by this status.** | `app/api/agent/autonomy/goals/route.ts` (`status: policyLive ? "ACTIVE" : "DRAFT"`) |
| `0 triggered · 0 verified` | No evaluation has ever reached a broadcast. Correct and expected. | `goal.stats` |
| `No transaction hash` | Nothing was submitted. `pendingExecution` is `null`. | `publicGoal()` |
| `Delegated Execution · Base Sepolia: NOT CONFIGURED` | `autonomyStatus().executionAvailable === false`, i.e. the resolved adapter's `canDelegate` is false. **This is a truthful fail-closed signal, not a UI bug.** | `AgentAutonomyPanel.tsx:253`, `lib/autonomy/index.ts` |

One nuance worth knowing: `ACTIVE` is the *pre-first-evaluation* state. There is **no cron
scheduled for the tick endpoint** (`vercel.json` schedules only the two `mpgr-run`
settlement jobs), so evaluation happens only via the 60 s client heartbeat while the tab is
visible, or a manual/cron `POST /api/agent/autonomy/tick`. After the first tick the goal
will read `WAITING` with:

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
  POST /api/agent/autonomy/tick (SIWE session, or Vercel Cron + CRON_SECRET).
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
*would* be required (none applied).

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
5. Decide MC-4: schedule `POST /api/agent/autonomy/tick` with `CRON_SECRET` if goals should
   evaluate while the user is away.
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

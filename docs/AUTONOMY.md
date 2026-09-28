# MPGR AGENT — Autonomous Runtime (Phase 3) — Final Report

Additive, flag-gated autonomous agent runtime. **Default OFF.** Assisted
(user-signature) trading is byte-identical when the flag is off. This
document is the 21-item final report required by the Phase 3 specification,
followed by an operator runbook.

Branch: `arena/01a0e784-mpgr-hub` · PR: `feat: add safe autonomous agent runtime`

---

## The 21 items

### 1. Architecture map (what was added, where)
One additive module — `lib/autonomy/` (16 files, ~3.2k lines incl. tests) —
plus six flag-gated API routes under `app/api/agent/autonomy/`, two small UI
surfaces, and one type addition. Production modules were touched only to
*carry* data, never to change behavior:
`lib/architecture/core/types.ts` (+ `autonomy_audit` on `AgentEventMap`),
`lib/architecture/ai/ai-provider.ts` (+ optional `autonomyGoalDraft`),
`lib/architecture/ai/deterministic-ai-provider.ts` (+ one narrow branch),
`lib/agent-engine.ts` (+ optional message field, threaded), three chat
components (+ optional props/panel), `.env.example` (+ two flags).

### 2. Runtime loop
`runtime.ts` implements OBSERVE → UNDERSTAND → PLAN → POLICY CHECK → ACT →
VERIFY → REMEMBER → CONTINUE/WAIT: due-goal selection (scheduler), quote
fetch (MCP), deterministic condition evaluation (bigint, decimals-aware),
policy evaluation (live day counters), authorization check, execution-slot
claim (SET-NX idempotency, taken BEFORE the daily ledger), quote freshness
re-check, CAS → EXECUTING, prepare/execute via MCP, then verification with
bounded retries (10 × 30 s backoff). Pending verification runs even when
the flag is later switched off.

### 3. MODE A preserved (zero breaking changes)
MODE A (assisted) code paths are untouched: same tools, same routes, same
signing flow in `lib/trade/trade-execution.ts`. With
`MPGR_AUTONOMOUS_AGENT_ENABLED=false` (default): all autonomy routes 404,
the scheduler returns `disabled=true`, chat never drafts goals, and the UI
panel renders "Off until you activate a goal". Verified: full suite green
pre/post, lint output byte-identical to baseline.

### 4. MODE B authorization
Autonomous execution requires an explicit POST from an authenticated SIWE
session with `authorized: true` in the body (policy route) — nothing is
implied by chat text, UI state, or LLM output. Policies always expire
(mandatory `expiresAt`), cover exactly one token pair, and can be revoked
instantly (DELETE) or globally killed via
`MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true`.

### 5. Deterministic policy engine — LLM never the authority
`policy-engine.ts` validates/normalizes every value server-side: token pair
(executor-allowlist resolution only), per-trade/day caps (ceilings 10,000 /
100,000 human units), slippage 1–500 bps, actions (fixed `["swap"]`),
expiry, enabled flag. LLM- or client-supplied policy values are never
trusted: goals derive their trade spec from the POLICY, not the request;
conditions are evaluated with bigint math in `evaluateCondition`
(decimals-aware; empty/zero quote data ⇒ `INVALID_CONDITION`, never "met").

### 6. Typed goal model + strict state machine
`AgentGoal` with statuses DRAFT / ACTIVE / PAUSED / WAITING / EXECUTING /
COMPLETED / FAILED / EXPIRED / CANCELLED. `goal-machine.ts` + CAS
(scalar `status|updatedAt|wallet`) in both stores reject invalid
transitions (e.g. EXECUTING cannot reach PAUSED/CANCELLED;
PAUSED→EXECUTING is refused). `expiresAt` is not patchable; edits while not
executing are limited to cooldown / trade cap / maxTrades.

### 7. Existing seams reused — no duplicates
Audit events flow over the EXISTING `agentEventBus` (additive
`autonomy_audit` type); jobs through the EXISTING `agentTaskQueue`; goals,
policies, day ledgers and idempotency in the EXISTING Upstash Redis
(`lib/api/redis.ts`); scheduling joins the EXISTING Vercel Cron +
`CRON_SECRET` pattern; execution goes through the EXISTING MCP server. No
new event bus, queue, database, wallet, or scheduler was introduced.

### 8. MCP tools are the only execution interface
The runtime orchestrates `mpgr_get_quote` → `mpgr_prepare_trade` →
`mpgr_execute_swap` → `mpgr_get_trade_status` → `mpgr_verify_trade`
(`mcp-gateway.ts`). It never constructs transactions, never touches
contract ABIs directly, and never bypasses the MCP boundary (mainnet gate
in `lib/mcp/mcp-deps.ts` still applies).

### 9. No private keys, ever
The runtime holds no key material, signs nothing, and cannot sign: the
default execution adapter refuses with `AUTHORIZATION_MISSING`
(`canDelegate=false`, `executionAvailable` always false today). Signatures
happen only in the existing user-signature flow on explicit user Confirm.
The policy stores a non-secret `authorizationRef` (session id + truncated
hash) for provenance — never a key or delegate.

### 10. USER SIGNATURE vs AUTHORIZED AUTONOMOUS ACTION
Clearly separated in code and UI: autonomous jobs are typed
`DelegatedSwapRequest` (UNSIGNED MCP steps + quote snapshot + idempotency
key); audit events record `USER_SIGNATURE` flows and `AUTHORIZED_ACTION`
flows as distinct types; the UI labels autonomous goals as authorized
actions with limits and expiry, while proposals (trade/transfer/x402)
remain user-signature flows behind their own confirmation modals.

### 11. Idempotency everywhere
Every autonomous action, job, and notification carries an idempotency key
(`idempotency.ts`; quote id + goal id + eval slot). Execution slots are
claimed SET-NX **before** the daily-ledger increment; duplicate evaluations
park the goal (`DUPLICATE_PREVENTED`) and never re-submit; verification
claiming is likewise SET-NX.

### 12. Bounded retries + failure taxonomy
Exact spec codes: `QUOTE_FAILED, NO_LIQUIDITY, POLICY_REJECTED,
AUTHORIZATION_MISSING, APPROVAL_REQUIRED, USER_REJECTED, TX_REVERTED,
RPC_ERROR, VERIFICATION_FAILED, TIMEOUT`, plus explicit runtime additions
(`MCP_DISABLED, EXECUTOR_PAUSED, QUOTE_STALE, TOKEN_NOT_ALLOWED,
EXECUTION_UNAVAILABLE, DUPLICATE_PREVENTED, INVALID_CONDITION`).
Uncertain-broadcast codes (`TX_REVERTED, VERIFICATION_FAILED, TIMEOUT`)
are NEVER blindly retried: the runtime first checks whether the prior
transaction executed (verifyTrade: MAC, `tx.from==taker`, `tx.to==executor`,
exact `SwapExecuted` log, `amountOut≥minOut`); a verified prior execution
finalizes the goal instead of duplicating the swap. Retries: exponential
60 s → 3600 s cap, 5 consecutive failures ⇒ FAILED.

### 13. Receipt verification before success claims
A trade is only reported/executed-as-success after `mpgr_verify_trade`
confirms the on-chain receipt (executor address, taker, exact event,
min-out). Pending executions persist across ticks with bounded
verify-retries; UNCERTAIN verdicts finalize the goal as FAILED with
`GOAL_FAILED(UNCERTAIN_BROADCAST)` audit and a `recordAction(UNCERTAIN)`
entry — never claimed as success, never re-broadcast.

### 14. Audit trail
Every state change, policy event, authorization, evaluation outcome,
execution, and verification is appended to a capped (100/goal) audit log
with monotonic sequence numbers, mirrored to `autonomy_audit` on the
agentEventBus, and exposed (bounded projection) via the goals API.

### 15. Feature flag + emergency stop
`MPGR_AUTONOMOUS_AGENT_ENABLED` (default **false**) gates all routes, chat
drafting, the UI panel, and the scheduler. `MPGR_AUTONOMOUS_EMERGENCY_DISABLE`
overrides everything at the policy/runtime layer with zero deploy: goals
stop evaluating (pending verification still finishes safely), routes
report the kill state, and manual trading is unaffected.

### 16. Minimal UI
Exactly the spec's minimum, below the chat stage: mode display ("Off until
you activate a goal" / "Disabled by operator" / active count), goal list
with pause / resume / cancel / edit-limits (cooldown, trade cap — pair and
amount fixed by the policy), execution history per goal (outcome,
verified badge, BaseScan link, bounded to 5), authorizations with revoke,
and the single activation form. No raw MCP/RPC JSON is ever rendered; a
chat draft opens the panel pre-filled but authorization is always an
explicit button press.

### 17. Chat behavior (spec §20)
Clearly recurring / conditional phrasing ("Buy AAPLc whenever it falls
below $200") returns an explanation of the goal + limits + authorization
boundary and a REVIEW-ONLY draft card. Nothing auto-activates: no policy
POST, no execution, no silent upgrade of an assisted request — absent
valid authorization everything falls back to the user-signature flow. A
locked test proves one-shot swaps and balance questions are NOT captured
and still route to the unchanged assisted branches.

### 18. Tests added before enabling anything
86 autonomy-scoped tests across 9 files (policy engine decimals math, goal
machine illegal transitions, InMemory + Redis store CAS/audit-seq
monotonicity, runtime pipeline incl. duplicate prevention & uncertain
broadcasts, verification, scheduler caps/disabled mode, chat draft
matcher, security boundary: no keys / no signing / flag-gating), plus 4
provider-branch tests. Full suite: **199 files / 2095 tests, 0 failures**
(baseline 190/2009 → +9 files, +86 tests, no regressions).

### 19. Spec constraints honored
No changes to deployed contracts, production addresses, the 25 bps fee
arithmetic, the non-custodial boundary, fallback routes/providers,
campaigns/staking/token lock/Reward Hub/XP/leaderboards/games. Token
resolution uses the executor allowlist (no hardcoded registry beyond the
existing one; ambiguous name/symbol ⇒ ask, never guess). The 12-point
pre-swap checklist is enforced inside the runtime pipeline (resolve →
chain → fresh quote → route → fee → slippage → policy → authorization →
prepare → execute → verify → balances). No mainnet transactions were sent;
all tests use mocks/fixtures/local sims (existing read-only live tests
untouched).

### 20. Verification summary
`npx tsc --noEmit` clean · `npm run lint` 59 warnings / 0 errors
(byte-identical to the pre-change baseline — one targeted
`eslint-disable` with justification matches repo convention) · `npm test`
199 files / 2095 tests, 0 failures · `npm run build` succeeds with all six
autonomy routes registered (`/api/agent/autonomy/{config,policy,goals,
goals/[id],tick,tokens}`). Note: this sandbox cannot reach
fonts.googleapis.com, so the build was verified with a temporary,
reverted stub of the pre-existing `Inter` import in `app/layout.tsx` —
the committed diff contains no font change.

### 21. Known limitations / next steps
v1 ships WATCH-ONLY execution: goals evaluate, notify (audit + goal
`lastResult`), and park with `EXECUTION_UNAVAILABLE` when reaching the
adapter, because no delegated-signing adapter exists (by design —
enabling autonomous broadcast requires a future, separately-reviewed
adapter bound to the same policy engine). Suggested next steps, all
behind the same flag: wire the tick to a Vercel cron schedule when
enabling, add a notification channel (existing tape/notification seam),
and consider per-goal slippage overrides within policy bounds.

---

## Operator runbook (when / if enabling)

1. Set `MPGR_AUTONOMOUS_AGENT_ENABLED=true` in the deployment env.
2. (Recommended) schedule `POST /api/agent/autonomy/tick` with the
   existing `CRON_SECRET` header (Vercel Cron, like settlement/reconcile).
   In-session users also get a bounded 60 s client heartbeat.
3. Users authorize per pair via the Autonomous Goals panel: explicit
   "Authorize & activate goal" creates the policy (limits + expiry) then
   binds the goal. Revoke or pause at any time; the global kill switch is
   `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true`.
4. Audit: every goal's audit trail is queryable via the goals API and
   mirrored on the agent event bus.

## File inventory

Added: `lib/autonomy/{types,config,policy-engine,goal-machine,idempotency,
store,redis-store,execution-adapter,mcp-gateway,verify,audit,runtime,
scheduler,chat-draft,index,api-helpers}.ts`, `lib/autonomy/__tests__/` (8
test files + helpers), `app/api/agent/autonomy/**` (6 routes),
`components/features/agent/AgentAutonomy{Panel,DraftCard}.tsx`,
`hooks/useAgentAutonomy.ts`,
`lib/architecture/ai/__tests__/deterministic-autonomy-fallback.test.ts`,
this document.
Modified (additive only): `lib/architecture/core/types.ts`,
`lib/architecture/ai/ai-provider.ts`,
`lib/architecture/ai/deterministic-ai-provider.ts`, `lib/agent-engine.ts`,
`components/features/agent/{AgentExperience,AgentChatWindow,AgentChatBubble}.tsx`,
`.env.example`.

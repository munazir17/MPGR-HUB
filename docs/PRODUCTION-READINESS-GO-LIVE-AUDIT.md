# PRODUCTION READINESS + GO-LIVE AUDIT — Autonomous Runtime on the Deployed Base Mainnet Delegated Executor

**Date:** 2026-10-08 · **Branch:** `arena/9987840c-mpgr-hub` · **Base commit:** `3c83497` (main)

**Scope discipline:** no deployed contract was modified or redeployed, no swap/fee/Permit2
money-path was changed, no real Mainnet transaction was sent, no private key was created,
read or logged, and `AUTONOMOUS_PRODUCTION_ENABLED` was NOT enabled anywhere. The smoke
workflow was NOT dispatched. The only functional change is the one missing production gate
the go-live checklist requires, plus tests and docs — everything else audited green and was
left untouched.

---

## A. AUDIT RESULT

The repository is a mature, multiply-audited autonomy stack (Phase 2 → 6 + MC-1..MC-4
remediations, hardening passes H-1..H-14, activation-flow audit). Every required production
gate below ALREADY EXISTS in code and is test-pinned, with **one exception**: an explicit,
single-purpose production gate named `AUTONOMOUS_PRODUCTION_ENABLED` did not exist (the
mainnet path was gated by a *combination* of `MPGR_AUTONOMOUS_AGENT_ENABLED` +
`MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-mainnet` +
`MPGR_MAINNET_DELEGATED_EXECUTOR` + `MPGR_MAINNET_BROADCASTER_PRIVATE_KEY` +
`MPGR_MCP_ENABLE_BASE_MAINNET`). That one gap is now implemented (see §B).

| # | Audited area | Where | Verdict |
|---|---|---|---|
| 1 | Autonomous/agent runtime | `lib/autonomy/{runtime,scheduler,store,redis-store,types,goal-machine}.ts` — OBSERVE→UNDERSTAND→PLAN→POLICY→ACT→VERIFY→REMEMBER loop; LLM appears nowhere in the execution path | ✅ |
| 2 | Trading execution path | `lib/trade/*` (assisted, user-signed) + `lib/mcp/mcp-trade-service.ts` (MCP quote/prepare/verify/delegateSwap) | ✅ |
| 3 | Delegated Executor integration | `lib/executor/delegated-executor.ts`, `lib/autonomy/delegated-execution-adapter.ts`; deployed Base mainnet contract `0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb` recorded in `deployments/base-mainnet/mpgr-executor-delegated.json`; operator-pinned at runtime via `MPGR_MAINNET_DELEGATED_EXECUTOR` (never hardcoded, never guessed) and proven live on-chain (owner, feeRecipient, feeBps==25, canonical Permit2, exact witness type string, unpaused, token allowlist, module posture) before any authorization is accepted | ✅ |
| 4 | x402 / payment integration | `lib/x402/*`, `app/api/x402/*` — fail-closed (503) without `X402_TAPE_PAY_TO`; untouched | ✅ |
| 5 | Policy / risk / authorization | `lib/autonomy/policy-engine.ts` (deterministic, bigint, server-normalized), `lib/autonomy/delegated-authorization.ts` (Permit2 witness slots, EIP-712 signature recovery against the SIWE wallet in `app/api/agent/autonomy/authorization/route.ts`) | ✅ |
| 6 | Base Mainnet RPC configuration | Runtime: `BASE_RPC_URL` (configured ⇒ exactly one transport; receipt-only public retry documented + tested in `lib/executor/executor-chain.ts`). Smoke CI: `BASE_MAINNET_RPC_URL` secret → `SMOKE_DELEGATED_RPC_URL`, https enforced, NO public fallback list, paced ≤10-block `eth_getLogs` walk, one request in flight | ✅ |
| 7 | GitHub Actions delegated smoke workflow | `.github/workflows/smoke-delegated-executor-base-mainnet.yml` — rehearse (fork, no key) → preflight (strictly read-only, no key) → live (environment `base-mainnet` required-reviewer approval, exactly ONE 0.50 USDC canary, one-shot ledger + deterministic single-use Permit2 nonce + on-chain SwapExecuted scan). Pinned by `test/workflows/smoke-delegated-executor-base-mainnet.test.ts` (37 tests) + `scripts/delegated-smoke-gates.test.ts` (324 tests). Not weakened | ✅ |
| 8 | Vercel production deployment & API routes | `vercel.json` (build + 2 game crons only); autonomy routes all present: `app/api/agent/autonomy/{config,policy,goals,goals/[id],tick,tokens,authorization}/route.ts`. Live Vercel project settings cannot be read from this sandbox — see §E for the name-only env checklist | ✅ (repo side) |
| 9 | Env vars / secrets usage | `.env.example` documents every variable; secrets are Vercel/GitHub-only; gitleaks config + `.gitleaksignore`; no secret values printed anywhere in this work | ✅ |
| 10 | Kill switch / pause / emergency | `MPGR_AUTONOMOUS_EMERGENCY_DISABLE` (checked inside the loop pre-action AND pre-slot-signing), goal PAUSE/CANCEL CAS, policy revoke, slot revoke, on-chain executor `pause()` (posture check refuses a paused executor) | ✅ |
| 11 | Audit / logging / idempotency / replay | Bounded audit trail (`lib/autonomy/audit.ts`, event bus + store, secrets unrepresentable in the type model); per-slot idempotency key claimed SET-NX before broadcast; atomic daily ledger; deterministic Permit2 nonces (`delegatedPermitNonce`); store refuses nonce reuse; Permit2 burns the nonce on-chain; uncertain broadcasts terminal, never re-submitted | ✅ |
| 12 | BUY and SELL paths | BUY (USDC→WETH Uniswap V3 fee 3000; USDC→B20 Slipstream tickSpacing 10) and SELL (reverse legs of the same unordered registered routes) both expressible through policy/goal/slot; BUY+SELL round trip proven on the Base-mainnet fork rehearsal (`lib/autonomy/__tests__/phase6-fork-rehearsal.test.ts`, CI-green) and now ALSO offline for the delegated mainnet path (§D) | ✅ |
| 13 | agentFee BUY and SELL | Fee is ALWAYS `floor(grossSellAmount × 25 / 10 000)` of the SELL leg, taken inside the swap by the executor (`lib/executor/executor-fee.ts`, `lib/trade/trade-agent-fee.ts`); committed as `expectedFeeAmount` and re-checked by the broadcast gate (FEE_MISMATCH) and on-chain; verified from the real `SwapExecuted` event after the fact | ✅ |
| 14 | User authorization / delegation flow | SIWE session → policy (limits+expiry+authorizationRef) → goal → user-signed Permit2 witness SLOTS (bounded: exact token/amount/minOut/deadline/actionId/policyHash, ≤5 slots, ≤30-day TTL) → single-use consumption. The AI/server never sees a user key; the operator broadcaster is a gas-only, structurally bounded hot wallet (`lib/delegated/broadcast-gate.ts`) that refuses the canary key/address outright | ✅ |
| 15 | Slippage / deadline / allowlists / spend limits | Slippage 1–500 bps (policy cap clamps the goal before quoting; signed minOut floor can never be weakened); deadlines checked at slot signing, selection, broadcast time and pre-sign gate; token allowlist = executor registry + the contract's OWN on-chain `isTokenAllowed`; router/route allowlist = registered routes only (caller can never choose a router); per-trade + per-day + per-day-action caps with atomic ledger claims; absolute runtime ceilings (10 000 / 100 000 sell-units) | ✅ |
| 16 | **Explicit production gate `AUTONOMOUS_PRODUCTION_ENABLED`** | **WAS MISSING — implemented by this change (§B)** | ⚠️→✅ |

Executor invariants preserved (verified, untouched): chainId 8453 · Permit2
`permitWitnessTransferFrom` flow · existing delegated calldata (three pinned selectors only) ·
25 bps fee model · existing swap routing/venues · existing BUY/SELL behavior · existing
slippage/decimal handling · existing wallet flow · **the executor is never granted an ERC-20
allowance** (the smoke gate treats a non-zero `allowance(wallet → executor)` as a failure; the
only allowance in the whole design is the user's one-time `USDC.approve(Permit2, 500000)`).

## B. CHANGES MADE

Only the missing gate + its tests/docs. No working system was rebuilt.

| File | Change | Why |
|---|---|---|
| `lib/autonomy/config.ts` | Added `AUTONOMOUS_PRODUCTION_GATE_ENV` + `isAutonomousProductionEnabled()` (default **false**; only exact `"true"`, trimmed/case-insensitive, opens it) | The required explicit production gate, fail-closed when missing/false |
| `lib/autonomy/delegated-execution-adapter.ts` | `checkOperational()` refuses Base-mainnet adapters with `PRODUCTION_GATE_DISABLED` when the gate is not open (before executor/broadcaster/chain I/O); header checklist updated | Gate enforcement at the runtime's execution seam — `checkAuthorization`/`checkStatic`/`executeSwap` all refuse; goals stay watch-only |
| `lib/mcp/mcp-trade-service.ts` | `delegateSwap()` refuses chain 8453 with `PRODUCTION_GATE_DISABLED` when the gate is not open (ordered after the executor-pin check so the frozen Phase-6 refusal taxonomy is preserved) | Defence in depth at the ONE broadcast chokepoint — no code path reaches a mainnet delegated broadcast without the gate |
| `lib/autonomy/mcp-gateway.ts` | Mapped `PRODUCTION_GATE_DISABLED` → `EXECUTION_UNAVAILABLE` (non-retryable capability refusal, not an RPC fault) | Honest failure taxonomy in the runtime |
| `lib/autonomy/index.ts` | `autonomyStatus()` exposes `productionGate` (public boolean, no secrets) | UI/config endpoint reports the gate honestly |
| `.env.example` | Documented `AUTONOMOUS_PRODUCTION_ENABLED=false` with the full fail-closed contract | Operator-visible configuration |
| `docs/AUTONOMY.md` | §15 gate description + operator runbook step 5 (mainnet go-live order, ending with the gate) | Runbook accuracy |
| `lib/autonomy/__tests__/production-gate.test.ts` | **NEW — 16 tests**: flag semantics; every adapter seam refuses gate-OFF with zero broadcasts and an unconsumed slot; runtime parks honestly; pulling the gate after a proven posture stops the next tick; gate-ON isolates the gate as the only blocker; Sepolia unaffected; `delegateSwap` chokepoint both chains; status surface; no secret leakage | Pins every required gate behaviour |
| `lib/autonomy/__tests__/mainnet-delegated-execution.test.ts` | Suite opens the gate explicitly (operator-mirroring); **NEW offline SELL test**: AAPLc→USDC through the same delegated machinery with the fee proven to be `floor(sell × 25 bps)` of the SELL-side `fromAmount` (and NOT of the buy side), receipt-verified to COMPLETED; receipt miner generalized for direction | Task-required SELL-path + agentFee-SELL + fee-from-correct-fromAmount coverage in the deterministic (non-fork-gated) suite |
| `lib/mcp/__tests__/delegated-module-route.test.ts` | Mainnet typed-module broadcast test opens the gate explicitly (encoding proof, unchanged semantics) | Keeps the existing proof working under the new gate |
| `app/api/agent/autonomy/autonomy-routes-security.test.ts` | Response-hygiene key allowlist += `productionGate` (asserted boolean) | The pin enumerates allowed public fields; the new field is a flag |

Explicitly NOT changed: deployed contracts, `contracts/`, smoke workflow YAML, smoke scripts,
Permit2 design, fee math, routing registries, the assisted/user-signed trade path, x402,
Vercel env, any secret, `MPGR_AUTONOMOUS_AGENT_ENABLED` defaults, and the one-time
`USDC.approve(Permit2, 500000)` operator action (still manual — nothing in code, CI, Vercel,
Arena or the agent creates it; preflight only REPORTS it).

## C. SECURITY GATES (execution order for a Base-mainnet autonomous trade)

1. `MPGR_AUTONOMOUS_AGENT_ENABLED=true` (master flag; default false → every route 404s)
2. `MPGR_AUTONOMOUS_EMERGENCY_DISABLE` not set (kill switch, checked in-loop pre-action)
3. **`AUTONOMOUS_PRODUCTION_ENABLED=true` (NEW explicit production gate; default false → `PRODUCTION_GATE_DISABLED`)**
4. `MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-mainnet` AND the matching adapter installed (mismatch throws — fail-closed)
5. `MPGR_MAINNET_DELEGATED_EXECUTOR` pinned (`0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb`) + LIVE on-chain posture proof: code, canonical Permit2, feeBps==25, exact witness type string, owner==MPGR governance, feeRecipient==pinned, not paused, both policy tokens on the contract's own allowlist, typed-module posture when applicable (60 s TTL cache; cold cache ⇒ `ONCHAIN_CHECK_PENDING`, never optimistic)
6. Operator broadcaster configured (`MPGR_MAINNET_BROADCASTER_PRIVATE_KEY`; the canary key/address is refused outright)
7. Wallet/user authorization: SIWE session-bound policy (chain-bound `policyHash`), goal bound to policy, user-signed Permit2 witness slot (exact token/amount/minOut/deadline/actionId/policyHash; EIP-712 signer recovery == session wallet; single-use; ≤5 slots; ≤30-day TTL)
8. Deterministic policy engine: token pair == policy pair (allowlisted, registered route), per-trade cap, daily spend cap, daily action cap (atomic ledger), slippage ≤ policy cap (clamped before quoting), chain == policy chain
9. Fresh quote at broadcast time (stale ⇒ `QUOTE_STALE`, nothing sent); quote expires ⇒ refusal
10. Idempotency: per-evaluation-slot key claimed SET-NX (86 400 s guard) before broadcast; deterministic Permit2 nonce per (goal, slotIndex); consumed slot can never re-spend; duplicate ⇒ `DUPLICATE_PREVENTED`
11. Broadcast gate (`lib/delegated/broadcast-gate.ts`): re-decodes the EXACT calldata before the operator key signs — chain, pinned executor, one of three selectors, zero native value, witness==user authorization, recipient==owner==policy wallet, intentId/deadline/minOut/tokenOut==witness, permit==calldata permit, canonical fee re-derivation, deadline in the future
12. Verification: receipt facts from the chain (executor event, taker, tokens, gross, EXACT fee to feeRecipient, out ≥ min, broadcaster `expectedSender`, event `intentId == delegatedActionId(goal)`); pending ⇒ never success; uncertain ⇒ terminal FAILED, never re-broadcast
13. Audit: every decision appended (bounded), no secrets representable in the event model

There is no unsafe fallback anywhere in this chain: every refusal is explicit, auditable and
terminal for that slot; the default adapter (`none`) refuses everything; unknown adapter ids
throw; the server never holds a user key and never falls back to one.

## D. BUY / SELL EXECUTION VERIFICATION

* **BUY (USDC → AAPLc, Base mainnet delegated):** offline end-to-end in
  `mainnet-delegated-execution.test.ts` (quote → condition → policy → slot → Slipstream
  calldata → broadcast → receipt → VERIFIED → COMPLETED, ordered audit chain) and on a real
  Base-mainnet anvil fork in `phase6-fork-rehearsal.test.ts` (CI-green, exact 25 bps fee
  reconciled from the real `SwapExecuted` event).
* **SELL (AAPLc → USDC):** NEW offline test in `mainnet-delegated-execution.test.ts` —
  same machinery, mirrored pair: `tokenIn=AAPLc`, `tokenOut=USDC`,
  `expectedFeeAmount == floor(100000000 × 25 / 10 000) = 250000` (AAPLc units — the SELL-side
  `fromAmount`, explicitly asserted NOT to equal 25 bps of the buy-side amount), signed minOut
  floor preserved, recipient == user, intentId == `delegatedActionId(goal)`, receipt-verified
  to COMPLETED with the SELL-side fee in the action record. Fork-level SELL round trip remains
  proven by the Phase-6 rehearsal.
* **agentFee:** `lib/trade/__tests__/trade-agent-fee.test.ts` (21 tests: exact 25 bps from
  `fromAmount`, floor-never-up, decimals-correct display, executor-only application, no
  separate fee transaction ever, tamper refusals) + fork fee reconciliation + the delegated
  `FEE_MISMATCH` refusals in `hardening-quotes-verify.test.ts` / `broadcast-gate.test.ts`.

## E. VERCEL PRODUCTION VERIFICATION

This sandbox has no Vercel access (no connected Vercel integration/token), so the live
project settings could not be read. Repo-side verification (all ✅): `vercel.json` present
with the production build command and only the two game-settlement crons; all seven
autonomy API routes exist under `app/api/agent/autonomy/`; the tick route keeps its
mandatory timing-safe `CRON_SECRET` bearer check; the README documents "connect the GitHub
repo … deploy from `main`".

**Operator must confirm in the Vercel dashboard (Production scope, values never printed):**

1. Project is connected to `munazir17/MPGR-HUB` with **Production Branch = `main`**, and the
   latest Production deployment is from `main` (this PR must be merged first).
2. Required env vars exist **by name** (autonomous mainnet runtime):
   `MPGR_AUTONOMOUS_AGENT_ENABLED`, `MPGR_AUTONOMOUS_EMERGENCY_DISABLE`,
   `AUTONOMOUS_PRODUCTION_ENABLED`, `MPGR_AUTONOMOUS_EXECUTION_ADAPTER`,
   `MPGR_MAINNET_DELEGATED_EXECUTOR`, `MPGR_MAINNET_BROADCASTER_PRIVATE_KEY` (Sensitive),
   `MPGR_MCP_ENABLE_BASE_MAINNET`, `BASE_RPC_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`,
   `AUTH_SESSION_SECRET` (Sensitive), `APP_ORIGIN`, `CRON_SECRET` (Sensitive); optional:
   `MPGR_AGENT_FEE_RECIPIENT`, `ZERO_EX_API_KEY`, `MPGR_MCP_ALLOWED_ORIGINS`.
   Any missing ⇒ the corresponding capability fails closed and must be reported, not worked
   around. **Do not set `AUTONOMOUS_PRODUCTION_ENABLED=true` until the GO checklist below is
   complete** — this change deliberately leaves it off everywhere.
3. After merging + env changes: redeploy Production (NEXT_PUBLIC values are build-inlined).

## F. GITHUB / CI VERIFICATION

* All 17 workflow YAMLs parse cleanly (validated locally with js-yaml).
* Delegated smoke workflow intact and pinned by its own test suites (37 + 324 tests, green):
  rehearsal-first, read-only preflight, approval-gated live, exactly one 0.50 USDC canary,
  one-shot ledger + deterministic nonce + paced 10-block certified scan, single dedicated
  RPC (`BASE_MAINNET_RPC_URL` → `SMOKE_DELEGATED_RPC_URL`, https-only, no public fallback
  list, no parallel `eth_getLogs`). **Not dispatched by this work.**
* Required GitHub config for the smoke (names only): secrets `BASE_MAINNET_RPC_URL`,
  `BASE_MAINNET_DELEGATED_SMOKE_PRIVATE_KEY`; variable `SMOKE_DELEGATED_WALLET_ADDRESS`;
  environment `base-mainnet` with a required reviewer.
* `ci.yml` runs lint/typecheck/tests on PRs — this branch's PR exercises it.

## G. TEST RESULTS

* `npm ci` — clean.
* `npx tsc --noEmit` — clean (exit 0).
* `npm run lint` — 0 errors / 59 warnings (byte-identical to the documented baseline).
* New/updated suites: `production-gate.test.ts` 16/16 ✅ · `mainnet-delegated-execution.test.ts`
  21/21 ✅ (incl. the new SELL path) · `phase6-mainnet-audit.test.ts` 19/19 ✅ ·
  `autonomy-routes-security.test.ts` 11/11 ✅ · `delegated-module-route.test.ts` 4/4 ✅ ·
  `activation-flow-audit.test.ts` 23/23 ✅ · smoke workflow tests 37/37 + gates 324/324 ✅.
* Full suite (`npm test`): **254 files passed / 4 file-skipped (258) · 3049 tests passed /
  17 skipped (3066) · 0 failed** (exit 0, 169 s). The skips are the pre-existing
  operator-armed suites: live Sepolia execution (1), disarmed mainnet canary (1), Phase-5
  preflight (9), Phase-6 fork rehearsal (6 — runs green in its dedicated CI workflow on a
  local anvil fork).

## H. REMAINING OPERATOR ACTIONS (manual, in order — none performed here)

1. Review + merge this PR; confirm the Vercel Production branch is `main` and redeploy.
2. Verify the §E env-var NAMES in Vercel Production (values never shared in chat/tickets).
   Set `MPGR_MAINNET_DELEGATED_EXECUTOR=0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb`,
   `MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-mainnet`; keep
   `AUTONOMOUS_PRODUCTION_ENABLED` **false/unset** for now.
3. Run the delegated smoke certification: label/dispatch
   `smoke-delegated-executor-base-mainnet` → rehearse → preflight → approve the `live` job.
   Before live: the ONE-TIME manual `USDC.approve(Permit2, 500000)` from the smoke wallet
   (exactly 500000 raw for the 0.50 USDC canary; never from code/CI/Vercel/Arena/agent; the
   executor itself is never approved).
4. Only after the smoke passes: fund/provision the operator broadcaster wallet
   (`MPGR_MAINNET_BROADCASTER_PRIVATE_KEY`, never the canary key), provision the external
   per-minute scheduler for `GET /api/agent/autonomy/tick` (`Authorization: Bearer
   <CRON_SECRET>`), then set `AUTONOMOUS_PRODUCTION_ENABLED=true` as the FINAL deliberate
   step and redeploy.
5. Keep `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` ready as the zero-deploy kill switch;
   pulling `AUTONOMOUS_PRODUCTION_ENABLED` also stops mainnet execution on the next tick.

## I. FINAL GO / NO-GO

**GO** on the code/runtime being production-ready **with the gate closed**:

* [x] Explicit production gate `AUTONOMOUS_PRODUCTION_ENABLED` implemented, default-off, fail-closed, enforced at BOTH the mainnet adapter and the broadcast chokepoint (new tests)
* [x] Wallet/user authorization (SIWE + user-signed Permit2 witness slots, server-recovered) before any execution
* [x] Token allowlist (registry + contract's own on-chain allowlist), router/route allowlist (registered routes only), spend caps, slippage caps, deadline checks, fee correctness, deterministic nonce/replay protection, per-slot idempotency, kill switch, stale/malformed/expired intent refusal, no unsafe fallback, no server-held user key, audit without secrets
* [x] Executor preserved: 8453, Permit2 flow, existing calldata/fee/routing/BUY-SELL/slippage/decimals/wallet flow; executor never approved
* [x] Smoke certification intact (rehearse → read-only preflight → approval-gated single 0.50 USDC canary; dedicated RPC; paced 10-block scan) and NOT dispatched
* [x] Full local gates green: `npm ci`, lint 0 errors, `tsc` clean, full vitest suite 0 failures, workflow YAMLs valid
* [ ] Operator: Vercel production branch/env verification (§E) — requires dashboard access
* [ ] Operator: smoke certification run + manual Permit2 approval (§H.3)
* [ ] Operator: final `AUTONOMOUS_PRODUCTION_ENABLED=true` (§H.4) — deliberately NOT done here

**NO-GO for live autonomous mainnet execution until the three operator boxes above are
checked.** Nothing in this change can execute on mainnet by itself; the live canary and the
final gate flip remain manual operator actions after PR review and merge.

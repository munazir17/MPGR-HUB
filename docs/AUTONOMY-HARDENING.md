# Autonomy Hardening — Phase 4 Adversarial Validation Report

**Status: CONDITIONAL PASS — no blockers for a guarded Phase 5 on Base Sepolia.**
Date: 2026-10-01 · Branch: `arena/01a0e784-mpgr-hub` · Baseline: `9d96869` (Phase 3 closed, CI green)

Phase 4 subjected the autonomous runtime to adversarial validation: authorization
mutation matrices, Permit2/replay/nonce semantics, concurrency races, restart
idempotency, quote/verification fail-closed proofs, policy boundary tables,
scheduler bounds, emergency-stop paths, broadcaster binding, secret hygiene,
audit integrity, and API/wallet-scoping security. **No existing test was
weakened or skipped.** Every finding below is disclosed.

---

## 1. Deliverables

| Artifact | Path |
| --- | --- |
| Hardening suites (9 files, 126 tests) | see §2 |
| Security findings report | §4 (this file) |
| Production-readiness checklist | §6 |
| Phase 5 blockers / prerequisites | §7 |

## 2. Test evidence

New hardening suites (all deterministic; Base Sepolia semantics on local fakes;
no live chain, no broadcaster calls, no Mainnet):

| Suite | Coverage | Result |
| --- | --- | --- |
| `lib/autonomy/__tests__/hardening-authorization.test.ts` | §2 authorization mutation matrix (every single-field mutation toward a broader auth), splice/segment attacks, pre-store validation, replay/duplicate-nonce, H-1/H-2 regressions, claim idempotency | 11/11 ✓ |
| `lib/autonomy/__tests__/hardening-concurrency.test.ts` | §4 slot/claim/revoke races, broadcast-failure-after-consume, duplicate ticks, cancel race; §12 emergency stop; §13 broadcaster calldata binding + max-loss model; §14 client-bundle hygiene | 14/14 ✓ |
| `lib/mcp/__tests__/hardening-quotes-verify.test.ts` | §6 quote/fee tampering + freshness, §7 broadcaster failure, §8 false-success verification matrix (wrong executor/sender/taker/token/amount/fee/feeRecipient/router/actionId/nonce, out<minOut, missing/forged event, `tx.to` ≠ executor) | 26/26 ✓ |
| `lib/autonomy/__tests__/hardening-policy-goals.test.ts` | §9 policy boundaries at exact limit−1/limit/limit+1 (per-trade, daily, slippage, action-rate) incl. BigInt ≥2⁵³; §10 exhaustive goal transition matrix; §15 audit ordering + no-secrets payloads + terminal-failure auditing | 10/10 ✓ |
| `lib/autonomy/__tests__/hardening-scheduler-idempotency.test.ts` | §5/§11 duplicate concurrent ticks, stale/expired leases, missed/delayed ticks, retry bounding (strictly-future retries, maxConsecutiveFailures), pause/resume, expiry, TTL claims, **restart-never-rebroadcasts**, emergency mid-flight | 11/11 ✓ |
| `app/api/agent/autonomy/autonomy-routes-security.test.ts` | §16 session enforcement on every verb, flag-OFF 404s, cross-wallet inspect/modify/revoke, cron-secret handling, bounded tick summary, response hygiene (no key material/RPC URLs), config/tokens projections, server-side wallet binding; **Round 2:** expired-SIWE semantics, malformed body → 4xx, duplicate goal creation scoping, GOAL_CREATED audit emission | 10/10 ✓ |
| `lib/executor/__tests__/hardening-invariants.test.ts` | §17 explicit invariants INV-1…INV-5 (single-use slots, deterministic nonce/actionId, policyHash pinning, integer-exact fee math, slippage monotonicity) | 11/11 ✓ |
| `lib/autonomy/__tests__/hardening-gaps.test.ts` | **Round 2:** §6 full RPC/tx classification matrix (10 verdict paths), §4 concurrent daily-cap + same-goal races via the scheduler's own batching, §2 actionId collision, §9 restart in ACTIVE/WAITING/FAILED, §3 duplicate goal creation, §14 full ordered audit chain | 24/24 ✓ |
| `lib/mcp/__tests__/hardening-boundaries.test.ts` | **Round 2:** §1 malformed signatures (6 shapes) fail closed pre-broadcaster; §12 assisted-path isolation (non-taker key → SIGNATURE_MISMATCH; delegated calldata bound to the delegated executor) | 9/9 ✓ |

### Full regression (§18)

| Gate | Result |
| --- | --- |
| `vitest run` (entire repo) | **223 files / 2321 tests passed**, 1 skipped (pre-existing env-gated) |
| `tsc --noEmit` | clean (0 errors) |
| `eslint .` | 0 errors; 59 warnings — byte-identical count to the unmodified baseline (all pre-existing, none introduced) |
| `npm run audit:high` | PASSED (unchanged known upstream-limited advisory, disclosed pre-Phase-4) |

### Mandate area → evidence map (round-2 audit)

| Mandate area | Evidence |
| --- | --- |
| 1 Authorization security | `hardening-authorization` (11) + fixtures; malformed sigs at the delegated boundary in `hardening-boundaries` (6 shapes → `INVALID_AUTHORIZATION`, broadcaster never called) |
| 2 Replay/nonce/slot safety | `hardening-authorization` replay/dup-nonce; `hardening-concurrency` races; `hardening-invariants` INV-1; actionId collision (`hardening-gaps` §2/§4) |
| 3 Idempotency | `claimExecution` single-winner + TTL (`hardening-scheduler-idempotency`, `hardening-gaps` §3); duplicate goal creation disclosed (route mints fresh ids — F-8) |
| 4 Concurrency | same-goal concurrent eval (lease), two-worker slot races, duplicate ticks, pause/cancel vs execute, **concurrent daily-limit consumption proven race-free** (atomic `tryRecordDailyAction` pre-broadcast claim: 2 evaluated → 1 broadcast, `hardening-gaps` §4) |
| 5 Quote safety | `hardening-quotes-verify` §6 (stale/expired/tamper/fee/RPC); signed-minOut immutability (INV-2); quote-freshness at broadcast (`QUOTE_STALE`) |
| 6 TX/RPC failure matrix | `hardening-gaps` §6 — 10 classification paths over `verifyExecution`: UNCERTAIN/TIMEOUT on budget exhaustion, RPC_ERROR→PENDING, TX_REVERTED→FAILED, VERIFICATION_FAILED with named checks, defense-in-depth minOut check; uncertain never re-broadcast (`hardening-scheduler-idempotency` restart + `runtime.test`) |
| 7 Verification integrity | `hardening-quotes-verify` §8 (26) — wrong sender/taker/executor/token/amount/fee/feeRecipient/router/actionId/nonce, out<minOut, missing/forged event, tx.to≠executor |
| 8 Policy boundaries | `hardening-policy-goals` §9 (limit−1/limit/limit+1 for max-trade, daily, slippage, action-rate; token/chain/action restrictions; expiry edges; BigInt ≥2⁵³) |
| 9 Goal state machine | `hardening-policy-goals` §10 exhaustive matrix; restart in EXECUTING (`hardening-scheduler-idempotency`), ACTIVE/WAITING/FAILED (`hardening-gaps` §9) |
| 10 Scheduler | `hardening-scheduler-idempotency` (duplicate/missed ticks, strictly-future retries, caps, pause/resume, expiry, stale/expired leases, restart, no storms) |
| 11 Emergency shutdown | `hardening-concurrency` §12 (idle/mid-flight/concurrent) + flag-OFF 404s (`autonomy-routes-security`) |
| 12 Broadcaster security | `hardening-concurrency` §13 calldata binding + max-loss model; `hardening-boundaries` §12 (assisted-path cryptographic isolation) |
| 13 Secret isolation | git-history + worktree scans clean; client-bundle test (`hardening-concurrency` §14); audit/route payload hygiene (`hardening-policy-goals` §15, `hardening-gaps` §14, routes suite) |
| 14 Audit integrity | full ordered success chain QUOTE_CREATED→…→EXECUTION_VERIFIED with no secrets (`hardening-gaps` §14); terminal-failure auditing (`hardening-policy-goals` §15); GOAL_CREATED route emission (routes suite) |
| 15 API isolation | `autonomy-routes-security` — cross-wallet goal/authorization/policy/revoke, expired-SIWE 401, malformed body 4xx, duplicate-creation scoping, cron-secret tiers |
| `npm run build` | fails in this sandbox at `next/font/google` (**pre-existing**: identical failure on the unmodified base commit — sandbox egress blocks `fonts.googleapis.com`; CI with network is the authority and was green at `9d96869`) |
| Secret scan | clean — see §5 |

## 3. Fixes landed in Phase 4 (behavior changes, each with regressions)

### H-1 (MEDIUM — fixed): slot resurrection in both stores
`saveSlots` could overwrite an existing slot record under its deterministic id
(`slot-<policyId>-<goalId>-<index>`), resurrecting a CONSUMED or REVOKED
authorization.
- `InMemoryDelegatedAuthorizationStore.saveSlots` now throws on overwrite of a consumed/revoked slot.
- `RedisDelegatedAuthorizationStore.saveSlots` performs a best-effort pre-SET
  consumed/revoked check with nonce-key rollback on conflict. The Lua CAS
  consume remains the authoritative single-use gate (Phase 5: fold the check
  into the Lua script itself).

### H-2 (HIGH — fixed): unbound `witness.actionId` in slot selection
`selectDelegatedSlot` never bound the SIGNED `witness.actionId` to the slot's
goal. It now requires `actionId === delegatedActionId(slot.goalId)` (else
`ACTION_MISMATCH`), aligning host-side selection with the executor's on-chain
`InvalidWitness` check. Three existing fixture files were updated to carry
goal-bound actionIds (correctness-only; no assertion weakened).

### H-3 (resolved — not a vulnerability): `tx.to` ≠ executor is fail-closed
An initial hardening test reported `verified=true` for a receipt whose `to` was
not an executor. Root-caused: **two independent fail-closed paths exist** —
(a) registry selection uses the receipt's executed contract as a FACT; a
non-executor `to` selects the v1 registry, whose allowlist rejects the
delegated tokens → hard `TOKEN_NOT_ALLOWED` refusal; (b) even when a registry
is selected, `verifyExecutorReceipt` pins `tx.to == intent.executor`
(`executor-verify.ts:67`) → `verified:false`. The test was corrected to accept
either failure shape (hard refusal or `verified:false`); no production code
change was needed.

## 4. Findings (complete list — nothing hidden)

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| H-1 | MEDIUM | Slot resurrection via `saveSlots` overwrite (consumed/revoked) | **FIXED** (both stores; Lua migration deferred) |
| H-2 | HIGH | `witness.actionId` not bound to slot goal in host-side selection | **FIXED** (`ACTION_MISMATCH`) |
| H-3 | — | Reported false-success on `tx.to` ≠ executor | **RESOLVED: not a bug** (dual fail-closed paths, §3) |
| F-4 | LOW | Transient evaluation failures (quote/RPC parks) are not individually audit-emitted; only the terminal `GOAL_FAILED` is. Goal `lastResult` carries the detail, so operator visibility exists, but the event stream is thinner than the mandate's ideal. | Documented; candidate Phase 5 additive audit event in `parkWithFailure` |
| F-5 | LOW | Delegated path performs no host-side EIP-712 `ecrecover`: `delegateSwap` validates signature *shape* (65-byte hex) and defers cryptographic verification to Permit2 on-chain (`permitWitnessTransferFrom` → `InvalidSignature` revert, no state change on failure). Consequence: a user-supplied malformed/forged signature burns one broadcaster-gas attempt and keeps the slot consumed (uncertain-broadcast safety) — self-harm only, since the signature must be the slot owner's own. | Documented; optional Phase 5 pre-flight `recoverTypedDataAddress` to avoid doomed broadcasts |
| F-6 | INFORMATIONAL | `delegatedPolicyHash` V1 pins policyId, wallet, chain, token pair, `maxPerTradeRaw`, `maxSlippageBps`, `expiresAt` — but **not** `maxDailyRaw`/`maxActionsPerDay`. Safe today because those caps are enforced live from the store at every evaluation, and any policy mutation changes the stored policy snapshot the slot must match; per-trade size is independently pinned by the signed `permit.amount`. | Documented; include daily caps if a V2 witness format is ever staged (requires explicit approval — contract witness type is frozen) |
| F-7 | INFORMATIONAL | `evaluationLeaseSeconds` TTL takeover means two workers *can* evaluate the same goal sequentially after a lease expires mid-evaluation; safety holds because broadcast-gating is the `claimExecution` idempotency key (SET-NX), not the lease. | Documented (by-design layering; verified by tests) |
| F-8 | LOW | Store-level `createGoal` with an explicit duplicate id silently overwrites (both stores). NOT client-reachable — the goal route always mints a fresh id — and execution safety is unaffected (idempotency claims + slots bound the broadcast). Defense-in-depth candidate: refuse duplicate goal ids at the store seam. | Documented; regression test pins current behavior (`hardening-gaps` §3) |

**Round-2 verification of the daily-cap under concurrency (mandate §4):** the scheduler's production batching (`Promise.all` within a tick) was probed with two goals sharing one policy capped at 1 action/day. Result: **both goals evaluated, exactly ONE broadcast, the loser parked `POLICY_REJECTED`** — the runtime's atomic pre-broadcast `tryRecordDailyAction` claim (append-capped ledger, Lua-backed in Redis) closes the check-then-act window by design. No overage exists; a regression test now pins this (`hardening-gaps` §4).

No BLOCKER findings remain. No finding weakens the non-custodial boundary, the
signed-binding immutability, or the single-execution-per-slot property.

## 5. Secret hygiene (§14)

- Tracked files: no private-key-shaped literals (only a JWT-detector test string in `trade-jwt.test.ts`).
- Full git history (`git log --all -p`): zero additions of key-shaped literals; `MPGR_BROADCASTER_PRIVATE_KEY` never appears with a value anywhere in history.
- Workflows reference only `secrets.*` names (GitHub-injected); broadcaster key exists solely as the `MPGR_BROADCASTER_PRIVATE_KEY` secret in the `base-sepolia` environment.
- Audit/event payloads: lifecycle suites assert no key material, no 65-byte signatures, no mnemonics; route suites assert no CRON/broadcaster secrets in any response body; `publicPolicy`/`publicGoal` projections never echo wallet-secret material.
- Client bundle hygiene assertions included in the concurrency suite (§14).

## 6. Production-readiness checklist

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Autonomous default OFF (`MPGR_AUTONOMOUS_AGENT_ENABLED=false` in `.env.example:176`; true only in tag-gated `live-delegated.yml:66`) | ✅ unchanged |
| 2 | Emergency stop blocks new execution; in-flight verification completes; revoke stays available | ✅ proven (§12 + §16) |
| 3 | One slot ⇒ ≤1 successful execution; replay/duplicate/concurrent all fail closed | ✅ proven |
| 4 | Signed bindings (token/amount/minOut/deadline/nonce/actionId/policyHash) immutable post-authorization | ✅ proven (H-2 closed the last host-side gap) |
| 5 | Fee model 25 bps, BigInt-exact, FeeRoundsToZero mirrored host-side | ✅ proven (`executor-config.ts:61` unchanged) |
| 6 | Uncertain broadcast never re-broadcast; slot stays consumed | ✅ proven |
| 7 | Bounded scheduler (strictly-future retries, caps, no storms) | ✅ proven |
| 8 | Goal machine exhaustive legal/illegal matrix | ✅ proven |
| 9 | Wallet-scoped API; SIWE fail-closed; cross-wallet rejected server-side | ✅ proven |
| 10 | No secrets via API/UI/logs/bundles/git history | ✅ scanned clean |
| 11 | Scope protection: assisted/manual flow, fee model, contracts, Mainnet paths, Vercel env untouched (`lib/executor/executor-fee.ts`, `lib/trade/`, `contracts/` byte-identical) | ✅ verified |
| 12 | Full green regression without weakened/skipped tests | ✅ 2284 passed |

## 7. Phase 5 prerequisites / blockers

**Blockers: none.** Prerequisites before Phase 5 (operator-side, in order):

1. Explicit operator approval to run Phase 5 on Base Sepolia only (contracts frozen at v1 deployments; no redeploy).
2. Decide (optional, non-blocking): fold H-1's pre-SET check into the Redis Lua script; add `parkWithFailure` audit event; add host-side ecrecover pre-flight (F-5). All three are additive code changes — none is required for safety on Base Sepolia.
3. CI must be green on the Phase 4 commit (sandbox `npm run build` is egress-blocked on Google Fonts; CI is authoritative).
4. Any Mainnet enablement remains out of scope and requires a separate explicit approval + its own adversarial pass.

## 8. Explicit invariants (§17 quick reference)

- **INV-1** one slot ⇒ at most one successful execution (consume CAS; selection refuses consumed/revoked/expired).
- **INV-2** signed bindings immutable + deterministic (nonce ≡ f(goalId, slotIndex); actionId ≡ f(goalId); policyHash pins policy snapshot).
- **INV-3** fee = floor(gross × feeBps / 10⁴), BigInt-exact, ≤ 25 bps configured cap, dust refused.
- **INV-4** revoked/expired authorizations can never execute.
- **INV-5** emergency stop + feature flag gate every new execution; verification of an already-broadcast tx still completes.
- **INV-6** uncertain broadcast outcomes are never re-broadcast; verification-first, bounded attempts.

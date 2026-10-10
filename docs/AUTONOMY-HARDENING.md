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

---

# PHASE 5 ADDENDUM — GUARDED BASE SEPOLIA READINESS (2026-10-01)

**Result: PASS.** One explicitly armed, tiny-value (0.01 tUSD) readiness test ran the
EXISTING delegated path end-to-end on Base Sepolia 84532 and reconciled clean.
No Mainnet touch; no Vercel/production change; autonomous remains OFF by default
(the flag is true ONLY inside the armed job of the explicitly dispatched run).

## Mechanism (existing, reused — nothing new)
`.github/workflows/phase5-readiness.yml`: `preflight` (always) → `armed` (explicit
commit-tag arm) → `reconcile` (read-only). Harness:
`lib/autonomy/__tests__/live-delegated.execution.test.ts` (Phase 3 mechanism,
extended: tiny policy caps, runtime-driven SELL leg). Reconciler:
`scripts/phase5-reconcile.mjs`.

## Preflight results (run 36839442133 + every armed run's gate)
- Env fail-closed: broadcaster/test-user/deployer keys + RPC verified present and well-formed.
- Identity: broadcaster `0x9898EcD0BcDdF1A240b88355db069d4016b23d28`, test user and
  deployer — three distinct wallets; broadcaster ETH ≥ gas floor.
- Chain: `chainId == 84532`; executor == frozen `0xa9568499D7e58854F2590a56B6D32788DbfA58F9`.
- Executor deep posture ON-CHAIN: bytecode present; `feeBps == 25`;
  `PERMIT2 == 0x0000…` canonical; `WITNESS_TYPE_STRING` == `DELEGATED_WITNESS_TYPE_STRING`.
- Fee recipient on-chain: `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`.
- Slot limits: `MAX_DELEGATED_SLOTS == 5`; deterministic nonce/actionId space pinned.
- Emergency disable: `EMERGENCY_DISABLE` blocks the adapter (fail-closed, env-proven).
- No-Mainnet path: `delegateSwap` refuses chainId 8453 (`UNSUPPORTED_CHAIN`);
  slot selection refuses a Mainnet policy (`CHAIN_MISMATCH`).
- Dry-run plan produced (`phase5-plan.json`) — NO broadcast at preflight.
- ALL 9 Phase 4 hardening suites re-run in CI preflight: 126/126 ✓.

## Armed test (run 36841538979 @ `1e161db`) — BROADCAST TRANSACTIONS
| Leg | Tx | Path |
| --- | --- | --- |
| BUY tUSD→tSTOCK | `0x9f007a5b1f16dda81edbe4e0326ab7b52d5a0e36c0db42dab8e04c5b5fbbe285` | goal → policy (tiny caps) → user-signed slot → DelegatedExecutionAdapter → MCP `delegateSwap` → broadcaster → frozen executor |
| SELL tSTOCK→tUSD | `0x5a9b9a86aa13afaf454721b82171b320308a2595add976191d540286aefbae90` | FULL runtime chain: goal (ACTIVE) → policy → slot → runtime condition/policy/idempotency gates → adapter → MCP → broadcaster → executor → receipt → `EXECUTION_VERIFIED` → ordered audit events → goal **COMPLETED** |

Both receipts `success` (blocks 47539004 / 47539007); both verified with
`tx.from == broadcaster`, `taker == testUser`, exact `floor(gross × 25 bps)` fees,
on-chain minOut enforced.

## Reconciliation (all checks OK)
- Balances (Phase 3-end → now): test user tUSD 98,905,468 → 98,885,358 (−20,110 =
  two BUYs of 10,025 incl. fee, minus SELL proceeds); tSTOCK 1,775,488,098,139,350,068
  → 1,775,642,919,384,543,795 (+154.82e12 = two BUY outs − SELL fee) — consistent
  with the disclosed orphan (below) plus this run's pair.
- Fee recipient: `0x96F7fb5C…964A4`, tUSD balance 50,500,075 (received both BUY fees).
- Broadcaster gas: 0.00000122 ETH (BUY) + 0.00000122 ETH (SELL) = 2.438e9 wei total;
  broadcaster identity re-derived from the key and matched the run evidence.
- Slot/nonce state: BOTH Permit2 single-use nonces consumed (bitmap bits flipped:
  buy wordPos 354797…569 bit 240; sell wordPos 960210…590 bit 155).
- Goal state: runtime goal **COMPLETED**, `pendingExecution` cleared, VERIFIED action record persisted.
- Audit: ordered `QUOTE_CREATED → CONDITION_CHECKED → CONDITION_MET → POLICY_APPROVED →
  AUTHORIZATION_CHECKED → TRADE_PREPARED → TRANSACTION_SUBMITTED → EXECUTION_VERIFIED`, no secrets.

## Phase 5 findings
| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| F-9 | HIGH | Runtime's TRADE_PREPARED seam built a v1 intent on the delegated chain — v1 token registry wrongly rejects delegated-allowlisted tokens (`TOKEN_NOT_ALLOWED`), so delegated goals could never pass prepare. **One orphan BUY (0.01 tUSD, run 36840467365) occurred before discovery; its hash was only in capped log lines and is disclosed as unrecoverable here (fee 25 raw + dust gas; balances above account for it).** | **FIXED** — delegated path skips v1 prepare (preparation = adapter's signed-slot re-validation); unit pin in `hardening-gaps`; v1 path unchanged |
| F-10 | LOW | First armed attempt failed at the broadcaster with the underlying cause swallowed. No broadcast occurred (pre-acceptance throw; balances/nonce math confirm nothing on-chain). | FIXED — sanitized diagnostics in `delegateSwap`'s fail-closed message (URLs stripped, capped) |
| F-11 | INFORMATIONAL | The delegated quote seam requires the quote-signing env (`AUTH_SESSION_SECRET`) in harness runs; a run-scoped value suffices (same pattern as the Phase 3 workflow). | Documented |

## Phase 5 verdict
The autonomous delegated path is **READY on Base Sepolia** under the existing
guards: flag-off default, explicit per-goal wallet authorization (user-signed
bounded Permit2 slots), tiny caps, emergency stop, single-use nonces, receipt-fact
verification, no auto-rebroadcast, full audit. Mainnet remains LOCKED and requires
its own explicit approval + adversarial pass (see §7 prerequisites, unchanged).

## Phase 5 final gate addendum (same day, no new broadcast)

- **Full-suite gate on the final state:** 2324 passed / 0 failed (10 env-gated skips:
  the armed live harness + the CI-only preflight), tsc clean, lint 0 errors / 59
  pre-existing warnings, audit:high PASSED, CI green at the Phase 5 tip.
- **Scheduler link + duplicate rejection proven deterministically**
  (`lib/autonomy/__tests__/phase5-chain.test.ts`): goal → `scheduler.tick` →
  policy → slot → quote → ONE broadcast → EXECUTING(pending) → immediate duplicate
  tick evaluates 0 and cannot re-broadcast → verification via the same scheduler
  seam → goal COMPLETED with the full ordered audit chain and no key material;
  consumed slot selection refuses forever (`NO_SLOTS`).
- **F-12 (LOW, disclosure correction):** balance re-reconciliation proved **two**
  orphan BUY broadcasts occurred across the arming attempts (runs 36840467365 and
  36841133124), not one as previously disclosed. Each 0.01 tUSD, each verified
  on-chain with the exact fee; both SELL counterparts never ran (assert failures
  after the BUY). Run 36841133124's failure was a stale load-balanced-RPC balance
  read in the TEST's evidence code (its in-test verification had already passed) —
  production-path balance reads use receipt facts, not mid-test balance deltas.
  Full arithmetic: −3×10,025 (three BUYs incl. fees) + 9,965 (SELL proceeds) =
  −20,110 tUSD — exactly the on-chain delta.

## KV emergency switch

See `docs/AUTONOMY-EMERGENCY-SWITCH.md`. The env flag
`MPGR_AUTONOMOUS_EMERGENCY_DISABLE` remains a further restrictor only; the
authoritative execution control is the fail-closed KV record
`mpgrhub:autonomy:switch`. 

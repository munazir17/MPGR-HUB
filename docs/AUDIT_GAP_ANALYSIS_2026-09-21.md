# Audit Gap Analysis — 2026-09-21
# MPGR Run Game Rewards — mapping audit requirements to current implementation on origin/main (commit 2bb5e56)

This checklist was produced BEFORE any code changes in this branch, then updated with the single required fix (removal of external verifier wiring).

## 1. AUTHORITATIVE GAME VERIFICATION

| AUDIT REQUIREMENT | CURRENT CODE | STATUS | REQUIRED CHANGE |
|---|---|---|---|
| Preserve server-side authoritative deterministic replay | `lib/games/mpgr-run/authoritative-replay.ts` + `authoritative-verifier.ts` implement fixed 60Hz replay, seed-bound, tick-aligned, score recomputed | PASS | None — preserve |
| Client must never self-authorize via `verified`, `serverValidated`, `verificationVersion`, `authoritativeProofId`, `reward amount`, `XP amount`, `score`, `seed` | `app/api/games/mpgr-run/reward/route.ts` `isValidShape` only allows `sessionId`, `result`, `inputTrace`; score recomputed via `computeRunScore`; proofId generated server-side via sha256; wallet from session; extra fields ignored | PASS | None — verified via existing `route.security.test.ts` |
| Wallet identity from authenticated server session, not JSON | `authenticateRequest` used in reward, session, checkpoint, weekly-status; wallet derived from session; tests assert body wallet ignored | PASS | None |
| Server-issued session/seed binding, expiry, single-use, timing/heartbeat, replay verification | `server-session.ts`: random 32-byte seed, 15min TTL, `MAX_CONCURRENT_SESSIONS_PER_WALLET=3`, `consumedAt`, `heartbeatsCoverDuration`, `HEARTBEAT_MAX_GAP_MS=25s`; reward route checks age window `duration <= sessionAge+2s` and `sessionAge <=15min`, heartbeat coverage, then `verifyAuthoritativeRun` with seed | PASS | None |
| Do not replace authoritative verification with client validation | `validateRunResult` is sanity filter only; since Task 7 only passing replay grants XP/weekly facts in BOTH flag configs; settlement requires `verificationVersion=authoritative-v1` + proofId | PASS | None |

## 2. REWARD / SETTLEMENT SECURITY

| REQUIREMENT | CURRENT CODE | STATUS | REQUIRED CHANGE |
|---|---|---|---|
| Idempotency & duplicate-run protection | `kvAllocationStore.putRunRecordIfAbsent` uses `SET NX`; `consumeGameSession` frees slot; XP ledger uses `game:{sessionId}` event idempotency | PASS | None |
| Upgrade-only attestation | `RECORD_VALIDATED_RUN_SCRIPT` in `kv-allocation-store.ts`: `if ARGV[6] != "" then verificationVersion =`; empty never clears; same for proofId | PASS | None |
| Weekly eligibility | `MIN_VALID_RUNS_FOR_ELIGIBILITY=5`, `resolveEligibility`, `listEligiblePlayersForWeek` filters `eligible` | PASS | None |
| Weekly pool cap | `WEEKLY_POOL_CAP_RAW=35_000 MPGR`, `computeWeeklyPool` = min(cap, remainingBudget, availableBalance) | PASS | None |
| Per-player allocation cap | `MAX_SHARE_OF_WEEKLY_POOL_PER_PLAYER=0.2`, enforced in `computeAllocations` | PASS | None |
| Lifetime game-reward budget | `GAMES_LIFETIME_BUDGET_RAW=7_000_000 MPGR`, `remainingGamesBudget`, treasury ledger `recordTreasuryLedgerEntryOnce` idempotent | PASS | None |
| Live-season checks | `vaultSeasonLookup.resolveActiveVaultSeasonId` checks `exists` + `finalized` via `seasonExists`/`getSeason`; settlement aborts if missing | PASS | None |
| Reward Manager authorization | `rewardVaultAdminClient.verifyRewardManagerAuthorized()` live read before allocation; aborts if false | PASS | None |
| Vault balance/funding checks | `getAvailableBalance()` live; pool = min(...); invariant check `totalAllocated <= pool && <= remainingBudget && <= availableBalance` | PASS | None |
| Cron authentication | `isAuthorized` in settlement route uses `timingSafeEqual` with `CRON_SECRET`, fails closed if secret missing | PASS | None |
| Settlement locking/CAS/outbox/reconciliation | `withSettlementLock` global lock (300s), CAS scripts for settlement (`CAS_UPSERT_SETTLEMENT_SCRIPT`) and player week, `allocationAttemptId` verifies CAS win, outbox `recordSettlementOutboxAttempt` NX before broadcast, `updateSettlementOutboxAttempt` CAS, `reconcileSettlement` checks on-chain `getUserRewardIds`/`getReward` | PASS | None |
| No other payout path | Only `settlement/route.ts` calls `allocateRewardsBatch`; reward route never allocates MPGR; `game-rewards.ts` only awards XP | PASS | None |

## 3. SYBIL / ANTI-ABUSE

| REQUIREMENT | CURRENT CODE | STATUS | REQUIRED CHANGE |
|---|---|---|---|
| Accurate representation, not claiming Sybil-proof | Docs `FINAL_REMEDIATION_VERIFICATION` says Sybil identity remains operational risk, caps mitigate but do not prove human identity | PASS | Ensure docs do not claim human-proof |
| Per-wallet limits, rate limits, replay validation | `MAX_CONCURRENT_SESSIONS_PER_WALLET=3`, `DAILY_XP_RUN_CAP=10`, `protectApiRequest` rate limits: game-session 10/60, game-reward 10/60, checkpoint 30/60; replay validation + heartbeat | PASS | None |
| Risk scoring/manual review/human identity | Not implemented; only spec mentions manual-review queue; no fake implementation | PASS — gap documented | Document remaining limitation: no human identity, no risk scoring, no manual review queue implementation; per-wallet caps + replay are only mitigations |

Remaining limitation to document: System is NOT Sybil-proof. An attacker can create multiple wallets. Controls are per-wallet only (concurrent sessions, daily XP cap, rate limits, replay verification, heartbeat). No CAPTCHA, no proof-of-human, no device fingerprint, no risk scoring, no manual review for top winners.

## 4. REWARD LEDGER / SERVER AUTHORITY

| REQUIREMENT | CURRENT CODE | STATUS | REQUIRED CHANGE |
|---|---|---|---|
| Event -> verification -> idempotency key -> reward policy -> ledger entry -> derived totals | `RunRecord` (event) -> `validateRunResult` + `verifyAuthoritativeRun` (verification) -> `sessionId` NX (idempotency) -> weighting formula + `awardCappedGameXP` (policy) -> `PlayerWeekRecord` + treasury ledger + XP ledger (ledger entry) -> `getTreasuryLedgerTotal`, `getTotalXP`, `getSeasonPoints` (derived totals) | PASS | None |
| Do not trust browser-owned XP/reward/score values | Score recomputed server-side; XP from server ledger `xp-ledger.ts`; Season Points weight 0 (disabled); weighting uses only server-recorded run facts | PASS | None |

## 5. DOUBLE CLAIM / CONTRACT SAFETY

| REQUIREMENT | CURRENT CODE | STATUS | REQUIRED CHANGE |
|---|---|---|---|
| No double claim | Reward Vault contract is external (0xbe4B...), not in repo; client `reward-vault-abi.ts` only has `claim`/`claimMultiple` which should enforce on-chain; off-chain settlement uses idempotent ledger + outbox + CAS to prevent double allocation | PARTIAL — cannot verify vault contract code in this repo | Report as prerequisite: need external audit of deployed vault contract invariants |
| Reward solvency, principal solvency, accounting checkpoints, user exit availability | Staking contract `MPGRStaking.sol` has `rewardPoolBalance` separate from principal, tests `MPGRStakingInvariant.t.sol` etc.; vault contract invariants not verifiable in repo | PARTIAL | Report as prerequisite |
| Do not modify contracts unless audit explicitly requires missing fix | No vault contract in repo to modify; staking contract unchanged | PASS | None |

## 6. FUTURE VERIFIER URL/SECRET

| REQUIREMENT | CURRENT CODE | STATUS | REQUIRED CHANGE |
|---|---|---|---|
| Remove unnecessary external-verifier wiring if not required by audit or active code | `games-reward-config.ts` required `GAME_RUN_VERIFIER_URL`+`SECRET` via `authoritativeGameVerifierIsConfigured()`; no code path ever fetched external verifier; docs mentioned it as gate | FAIL — unnecessary wiring present | **REMOVE**: delete `authoritativeGameVerifierIsConfigured`, remove URL/SECRET from `gameRewardsAreOperatorEnabled`, from `.env.example`, from tests, update docs to state active verifier is in-process replay |

## 7. DO NOT WEAKEN FINANCIAL GATE

| REQUIREMENT | CURRENT CODE | STATUS | REQUIRED CHANGE |
|---|---|---|---|
| Gate must fail closed when authoritative verification/security prerequisites unavailable | Current gate required 3 env vars (including external URL) — fails closed but with unnecessary requirement; reward route returns 503 when `GAME_REWARDS_ENABLED=true` and replay fails; settlement requires `gameRewardsAreOperatorEnabled()` | PASS after fix | After removing external URL, gate still requires `GAME_REWARDS_ENABLED=true` + `GAME_AUTHORITATIVE_VERIFICATION_ENABLED=true`, both default false, fail-closed. No weakening. |

## 8. SUMMARY OF REQUIRED CODE CHANGES

1. **lib/games/games-reward-config.ts**: Remove `authoritativeGameVerifierIsConfigured`, update `gameRewardsAreOperatorEnabled` to check only two flags, update comment.
2. **.env.example**: Remove `GAME_RUN_VERIFIER_URL` and `GAME_RUN_VERIFIER_SECRET`.
3. **lib/games/games-reward-config.test.ts**: Update to test only two-flag gate, add regression that no external verifier env is required, assert function removed.
4. **docs/GAME_REWARDS_SETUP.md**: Rewrite section 3 to describe in-process replay as authoritative verifier, remove external deploy instructions.
5. **docs/GAME_RUN_VERIFIER_PROTOCOL.md**: Rewrite to describe active in-process replay and mark external protocol as historical.
6. **docs/GAME_REWARDS_RUNBOOK.md**: Clarify no external URL required.
7. **docs/FINAL_REMEDIATION_VERIFICATION.md**: Update P0-3 and financial safety notes.
8. **docs/SECURITY_REMEDIATION.md**: Update operational requirements and implementation notes.

No changes to reward vault contracts, staking, trading, wallet auth, Vercel envs, or enabling financial rewards.

## 9. TESTS REQUIRED

- Existing tests already cover forged verification fields, wallet-from-session, replay verification, malformed trace, duplicate, idempotency, weekly eligibility, weekly cap, per-player cap, lifetime budget, settlement auth, live season, vault balance, fail-closed, no external request (new).
- After fix, run `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.

## 10. FINAL GATE EXPECTATIONS

- CODE FIXES COMPLETED: removal of external verifier wiring.
- TESTS PASSED: existing 1198 tests + updated gate tests.
- ON-CHAIN/VERCEL PREREQUISITES: reward manager auth, season creation, vault funding, CRON_SECRET, independent anti-cheat audit, contract audit.
- AUDIT REQUIREMENTS THAT CANNOT BE SATISFIED BY CODE ALONE: external audit of vault contract invariants, anti-cheat certification, Sybil/human identity.
- REMAINING SECURITY GAPS: no Sybil-proof, no risk scoring/manual review, vault has no on-chain idempotency key (outbox is off-chain only), staking invariants need external audit.

This file is the checklist required by task section 8.

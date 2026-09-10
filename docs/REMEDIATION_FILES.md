# Remediation File Map

This archive contains the full repository plus the files changed or added for the August 2026 review remediation.

## Authentication

- `lib/auth/config.ts`
- `lib/auth/redis.ts`
- `lib/auth/nonce.ts`
- `lib/auth/session.ts`
- `lib/auth/siwe.ts`
- `app/api/auth/nonce/route.ts`
- `app/api/auth/verify/route.ts`
- `app/api/auth/logout/route.ts`
- `hooks/useWalletAuth.ts`
- `components/WalletAuthBootstrap.tsx`

## Server-owned rewards / leaderboard

- `lib/rewards/xp-ledger.ts`
- `app/api/xp/route.ts`
- `app/api/leaderboard/route.ts`
- `app/api/leaderboard/route.test.ts`
- `app/api/referral/route.ts`
- `components/ReferralCapture.tsx`

## MPGR Run / settlement

- `lib/games/game-session.ts`
- `lib/games/mpgr-run/server-session.ts`
- `app/api/games/mpgr-run/session/route.ts`
- `app/api/games/mpgr-run/reward/route.ts`
- `app/api/games/mpgr-run/weekly-status/route.ts`
- `lib/games/mpgr-run/submit-server-reward.ts`
- `components/features/games/mpgr-run/RunGame.tsx`
- `lib/reward-allocation/settlement-lock.ts`
- `lib/reward-allocation/settlement-reconciliation.ts`
- `lib/reward-allocation/allocation-store.ts`
- `lib/reward-allocation/kv-allocation-store.ts`
- `app/api/games/mpgr-run/settlement/route.ts`
- `app/api/games/mpgr-run/settlement/reconcile/route.ts`
- `lib/reward-vault/reward-vault-admin-client.ts`

## AI/API boundaries

- `lib/api/request-guard.ts`
- `lib/architecture/ai/server-policy.ts`
- `app/api/agent/complete/route.ts`
- `app/api/agent/complete/gemini/route.ts`
- `lib/architecture/agentkit/invoke.ts`

## Contracts / delivery

- `contracts/MPGRStaking.sol`
- `foundry.toml`
- `remappings.txt`
- `test/MPGRStaking.t.sol`
- `test/MPGRStakingFuzz.t.sol`
- `test/MPGRStakingInvariant.t.sol`
- `test/RewardMath.t.sol`
- `lib/games/mpgr-run/run-validation.test.ts`
- `lib/reward-allocation/settlement-engine.test.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/debug-build.yml`
- `.github/dependabot.yml`
- `.github/CODEOWNERS`
- `.eslintrc.json`
- `.nvmrc`
- `package.json`
- `.env.example`

## Documentation

- `AGENTS.md`
- `docs/AUDIT_AND_REVIEW_2026-08.md`
- `docs/FUTURE_PROOFING.md`
- `docs/SECURITY_REMEDIATION.md`
- `docs/GAME_REWARDS_RUNBOOK.md`
- `docs/REMEDIATION_FILES.md`
- `README.md`

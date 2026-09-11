# Remediation File Map

This archive contains the full repository plus the files changed or added for the August 2026 review remaining-gap closeout.

## Authentication

- `lib/auth/config.ts`
- `lib/auth/redis.ts`
- `lib/auth/nonce.ts`
- `lib/auth/session.ts`
- `lib/auth/siwe.ts`
- `lib/api/cookies.ts`
- `app/api/auth/nonce/route.ts`
- `app/api/auth/verify/route.ts`
- `app/api/auth/logout/route.ts`
- `hooks/useWalletAuth.ts`
- `components/WalletAuthBootstrap.tsx`

## Server-owned rewards / leaderboard

- `lib/rewards/xp-ledger.ts`
- `lib/rewards/xp-ledger.test.ts`
- `app/api/xp/route.ts`
- `hooks/useXP.ts`
- `app/api/leaderboard/route.ts`
- `app/api/leaderboard/route.test.ts`
- `app/api/referral/route.ts`
- `components/ReferralCapture.tsx`

## MPGR Run / settlement

- `lib/games/game-session.ts`
- `lib/games/mpgr-run/server-session.ts`
- `lib/games/mpgr-run/server-session.test.ts`
- `lib/games/mpgr-run/run-physics.ts`
- `lib/games/mpgr-run/run-physics.test.ts`
- `app/api/games/mpgr-run/session/route.ts`
- `app/api/games/mpgr-run/checkpoint/route.ts`
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

## AI/API boundaries / trade

- `lib/api/request-guard.ts`
- `lib/api/request-guard.test.ts`
- `lib/architecture/ai/server-policy.ts`
- `app/api/agent/complete/route.ts`
- `app/api/agent/complete/gemini/route.ts`
- `lib/architecture/agentkit/invoke.ts`
- `app/api/agentkit/invoke/route.ts`
- `app/api/x402/register/route.ts`
- `app/api/x402/submit/route.ts`
- `app/api/x402/discover/route.ts`
- `app/api/trade/price/route.ts`
- `app/api/trade/quote/route.ts`
- `app/api/trade/stocks/quote/route.ts`

## Chain / memory

- `lib/chain/base.ts`
- `lib/chain/base.test.ts`
- `lib/architecture/memory/memory-keys.ts`
- `lib/architecture/memory/memory-keys.test.ts`
- `lib/architecture/memory/user-memory-store.ts`
- `lib/architecture/memory/wallet-context-memory.ts`
- `lib/architecture/memory/conversation-memory-store.ts`
- `lib/architecture/memory/memory-engine.ts`
- `lib/agent-engine.ts`
- `lib/agent-commands/action-history.ts`

## Contracts / delivery

- `contracts/MPGRStaking.sol`
- `foundry.toml`
- `remappings.txt`
- `test/MPGRStaking.t.sol`
- `test/MPGRStakingFuzz.t.sol`
- `test/MPGRStakingInvariant.t.sol`
- `test/RewardMath.t.sol`
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
- `docs/FINAL_REMEDIATION_VERIFICATION.md`
- `README.md`

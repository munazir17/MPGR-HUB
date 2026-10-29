# Uncertain or unused

## Facts not verified outside the repo

- Production values of `GAME_REWARDS_ENABLED`, `GAME_AUTHORITATIVE_VERIFICATION_ENABLED`, RPC URLs, and cron success.
- That `mpgrhub.xyz` is serving `3fb5eb82`. Metadata points at that domain. The Vercel production deployment API was not queried.
- Player retention, session length, and what fraction of visits open MPGR Run.
- Gzip/Brotli transfer size and image decode time. Numbers in the Run doc are uncompressed file bytes.
- Upstash command rate, hot-key pressure, and memory.
- Whether PR #145's `mergeable_state: blocked` is branch protection, a required review, or a failing check that the check-run API did not list. The listed checks were green or skipped. No review was returned.

## Files whose production role is weak or unused

| Path | Why it is uncertain |
| --- | --- |
| `lib/leaderboard-store.ts` | Imported by its test, not by `app/api/leaderboard`. Live rank is the XP ZSET. The store's "refuse lower XP" guard is therefore not on the request path. |
| `hooks/useAgentActionConfirmation.ts` | No importer. A comment in `lib/architecture/tools/agent-action-confirmation.ts` names it. |
| `hooks/useAgentVisitorCount.ts` | No importer. Visitor API exists separately. |
| `hooks/useMPGRPortfolioSync.ts`, `useMPGRRefresh.ts`, `useMPGRToken.ts`, `useMPGRTransactionHistory.ts` | No importer. Comments in token services still name them. |
| `hooks/useAgentActionExecution.ts` | No runtime importer, but a test reads the file as text. Not dead. |
| `components/ui/QuickActions.tsx`, `CommunitySocialLinks.tsx`, `StakingPositionCard.tsx`, `StakingSummaryCard.tsx`, `TokenLockSummaryCard.tsx` | No importer found outside the file. |
| `components/features/holder-tier/HolderTierOverview.tsx` | No importer found. Profile uses the hook directly. |
| `lib/architecture/core/task-queue.ts` | Used by token refresh/history, in-process only. Not a worker fleet. |
| `docs/ARCHITECTURE.md` | Describes an older shape (generic mini-games, in-memory helpers). Do not treat it as the route map. |
| `docs/mpgr-run-next-gen/*` and `docs/MPGR_RUN_ASSET_OPTIMIZATION_2026-09.md` | Name art files. Some of those files are no longer in the preload list. The docs are history, not loaders. |

## Not uncertain

- Navbar → holder tier → staking/token-lock import chain (read before the snapshot change, and re-read after).
- XP ledger uses `INCRBY` only for totals.
- `RunGame` has a single page importer.
- The three deleted hook copies had no imports.

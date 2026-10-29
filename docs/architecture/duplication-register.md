# Duplication and centralization register

Rule: one owner for a rule. Routes and components call it. They do not reimplement it. Nothing here is permission to merge PaigerSwap into the agent or to edit fee math.

| Rule | Canonical today | Copies | Action |
| --- | --- | --- | --- |
| Executor fee `floor(gross * bps / 10_000)` | `computeExecutorFee` in `lib/executor/executor-fee.ts` | `calculateAgentFeeAmount` / `buildExecutorAgentFee` in `lib/trade/trade-agent-fee.ts`; `swapPathFeeFloor` in `lib/swap/swap-executor-intent.ts`; inline `(amount * 25n) / 10_000n` in `lib/mcp/mcp-trade-service.ts` and many tests; v2 discovery checks `feeBps: 25` in `lib/swap/v2/discovery.ts` | **Approval required.** Import the canonical function in a later PR with the existing vector tests. Do not change bps or recipients. |
| Quote | No single owner | Swap v1 search, swap v2 discovery, trade router, MCP service, dormant paths under `lib/swap/` | Keep separate. A shared proposal type is P3 and blocked on the fee review. |
| Session wallet | `authenticateRequest` (`lib/auth/session-store.ts`) plus route-level `session.wallet` overwrite | Any future `body.wallet` on user routes | Keep. Campaign admin is cron-gated and documented. |
| Rate limit | Redis window in `lib/api/request-guard.ts` `enforceRateLimit` | `lib/trade/trade-rate-limit.ts` (`mpgrhub:trade:ratelimit:*`) | Keep two buckets. Do not merge swap and AI counters. |
| XP amounts | `XP_ACTIONS` in `lib/xp-engine.ts` (50 / 20 / 30 / 15 / 40 / 100 / 8) | Docs pages repeat the numbers (`app/docs/page.tsx` and others). Server reads the same table via the ledger | Move the table only when a second server importer needs it. Do not change numbers. `PROFILE_COMPLETED` and `SHARE_ON_X` have no caller. `QUEST_COMPLETED` is local-only. |
| Lifetime XP | `awardServerXP` / `awardCappedGameXP` `INCRBY` | `awardXP` adds the same integers to `localStorage` first | Server stays the ledger. Local display must not be described as final when the POST failed. Not changed here. |
| Season month | `lib/season-points.ts` and the Redis month key written by the ledger | `lib/leaderboard-store.ts` also imports season helpers but has no production caller (only `lib/leaderboard-store.test.ts`) | Do not revive the unused store as a second rank. |
| Streak | `performDailyCheckIn` in `lib/xp-engine.ts` | Achievements read `record.streak`. No server field. No best-streak | Future server field needs product approval. Missed day sets streak to 1 on the next check-in. It does not subtract XP. |
| Holder tier math | `lib/holder-tier-engine.ts` + `lib/useHolderTier.ts` | `hooks/useHolderTier.ts` and `hooks/holder-tier-engine.ts` were unimported and stale | **Deleted on this branch.** |
| Premium math | `lib/premium-engine.ts` (`derivePremiumStatus`, on-chain cache) | `hooks/premium-engine.ts` still imported `getTokenLockPositions` from the local lock engine | **Deleted on this branch.** |
| Live chain poll | `shouldPollLiveReads` (`lib/chain/live-read-policy.ts`), default on | Navbar used to call the default and so polled on every hub page | **Navbar opts out.** Staking page, token-lock page, profile, leaderboard premium, and the home agent do not. |
| Nav links | None | `PRIMARY_LINKS` (6 links) and `SIDEBAR_GROUPS` (11 links). `/swap` is "Swap" vs "PaigerSwap". `/rewards` is "Rewards" vs "Reward Hub" | One `lib/content/nav.ts` later. Do not change destinations in that PR. Sidebar comment still says "Home \| Rewards \| Profile"; the header does not match that comment. |
| Dialog shell | None | `SwapDialog` is a native `<dialog>`. Stake, unstake, exit, level-up, agent confirm, and `PairSheet` are hand-rolled | A hub shell must not wrap PaigerSwap. |
| Logger | `lib/observability/log.ts` (`logApi`, redacts wallets) and `lib/architecture/core/logger.ts` (`ConsoleLogger`) | Direct `console.error` in routes | P3. No Sentry dependency. |
| Token metadata | `lib/token/**` for the MPGR asset | Trade/swap catalogs for other Base tokens | Different jobs. Do not merge. |
| Game score | `computeRunScore` + `authoritative-replay.ts` | Client `RunGameSimulation` must stay in lockstep (parity tests exist) | New games get a new verifier. Do not fork this one. |
| Redis client | `getRedis()` in `lib/api/redis.ts` | `lib/x402/x402-proposal-store.ts` and `lib/reward-allocation/kv-allocation-store.ts` construct their own client from the same env | One factory later. Not a behavior change. |

## What not to centralize

- PaigerSwap visuals and the hub glass cards.
- Swap rate-limit bucket and AI budget bucket.
- MPGR Run's renderer and a future tap game's renderer.
- Contract ABIs and the TypeScript mirrors (`script/gen-executor-abi.mjs --check` already fails CI on drift).

## Shared UI that already exists

`GlassCard`, `EmptyState`, `Skeleton`, `SkeletonCard`, `StatCard`, `ProgressBar`, `SectionHeader`, `AnimatedNumber`, `CountdownCard`, and `.btn-*` in global CSS. Staking and reward widgets live beside them under `components/ui/` and are feature components, not primitives.

Unreferenced outside their own file (kept, not deleted): `QuickActions.tsx`, `CommunitySocialLinks.tsx`, `StakingPositionCard.tsx`, `StakingSummaryCard.tsx`, `TokenLockSummaryCard.tsx`, `HolderTierOverview.tsx`. Deleting them is a separate visual check.

## Other unused hooks (not deleted)

Confirmed by import search, comments excluded: `hooks/useAgentActionConfirmation.ts`, `hooks/useAgentVisitorCount.ts`, `hooks/useMPGRPortfolioSync.ts`, `hooks/useMPGRRefresh.ts`, `hooks/useMPGRToken.ts`, `hooks/useMPGRTransactionHistory.ts`.

Do **not** delete `hooks/useAgentActionExecution.ts`. `lib/architecture/tools/agent-action-execution.test.ts` reads that file from disk.

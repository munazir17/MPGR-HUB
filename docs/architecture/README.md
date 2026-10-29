# Architecture audit — MPGR HUB

Status: audit of `main`, plus one behavior-preserving read-path change on this branch. No fee math, reward amounts, contracts, Redis key layout, or MPGR Run assets change here.

| | |
| --- | --- |
| Repository | [munazir17/MPGR-HUB](https://github.com/munazir17/MPGR-HUB) |
| Production domain | `mpgrhub.xyz` (named in app metadata; this audit did not probe live traffic) |
| Branch audited | `main` |
| Commit | `3fb5eb82f1e7293ec99926b0511d6196d145a03e` |
| Commit message | Merge pull request #143 — connect MPGR Agent to PaigerSwap V2 |
| Audit date | 2026-10-29 |

Evidence labels: **confirmed** (read in this tree or observed in GitHub check output), **estimate** (reasoned from code, not measured in production), **unknown** (no access).

These notes do not replace [docs/ARCHITECTURE.md](../ARCHITECTURE.md), [docs/SECURITY.md](../SECURITY.md), or [AGENTS.md](../../AGENTS.md). `docs/ARCHITECTURE.md` is a product narrative. It still describes in-memory helpers and aspirational games. The route map below is the one that matches the tree.

## Read in this order

| Doc | Question |
| --- | --- |
| This file | What is true, what is unknown, what this branch changes. |
| [source-inventory.md](./source-inventory.md) | Every source file, with a path heuristic. |
| [feature-matrix.md](./feature-matrix.md) | Which feature owns which files. |
| [duplication-register.md](./duplication-register.md) | Repeated rules and the owner to keep. |
| [data-flow.md](./data-flow.md) | Request, XP, and chain flows. |
| [target-architecture.md](./target-architecture.md) | Modular boundaries. Not a rewrite. |
| [mpgr-run-decision.md](./mpgr-run-decision.md) | Keep, isolate, or retire the runner. |
| [game-platform.md](./game-platform.md) | Future light games and the points rule. |
| [quality-audit.md](./quality-audit.md) | Performance, security, tests, 10× / 100×. |
| [roadmap.md](./roadmap.md) | Prioritized work, approvals, rollback. |
| [uncertain.md](./uncertain.md) | Files and facts this pass could not close. |

## Confirmed facts

- Stack from [package.json](../../package.json): Next.js **16.4.2** (exact), React 18.3, TypeScript, Tailwind 3.4, wagmi 2.19, viem 2.21, RainbowKit 2.2, `@upstash/redis` 1.35, `@tanstack/react-query` 5.59 (provider only), Framer Motion 11, Vitest 4.1. Node `20` in `.nvmrc`; engines `>=20.11.0`. README previously said Next 16.3.5; this branch corrects that line.
- Persistence is Upstash Redis / Vercel KV via `lib/api/redis.ts`. No Postgres client, no Prisma, no Drizzle, no BullMQ, no worker process. Vercel crons in `vercel.json` hit two MPGR Run settlement routes.
- Chain in the wagmi config is Base mainnet `8453` only.
- Wallet writes stay in the user wallet or an explicitly gated operator broadcaster. This audit did not change signing, quotes, or fees.
- CI on pull requests (`/.github/workflows/ci.yml`) runs `quality` (lint, typecheck, vitest, `audit:high`), `build`, `contracts`, `contracts-fork`, `secret-scan`, `slither`, `real-redis`.
- There is no `next/dynamic` anywhere in the TypeScript sources. `RunGame` is imported only by `app/games/mpgr-run/page.tsx`.
- Lifetime server XP only increases. `lib/rewards/xp-ledger.ts` awards with `INCRBY` / `ZINCRBY`. A missed day does not subtract. Streak is `localStorage` in `lib/xp-engine.ts`. There is no `bestStreak` field.
- `public/` file bytes: **104,134,908** (99.31 MiB), 208 files. `public/games/mpgr-run`: **93,340,966** (89.02 MiB), 116 files. That is repository weight, not the download of `/` or `/swap`.
- Sprite catalog at `RUN_ASSET_VERSION` `2026-09-18a`, summed from disk in this audit: critical **24 files / 13,941,098 bytes**, all sprites **61 / 45,357,918**, optional **37 / 31,416,820**. Music `neon-circuit.wav` is **2,646,044** bytes and is not in the sprite list.

## PR #145 (not on this commit)

[PR #145](https://github.com/munazir17/MPGR-HUB/pull/145) (`perf/mpgr-run-asset-budget` @ `5692383471c65fd33f4db3855a67d9d21c95f43f`) is **open, not merged**. `mergeable_state` was `blocked`. Reviews returned none.

Checks observed on that head SHA, 2026-10-29:

| Check | Result |
| --- | --- |
| quality, build, contracts, contracts-fork, secret-scan, slither, real-redis | success |
| e2e, reference | skipped |
| Vercel status | success, "Deployment has completed" (preview URL, not production) |
| Vercel Preview Comments | success |

`main` is still `3fb5eb82`. Do not treat the PR body or the preview as a production deploy. This branch does not include #145's asset deletions. [PR #144](https://github.com/munazir17/MPGR-HUB/pull/144) is an earlier docs-only audit on the same base and is also unmerged. This folder is an independent pass.

## Unknowns

- Production env values (`GAME_REWARDS_ENABLED`, RPC URLs, Redis size, error rates).
- Visitor counts, game retention, and RPC volume. No analytics warehouse was queried. `@vercel/analytics` is mounted; this audit did not read its dashboard.
- Whether `mpgrhub.xyz` is currently serving `3fb5eb82`. Not verified against the Vercel production deployment API.
- Bundle analyzer output and a mobile network waterfall. Byte figures below are file sizes and catalog membership, not Chrome transfer sizes (gzip/br will be smaller; decode cost is separate).
- Full dead-code graph. Only the three deleted hook copies were proven unused and removed.

## Ten findings

1. **The ~100 MB figure is the `public/` tree, not a page download.** Almost all of it is MPGR Run art. Dashboard routes do not import `RunGame`.
2. **The play route still preloads 13.94 MB of critical sprites before optional art**, including legacy city panoramas and side-view poses the steady-state renderer does not need. PR #145 proposes to cut that. It is not merged.
3. **Navbar mounted a full staking and token-lock poll on every hub page** (15s, plus a staking `getGlobalState` even when logged out, plus a 1s local reward clock once both states existed). This branch stops that for the badge only. Staking, token-lock, profile, leaderboard, and the home agent keep their own readers.
4. **Hooks do not share state.** Home's agent calls `useStaking` and `useTokenLock` itself and again through `useHolderTier` and `usePremium`. Cache TTLs (12s staking, 15s locks) collapse aligned bursts, but the timers still exist. Not changed here: that code is the agent surface.
5. **Two XP worlds.** The server ledger is authoritative. `awardXP` / `performDailyCheckIn` still write `localStorage` first. A later `GET /api/xp` replaces the displayed total. Streak stays local and resets to 1 on the next check-in after a missed day. It does not deduct XP or tokens.
6. **Fee math is copied.** Canonical helper is `computeExecutorFee` in `lib/executor/executor-fee.ts`. Agent, swap path, and several call sites reimplement `floor(gross * bps / 10_000)`. Do not unify without a dedicated review.
7. **`components/ui` is not a design system.** Primitives exist (`GlassCard`, `EmptyState`, `Skeleton`, `StatCard`). No shared dialog, button, input, or toast. PaigerSwap uses none of them and should stay separate.
8. **Navigation is two hand-maintained lists** (`PRIMARY_LINKS`, `SIDEBAR_GROUPS`) with different labels for the same hrefs. Not unified in this PR.
9. **Three stale hook copies had zero importers** and diverged from `lib/` (the premium copy still read the old local lock engine). They are deleted on this branch. Other unused hooks remain and are listed in the roadmap.
10. **100× is an RPC, Redis, and asset problem before it is a microservice problem.** One Vercel project, in-process caches, and per-page chain polling will not survive a large traffic jump. Splitting services now would duplicate the fee and XP rules.

## What this branch changes

| Change | Why |
| --- | --- |
| `useHolderTier({ poll: false })` in `components/Navbar.tsx` | The badge needs one read of wallet, stake, and locks. It does not need a 15s pool poll or a 1 Hz clock. |
| `shouldPollLiveReads` in `lib/chain/live-read-policy.ts` | Default stays **poll**, so `useStaking()` and `useTokenLock()` on their own pages are unchanged. |
| Delete `hooks/useHolderTier.ts`, `hooks/holder-tier-engine.ts`, `hooks/premium-engine.ts` | Unimported, and the engines were older than `lib/`. |

Snapshot mode still loads the connected wallet's stake and lock positions once, and still listens for `staking_changed`. It skips pool-wide `getGlobalState` and the repeat timers. Logged-out hub pages no longer pay for a staking global read from the navbar. The header badge can go stale until the next mount if the user locks tokens on a page whose own hook is a different instance. Staking and token-lock pages still poll for their own numbers.

## Single best next step

Review and merge this branch if the checks pass. Leave [PR #145](https://github.com/munazir17/MPGR-HUB/pull/145) as its own asset review. Do not combine them. Do not start a folder move, a fee-function merge, or a server streak in the same change.

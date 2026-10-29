# Architecture initiative — audit index

Status: the documentation audit from [PR #144](https://github.com/munazir17/MPGR-HUB/pull/144) is **merged**. The MPGR Run asset budget from [PR #145](https://github.com/munazir17/MPGR-HUB/pull/145) is **merged** on `main` @ `99a0fb3602b0150517ecc03550753fcbee692f13`. This branch adds the navbar snapshot read and deletes three unimported hook copies. It does not change fee math, reward amounts, contracts, Redis key layout, XP ledger semantics, or MPGR Run gameplay.

Original audit baseline: `main` @ `3fb5eb82f1e7293ec99926b0511d6196d145a03e` (merge of [PR #143](https://github.com/munazir17/MPGR-HUB/pull/143)). Byte tables that name that commit are historical measurements, not the tree after #145.

These notes sit beside the existing canon. They do not replace it:

- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — older product narrative (parts are aspirational; see current-state).
- [docs/SECURITY.md](../SECURITY.md), [docs/FUTURE_PROOFING.md](../FUTURE_PROOFING.md), [docs/ROADMAP.md](../ROADMAP.md).
- [AGENTS.md](../../AGENTS.md) — agent safety rules still apply to any later implementation.

Production behavior of `mpgrhub.xyz` was **not** verified. A green preview or a local build is not a production deploy.

## Read in this order

| Doc | Question it answers |
| --- | --- |
| [current-state.md](./current-state.md) | What is actually running, and how sure we are. |
| [file-wise-audit.md](./file-wise-audit.md) | Who owns which module, who calls it, what to leave alone. |
| [performance-baseline.md](./performance-baseline.md) | Measured bytes at the audit baseline, and the post-#145 budget. |
| [gaming-strategy.md](./gaming-strategy.md) | The ~100 MB claim, keep/isolate/replace, points and streaks. |
| [centralization-map.md](./centralization-map.md) | Duplicates, the canonical owner, and the migration order. |
| [target-architecture.md](./target-architecture.md) | Modular monolith boundaries. Not microservices. |
| [scalability-roadmap.md](./scalability-roadmap.md) | 100x plan with triggers, not a rewrite. |
| [compatibility-and-risk-register.md](./compatibility-and-risk-register.md) | What must not break, and how to roll back. |

Supplements from the navbar pass. They must not contradict the table above:

| Doc | What it adds |
| --- | --- |
| [data-flow.md](./data-flow.md) | Request, XP, and the navbar read path. |
| [feature-matrix.md](./feature-matrix.md) | Feature ownership after the snapshot change. |
| [duplication-register.md](./duplication-register.md) | Same rules as the centralization map, with this branch's status. |
| [source-inventory.md](./source-inventory.md) | Path list from the pre-#145 tree plus the navbar files. Not a live recount. |
| [mpgr-run-decision.md](./mpgr-run-decision.md) | Keep the runner. Asset deletion itself landed in #145. |
| [quality-audit.md](./quality-audit.md) | Poll and test notes for this branch. |
| [roadmap.md](./roadmap.md) | Landed vs still-open items. Prefer [scalability-roadmap.md](./scalability-roadmap.md) when they disagree. |
| [uncertain.md](./uncertain.md) | Facts this pass could not close. |
| [game-platform.md](./game-platform.md) | Future light games. Not a second gaming strategy. |

## What has landed

| Change | Where | Status |
| --- | --- | --- |
| Architecture documentation | This folder, PR #144 | Merged. Updated here so it no longer calls #145 open or the navbar poll current. |
| Asset budget | PR #145 | Merged. Critical sprites **7,822,192** bytes (21 paths). All catalog sprites still **45,357,918** (61). `public/games` **54,482,009** (88 files, 51.96 MiB). `public/` **65,275,951** (180 files, 62.25 MiB). Legacy city panoramas stay on disk and in `OPTIONAL_SPRITE_PATHS`. Locked by `lib/games/mpgr-run/run-asset-budget.test.ts`. |
| Navbar snapshot reads | `useHolderTier({ poll: false })` | This branch. One connected-wallet read of stake and locks. No 15s timer. Logged-out pages do not call staking `getGlobalState`. `staking_changed` still reloads the wallet position and does not load pool-wide state unless the caller is polling. |
| Dead hook copies | `hooks/useHolderTier.ts`, `hooks/holder-tier-engine.ts`, `hooks/premium-engine.ts` | Deleted on this branch. Live code is `lib/`. |

Staking, token-lock, profile, leaderboard premium, and the home agent still use the default poll. Home still mounts a second staking and token-lock reader inside `useAgentChat` (and another through `useHolderTier()` and `usePremium()`). Those instances are not the navbar. Sharing them would mean changing the agent surface; in-flight dedupe inside the staking service remains the existing guard. Not changed here.

## Executive summary

MPGR HUB is a Next.js 16.4.2 App Router app on Vercel, Base mainnet only (`8453`). Persistence is Upstash Redis / Vercel KV plus the chain. There is no Postgres and no worker fleet. Wallet writes stay in the user wallet (or an explicitly gated operator broadcaster).

### Ten findings

1. **The ~100 MB figure was the pre-#145 `public/` tree (99.31 MiB), not a page download.** After #145, `public/` is 62.25 MiB and `public/games/mpgr-run` is 51.96 MiB. The play route still preloads **61 sprites / 43.26 MiB**, of which **21 / 7.46 MiB are critical**. Music is a separate 2.52 MiB WAV. Dashboard routes do not import `RunGame`.
2. **Dashboard routes do not download the game.** `RunGame` is imported only by `app/games/mpgr-run/page.tsx`. There is no `next/dynamic`. The module still parses before the wallet connects on that route.
3. **Lifetime XP does not decay.** Server totals only `INCRBY` (`lib/rewards/xp-ledger.ts`). A missed day resets the **local** streak to 1 on the next check-in. It does not subtract XP, season points, or tokens. There is **no best-streak field** and **no server streak**.
4. **Two XP worlds.** Authoritative grants go through Redis (`/api/xp`, game reward route). `lib/xp-engine.ts` still writes `localStorage` first. A failed server call can show XP the ledger does not have until the next successful `GET /api/xp`.
5. **Fee math is copied, not shared.** Canonical integer formula is `computeExecutorFee` in `lib/executor/executor-fee.ts`. The same `gross * bps / 10_000` floor is reimplemented in trade, swap path, and swap v2 discovery. Do not “clean this up” without a dedicated review and regression tests.
6. **Five quote paths**, not one service: swap v1, swap v2, agent/trade, stocks (order execution disabled with 403), and MCP. Taker is taken from the session on the HTTP quote routes.
7. **Wallet infra still loads on every page. The navbar no longer polls staking or token-lock.** `Providers` wraps the root layout. The badge calls `useHolderTier({ poll: false })`. Staking and token-lock screens, profile, and the home agent keep their own readers. Home can still poll twice because the agent does not share hook state with the badge.
8. **`components/ui` is not a design system.** Primitives that exist: `GlassCard`, `EmptyState`, `Skeleton`, `StatCard`, `ProgressBar`, plus `.btn-*` in `globals.css`. Staking and reward widgets live in `ui/`. There is no shared dialog, input, or toast. PaigerSwap uses none of `components/ui` and should stay visually separate.
9. **The three stale `hooks/` engine copies are deleted on this branch.** Live tier and premium math is under `lib/`. Local engines (`staking-engine.ts`, `token-lock-engine.ts`) are not the chain clients. Other unused hooks remain and are listed in [uncertain.md](./uncertain.md). They were not deleted here.
10. **100x is an RPC, Redis, and asset problem before it is a microservice problem.** One Vercel deploy, in-process caches, and per-page chain polling on the screens that still need it will not survive 100x users. Splitting services now would duplicate the fee and XP rules.

### Still open (do one at a time)

None of these change fee recipients, calldata, XP amounts, or settlement flags.

| # | Task | Priority | Why it is next |
| --- | --- | --- | --- |
| 4 | One navigation config for `Navbar` `PRIMARY_LINKS` and `AppSidebar` `SIDEBAR_GROUPS`. | P1 | Tasks 1–3 (assets, navbar poll, dead copies) are done. |
| 5 | Server streak and best-streak fields that **never** decrement lifetime XP. Local streak remains a cache. | P1 | Needs an explicit product yes. Not started. |

Also still open, and not “next” until approved: pending-XP label, `next/dynamic` for `RunGame`, dialog shell, fee-function dedupe.

### Needs explicit approval before any code

- Unifying fee math or quote routes.
- Enabling `GAME_REWARDS_ENABLED` or changing weekly settlement.
- Changing XP amounts, season boundaries, or referral caps.
- Deleting MPGR Run or its reward API.
- Moving streak authority to the server — design is in the gaming doc; implementation waits for a yes.
- Any contract, manifest, or executor address change.

### Evidence labels used in the audit docs

1. Verified working — checked in source and, where noted, in CI or GitHub status for the named SHA.
2. Implemented, not runtime-verified — code path exists; this audit did not execute it against production.
3. Partially implemented.
4. Planned, not implemented — docs or UI only.
5. Broken or regressed — only if a test or contradiction shows it.
6. Unknown — missing access (no production Redis, no bundle analyzer run, no mobile device trace).

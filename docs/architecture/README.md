# Architecture initiative — audit index

Status: **audit only**. No runtime code, fee math, reward amounts, or contracts change in this set of documents.

Baseline: `main` @ `3fb5eb82f1e7293ec99926b0511d6196d145a03e` (merge of [PR #143](https://github.com/munazir17/MPGR-HUB/pull/143)).

These notes sit beside the existing canon. They do not replace it:

- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — older product narrative (parts are aspirational; see current-state).
- [docs/SECURITY.md](../SECURITY.md), [docs/FUTURE_PROOFING.md](../FUTURE_PROOFING.md), [docs/ROADMAP.md](../ROADMAP.md).
- [AGENTS.md](../../AGENTS.md) — agent safety rules still apply to any later implementation.

## Read in this order

| Doc | Question it answers |
| --- | --- |
| [current-state.md](./current-state.md) | What is actually running, and how sure we are. |
| [file-wise-audit.md](./file-wise-audit.md) | Who owns which module, who calls it, what to leave alone. |
| [performance-baseline.md](./performance-baseline.md) | Measured bytes, polls, and what was not measured. |
| [gaming-strategy.md](./gaming-strategy.md) | The ~100 MB claim, keep/isolate/replace, points and streaks. |
| [centralization-map.md](./centralization-map.md) | Duplicates, the canonical owner, and the migration order. |
| [target-architecture.md](./target-architecture.md) | Modular monolith boundaries. Not microservices. |
| [scalability-roadmap.md](./scalability-roadmap.md) | 100x plan with triggers, not a rewrite. |
| [compatibility-and-risk-register.md](./compatibility-and-risk-register.md) | What must not break, and how to roll back. |

## Executive summary

MPGR HUB is a Next.js 16 App Router app on Vercel, Base mainnet only (`8453`). Persistence is Upstash Redis / Vercel KV plus the chain. There is no Postgres and no worker fleet. Wallet writes stay in the user wallet (or an explicitly gated operator broadcaster). CI on this commit is green: `quality`, `build`, `contracts`, `contracts-fork`, `secret-scan`, `slither`, `real-redis`. Vercel reported a successful deployment for the same SHA.

### Ten findings

1. **The ~100 MB figure is real as a repository payload, not as a single page download.** `public/` is 99.31 MiB. `public/games/mpgr-run` is 89.02 MiB (116 files). The play route preloads **61 sprites / 43.26 MiB**, of which **24 / 13.30 MiB are critical**. Music is a separate 2.52 MiB WAV. About **43.2 MiB of WebP is not in the preload list** (menus, portals, pads, unused originals). README still quotes the 2026-09-18 snapshot of 76.37 MiB.
2. **Dashboard routes do not download the game.** `RunGame` is imported only by `app/games/mpgr-run/page.tsx`. There is no `next/dynamic`. The module still parses before the wallet connects on that route.
3. **Lifetime XP does not decay.** Server totals only `INCRBY` (`lib/rewards/xp-ledger.ts`). A missed day resets the **local** streak to 1 on the next check-in. It does not subtract XP, season points, or tokens. There is **no best-streak field** and **no server streak**.
4. **Two XP worlds.** Authoritative grants go through Redis (`/api/xp`, game reward route). `lib/xp-engine.ts` still writes `localStorage` first. A failed server call can show XP the ledger does not have until the next successful `GET /api/xp`.
5. **Fee math is copied, not shared.** Canonical integer formula is `computeExecutorFee` in `lib/executor/executor-fee.ts`. The same `gross * bps / 10_000` floor is reimplemented in trade, swap path, and swap v2 discovery. Do not “clean this up” without a dedicated review and regression tests.
6. **Five quote paths**, not one service: swap v1, swap v2, agent/trade, stocks (order execution disabled with 403), and MCP. Taker is taken from the session on the HTTP quote routes.
7. **Every page pays for wallet infra and, via the navbar, for staking and lock polls.** `Providers` (wagmi, RainbowKit, react-query) wraps the root layout. `Navbar` mounts holder tier, which mounts staking + token lock + multiple balance reads on a 15s poll. Home does that twice (navbar and agent chat). React Query is not used for product data.
8. **`components/ui` is not a design system.** Primitives that exist: `GlassCard`, `EmptyState`, `Skeleton`, `StatCard`, `ProgressBar`, plus `.btn-*` in `globals.css`. Staking and reward widgets live in `ui/`. There is no shared dialog, input, or toast. PaigerSwap uses none of `components/ui` and should stay visually separate.
9. **Dead copies.** `hooks/useHolderTier.ts`, `hooks/holder-tier-engine.ts`, and `hooks/premium-engine.ts` have no importers. Live code is under `lib/`. Local engines (`staking-engine.ts`, `token-lock-engine.ts`) are not the chain clients.
10. **100x is an RPC, Redis, and asset problem before it is a microservice problem.** One Vercel deploy, in-process caches, and per-page chain polling will not survive 100x users. Splitting services now would duplicate the fee and XP rules we are trying to stop duplicating.

### Recommended next five tasks

Do these one PR at a time. Do not start a mass rewrite. None of them change fee recipients, calldata, XP amounts, or settlement flags.

| # | Task | Priority | Why first |
| --- | --- | --- | --- |
| 1 | Game asset budget: drop or relocate unreferenced `screen/`, `portal/`, `pads/`, and unused originals; demote legacy city panoramas from the critical preload; add a byte-budget test. | P0 | Directly attacks the 100 MB payload. Gameplay and reward routes stay. |
| 2 | Stop the navbar from polling staking and token-lock on every route. | P0 | Cuts RPC on every visit. Largest cheap scalability win. |
| 3 | Delete the unused `hooks/` engine copies after a repo-wide import check. | P1 | Removes a real foot-gun. No behavior change. |
| 4 | One navigation config for `Navbar` `PRIMARY_LINKS` and `AppSidebar` `SIDEBAR_GROUPS`. | P1 | Stops new pages from being added twice, differently. |
| 5 | Add server streak and best-streak fields that **never** decrement lifetime XP. Local streak remains a cache. | P1 | Matches the product rule. Needs an explicit check-in design review, not a silent change. |

**Single best next implementation task:** task 1 (asset budget). It is measurable, reversible, and does not touch PaigerSwap, the agent, fees, or the XP formula.

### Needs explicit approval before any code

- Unifying fee math or quote routes.
- Enabling `GAME_REWARDS_ENABLED` or changing weekly settlement.
- Changing XP amounts, season boundaries, or referral caps.
- Deleting MPGR Run or its reward API.
- Moving streak authority to the server (task 5) — design is in the gaming doc; implementation waits for a yes.
- Any contract, manifest, or executor address change.

### Evidence labels used everywhere

1. Verified working — checked in source and, where noted, in CI or GitHub status for this SHA.
2. Implemented, not runtime-verified — code path exists; this audit did not execute it against production.
3. Partially implemented.
4. Planned, not implemented — docs or UI only.
5. Broken or regressed — only if a test or contradiction shows it.
6. Unknown — missing access (no production Redis, no bundle analyzer run, no mobile device trace).

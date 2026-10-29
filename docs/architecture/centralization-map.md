# Centralization map

Rule: one owner for a rule. Routes, MCP, crons, and React components call that owner. They do not reimplement it.

Nothing below is a license to merge PaigerSwap into the agent UI, or to rewrite fee math “while we are here.”

## Duplicates and the canonical owner

| Rule | Canonical today | Copies that must not drift | Migration |
| --- | --- | --- | --- |
| Executor fee floor `gross * bps / 10_000` | `lib/executor/executor-fee.ts` `computeExecutorFee` | `lib/trade/trade-agent-fee.ts`, `lib/swap/swap-executor-intent.ts` `swapPathFeeFloor`, `lib/swap/v2/discovery.ts`, `lib/trade/zero-ex-native-fee.ts` (check, not calculator) | **Approval gate.** Import the canonical function. Add a table test of bps, gross, and dust. Do not change recipients or bps in that PR. |
| Quote | No single owner. Five paths (see current-state). | v1 search, v2 discovery, trade router, MCP service, dormant `lib/swap/zerox-quote.ts` | Keep paths. Later, adapters call one proposal builder. `zerox-quote.ts` stays unwired (file header forbids execution). |
| Trade proposal type | `lib/trade/trade-types.ts` | MCP has its own tool payloads | Map at the MCP boundary. Do not leak JSON-RPC into swap UI. |
| Session wallet | `authenticateRequest` | Any `body.wallet` on user routes | Already true on quote routes. Keep tests that reject a mismatched query wallet. |
| XP amounts | `XP_ACTIONS` in `lib/xp-engine.ts` | Ledger imports it; local `awardXP` adds the same numbers to `localStorage` | Move table to `lib/rewards/xp-actions.ts`. Local writer becomes a cache of server totals. |
| Season month | `lib/season-points.ts` | Was historically reimplemented; header says leaderboard shares it | keep one function |
| Streak | local `performDailyCheckIn` only | UI achievements read that record | Future: Lua beside the check-in `SET NX`. Not a second formula. |
| Rate limit | Redis Lua in `request-guard.ts` | `lib/trade/trade-rate-limit.ts` | One primitive, **different bucket names**. Do not merge swap and AI into one counter. |
| Dialog shell | none | 10 hand-rolled overlays; `SwapDialog` is native `<dialog>` | New shell for hub modals. Swap dialog stays. |
| Nav links | none | `PRIMARY_LINKS`, `SIDEBAR_GROUPS` | One `lib/content/nav.ts` |
| Holder tier math | `lib/holder-tier-engine.ts` + `lib/useHolderTier.ts` | `hooks/useHolderTier.ts`, `hooks/holder-tier-engine.ts` (unimported) | **Deleted on this branch.** |
| Premium math | `lib/premium-engine.ts` | `hooks/premium-engine.ts` (unimported) | **Deleted on this branch.** |
| Logger | `lib/observability/log.ts` | `lib/architecture/core/logger.ts` | P2, low value |
| Token metadata | `lib/token/*` for MPGR the asset | `lib/trade` / swap catalogs for other Base tokens | Do not merge. Different jobs. |
| Game score | `computeRunScore` + `authoritative-replay.ts` | Client `RunGameSimulation` must stay in lockstep (parity tests exist) | Keep parity tests. New games get a new verifier, not a fork of this one. |

## Planned shared modules (do not create them all now)

Create a module only when the second caller is being migrated in the same PR.

| Future module | Callers | Not in v1 |
| --- | --- | --- |
| `lib/content/nav.ts` | Navbar, sidebar | Routes themselves |
| `components/ui/DialogShell.tsx` | stake, unstake, burn, lock, agent confirms | `SwapDialog`, `PairSheet` |
| `components/ui/WalletButton.tsx` | Navbar, sidebar, game page, agent | PaigerSwap’s `openConnectModal` |
| `lib/rewards/xp-actions.ts` | ledger, `/api/xp`, game reward | local history UI |
| `lib/games/shell/` | future light games | MPGR Run renderer |
| Quote kernel | swap, trade, MCP | only after fee review |

## Sequence

Each step is its own PR, rebased on `main`, with the tests named in the file-wise audit.

1. **Docs** (PR #144). Merged. This branch only corrects status that #145 and the navbar change made stale.
2. **Asset budget.** Merged in PR #145. `run-asset-budget.test.ts` locks the new ceilings.
3. **Navbar poll cut.** This branch. Navbar calls `useHolderTier({ poll: false })`, which still mounts staking and token-lock once for a connected wallet. It does not interval, and it does not call `getGlobalState` while logged out or on `staking_changed` unless the caller is polling. An `eth_call` count was not measured in production.
4. **Delete dead `hooks/` copies.** This branch. The three files are gone.
5. **Nav config.** Still open. Update `AppSidebar.render.test.ts` expectations in the same PR.
6. **Pending XP label.** `useXP` / game overlay must not present local +8 as final if the POST failed. No amount changes.
7. **Dialog shell + move staking/reward files out of `components/ui`.** Visual regression on staking and rewards only.
8. **Server streak fields.** Explicit product approval. Lua + concurrency test. XP `INCRBY` path unchanged.
9. **Fee function dedupe.** Explicit financial approval. Golden vectors from current tests. No bps or recipient change.
10. **Light game #1 (Reaction Tap)** behind the catalog, new routes, participation XP only, flags for tokens stay off.

Steps 9 and 10 are not “next.” They wait on 2–6 and on approval.

## What “done” means for centralization

- A new page imports `PageContainer`, nav config, and `GlassCard` / `.btn-*`. It does not copy the navbar.
- A new XP action is one row in the amount table and one server event id. No client-supplied integer.
- A new game adds a folder under `lib/games/<id>` and a catalog row. It does not edit `RunGame.tsx`.
- A new AI provider is a factory entry. It does not get a forked copy of the session/CSRF/budget block (`handleOpenAICompatibleChat` is the template; the OpenAI route should call it).
- Fee math changes are impossible to do “just in the UI.”

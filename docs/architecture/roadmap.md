# Roadmap

Items already done on this branch are marked **landed**. Everything else is a recommendation. Do not batch them.

## P0 — correctness and production cost

### P0.1 Navbar snapshot reads — landed

| | |
| --- | --- |
| Benefit | Hub pages stop a 15s staking + token-lock poll and a logged-out staking global read that existed only to paint a badge. |
| Files | `components/Navbar.tsx`, `lib/useHolderTier.ts`, `hooks/useStaking.ts`, `hooks/useTokenLock.ts`, `lib/chain/live-read-policy.ts`, tests |
| Dependencies | None |
| Risk | Badge can be stale until remount on pages that do not have their own reader. Staking page numbers still poll. Home agent still polls. |
| Test | `shouldPollLiveReads` default true; Navbar source passes `poll: false`; staking and token-lock pages call the hooks with no flag; interval effects return early when `poll` is false. |
| Acceptance | Logged-out navbar path does not call `getGlobalState`. Connected badge still renders after the one-shot wallet, stake, and lock reads. `useStaking()` with no args still intervals at 15s. |
| Rollback | Revert the commit. No Redis or asset migration. |

### P0.2 Remove stale unimported engines — landed

| | |
| --- | --- |
| Benefit | A future import cannot pick up the old local-storage premium/tier math. |
| Files | Deleted `hooks/useHolderTier.ts`, `hooks/holder-tier-engine.ts`, `hooks/premium-engine.ts` |
| Risk | None found. Zero imports. The execution-hook file that a test reads by path was not touched. |
| Test | `navbar-live-read.test.ts` asserts the three paths are absent. |
| Rollback | Restore the files from git. They had no callers. |

### P0.3 MPGR Run critical bytes — open as PR #145, not this branch

| | |
| --- | --- |
| Benefit | Cuts the play-route critical preload. See [mpgr-run-decision.md](./mpgr-run-decision.md). |
| Files | `public/games/mpgr-run/**`, `lib/games/mpgr-run/run-assets.ts`, asset tests. Not fee, XP, or Redis. |
| Risk | One frame of procedural background if the layered skyline is slow. PR #145 says CI was green; this audit did not re-run that branch. |
| Acceptance | Critical bytes lower; gameplay and reward route tests unchanged; not merged together with this branch. |
| Rollback | Revert #145. |

## P1 — high-value, still small

### P1.1 One nav config

Benefit: new pages are added once. Files: new `lib/content/nav.ts`, `Navbar.tsx`, `AppSidebar.tsx`, `AppSidebar.render.test.ts`. Risk: label changes if the merge picks the wrong string. Keep both labels unless product picks one (`Swap` vs `PaigerSwap`). Test: the existing sidebar href list. Rollback: revert.

### P1.2 Dynamic-import `RunGame`

Benefit: game JS leaves the play route's first evaluation. Files: `app/games/mpgr-run/page.tsx` only. Risk: loading flash. Test: a source test that the page uses `next/dynamic` and that `app/page.tsx` still does not mention `RunGame`. Rollback: revert.

### P1.3 Pending XP label

Benefit: a failed `POST /api/xp` is not shown as a final +20. Files: `hooks/useXP.ts` and the check-in UI. No amount change. Risk: copy-only. Test: extend the XP hook tests so a rejected POST does not leave `source: "server-ledger"`. Rollback: revert.

### P1.4 Delete the other unused hooks

Benefit: smaller mental model. Files listed in the duplication register. Do not delete `useAgentActionExecution.ts`. Risk: a string import the search missed. Test: typecheck plus the execution-path test. Rollback: revert.

## P2 — reusable modules

### P2.1 Hub dialog shell

Stake, unstake, burn, lock, agent confirms. Not `SwapDialog` or `PairSheet`. Visual check on those screens only.

### P2.2 Move staking widgets out of `components/ui`

Leaves primitives in `ui/` and feature widgets in `features/staking`. Import updates only.

### P2.3 Game shell types

`lib/games/shell/` plus one catalog row. No new game art until a game is approved. Token rewards stay off.

### P2.4 Server streak

**Blocked on approval.** Lua beside the check-in script. XP `INCRBY` unchanged. No best-streak unless the approval names it. Tests: same day, missed day, two concurrent check-ins, month boundary, total never decreases.

## P3 — scale, only after a measurement

- One Redis factory (x402 and allocation stores).
- Structured logs on quote and XP routes.
- RPC provider budget if 429s show up.
- Fee-function dedupe. **Approval required.** Golden vectors from current tests. No bps or recipient change.
- Postgres, queues, or a second service. Not justified by this tree.

## Explicit approvals required before code

- Unifying fee helpers or quote routes.
- Changing XP amounts, season boundaries, referral caps, or `GAME_REWARDS_ENABLED`.
- Adding a best-streak field or moving streak authority to the server (P2.4).
- Deleting MPGR Run or its reward route.
- Any contract, manifest, executor address, or settlement flag change.
- New infrastructure (database, queue, worker, SaaS error tracker).

## Next PR after this one

Smallest safe scope that is not already in this diff: review PR #145 on its own, or, if that review is blocked, P1.2 (`next/dynamic` for `RunGame` only). Do not start P2.4 or the fee dedupe.

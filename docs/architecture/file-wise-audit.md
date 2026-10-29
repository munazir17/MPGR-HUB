# File-wise audit

Scope: first-party source that affects runtime. Not line-audited: `node_modules`, `.git`, `docs/evidence/**` screenshots, `package-lock.json`, one-byte placeholder files under `public/games`.

Inventory method: directory ownership from entry files and import greps, plus full reads of XP, game reward, asset, layout, and CI paths. Counts are from this tree at `3fb5eb82`.

Legend for the Action column: **keep**, **refactor**, **split**, **consolidate**, **deprecate** (only after nothing imports it).

Tests-before-change means the smallest existing suite to run before editing that module. “Add” means coverage is missing.

## Hotspots

| Path | Lines (approx) | Why it is a hotspot | Action | Priority |
| --- | --- | --- | --- | --- |
| `lib/api/request-guard.ts` | — | ~76 importers. CSRF, body cap, rate limit, AI budget, request id. | keep; split only if a change needs it | P2 |
| `lib/auth/session-store.ts` | — | ~71 importers. | keep | — |
| `lib/executor/executor-config.ts` | — | ~65 importers. Addresses and fee constants. | keep; no drive-by edits | P0 do-not-touch |
| `lib/trade/trade-types.ts` | — | Shared `TradeProposal`. | keep | — |
| `lib/mcp/mcp-trade-service.ts` | ~1529 | Quote + prepare + verify for three venues. | split later, after a quote-kernel design review | P1 approval |
| `lib/autonomy/runtime.ts` | ~1592 | Evaluate, reserve, execute, reap. | split only with the autonomy tests | P2 |
| `lib/swap/v2/discovery.ts` | ~766 | Routing **and** fee floor. | keep until fee review | P0 do-not-touch |
| `lib/trade/trade-execution.ts` | ~725 | User-wallet signer. | keep | P0 do-not-touch |
| `lib/games/mpgr-run/run-render.ts` | ~56 KB | Canvas. Not on the dashboard import graph. | keep; do not import from shell | P1 |
| `components/features/games/mpgr-run/RunGame.tsx` | 632 | Simulation loop + preload + submit. | split input/loop from rewards submit later | P2 |
| `hooks/useAgentChat.ts` | 652 | Pulls staking, lock, XP, rewards, premium, season. | stop mounting chain polls here | P0 |
| `hooks/useAgentAutonomy.ts` | 900 | Autonomy UI state. | split when next touching it | P2 |
| `app/docs/page.tsx` | 1494 | Content in a page component. | move copy to `lib/content` | P2 |
| `app/whitepaper/page.tsx` | 1017 | Same. | same | P2 |
| `components/ui/*` staking & reward cards | — | Feature UI in the primitive folder. | move to `features/` | P1 |

## `app/` routes

| Path | Responsibility | Consumers | Placement | Risk | Action |
| --- | --- | --- | --- | --- | --- |
| `app/layout.tsx` | HTML shell, Inter, metadata, `Providers`, referral + auth bootstrap | every page | correct | Wallet stack is global | refactor provider split (P1) |
| `app/page.tsx` | Home = agent stage | — | correct, client | Heavy hooks via children | keep |
| `app/swap/page.tsx` | Metadata + `SwapExperience` | — | correct, server, 4 lines | — | keep |
| `app/agent/page.tsx` | Redirect `/` | — | correct | — | keep |
| `app/games/page.tsx` | Catalog | — | correct | Imports reward helpers for display | keep |
| `app/games/mpgr-run/page.tsx` | Full viewport game | — | correct | Static `RunGame` import | refactor dynamic import (P1) |
| `app/api/xp/route.ts` | GET standing, POST connect + UTC check-in | `hooks/useXP.ts` | correct | Check-in also settles referrals | keep |
| `app/api/swap/quote/route.ts` | V1 quote, session taker | swap UI | correct | Fee policy | do-not-touch |
| `app/api/swap/v2/*` | V2 quote, settlement, status | swap UI, agent routing | correct | Sealed manifest | do-not-touch |
| `app/api/trade/quote/route.ts` | Agent quote | agent hooks | overlaps swap | Different fee strictness | keep until kernel review |
| `app/api/trade/stocks/order/route.ts` | Always 403 | — | correct | — | keep |
| `app/api/mcp/route.ts` | JSON-RPC | skills, autonomy | correct | No cookie session | keep |
| `app/api/agent/complete/*` | Provider proxies | chat | Groq/OpenRouter share a helper; OpenAI route duplicates it | refactor duplicate (P2) |
| `app/api/games/mpgr-run/session/route.ts` | Issue seed + session | `RunGame` | correct | — | keep |
| `app/api/games/mpgr-run/checkpoint/route.ts` | Heartbeat | `RunGame` | correct | — | keep |
| `app/api/games/mpgr-run/reward/route.ts` | Replay, idempotent XP, no token amount | `RunGame` | correct | Flags change failure mode | do-not-touch flags |
| `app/api/games/mpgr-run/settlement/route.ts` | Weekly cron | `vercel.json` | correct | Vault write if flags on | do-not-touch |
| `app/api/games/mpgr-run/settlement/reconcile/route.ts` | Stuck-week report | cron | correct | Does not auto-retry | keep |
| `app/api/leaderboard/route.ts` | GET from XP zset; POST 410 | leaderboard page | correct | N+1 reads | refactor read (P2) |
| `app/api/campaigns/**` | Join / action / admin | campaign UI | correct | Admin is `CRON_SECRET` | keep |
| `app/api/x402/**` | Discover (SSRF guarded), register, submit, tape | agent | correct | — | keep |
| `app/docs/page.tsx`, `whitepaper`, `about`, `support` | Long static content via `InfoPageShell` | — | content mixed into routes | — | split copy (P2) |

No route-level `loading.tsx` or `error.tsx`. Tests before API edits: the colocated `*.test.ts` next to that route, plus `lib/api/request-guard.test.ts` if the guard changes.

## `components/`

| Path | Responsibility | Consumers | Placement | Duplication | Action |
| --- | --- | --- | --- | --- | --- |
| `components/providers.tsx` | wagmi, RainbowKit, react-query, `WalletAuthProvider` | root layout | correct | — | keep; optional second tree for docs |
| `components/Navbar.tsx` | Primary links + custom connect + holder tier | most pages | correct | Nav list ≠ sidebar | consolidate nav config (P1) |
| `components/layout/AppSidebar.tsx` | Mobile/desktop sheet | Navbar | correct | Stock `ConnectButton`; stale comment | consolidate (P1) |
| `components/layout/PageContainer.tsx`, `InfoPageShell.tsx`, `LegalPage.tsx` | Page frames | info + a few product pages | correct | Product pages often skip them and reimport Navbar | refactor (P2) |
| `components/ui/GlassCard.tsx`, `EmptyState.tsx`, `Skeleton.tsx`, `SkeletonCard.tsx`, `StatCard.tsx`, `ProgressBar.tsx`, `SectionHeader.tsx` | Real primitives | many features | correct | — | keep |
| `components/ui/StakeModal.tsx`, `UnstakeModal.tsx`, `ExitModal.tsx`, `Staking*.tsx` | Staking UI | staking page | **wrong folder** | Same backdrop class as burn/lock/agent | move + shared shell (P1) |
| `components/ui/Reward*.tsx`, `AchievementCard.tsx`, `OnChainRewardsSection.tsx` | Rewards UI | rewards | **wrong folder** | Several card dialects | move (P1) |
| `components/features/swap/**` | PaigerSwap | `/swap` | correct | Zero `components/ui` imports. Own dialog. | **keep visually separate** |
| `components/features/agent/**` | Chat, autonomy, confirm modals | home | correct | Four modal recipes | shared shell except swap (P1) |
| `components/features/games/mpgr-run/RunGame.tsx` | Game loop | game page only | correct | — | keep isolated |
| `components/features/games/GameCard.tsx`, `FeaturedGameBanner.tsx` | Catalog art | games, rewards banner | correct | lazy card, eager banner | keep |
| `components/markets/LiveTape.tsx`, `PairSheet.tsx` | Tape + pair drawer | home | correct | Own drawer | keep |

`useReducedMotion` only in `AgentCore.tsx` and `AgentExperience.tsx`. Other motion always runs. **P2.**

Accessibility evidence: 44px targets and focus ring in `globals.css`; sidebar is a dialog with Escape. Stake/unstake/burn/x402 modals lack `role="dialog"`. **P1** when a shell exists. Tests: `tests/mobile/*` cover swap layout at 360/390, not the whole site.

## `hooks/`

| Path | Responsibility | Placement | Action |
| --- | --- | --- | --- |
| `useWalletAuth.tsx` | Single SIWE provider | correct | keep |
| `useXP.ts` | Local check-in then POST `/api/xp` | correct | refactor pending-state (P1) |
| `useSwapExecution.ts`, `useSwapBalances.ts` | PaigerSwap only | correct | keep |
| `useTrade*.ts`, `useTransfer*.ts`, `useX402*.ts` | Agent confirm/send | correct | keep |
| `useStaking.ts`, `useTokenLock.ts` | 15s chain polls | correct for their pages | do not mount from navbar (P0) |
| `useRewardHub.ts`, `useRewardClaim.ts` | 15s | rewards pages | keep |
| `useAgentChat.ts` | Orchestrator | home | drop nested staking/lock (P0) |
| `useHolderTier.ts`, `holder-tier-engine.ts`, `premium-engine.ts` | Copies of `lib/` | **dead, zero importers** | deprecate/delete (P1) |

`lib/useHolderTier.ts` is the live one (Navbar, profile, holder overview, agent chat).

There is no `useQuery` for product data. Polling is `setInterval` inside hooks. **P** for cache invalidation. Do not introduce React Query as a drive-by.

## `lib/` domains

Source lines exclude tests. Test lines are the safety net; run them before editing the domain.

| Folder | Src lines | Test lines | Responsibility | Overlap | Action |
| --- | --- | --- | --- | --- | --- |
| `architecture/` | 15294 | 12372 | AI providers, tools, memory, AgentKit prepare-only | Overlaps `agent-intelligence`, `agent-commands` | keep boundaries |
| `trade/` | 9675 | 6089 | Agent quotes, signer, 0x/CDP | Fee copy; three 0x clients | do-not-touch signer |
| `swap/` | 8874 | 7176 | PaigerSwap v1 search + v2 discovery/execute | Fee copy vs executor | do-not-touch v2 |
| `autonomy/` | 7754 | 11378 | Goals, policy, delegated adapter, off by default | Calls MCP, not `/api/trade` | keep |
| `games/` | 5839 | 4006 | MPGR Run assets, replay, sessions | — | asset budget only |
| root engines | 5446 | 535 | `xp-engine` (local), `agent-engine`, mock staking/lock engines | Dual XP | mark local as cache (P1) |
| `x402/` | 4007 | 2232 | Paid HTTP, SSRF guard | — | keep |
| `executor/` | 3575 | 2988 | V1 executor config, fee, intents, ABI | Canonical fee | do-not-touch |
| `mcp/` | 2537 | 3477 | Stateless tools | Third quote implementation | approval to dedupe |
| `rewards/` | 824 | 183 | On-chain hub aggregate + **XP ledger** | Imports amounts from `xp-engine` | ledger is canonical |
| `auth/` | 482 | 389 | Session, SIWE, nonce | — | keep |
| `referral/` | 428 | 312 | Attribution + capped XP | Uses ledger | keep |
| `api/` | 642 | 753 | Redis, guard | Two rate-limit implementations (`request-guard` vs `trade-rate-limit`) | consolidate primitive later (P2) |
| `observability/` | 25 | 0 | JSON log, wallet-key redaction | Second logger in `architecture/core/logger.ts` | P2 |
| `runtime/` | 17 | 0 | In-process round robin | Not durable across isolates | acceptable until 100x AI |

Root files that look like services but are client caches: `lib/xp-engine.ts`, `lib/staking-engine.ts`, `lib/token-lock-engine.ts`, `lib/rewards-engine.ts`, `lib/storage.ts`. Chain truth is `lib/staking/staking-client.ts` and `lib/token-lock/token-lock-client.ts`.

### Games files worth naming

| Path | Role | Action |
| --- | --- | --- |
| `lib/games/mpgr-run/run-assets.ts` | Path manifest, critical vs optional | edit only in the asset-budget PR |
| `lib/games/mpgr-run/asset-loader.ts` | Concurrency 3/2, no gameplay wait | keep |
| `lib/games/mpgr-run/run-music.ts` | WAV | optional follow-up |
| `lib/games/mpgr-run/authoritative-replay.ts` | Tick replay | do-not-touch |
| `lib/games/mpgr-run/server-session.ts` | Redis sessions, 3 per wallet | keep |
| `lib/games/mpgr-run/run-validation.ts` | Bounds, not proof | keep |
| `lib/games/game-registry.ts` | One playable id, rest coming-soon | do not advertise routes that 404 |
| `lib/reward-allocation/*` | Weekly weight, settlement lock, outbox | do-not-touch without reward review |
| `lib/games/asset-loading-policy.test.ts` | Forbids `loading="lazy"` on in-game sprites | keep; it does not forbid JS code-splitting |

### Points files

| Path | Role | Tests before edit |
| --- | --- | --- |
| `lib/xp-engine.ts` | Amount table + local streak/check-in | `lib/rewards/xp-ledger.durability.test.ts`, xp route tests |
| `lib/rewards/xp-ledger.ts` | Canonical Redis award | same |
| `lib/season-points.ts` | Month math shared with leaderboard | season tests if present |
| `lib/season-engine.ts` | Local season-pass claims, can local-award quest XP | do not treat as ledger |
| `lib/leaderboard-store.ts` | Monotonic upsert exists; live route does not call it (POST 410) | leaderboard route tests |
| `lib/referral/referral-store.ts` | SETNX + daily cap | referral tests |
| `lib/campaigns/campaign-store.ts` | Idempotent points, cap rollback | campaign tests |

## Contracts, workflows, skills

| Path | Role | Action |
| --- | --- | --- |
| `contracts/**`, `test/**` | Staking and swap/executor Forge tests. solc 0.8.24. | do-not-touch in this initiative |
| `script/gen-executor-abi.mjs` | CI `--check` against `lib/executor` ABI | do-not-touch |
| `.github/workflows/ci.yml` | Required gate | keep |
| `.github/workflows/deploy-*.yml`, `mainnet-canary.yml` | Manual, privileged | do not trigger from this work |
| `skills/mpgr/{paigerswap,mpgr-mcp,mpgr-agent}` | Client instructions. Not a signature. | update only if a tool contract changes |
| `public/games/mpgr-run/**` | 89 MiB art | asset-budget PR |
| `docs/ARCHITECTURE.md` | Aspirational | leave; this folder supersedes it for the 2026-10 audit |

## Dependency map (coupling)

```text
Navbar
  -> lib/useHolderTier
       -> useStaking (15s) -> lib/staking + useMPGRBalance
       -> useTokenLock (15s) -> lib/token-lock + useMPGRBalance
       -> useMPGRBalance again

useAgentChat (home)
  -> the same staking/lock/XP/rewards tree
  -> /api/agent/complete -> architecture/ai -> providers
  -> trade hooks -> /api/trade/quote -> trade router -> executor | CDP | 0x

SwapExperience
  -> /api/swap/quote and /api/swap/v2/quote
  -> does not import components/ui or the agent tree

RunGame
  -> run-assets preload
  -> /api/games/mpgr-run/{session,checkpoint,reward}
  -> reward -> authoritative-replay + xp-ledger
  -> not imported by Navbar or home

MCP / autonomy
  -> mcp-trade-service -> executor + 0x native fee + swap v2
  -> does not go through /api/swap
```

Circular risk: `xp-ledger` imports amounts from `xp-engine`, and `xp-engine` is also the localStorage writer. A server module depending on a client storage module is the wrong direction. Move `XP_ACTIONS` to `lib/rewards/xp-actions.ts` when streak work starts, and keep `xp-engine` as a cache. **P1.** Not in the asset PR.

## Tests required before any of the recommended code PRs

| PR | Run |
| --- | --- |
| Asset budget | `lib/games/mpgr-run/run-assets*.test.ts`, `asset-loading-policy.test.ts`, game reward route tests |
| Navbar polls | holder-tier tests, a render test that Navbar does not import `useStaking` if that becomes the rule |
| Dead hook delete | `npm run typecheck` (imports fail closed) |
| Nav config | `components/layout/AppSidebar.render.test.ts` |
| Server streak | `xp-ledger` durability tests plus new Lua tests for concurrency. Do not ship without them. |

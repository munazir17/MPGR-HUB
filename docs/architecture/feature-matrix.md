# Feature to file matrix

Baseline `3fb5eb82`, updated for the navbar poll flag and for merged PR #145's asset files. "Calls" means a confirmed import, not every transitive file. Asset byte ownership is `lib/games/mpgr-run/run-assets.ts` plus `run-asset-budget.test.ts`, not this table.

| Feature | Entry | Owns | Calls | Must stay isolated |
| --- | --- | --- | --- | --- |
| App shell | `app/layout.tsx`, `components/providers.tsx`, `components/Navbar.tsx`, `components/layout/AppSidebar.tsx` | Wagmi, RainbowKit, React Query, SIWE bootstrap, nav | `lib/useHolderTier` with `poll: false` from the navbar only | Do not import `RunGame`, swap quote builders, or Redis |
| Home agent | `app/page.tsx`, `components/features/agent/*`, `hooks/useAgentChat.ts`, `hooks/useAgentAutonomy.ts` | Chat, confirmations, autonomy UI | Staking, token-lock, premium, holder tier, XP, trade/transfer/x402 quote hooks. Still polls | Signing and quote display. Do not fold into PaigerSwap components |
| PaigerSwap | `app/swap/page.tsx`, `components/features/swap/*`, `app/api/swap/**`, `lib/swap/**` | Quote, liquidity search, v2 settlement UI | Session taker overwrite on quote routes | No `components/ui` dependency. No agent chat imports |
| MPGR Agent trade API | `app/api/trade/**`, `lib/trade/**`, `lib/mcp/**`, `app/api/mcp/route.ts` | Quotes, stock catalog, MCP tools | `computeExecutorFee` and a local `floor(gross * bps / 10_000)` copy | Prepare-only. Stocks order route stays 403 |
| Staking | `app/staking/page.tsx`, `hooks/useStaking.ts`, `lib/staking/**`, `components/ui/Staking*.tsx` | Positions, stake/unstake/claim UI | `useStaking()` default poll | Reward economics and ABIs |
| Token lock | `app/app/token-lock/page.tsx`, `hooks/useTokenLock.ts`, `lib/token-lock/**` | Locks, early unlock | `useTokenLock()` default poll | Same |
| Holder tier | `lib/holder-tier-engine.ts`, `lib/useHolderTier.ts`, `components/features/holder-tier/*` | Score = wallet + staked + locked | Balance, staking, token-lock | The deleted `hooks/` copies must not return |
| Premium | `lib/premium-engine.ts`, `hooks/usePremium.ts` | Tier from cached on-chain locks | `useTokenLock` | Not the deleted `hooks/premium-engine.ts` |
| XP and season | `lib/xp-engine.ts`, `lib/rewards/xp-ledger.ts`, `lib/season-points.ts`, `app/api/xp/route.ts`, `hooks/useXP.ts` | Local cache + server ledger | Auth, referral settle on check-in | Amount table. No client-supplied XP integer |
| Referrals | `lib/referral/referral-store.ts`, `app/api/referral/route.ts` | First referrer, daily cap, +100 on real check-in | XP ledger | Cap and event id |
| Leaderboard | `app/leaderboard/page.tsx`, `app/api/leaderboard/route.ts` | Rank from XP ZSET. POST is 410 | `getRankedWallets` | `lib/leaderboard-store.ts` is **not** on this path (tests only) |
| Campaigns | `app/campaigns/**`, `app/api/campaigns/**`, `lib/campaigns/**` | Join/track as session wallet | Redis | Admin route is `CRON_SECRET` and is the one writer that takes `body.wallet` |
| MPGR Run | `app/games/mpgr-run/page.tsx`, `components/features/games/mpgr-run/**`, `lib/games/mpgr-run/**`, `app/api/games/mpgr-run/**` | Canvas, assets, sessions, replay, weekly settlement | XP ledger for capped +8 | Not imported by the dashboard. Do not delete in a cleanup PR |
| Games catalog | `app/games/page.tsx`, `lib/games/game-registry.ts`, `components/features/games/GameCard.tsx` | Coming-soon registry, two small marketing images | `run-rewards` / `run-config` types only | Must not import `run-assets` or `RunGame` |
| Rewards hub | `app/rewards/page.tsx`, `hooks/useRewardHub.ts`, `hooks/useRewardClaim.ts` | On-chain reward vault reads | Own 15s poll, not the navbar | Claim math |
| Burn | `app/burn/**`, `hooks/useBurn.ts` | Burn UI | Navbar (snapshot tier) | — |
| Auth | `app/api/auth/**`, `lib/auth/**`, `hooks/useWalletAuth.tsx` | SIWE nonce, HMAC cookie, Redis session | Rate limit | Never trust a bare address |
| Markets tape | `components/markets/**`, `app/api/market/**`, `hooks/useTape.ts` | Public tape | IP rate limit | — |
| x402 | `app/api/x402/**`, `lib/x402/**`, `hooks/useX402Payment.ts` | Discover, register, submit | Session + origin | SSRF guard stays |
| Contracts | `contracts/**`, `script/**`, `foundry.toml` | Executor, swap executor, staking | CI forge + slither | No app PR should redeploy |
| Content pages | `app/docs`, `whitepaper`, `about`, `support`, `roadmap`, `terms`, `privacy`, `token` | Static copy, some of it repeats XP numbers | `InfoPageShell` / `LegalPage` → Navbar | Copy can drift from `XP_ACTIONS` |

## Pages that mount Navbar

Direct: `/`, `/rewards`, `/season`, `/leaderboard`, `/campaigns`, `/campaigns/[slug]`, `/staking`, `/season-pass`, `/games`, `/app/token-lock`, `/profile`, `/burn`.

Through a shell: `/whitepaper`, `/support`, `/roadmap`, `/about`, `/docs`, `/terms`, `/privacy`, `/token`.

No Navbar: `/swap`, `/games/mpgr-run`. `/agent` and `/premium` redirect.

## API groups

Auth (`nonce`, `verify`, `session`, `logout`), agent complete (OpenAI, Gemini, NVIDIA, Groq, OpenRouter), agent stats/voice/visitors, autonomy (config, tokens, policy, goals, authorization, tick), AgentKit actions/invoke, campaigns, XP, referral, leaderboard, MPGR Run session/checkpoint/reward/weekly-status/settlement/reconcile, market, trade, swap v1 + v2, transfer quote, x402, MCP, `llm.txt` / `llms.txt`.

Session wallet is the actor on user routes checked in this pass. The exception is campaign admin, gated by `CRON_SECRET`, which records an outcome for `body.wallet`.

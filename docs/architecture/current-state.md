# Current state

Audit date: 2026-10-29. Branch audited: `main`.

Evidence labels: **V** verified working, **I** implemented not runtime-verified here, **P** partial, **L** planned only, **B** broken, **U** unknown.

## Repository

| Fact | Value | Label |
| --- | --- | --- |
| URL | https://github.com/munazir17/MPGR-HUB | V |
| Default branch | `main` | V |
| HEAD | `3fb5eb82f1e7293ec99926b0511d6196d145a03e` | V |
| HEAD subject | Merge pull request #143 from `fix/paigerswap-v2-agent-routing` | V |
| Working tree at audit start | Clean (shallow clone of that commit) | V |
| License | MIT for `/contracts` and `/test`; All Rights Reserved elsewhere (`LICENSE`) | V |

Recent merged PRs on `main` (closed, `merged_at` set): #143 agent↔PaigerSwap v2, #142 v4 scan rate-limit quotes, #141 fair quotes / brand, #140 Discord link, #139 smart-wallet confirmation, #138 builder code, #137 USD quotes and RPC rotation, #136 multi RPC/AI, #135 CSRF/SSRF/campaign points, #134 hub traded volume.

Open PRs at audit time are Dependabot only (#48–#52). They are **not** part of this initiative. Do not pile architecture work onto them.

## CI and deploy

GitHub check runs on `3fb5eb82` (queried 2026-10-29):

| Check | Conclusion |
| --- | --- |
| quality | success |
| build | success |
| contracts | success |
| contracts-fork | success |
| secret-scan | success |
| slither | success |
| real-redis | success |
| Secure read-only Base Mainnet checks | skipped |
| Vercel deployment status | success |

Workflow file: `.github/workflows/ci.yml`. Jobs: `quality` (lint, typecheck, vitest, `audit:high`), `build` (`next build`), `contracts` (Forge, solc 0.8.24), `contracts-fork`, `secret-scan` (gitleaks), `slither`, `real-redis` (one autonomy Lua test). Many other workflows are manual deploy/smoke/canary. This audit did not re-run them.

`vercel.json`: build is `next build --webpack || next build`. Crons: weekly game settlement `10 0 * * 1`, daily reconcile `15 6 * * *`. No other scheduler.

## Stack (from package.json, not the README)

| Piece | Actual | README claim | Label |
| --- | --- | --- | --- |
| Framework | `next@16.4.2`, App Router | “Next.js 16.3.5” | V code, README stale |
| UI | React 18.3, Tailwind 3.4, framer-motion 11 | matches | V |
| Chain | wagmi 2.19, viem 2.21, RainbowKit 2.2, ox 0.14 | matches | V |
| Data | `@upstash/redis` 1.35 | matches | V |
| Tests | vitest 4.1, Playwright 1.56 (mobile harness), Foundry | matches | V |
| Package manager | npm, lockfile present, Node `>=20.11.0` (`.nvmrc` is Node 20) | matches | V |
| Postgres, Docker, BullMQ, Prometheus, pnpm | absent | README already says absent | V |
| AgentKit | `@coinbase/agentkit` server-external in `next.config.mjs` | — | V |

`docs/ARCHITECTURE.md` describes a task queue, event bus, and “no major architectural changes needed.” The event/refresh helpers exist as in-process client utilities. There is no durable queue. Treat that document as **P/L**, not as the runtime map.

## Runtime shape

One Next.js deployment. Server logic is route handlers plus `lib/`. The browser holds wallet state (wagmi) and several `localStorage` caches.

```text
Browser (wagmi session + local caches)
  -> app/api/*  (cookie session, CSRF on mutating JSON, Redis rate limits)
       -> lib/<domain>  (pure rules + Redis + viem reads)
            -> Base RPC / 0x / CDP / AI providers / DexScreener
User wallet signs. Server does not hold user keys.
Operator broadcaster exists only behind autonomy/delegated flags (default off).
```

Production origin referenced in metadata: `https://mpgrhub.xyz`. This audit did not probe that host.

## Routes

Product pages (each mounts `Navbar` unless noted): `/` (agent), `/swap` (no navbar; thin server page), `/rewards`, `/staking`, `/games`, `/games/mpgr-run` (no navbar, own chrome), `/leaderboard`, `/campaigns`, `/campaigns/[slug]`, `/profile`, `/season`, `/season-pass`, `/burn`, `/app/token-lock`, `/token`, `/docs`, `/whitepaper`, `/about`, `/support`, `/roadmap`, `/terms`, `/privacy`.

Redirects: `/agent` → `/`, `/premium` → `/profile`.

API groups: `auth`, `xp`, `referral`, `leaderboard`, `campaigns`, `swap` (+ `swap/v2`), `trade` (+ stocks), `transfer`, `market`, `agent` (+ autonomy, complete, voice), `agentkit`, `mcp`, `x402`, `games/mpgr-run`.

No `loading.tsx` / `error.tsx` route boundaries were found. Failures are inline.

## Auth and signing

- **V** SIWE-style message in `lib/auth/siwe.ts` (hand-rolled, EOA then ERC-1271). Nonce in Redis, 5 min, consumed once.
- **V** Session cookie HMAC, chain fixed to 8453, 8h, revocable via `mpgrhub:auth:session:*`. Redis down ⇒ `authenticateRequest` returns null.
- **V** Quote HTTP routes overwrite taker/sender with `session.wallet`.
- **V** MCP is not cookie-authenticated. Economics are bound into an HMAC `quoteId` (`lib/mcp/quote-id.ts`). Mainnet MCP stays off unless `MPGR_MCP_ENABLE_BASE_MAINNET=true`.
- **I** User-wallet signing lives in client modules (`lib/trade/trade-execution.ts`, `lib/x402/x402-execution.ts`, swap hooks). Not re-executed here.
- **I** Delegated gas payer (`lib/delegated`) re-checks calldata before sign. Flags default off.

## Data

No SQL database. Redis key families are owned per domain (`mpgrhub:auth:`, `xp:`, `referral:`, `campaign:`, `games:`, `autonomy:`, `x402:`, `ratelimit:`, `ai:budget:`). XP event and total keys are written **without TTL** (durability migration inside the award Lua). Game sessions expire (15 min). Daily caps expire.

In-process `Map`s (quote cache, AI key cursor, chat memory, tape snapshot) do not survive extra serverless isolates. **P** for horizontal scale.

## XP, games, money

| Concern | State | Label |
| --- | --- | --- |
| Server XP ledger | Idempotent `SET NX` + `INCRBY`. Amounts fixed in `XP_ACTIONS`. | V code |
| Season points | Same award also increments `mpgrhub:xp:month:YYYY-MM`. New month reads 0. Lifetime key untouched. | V code |
| Streak | `localStorage` only. Missed UTC day sets streak to 1 on next check-in. No XP subtraction. No best streak. | V code |
| Game XP | Flat 8, daily cap 10, only after authoritative replay. Client cannot send an XP amount. | V code |
| On-chain game rewards | Both `GAME_REWARDS_ENABLED` and `GAME_AUTHORITATIVE_VERIFICATION_ENABLED` must be exactly `"true"`. Default false. | V code, **U** production flag values |
| Staking / lock / vault | Live wagmi clients under `lib/staking`, `lib/token-lock`, `lib/reward-vault`. Root `*-engine.ts` files are local mocks. | V code, **I** mainnet reads |
| Stocks order | `POST /api/trade/stocks/order` returns 403 `EXECUTION_UNAVAILABLE`. | V code |

## Environment names

Names only. Values are not copied here. `.env.example` is mostly empty or obvious placeholders. `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` and `NEXT_PUBLIC_BASE_RPC_URL` are non-empty public client settings; the project id is a public identifier committed in the example file.

`getRedis()` prefers `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, which are **not** listed in `.env.example` (KV names are). CI injects placeholder Upstash vars.

Fail-closed at first use, not at process boot: `AUTH_SESSION_SECRET` (min 32 chars when signing), `APP_ORIGIN` on Vercel production, Redis for authenticated routes, `CRON_SECRET` for settlement and campaign admin. AI keys are optional per provider. Game reward flags default off.

Nothing in this audit read production env dashboards. Whether those names are set in Vercel is **U**.

## Feature flags (code defaults)

| Name | Default in example / code | Label |
| --- | --- | --- |
| `GAME_REWARDS_ENABLED` | `false` | V |
| `GAME_AUTHORITATIVE_VERIFICATION_ENABLED` | `false` | V |
| `MPGR_MCP_ENABLE_BASE_MAINNET` | `false` | V |
| `MPGR_AUTONOMOUS_AGENT_ENABLED` | `false` | V |
| `AUTONOMOUS_PRODUCTION_ENABLED` | `false` | V |
| `MPGR_AUTONOMOUS_EMERGENCY_DISABLE` | `false` | V |

Swap v2 activation is a sealed manifest in code (`lib/swap/v2/deployment.ts`), not an env address. **I** — this audit did not call the live executor.

## Known doc drift (do not “fix” by editing behavior)

- README Next version and game-art size.
- `docs/ARCHITECTURE.md` infrastructure layer.
- `run-assets.ts` header still says only the city set is wired; code wires city, ice, and desert.
- Sidebar comment still describes an older primary nav.
- `docs/FINAL_REMEDIATION_VERIFICATION.md` repeats the 76.37 MiB figure.

## What this audit did not do

- No production traffic, RPC traces, or Redis `INFO`.
- No `next build` analyzer (CI build already passed on this SHA; bundle byte budgets are **U**).
- No phone network waterfall. Asset bytes are from the git tree plus the loader’s path list.
- No contract execution and no signing.

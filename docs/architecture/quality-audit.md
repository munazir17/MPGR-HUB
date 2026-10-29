# Performance, security, reliability, tests

No production load test was run. Nothing below is a claim that the app supports a specific user count.

## Route weight

| Path | Confirmed cost | Not measured |
| --- | --- | --- |
| Any hub page with Navbar | Wagmi + RainbowKit + React Query hydrate. Navbar holder read is now one-shot when connected, and no staking global read when logged out. | JS gzip of the main chunk |
| `/` | Above, plus agent chat, which still mounts extra staking and token-lock pollers | — |
| `/swap` | Swap graph, no Navbar, no Run | — |
| `/games/mpgr-run` | Static `RunGame` import. Critical sprites 13,941,098 bytes before optional. WAV 2,646,044 on mount | Decode time, br transfer |
| `/games`, `/rewards` | Small banner/card images only | — |

Client/server split is the App Router default. Game and swap UIs are client components because they touch wallet and canvas. API routes are server-only. `lib/api/redis.ts` is not marked `server-only` even though callers that hold secrets generally are. Worth a follow-up, not done here, because a wrong `server-only` add can break a client import that only needed types.

## RPC and Redis

- Staking poll interval 15s. Service cache TTL 12s, so each poll still misses the cache. Token-lock poll 15s with a 15s module cache.
- Home can mount several hook instances. They do not share React state. In-flight dedupe inside the staking service collapses simultaneous calls.
- This branch removes the Navbar instance's repeat timers and its logged-out global read. It does not remove the agent's polls or the staking page's polls.
- Redis hot keys at 100× would be session lookups, rate-limit windows, and XP rank `ZINCRBY` on one key. **Unknown** without Upstash metrics.
- Race notes already handled in code and not modified: XP event `SET NX`, referral `SET NX`, game session consume, campaign idempotency. Streak has no server concurrency because it is local.

## Observability

`logApi` writes JSON and redacts wallet fields. The agent logger is `console`. There is no Sentry (or similar) dependency. `@vercel/analytics` is on the root layout. Tracing is **unknown**. A 100× plan needs error rate, RPC p95, Redis p95, and 5xx by route before any capacity number.

## Tests and release

CI `quality` runs lint, `tsc --noEmit`, `vitest run`, and `audit:high`. This audit's new tests are `lib/chain/live-read-policy.test.ts` and `hooks/navbar-live-read.test.ts`. Results belong in the PR body after they are run, not here as a guess.

Contracts: Forge, slither, ABI check. Real-Redis job covers autonomy scripts. e2e workflows exist and were **skipped** on PR #145.

Rollback of an app PR is revert + Vercel redeploy of `main`. Do not use the mainnet deploy workflows for a UI or docs change.

## Security boundaries (unchanged)

| Boundary | Owner | Note |
| --- | --- | --- |
| SIWE + session cookie | `lib/auth` | Nonce single use |
| Origin check | `verifyTrustedOrigin` inside `protectApiRequest` | Keep on new POSTs |
| XP amount | Server `XP_ACTIONS` | Client field ignored on the run reward route |
| Run replay | `authoritative-replay.ts` | Light games need their own proof |
| Fee | Executor + swap/trade copies | Do not "clean up" here |
| x402 fetch | `lib/x402/ip-guard.ts` | No raw `fetch(userUrl)` |
| Secrets | Env, gitleaks in CI | Docs must not paste `.env.example` values |
| Campaign admin `body.wallet` | `CRON_SECRET` | Only cron writer found that trusts a body wallet |

## 10× and 100× (triggers, not a redesign)

| Signal | 10× response | 100× response |
| --- | --- | --- |
| RPC 429s on public Base | Finish snapshot reads (this PR is the navbar slice). Share one poll per tab for staking. | Dedicated RPC provider budget. Still one app. |
| Redis latency or command cap | Confirm hot keys in the Upstash console. Collapse duplicate clients onto `getRedis()`. | Only then consider a second store. Postgres is not justified by the current access pattern. |
| Game route LCP | Land #145 or an equivalent critical-byte cut. Dynamic-import `RunGame`. | CDN already immutable; the win is fewer bytes, not another origin. |
| AI route cost | Existing budget keys | Per-wallet caps stay. No new provider in an architecture PR. |
| No metrics | Add structured logs and a dashboard read | Do not quote a user capacity |

Required before any capacity claim: a scripted load of `GET /api/leaderboard`, `GET /api/xp`, and the public tape, plus a browser trace of `/` and `/games/mpgr-run` on a cold mobile profile. Those were not run.

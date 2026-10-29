# Scalability roadmap

“100x” means roughly 100× active wallets, API calls, game sessions, and stored XP events versus today’s unmeasured baseline. We do not have production QPS. Treat every benefit below as conditional on the verification column. Do not rewrite the app to get there.

I1 landed in merged PR #145. I2 and I3 land on this branch (navbar snapshot reads, dead `hooks/` copies deleted). They are not still “the next PR.”

## Immediate (this initiative, after audit approval)

| ID | Change | Priority | Impact | Complexity | Depends on | Acceptance | Metric | Trigger to stop |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I1 | Remove unreferenced game art; demote legacy panoramas; byte-budget test | P0 | Smaller git, deploy, and first play | S | Asset test update | **Landed in #145.** Critical 7,822,192 bytes; `public/games` 54,482,009. Panoramas remain optional. | `public/games` MiB; critical MiB | If a sprite 404s in the play proof |
| I2 | Navbar does not poll staking/lock | P0 | RPC per page view drops | S | None | **This branch.** Navbar passes `poll: false`. Staking page still polls. | eth_call count on `/` was not re-measured in production | If the tier badge becomes wrong and product rejects the one-shot read |
| I3 | Delete unused `hooks/*` engine copies | P1 | Less drift | S | I2 if both touch holder tier; else independent | **This branch.** The three copies are gone. `tsc` is still required. | dead-file count = 0 for those three paths | — |
| I4 | Single nav config | P1 | New links added once | S | None | Sidebar render test | one exported array | — |
| I5 | Game-over / check-in shows pending until server award | P1 | Stops false XP | S | None | Test: failed POST does not leave a permanent local total above server | support tickets about “missing XP” | — |

## Near-term (needs a yes, still one codebase)

| ID | Change | Priority | Impact | Complexity | Depends on | Acceptance | Metric | Trigger |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | Server streak + best streak in the check-in Lua. No XP DECR. | P1 | Streak survives devices. Still no decay. | M | Product yes; I5 | Concurrent double-POST yields one increment | Redis streak matches UTC calendar cases | Only if product wants cross-device streaks |
| N2 | Route group so docs do not load RainbowKit | P1 | Smaller first paint on content pages | M | Bundle baseline script | Analyzer: docs chunk has no `@rainbow-me` | gzip KB | After a recorded baseline, not before |
| N3 | `next/dynamic` for `RunGame` and home `PairSheet` | P1 | Parse time on those routes | S | I1 | Game still connects and scores | route chunk KB | — |
| N4 | Leaderboard pipeline (one round trip, not N+1 GETs) | P2 | Read latency at larger N | S | None | Same top-50 order as today | Redis commands per request | When board N or p95 is actually slow |
| N5 | OpenAI complete route calls `handleOpenAICompatibleChat` | P2 | One security gate | S | Existing complete tests | Same status codes | — | — |
| N6 | Light game: Reaction Tap, participation XP, no tokens | P2 | Retention without 40 MiB | M | I1; shell types | Replay rejects early taps; daily cap holds | game JS < 200 KB | After B (asset isolation) ships |
| N7 | Fee math imports `computeExecutorFee` only | P1 | Stops silent drift | M | **Financial review** | Golden vectors unchanged | diff of fee wei on fixtures = 0 | Not before review |

## Future (only if a measurement says so)

| Bottleneck | Current baseline | Failure mode | Proposal | Benefit | Cost | Verification | Trigger |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browser RPC | **U** QPS. Code: 15s polls on many pages, doubled on home. | 429s, stale UI, bill | I2 first. Then a server read cache for MPGR balance with 10–15s TTL keyed by wallet. | Linear cut in `eth_call` | Cache invalidation on user tx | Count calls | Public RPC 429 or invoice jump |
| Redis XP zset | **U** cardinality | Slow `ZRANGE` + N+1 | N4. Then a periodic snapshot key for the top 100. | Stable leaderboard p95 | Snapshot lag | Load test | p95 > 300 ms at 10k members |
| Game art origin bandwidth | 13–43 MiB per cold play session | Mobile bounce | I1 + CDN (already immutable headers) | Bandwidth | Art QA | Playwright transfer bytes | Cold-play > 3 MiB after I1 |
| AI vendor outage | Chain falls through to deterministic | Users see fallback copy | Already designed. Add a metric for fallback rate. | No new vendor | Low | Log line | Fallback > 20% for an hour |
| Quote fan-out | Several RPCs per quote, 15/min cap | Latency, shared bucket starvation | Separate bucket names per product (same limiter) | Isolation | Low | 429 source | Swap 429s while agent is idle, or the reverse |
| Serverless isolate caches | In-process tape and quote Maps | Stampede | Short Redis cache for tape (TTL already a concept in env) | Fewer DexScreener calls | Stale tape ≤ TTL | Hit rate | Origin 429 |
| Durable XP history queries | Event meta keys, no SQL | Cannot page “all history” cheaply | Postgres **only** for the event log, Redis stays the balance | Queryability | A database | Migration dry-run | Product asks for export/history beyond a capped list |
| Worker fleet | Two crons | Settlement stuck needs a human (`reconcile` does not retry) | Leave it. Document the runbook. | — | — | — | A week stuck in `allocating` more than once |
| Microservices | One deploy | Split brain on fees and XP | Do not | None proven | High | — | Never as a default |

## Graceful degradation (keep)

| Dependency down | Expected behavior | Label |
| --- | --- | --- |
| Redis | Authenticated routes 503. No fake XP. | V code |
| AI vendor | Next provider, then deterministic. Deterministic must not invent prices. | V design, **I** live |
| Game replay | No XP, no weekly credit. If financial flag is on and replay fails, 503 and session not consumed. | V code |
| Swap v2 manifest absent | V2 dormant; v1/agent paths are separate. Do not auto-fallback in a way that drops the fee. | I — read comments, not executed |
| DexScreener | Tape stale / empty. Swap page is a different route. | I |

## Rollback

Every immediate PR is `git revert` of one merge. Asset PR restores files. No migration of Redis key names in I1–I5. N1 adds keys and must tolerate their absence (old sessions still check in).

## Success for “100x ready enough”

Not a rewrite. All of:

- Cold `/games/mpgr-run` critical transfer meets the budget in `performance-baseline.md`.
- `/` does not poll staking.
- XP totals still monotonic under a concurrency test.
- Fee golden vectors unchanged.
- CI jobs that are green on `3fb5eb82` stay green.
- A one-page load test (even 50 concurrent `GET /api/xp` against a scratch Redis) is written down. Until that number exists, do not claim 100x capacity.

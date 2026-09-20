# Final Remediation Verification — remaining-gap closeout

This is an engineering closeout of remaining August 2026 audit gaps. It is **not** a formal smart-contract audit, penetration test, or anti-cheat certification.

## Status matrix

| Finding | Status | Evidence / limitation |
|---|---|---|
| P0-1 Wallet ownership | FIXED | SIWE nonce/session; protected writes derive wallet from the session. Cookie parse uses a shared decoder. |
| P0-2 Browser-owned XP | FIXED at ledger + client overlay | Server XP ledger (Lua `redis.call`, event TTL, daily game cap in Redis). `useXP` posts to `/api/xp` and caches server totals. Local storage remains a UI cache, not ranking truth. |
| P0-3 Game result authority | PARTIAL → IMPROVED | In-process deterministic authoritative replay implemented (`lib/games/mpgr-run/authoritative-replay.ts` + `authoritative-verifier.ts`): server-issued 64-hex seed, fixed 60Hz simulation, input trace replayed tick-for-tick with drift-tolerant timing checks, score recomputed via shared `computeRunScore`. Since Task 7 only a passing replay can earn XP or weekly competitive facts in BOTH flag configurations. Additional gates: server session, heartbeat coverage, timing/rate/idempotency, per-wallet caps, manual-review queue spec. No external `$GAME_RUN_VERIFIER_URL` is called today — those env vars remain an additional operator gate inside `gameRewardsAreOperatorEnabled()`. Financial settlement remains fail-closed and requires independent anti-cheat audit before production payouts. |
| P0-4 Contract tests/audit | PARTIAL | Foundry remappings match CI `.forge-deps` clones; unit/fuzz/invariant tests expanded. External audit is still required. |
| P1-5 AI proxy | FIXED at code-policy level | Auth, body/prompt limits, timeout, output cap, request IDs, shared server policy, per-IP + per-wallet rate limits, daily token budgets. |
| P1-6 Referral attribution | PARTIAL → IMPROVED | Authenticated referred wallet, first-write-wins, click TTL, self-referral controls, per-referrer daily caps (Lua atomic), delayed award until referred wallet has genuine activity (daily check-in), abuse logging. Sybil identity remains an operational risk. |
| P1-7 Settlement exactly-once | IMPROVED / PARTIAL | Durable settlement state, lock, reconciliation, treasury-ledger marker, request IDs on cron routes, outbox/reconciliation design doc. Vault `allocateRewardsBatch` still has no idempotency key (spec only, not deployed). |
| P1-8 Dependencies | PARTIAL | `package-lock.json` exists; CI uses `npm ci`; `npm run audit:high` runs in CI. Next.js is now 16.3.5 (was 15.5.24). Residual advisories still need dedicated upgrade PRs per family. |
| P1-9 API boundary policy | IMPROVED | Shared request guard, bounded `readJsonBody`, lazy Redis rate-limit client, dual-bucket (IP + wallet) limits, trade routes moved to Redis limiter. Trade price/quote/stock-quote, XP, referral, game, x402, AgentKit writes are session-bound. |
| P2-10 Documentation | IMPROVED | README matches the repo: npm not pnpm, no Docker/BullMQ/Prometheus, Next 16.3.5, financial rewards not production-ready. Asset docs updated to reflect WebP migration. |
| P2-11 Large files | OPEN | `RunGame.tsx` still large (1287 lines). Shared physics helpers and heartbeat pings were extracted/wired; a full split was not done because it is behavior-sensitive. |
| P2-12 Duplication | IMPROVED | Shared AI policy, chain registry, memory key helper. Provider-specific request construction remains separate on purpose. |
| P2-13 Assets | IMPROVED → DONE (lossless) | Lossless PNG → WebP migration completed 2026-09-18: 55 files under `public/games/mpgr-run/`, 108.69 MiB → 76.37 MiB (−29.7%), pixel-exact + dimension-identical verified, `RUN_ASSET_VERSION` bumped. Total `public/` is now 82 MiB (77 MiB games + 3 PNG splash/icon). See `docs/MPGR_RUN_ASSET_OPTIMIZATION_2026-09.md`. Remaining work is responsive sizes / lazy-load / preloading, not format conversion. |
| P2-14 Test coverage | IMPROVED | XP Lua, physics, heartbeat coverage, cookies, chain registry, request-guard, staking unit/invariant tests, referral abuse tests, game replay/drift tests. |

## Still not claimable

Do not mark these PASS without independent evidence:

- Independent smart-contract audit and production funding
- Full anti-cheat certification — in-process deterministic replay is implemented (`lib/games/mpgr-run/authoritative-replay.ts`, tick-for-tick verification, score recomputation, timing statistics) but no independent audit has been performed; external verifier URL remains an additional operator gate, not the sole verifier
- Referral sybil resistance (caps and delayed awards mitigate but do not prove human identity)
- Vault-level settlement idempotency (design doc only, no contract redeploy in this repo)
- Complete responsive / lazy-load / preload optimization (format migration done; performance tuning remains)
- `forge test` / `npm run build` in an environment that has not actually run them (sandbox offline for fonts)

## Financial reward safety

`GAME_REWARDS_ENABLED` and `GAME_AUTHORITATIVE_VERIFICATION_ENABLED` default to disabled (fail-closed). In-process authoritative replay is implemented and required for XP/weekly facts in both flag configurations since Task 7, but this repository must not be described as production-ready for financial game rewards until an independent anti-cheat review, contract tests passing in a real environment, recovery procedures tested, and an independent smart-contract audit are completed. External verifier env vars (`GAME_RUN_VERIFIER_URL`/`SECRET`) remain an additional operator gate pending a decision on whether an external service is ever deployed.

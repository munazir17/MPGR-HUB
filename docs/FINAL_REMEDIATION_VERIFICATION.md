# Final Remediation Verification — remaining-gap closeout

This is an engineering closeout of remaining August 2026 audit gaps. It is **not** a formal smart-contract audit, penetration test, or anti-cheat certification.

## Status matrix

| Finding | Status | Evidence / limitation |
|---|---|---|
| P0-1 Wallet ownership | FIXED | SIWE nonce/session; protected writes derive wallet from the session. Cookie parse uses a shared decoder. |
| P0-2 Browser-owned XP | FIXED at ledger + client overlay | Server XP ledger (Lua `redis.call`, event TTL, daily game cap in Redis). `useXP` posts to `/api/xp` and caches server totals. Local storage remains a UI cache, not ranking truth. |
| P0-3 Game result authority | PARTIAL | Server session, server score recomputation, heartbeat coverage, timing/rate/idempotency gates. Client gameplay statistics are still not cryptographically authoritative. Financial settlement remains fail-closed. |
| P0-4 Contract tests/audit | PARTIAL | Foundry remappings match CI `.forge-deps` clones; unit/fuzz/invariant tests expanded. External audit is still required. |
| P1-5 AI proxy | FIXED at code-policy level | Auth, body/prompt limits, timeout, output cap, request IDs, shared server policy. |
| P1-6 Referral attribution | PARTIAL | Authenticated referred wallet, first-write-wins, click TTL, self-referral controls. Sybil identity remains an operational risk. |
| P1-7 Settlement exactly-once | IMPROVED / PARTIAL | Durable settlement state, lock, reconciliation, treasury-ledger marker, request IDs on cron routes. Vault `allocateRewardsBatch` still has no idempotency key. |
| P1-8 Dependencies | PARTIAL | `package-lock.json` exists; CI uses `npm ci`; `npm run audit:high` runs in CI. Residual advisories still need dedicated upgrade PRs. |
| P1-9 API boundary policy | IMPROVED | Shared request guard, bounded `readJsonBody`, lazy Redis rate-limit client. Trade price/quote/stock-quote, XP, referral, game, x402, AgentKit writes are session-bound. |
| P2-10 Documentation | IMPROVED | README matches the repo: npm not pnpm, no Docker/BullMQ/Prometheus, financial rewards not production-ready. |
| P2-11 Large files | OPEN | `RunGame.tsx` still large. Shared physics helpers and heartbeat pings were extracted/wired; a full split was not done because it is behavior-sensitive. |
| P2-12 Duplication | IMPROVED | Shared AI policy, chain registry, memory key helper. Provider-specific request construction remains separate on purpose. |
| P2-13 Assets | IMPROVED | Lossless PNG work only. Full 204MB WebP/AVIF migration was not performed. |
| P2-14 Test coverage | IMPROVED | XP Lua, physics, heartbeat coverage, cookies, chain registry, request-guard, extra staking unit/invariant tests. |

## Still not claimable

Do not mark these PASS without independent evidence:

- Independent smart-contract audit and production funding
- Real replay / anti-cheat (heartbeats are liveness, not proof of play)
- Referral sybil resistance
- Vault-level settlement idempotency
- Complete game-art conversion
- `forge test` / `npm run build` in an environment that has not actually run them

## Financial reward safety

`GAME_REWARDS_ENABLED` and `GAME_AUTHORITATIVE_VERIFICATION_ENABLED` default to disabled (fail-closed). This repository must not be described as production-ready for financial game rewards until an authoritative game verifier is integrated and verified, contract tests pass in a real environment, recovery procedures are tested, and an independent smart-contract audit is completed.

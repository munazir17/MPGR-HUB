# Final Remediation Verification — 2026-09-10

This archive is a standalone security-remediation snapshot based on the August 2026 engineering/security audit.

## Status matrix

| Finding | Status | Evidence / limitation |
|---|---|---|
| P0-1 Wallet ownership | FIXED | SIWE nonce/session; protected writes derive wallet from session |
| P0-2 Browser-owned XP | FIXED | Server XP ledger with fixed action policy and idempotent server events |
| P0-3 Game result authority | PARTIAL | Server session, server score recomputation, timing/rate/idempotency gates; client gameplay statistics are still not cryptographically authoritative. Real-value settlement has an independent operator gate and remains disabled by default |
| P0-4 Contract tests/audit | PARTIAL | Foundry layout fixed and test coverage expanded; actual `forge test` and external audit still require an environment with dependencies/Foundry |
| P1-5 AI proxy | FIXED at code-policy level | Auth, limits, timeout, output cap, request IDs, shared server policy and usage logging |
| P1-6 Referral attribution | PARTIAL | Authenticated referred wallet, first-write-wins, self-referral/duplication controls; sybil identity remains an operational risk |
| P1-7 Settlement exactly-once | IMPROVED / PARTIAL | Durable settlement state, lock, reconciliation, and exactly-once treasury-ledger marker; external vault semantics still require real on-chain verification |
| P1-8 Dependencies | PARTIAL | Target versions are pinned/selected in package.json, but no package-lock is present and `npm audit` cannot be run in this environment |
| P1-9 API boundary policy | IMPROVED | Shared request guard applied to high-risk public JSON writes and AI; endpoint-specific protections remain for some read-only/cron routes |
| P2-10 Documentation | IMPROVED | README claims/gates reconciled; repository intentionally does not declare a software license |
| P2-11 Large files | OPEN | RunGame.tsx remains large; refactoring was not performed because it is behavior-sensitive |
| P2-12 Duplication | IMPROVED | Shared AI policy/prompt validation added; provider-specific request construction remains intentionally separate |
| P2-13 Assets | IMPROVED | Several PNGs were losslessly optimized; full 204MB asset migration was not performed because broad conversion could change runtime references/behavior |
| P2-14 Test coverage | IMPROVED | Additional validation, settlement, fuzz and invariant coverage added; full runtime execution remains environment-dependent |

## Execution limits

This environment does not have network access and does not have Foundry installed. Therefore the following cannot honestly be marked PASS here:

- `npm install`
- `npm run lint`
- `npm run typecheck` with real dependencies
- `npm test`
- `npm run build`
- `npm audit`
- `forge test`

A global TypeScript sanity run was performed only to catch syntax/configuration issues; its remaining diagnostics are dominated by unavailable dependency/type packages.

## Financial reward safety

`GAME_REWARDS_ENABLED` and `GAME_AUTHORITATIVE_VERIFICATION_ENABLED` default to disabled. This repository must not be described as production-ready for financial game rewards until an authoritative game verifier is integrated and verified, contract tests pass in a real environment, recovery procedures are tested, and an independent smart-contract audit is completed.

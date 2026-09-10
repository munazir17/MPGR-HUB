# MPGR HUB Security Remediation

This checkout contains the code remediation for the August 2026 engineering review. It is not a formal smart-contract audit or penetration test.

## Implemented in this remediation

- Short-lived signed wallet sessions using a one-time server nonce, Base chain ID 8453, domain/origin binding, issued/expiry checks, and HttpOnly cookies.
- User-write routes derive the wallet from the authenticated session instead of trusting a wallet field.
- Direct browser leaderboard writes are disabled. Leaderboard rankings are sourced from the server-owned XP ranking.
- Server XP ledger with fixed policy amounts, idempotent event IDs, lifetime totals, and UTC-month season totals.
- Referral attribution requires the referred wallet's authenticated session and awards referrer XP from the server event.
- MPGR Run sessions are issued server-side and bound to the authenticated wallet, game ID, and expiry.
- Game reward submissions use the server session identity and server clock window; financial eligibility additionally requires an independent verifier attestation with a unique proof ID, and the settlement path filters to that proof version.
- Real-value game settlement requires both operator gates plus configured verifier URL/secret; all gates default to disabled and missing verifier configuration fails closed.
- Settlement uses a global distributed lock because weeks share one vault balance/budget, plus durable allocation state and reconciliation for an `allocating` state.
- AI proxy routes require authentication, enforce body/prompt limits, distributed rate limits, timeouts, bounded output, and generic upstream errors.
- Staking rejects fee-on-transfer accounting mismatches, starts unfunded schedules at zero emission, and checks requested emission against funded reward balance.
- Foundry configuration and unit/fuzz/invariant test sources are included; CI installs pinned OpenZeppelin and forge-std revisions before running them.
- CI runs install, lint, typecheck, tests, build, dependency audit, and contract tests.

## Operational requirements before enabling financial game rewards

1. Deploy and verify the authoritative game verifier/replay/checkpoint service described in `docs/GAME_RUN_VERIFIER_PROTOCOL.md`.
2. Set `AUTH_SESSION_SECRET`, `APP_ORIGIN`, Redis credentials, and the required reward-manager configuration.
3. Install the exact contract test dependencies and run `forge test -vvv`.
4. Run the full web checks with network access: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm audit --audit-level=high`.
5. Protect `main` with required CI and owner review for financial/security paths.
6. Obtain an independent smart-contract audit before funding production contracts.

No document in this repository should describe financial rewards as production-ready until those evidence gates are satisfied.

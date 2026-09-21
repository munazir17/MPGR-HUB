# MPGR HUB Security Remediation

This checkout contains the code remediation for the August 2026 engineering review. It is not a formal smart-contract audit or penetration test.

## Implemented in this remediation

- Short-lived signed wallet sessions using a one-time server nonce, Base chain ID 8453, domain/origin binding, issued/expiry checks, and HttpOnly cookies.
- User-write routes derive the wallet from the authenticated session instead of trusting a wallet field (XP, referral, game, trade price/quote/stock-quote, AgentKit invoke, x402 register/submit).
- Direct browser leaderboard writes are disabled. Leaderboard rankings are sourced from the server-owned XP ranking.
- Server XP ledger with fixed policy amounts, idempotent event IDs, Lua `redis.call` (not `redis().call`), TTLs, lifetime totals, UTC-month season totals, and a server daily game-XP cap.
- `useXP` treats the server ledger as the displayed total and keeps `localStorage` as a cache.
- Referral attribution requires the referred wallet's authenticated session, stores a 7-day click, and awards referrer XP from the server event.
- MPGR Run sessions are issued server-side and bound to the authenticated wallet, game ID, and expiry.
- Live game heartbeats are recorded; reward submit rejects runs whose claimed duration is not covered by those pings (short-run grace remains).
- Game reward submissions use the server session identity and server clock window; financial eligibility additionally requires an in-process authoritative replay attestation with a unique proof ID (no external verifier).
- Real-value game settlement requires both operator gates (`GAME_REWARDS_ENABLED` + `GAME_AUTHORITATIVE_VERIFICATION_ENABLED`); both default to disabled and fail closed. No external `GAME_RUN_VERIFIER_URL` is required — active verifier is in-process replay.
- Settlement uses a global distributed lock because weeks share one vault balance/budget, plus durable allocation state, reconciliation for an `allocating` state, and request IDs on cron routes.
- AI proxy routes require authentication, enforce body/prompt limits, distributed rate limits, timeouts, bounded output, and generic upstream errors.
- Chain ID and contract addresses live in `lib/chain/base.ts`. Memory keys are namespaced by wallet and chain, with legacy-key migration and a full clear path.
- Staking rejects fee-on-transfer accounting mismatches, starts unfunded schedules at zero emission, and checks requested emission against funded reward balance.
- Foundry remappings match CI clones under `.forge-deps`; unit/fuzz/invariant tests are included.
- CI uses `npm ci`, a 4 GB Node heap for typecheck/build, a high-severity audit script, and Foundry `stable`.

## Operational requirements before enabling financial game rewards

1. Review and verify the in-process authoritative game verifier (deterministic replay `lib/games/mpgr-run/authoritative-replay.ts` + checkpoint/heartbeat) described in `docs/GAME_RUN_VERIFIER_PROTOCOL.md`.
2. Set `AUTH_SESSION_SECRET`, `APP_ORIGIN`, Redis credentials, and the required reward-manager configuration.
3. Install the exact contract test dependencies and run `forge test -vvv`.
4. Run the full web checks: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run audit:high`.
5. Protect `main` with required CI and owner review for financial/security paths.
6. Obtain an independent smart-contract audit before funding production contracts.

No document in this repository should describe financial rewards as production-ready until those evidence gates are satisfied.

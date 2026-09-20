# MPGR Run Authoritative Verifier Protocol

This protocol is the security boundary for real-value MPGR Run settlement.
The browser result is never treated as proof of gameplay.

> **Implementation note (Task 7, 2026-09):** the in-repo implementation of
> the verification step is the **in-process deterministic authoritative
> replay** (`lib/games/mpgr-run/authoritative-replay.ts`, invoked by
> `lib/games/mpgr-run/authoritative-verifier.ts` on every reward
> submission). It reproduces the run from the server-issued seed + the
> recorded input trace and only accepts results that match the replayed
> simulation. **No code path currently calls an external
> `$GAME_RUN_VERIFIER_URL`** — those variables remain an additional
> operator gate inside `gameRewardsAreOperatorEnabled()`
> (`lib/games/games-reward-config.ts`) that settlement requires before
> paying out, pending a decision on whether the external verifier
> described in this document is ever deployed. The XP/weekly-fact path
> requires a passing replay in BOTH flag configurations since Task 7.

## Request

`POST $GAME_RUN_VERIFIER_URL`

Headers:

- `Content-Type: application/json`
- `Authorization: Bearer $GAME_RUN_VERIFIER_SECRET`

Body:

```json
{
  "version": 1,
  "sessionId": "server-issued-session-id",
  "wallet": "0x...",
  "sessionCreatedAt": "2026-09-10T12:00:00.000Z",
  "sessionExpiresAt": "2026-09-10T12:15:00.000Z",
  "result": { "...": "RunResult fields" }
}
```

The verifier must independently validate evidence that the run occurred. A
client-side score/bounds check is not sufficient. Acceptable implementations
include deterministic replay, signed gameplay checkpoints, or equivalent
server-verifiable telemetry. The verifier must bind its evidence to the
provided `sessionId` and wallet and reject reuse.

## Success response

```json
{
  "verified": true,
  "proofId": "unique-auditable-proof-id"
}
```

`proofId` must be unique and stable for the verified run.

## Rejection

Return HTTP 4xx/5xx or:

```json
{
  "verified": false
}
```

The application fails closed on verifier rejection, timeout, malformed
responses, missing configuration, or missing proof IDs.

## Production requirements

- HTTPS only.
- Keep the verifier secret server-side.
- Persist proof records long enough to support reward disputes/audits.
- Never allow the verifier to trust a client-supplied wallet without binding it
  to the server-issued game session.
- Never reuse a proof for a different session or wallet.
- Keep the verifier independently deployable from the browser game.

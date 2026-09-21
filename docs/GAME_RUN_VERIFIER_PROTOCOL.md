# MPGR Run Authoritative Verifier Protocol

This protocol is the security boundary for real-value MPGR Run settlement.
The browser result is never treated as proof of gameplay.

> **Current implementation (2026-09):** the active verification step is the
> **in-process deterministic authoritative replay**
> (`lib/games/mpgr-run/authoritative-replay.ts`, invoked by
> `lib/games/mpgr-run/authoritative-verifier.ts` on every reward
> submission). It reproduces the run from the server-issued seed + the
> recorded input trace and only accepts results that match the replayed
> simulation. **No code path calls an external `$GAME_RUN_VERIFIER_URL`** —
> the external verifier described below is retained for historical
> reference only. The operator gate that settlement requires is now only
> `GAME_REWARDS_ENABLED` + `GAME_AUTHORITATIVE_VERIFICATION_ENABLED`
> (see `lib/games/games-reward-config.ts`). The XP/weekly-fact path
> requires a passing replay in BOTH flag configurations since Task 7.
> `GAME_RUN_VERIFIER_URL` / `GAME_RUN_VERIFIER_SECRET` are not required
> and have been removed from config and env examples.

## Active verifier: in-process deterministic replay

- **Input:** server-issued seed (64-hex, per session), input trace
  (`version: 1`, ordered `jump`/`slide`/`lane` events with tick-aligned
  `atMs`), submitted `RunResult`.
- **Process:** fixed 60Hz simulation (`MPGR_RUN_FIXED_DT_MS`), same spawn
  logic and physics as client, seeded RNG, input applied on exact tick.
- **Acceptance:** replayed result matches submitted result within tolerance
  (distance 0.75m, duration 20ms, score 2, etc.), game-over state reached,
  no input after game-over, timing aligned to fixed clock.
- **Proof ID:** `sha256(version, sessionId, wallet, seed, protocolVersion,
  sessionCreatedAt, sessionExpiresAt, inputTrace, result)` — unique and
  stable for the verified run.
- **Failure modes:** invalid seed, trace too large, unordered timestamps,
  off-grid timestamps, duration not aligned, simulation mismatch, etc.
  All failures are fail-closed: no XP, no weekly facts, no settlement
  eligibility.

## Historical external verifier protocol (not active)

The following described an external service that was once considered as
an additional gate. It is not implemented and no code path calls it.
Retained for audit traceability.

### Request

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

### Success response

```json
{
  "verified": true,
  "proofId": "unique-auditable-proof-id"
}
```

`proofId` must be unique and stable for the verified run.

### Rejection

Return HTTP 4xx/5xx or:

```json
{
  "verified": false
}
```

The application fails closed on verifier rejection, timeout, malformed
responses, missing configuration, or missing proof IDs.

## Production requirements (active verifier)

- Server seed is 32 random bytes, hex-encoded, per session, never
  client-supplied.
- Wallet identity comes from authenticated server session, not request JSON.
- Session binding, expiry, single-use (consumedAt), timing/heartbeat
  validation enforced before replay.
- Proof records (RunRecord + PlayerWeekRecord with verificationVersion
  and authoritativeProofId) persisted for audit/disputes.
- Never allow the verifier to trust a client-supplied wallet without binding it
  to the server-issued game session.
- Never reuse a proof for a different session or wallet.
- Replay logic is server-only, not exposed to browser bundle.

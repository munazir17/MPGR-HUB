# Autonomous execution emergency switch (KV)

Authoritative, fail-closed control plane for **autonomous** execution only.
Assisted (user-signed) trading is not gated by this switch.

## Key

`mpgrhub:autonomy:switch`

## Record schema (v1)

```json
{
  "v": 1,
  "enabled": false,
  "updatedAt": "2026-10-10T00:00:00.000Z",
  "updatedBy": "operator-id",
  "note": "optional audit note"
}
```

- `v` must be the integer `1`. Any other version refuses execution.
- `enabled` must be a JSON boolean. Only `true` authorizes execution.
- `updatedAt` must be a parseable ISO-8601 timestamp.
- Missing key, missing fields, malformed JSON, unexpected types, timeout,
  network error, or unavailable KV **refuse execution**.

There is **no application cache**. Each execution-boundary check performs an
uncached `GET`. Typical extra latency is one Upstash REST round-trip
(~20–80ms in-region; bounded by a 1500ms timeout). On timeout or outage the
runtime **fails closed** (no new autonomous broadcasts).

## Where it is enforced

1. Autonomy runtime — at tick authorization **and** immediately before
   `adapter.executeSwap`.
2. `DelegatedExecutionAdapter.executeSwap` — before slot consume / broadcast.
3. MCP `delegateSwap` — broadcast chokepoint (defence in depth).

A disable **cannot reverse a transaction already broadcast**. Goals with
`pendingExecution` still verify receipts (read-only). Residual risk: a
transaction in-flight at disable time may still land.

A switch refusal is **not** a trade failure: consecutive failure counters are
not incremented and goals are not permanently failed. Daily-spend reservations
already claimed are **not reversed** (over-count is safer than under-count if
execution might have been attempted).

## Environment flags

- `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` further **restricts** execution.
- It **cannot** enable execution when KV is missing, disabled, or unreadable.
- `AUTONOMOUS_PRODUCTION_ENABLED` remains an independent mainnet gate (keep OFF
  until a dedicated go-live). This switch does not turn the production gate on.

## Authorization to change the switch

No public HTTP write endpoint exists. Changes are **out of band**:

1. Sign in to the Upstash console (or `redis-cli` with the REST token) using
   credentials that can `SET` this key only.
2. Restrict the token: production KV tokens used by the app should be
   **read-capable** for this key; write should be limited to a break-glass
   operator token.
3. Do not commit tokens. Do not paste token values into tickets or logs.

This repository task does **not** provision or modify the production key.

## Operator runbook

### Verify current value (read-only)

```
GET mpgrhub:autonomy:switch
```

Expect a v1 object. If empty/malformed, autonomous execution is refused.

### Disable (stop new autonomous executions)

```json
{"v":1,"enabled":false,"updatedAt":"<now ISO>","updatedBy":"<you>","note":"break-glass disable"}
```

`SET mpgrhub:autonomy:switch <json>`

Confirm with `GET`. New ticks park with `EXECUTION_UNAVAILABLE`. In-flight
broadcasts are **not** undone.

### Enable (only when intentionally authorizing)

```json
{"v":1,"enabled":true,"updatedAt":"<now ISO>","updatedBy":"<you>","note":"authorize autonomous execution"}
```

Confirm `GET` shows `"enabled": true`. Also require:

- `MPGR_AUTONOMOUS_AGENT_ENABLED=true`
- `MPGR_AUTONOMOUS_EMERGENCY_DISABLE` unset/false
- production gate still independent (`AUTONOMOUS_PRODUCTION_ENABLED`)
- pinned executor, policy, spend caps, slippage, reservation checks

### Outage / rollback

- KV unreadability ⇒ fail closed. No env fallback enables execution.
- Rollback = `SET` the previous known-good JSON, or `enabled: false`.
- App rollback of this code returns to env-only emergency disable (weaker).
  Prefer leaving this code deployed with `enabled: false` rather than reverting.

### Logs

Decision logs include `reason`, `correlationId`, `allowed`, and the key name.
They never include credentials, tokens, or raw KV payloads.

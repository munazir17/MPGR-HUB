# Settlement exactly-once design

Task 9 audit scope: game reward settlement, weekly reconciliation, XP/referral ledger settlement, reward-vault claims, and staking claims.

## Goal

The application only needs at-most-once **economic effect**. A retry may execute route code again as long as it cannot create a second payout, XP award, ledger increment, or on-chain allocation for the same trusted event.

## Economic-effect boundaries

| Flow | Economic effect | Existing idempotency / safety |
| --- | --- | --- |
| Game run submission | Counts one server-issued game session into one weekly player record and awards capped game XP | `RunRecord.sessionId` is inserted with `SET NX`; the weekly player aggregate is updated with Lua; game XP uses the server XP ledger event id. Client reward/amount fields are ignored. |
| Weekly game settlement | Calls `allocateRewardsBatch(seasonId, users, amounts, GAME)` on the reward vault | Week-level settlement status, global Redis mutex, computed-to-allocating CAS with `allocationAttemptId`, and the new pre-broadcast outbox record. |
| Weekly settlement reconciliation | Marks already-confirmed on-chain rewards as allocated and finalizes the week | Confirmation-only; it never calls `allocateRewardsBatch`. It matches expected wallet, season, amount, and reward type before advancing local state. Treasury ledger increment is `recordTreasuryLedgerEntryOnce(GAME, weekKey, amount)`. |
| Referral settlement | Awards referrer XP after genuine referred-wallet activity | Referral attribution is first-write-wins; settlement uses an atomic pending claim, daily cap, and permanent XP ledger event id (`referral:<referred>`). Failures do not block the referred wallet's check-in. |
| XP/check-in settlement | Adds server XP | Event ids are server-derived (`wallet-connected`, `daily-check-in:<date>`, game session ids, referral ids) and ledger/event-meta keys are durable. |
| Reward-vault user claim | User-initiated on-chain `claim`/`claimMultiple` | The contract owns claim status. The app only prepares calldata; the wallet signs and the chain enforces no second claim for the same reward id. |
| Staking claim | User-initiated on-chain `claimRewards` / `exit` | The staking contract checkpoints and zeroes claimable rewards during the transaction. The app only prepares calldata. |

## Weekly game settlement state machine

Actual production state:

```text
open -> closed -> computed -> allocating -> finalized
                         \-> aborted
```

Per-player allocation state:

```text
none -> pending -> allocated
              \-> failed (manual/operator use only)
```

The point of economic effect is the confirmed `allocateRewardsBatch` transaction. Local state before that is only a claim/outbox record; local state after that is reconciliation evidence.

## Outbox strategy added in Task 9

For each won `computed -> allocating` transition the route now writes:

```text
mpgrhub:games:settlement-outbox:<weekKey>:<allocationAttemptId>
mpgrhub:games:settlement-outbox-index:<weekKey>
```

The record stores the trusted server-derived batch: week, attempt id, season id, users, raw amounts, reward types, tx hash, reward ids, status, and timestamps.

Statuses:

- `pending`: durable pre-broadcast marker exists; no confirmed result persisted yet.
- `confirmed`: `allocateRewardsBatch` returned a successful receipt and reward ids.
- `uncertain`: submission/confirmation threw after the pre-broadcast marker. Reconciliation, not retry, must determine the result.
- `reconciled`: reserved for reconciliation-confirmed finalization.
- `failed`: reserved for an operator-confirmed no-effect failure.

If the outbox insert fails or the same attempt already has an outbox record, the settlement route fails closed and does **not** call `allocateRewardsBatch`.

## Crash/retry behavior

| Interleaving | Behavior |
| --- | --- |
| claim -> process -> success -> retry | Week is `finalized`; retry returns already done and does not allocate. |
| claim -> process -> timeout -> retry | Week remains `allocating`; retry invokes reconciliation only and does not allocate. |
| claim -> process -> Redis failure before outbox | No external call is made. |
| claim -> external effect -> process termination | Week remains `allocating`; reconciliation scans chain for expected wallet/season/amount/type. |
| concurrent settlement requests / cron overlap / manual during cron | Global mutex plus `allocationAttemptId` CAS permit only the winning attempt to write the outbox and call the vault. Losers return without a chain call. |
| stale pending state followed by retry | `allocating` is reconciled; `computed` can allocate only after winning CAS and writing outbox. |
| already-settled event with a different request id | Request ids are not idempotency keys. Week key + server-derived allocation attempt and player records determine economic effect. |

## Vault idempotency-key contract spec (not implemented here)

The deployed vault ABI is unchanged in this PR. A future vault should add an idempotent allocation entry point, for example:

```solidity
function allocateRewardsBatchWithIdempotencyKey(
    bytes32 idempotencyKey,
    uint256 seasonId,
    address[] calldata users,
    uint256[] calldata amounts,
    uint8[] calldata rewardTypes
) external returns (uint256 firstRewardId);
```

Required semantics:

1. `idempotencyKey` is unique per economic event, e.g. `keccak256("GAME_WEEK", weekKey, seasonId, users, amounts, rewardTypes)` built server-side from frozen state.
2. First successful call stores the key and a hash of the full batch.
3. Retrying with the same key and identical batch returns the original result or emits a deterministic already-allocated signal without creating rewards.
4. Retrying with the same key and different batch reverts.
5. The key record never expires.

Until such a vault exists, automatic retry from `allocating` remains intentionally disabled.

## Compatibility

No public API shape, env var name, Redis key used by old readers, contract ABI, cookie, reward amount, or economic policy was changed. The new outbox keys are additive. Existing `WeeklySettlement` and `PlayerWeekRecord` records remain readable.

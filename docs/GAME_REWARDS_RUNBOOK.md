# Game Rewards Recovery Runbook

## Unknown settlement outcome

If a weekly settlement is `allocating`, do not broadcast a second allocation transaction manually.

Run the reconciliation endpoint with the same protected cron credential:

`POST /api/games/mpgr-run/settlement/reconcile?week=YYYY-Www`

The reconciliation checks the vault's on-chain reward records against the durable weekly allocation records. If every payable player is confirmed, the settlement is finalized. Otherwise it remains `allocating` for investigation.

## Safety rules

- Never reset an `allocating` settlement to `computed` until on-chain state proves the batch did not land.
- Never reuse a reward-manager key outside the dedicated settlement service.
- Keep `CRON_SECRET` server-only.
- Keep `REWARD_MANAGER_PRIVATE_KEY` server-only and rotate it through the documented operational process.
- Keep both `GAME_REWARDS_ENABLED=false` and `GAME_AUTHORITATIVE_VERIFICATION_ENABLED=false` until an authoritative game verifier is deployed, integrated into the reward path, and reviewed.

# Game Rewards Module — Setup & Operations

This document covers the one-time setup required before the weekly
competitive MPGR settlement can run for real, plus what to check if a
settlement needs manual recovery.

## 1. Install the new dependency

`@vercel/kv` was added to `package.json`. Run:
npm install
(This could not be run inside the sandbox that produced this change — no
network access — so it has not been verified to resolve/build. Run it,
then `npm run build`, before deploying.)

## 2. Provision Vercel KV

Vercel dashboard → Storage → Create Database → KV → link to this
project. This populates `KV_REST_API_URL` / `KV_REST_API_TOKEN` /
`KV_REST_API_READ_ONLY_TOKEN` automatically for all environments. No
manual value entry needed on Vercel; for local dev, copy the values from
the dashboard into `.env.local`.

## 3. Generate a reward-manager signer key

Generate a **new, dedicated** wallet (do not reuse an existing hot
wallet). Set its private key as `REWARD_MANAGER_PRIVATE_KEY` in Vercel's
environment variables (production + any preview environments that will
run settlement). Never prefix this variable with `NEXT_PUBLIC_`.

## 4. One-time on-chain owner actions (REQUIRED — not yet performed)

These must be executed by the current owner of
`0xbe4B0e8692670229129562a50A62f5173E30937C` (Base Mainnet). Nothing in
this codebase can perform them — they are owner-only by contract design.

1. **Authorize the settlement signer:**
   setRewardManager(<REWARD_MANAGER_PRIVATE_KEY's address>, true)
   The settlement route verifies this on-chain before every allocation
attempt (`rewardManager(signer) == true`) and safely aborts, without
pretending success, if it is not set.

2. **Create the current vault season**, if one doesn't already exist for
the current XP season number
(`lib/xp-engine.ts`'s `getSeasonNumber()`):
createSeason(, , )
`lib/reward-allocation/reward-vault-season-mapping.ts`'s
`candidateVaultSeasonId()` / `candidateVaultSeasonWindow()` compute the
exact `seasonId`/`startTime`/`endTime` this call should use for
"right now." The settlement route calls `seasonExists()` itself and
aborts safely (status `"aborted"`, with the exact call to make in its
response) if this hasn't been done yet — it never calls `createSeason`
itself.

3. Confirm the vault already holds enough MPGR to fund Game allocations
(`fund(amount)` if not) — the settlement route checks
`availableBalance()` live before every allocation and simply spends
less (down to zero) than the weekly pool if the vault is short, it
never over-allocates.

## 5. Configure `CRON_SECRET` and the cron schedule

Set `CRON_SECRET` (e.g. `openssl rand -hex 32`) in Vercel's environment
variables. `vercel.json` already schedules
`GET /api/games/mpgr-run/settlement` for `10 0 * * 1` (00:10 UTC every
Monday, i.e. shortly after the previous ISO week closes). Vercel Cron
sends `Authorization: Bearer $CRON_SECRET` automatically — the route
rejects any request without it, including an unconfigured secret (fails
closed, not open).

You can also trigger a settlement manually (e.g. to backfill a missed
week) with:curl -X GET "https:///api/games/mpgr-run/settlement?weekKey=2026-W34" 
-H "Authorization: Bearer $CRON_SECRET"
## Architecture summary

- **Run recording:** `POST /api/games/mpgr-run/reward` — re-validates
  every run server-side (`validateRunResult`, `computeRunScore` — reused
  unmodified from `lib/games/mpgr-run/`), records it with atomic
  insert-if-absent idempotency (Vercel KV `SET NX`), and updates the
  wallet's current-week `PlayerWeekRecord`. Never allocates MPGR.
- **Weekly settlement:** `GET/POST /api/games/mpgr-run/settlement`
  (cron-only) — closes the previous week, computes deterministic
  weights (`lib/reward-allocation/settlement-engine.ts`), computes the
  weekly pool as `min(weekly cap, remaining 7M Games budget, live vault
  availableBalance())`, and calls `allocateRewardsBatch` for every
  player above the dust floor, only after verifying reward-manager
  authorization and season existence on-chain.
- **Budget enforcement:** the 7,000,000 MPGR lifetime Games ceiling is
  enforced entirely off-chain, by `lib/reward-allocation/kv-allocation-store.ts`'s
  treasury ledger (the vault contract itself has no concept of a
  per-category budget). The 8,000,000 MPGR Other-Rewards budget is never
  touched by any code path in this module — there is no ledger key or
  function anywhere in `lib/reward-allocation`/`lib/games` that can write
  to it.
- **Claiming:** unchanged. Once a `RewardType.GAME` reward is allocated
  on-chain, `lib/rewards/providers/game-rewards-provider.ts` (already
  read-only, untouched) picks it up automatically, and the existing
  `useRewardClaim` / `<OnChainRewardsSection />` claim flow (untouched)
  is the only way MPGR reaches a user's wallet.

## Known, disclosed gaps

1. **Season Points do not currently contribute to weekly weighting.**
   The XP engine (`lib/xp-engine.ts`) is entirely client-side
   `localStorage` — there is no server-side source of truth for a
   wallet's Season Points today, and building one is a full XP-storage
   migration explicitly out of scope (master prompt section 3: "EXISTING
   XP — DO NOT CHANGE"). Trusting a client-submitted Season Points number
   as an economic weighting input would violate the "never trust
   client-supplied ... weight" requirement. `SEASON_POINTS_WEIGHT` in
   `lib/games/games-reward-config.ts` is set to `0` so the formula uses
   only server-verified inputs (valid run count, best score) until XP
   moves server-side — flipping that one constant is the only change
   needed after that migration.

2. **Mid-allocation crash recovery is manual, not automatic.** If the
   settlement function crashes or times out between broadcasting
   `allocateRewardsBatch` and persisting its confirmed result, the
   settlement is left in `"allocating"` status and the route will not
   auto-retry it (to avoid a possible double allocation). See the
   "Known limitation" comment at the bottom of
   `app/api/games/mpgr-run/settlement/route.ts` for the exact manual
   recovery steps (compare `getUserRewardIds`/`getReward` against the
   expected `PlayerWeekRecord.allocatedAmountRaw` values, then either
   mark the settlement `"finalized"` or reset it to `"computed"` before
   the next cron run).

3. **`npm install` / `npm run build` / `npm run lint` could not be run**
   in the environment this change was produced in (no network access to
   install `@vercel/kv` or any package). Run all three, and fix any
   TypeScript errors surfaced, before deploying — see the final
   implementation report for what to double-check first (BigInt JSON
   handling, viem return types from `simulateContract`).

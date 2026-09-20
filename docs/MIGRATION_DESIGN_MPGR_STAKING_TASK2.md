# Migration Design — MPGRStaking Task 2 Fix (depositRewards checkpoint)

**Status:** DESIGN ONLY — no deployment, no funding, no pause, no user migration has been executed.
**Scope:** How to preserve every staker’s principal + pending rewards and activate the fixed contract without starting the new 25M/730-day emission early or stranding non-migrators.
**Addresses (hard-coded):**
- **Old (buggy, live):** `0x1690C7b6d312284e30434d93498e56eE09fFa12c` — Base 8453 — file `lib/chain/base.ts:22` `MPGR_STAKING_ADDRESS`
- **New (fixed, not yet deployed):** `TBD_NEW_ADDRESS` — `contracts/MPGRStaking.sol` @ `15941ba` (`updateReward(address(0))` on `depositRewards`)
- **Token:** `0xB2000000000000000000008d204203177a78AF01` (MPGR, 18 decimals, B20)
- **Reward vault (unrelated):** `0xbe4B0e8692670229129562a50A62f5173E30937C`

**Related code PR:** `fix(staking): checkpoint rewards in depositRewards` `15941ba` — PR #24 (OPEN, not merged to `main`). **This design is separate from that code PR.**

---

## Principles

1. **No silent loss.** `earned()` is derived (`balance * (rewardPerToken - userPaid)/1e18 + rewards`) — a single wrong `rewardPerTokenStored`/`lastUpdateTime` or per-user `userRewardPerTokenPaid`/`rewards` stranding loses real MPGR.
2. **User custody.** Owner cannot move a user’s `balanceOf` or `rewards` (no `migrate` function, `recoverERC20` reverts for MPGR). Migration **must be user-signed**.
3. **No early emission.** New pool’s 25M/730-day schedule must not accrue before the migration window closes, otherwise early migrators capture disproportionate share of fresh emissions while slow migrators earn 0 on the old frozen schedule.
4. **Old pool stays withdrawable forever.** `unstake`/`claimRewards`/`exit` have no `whenNotPaused` guard — intentionally. Even after `pause()`, exits work. Old contract stays live for late migrators.
5. **One atomic cutover for reads, two pools for writes.** Frontend reads switch from old address to new at a single block; both contracts remain write-able during migration.

---

## 1. Preservation of every user’s staked principal, pending rewards, reward accounting

### What must be preserved — exact storage (per §6 of deployment analysis)

**Global (new contract starts at zero, not copied):**
- `totalStaked` — sum of all `balanceOf`
- `rewardPoolBalance` — funded MPGR available for payouts (tracked separately from `stakingToken.balanceOf`)
- `rewardState.rewardRate`, `rewardState.periodFinish`, `rewardState.lastUpdateTime`, `rewardState.rewardPerTokenStored`
- `currentAPRBps`

**Per-user (per address):**
- `balanceOf[account]`
- `userRewardPerTokenPaid[account]`
- `rewards[account]` (contract name `rewards`, client name `accruedRewards`)

`earned(account)` is pure view; preserving the three per-user values + global reproduces it via `RewardMath` in `contracts/libraries/RewardMath.sol` == `lib/staking/reward-math.ts`.

### How preservation is achieved — **no on-chain copy** (trustless, user-driven)

The old contract has **no migration helper** and **cannot be upgraded** (no proxy, no `migrate` function, `recoverERC20` refuses MPGR). Therefore state is **not copied** by admin `SSTORE`. It is **preserved by claiming**:

- **Principal:** User calls `exit()` (or `unstake(amount)`) on **old** contract. `exit()` is `updateReward(msg.sender)` → checkpoints `rewards[account]=earned()`, zeroes `balanceOf[account]` chunk, `totalStaked -= amount`, transfers MPGR principal back to `account` (`safeTransfer`). This is the sole way to move principal — owner cannot.

- **Pending rewards:** Inside that same `exit()`, after `_unstake`, the contract runs `_payReward(account, rewards[account])` if `rewards[account] > 0`: checks `rewards[account] <= rewardPoolBalance`, zeroes `rewards[account]`, `rewardPoolBalance -= reward`, transfers MPGR rewards. If user used `unstake` alone, pending stays in `rewards[account]` and must be separately `claimRewards()`-ed before leaving; **`exit()` is the design’s required single-tx for migration** (atomic unstake+claim) to avoid stranded `rewards`.

- **Accounting reset on new pool:** On **new** contract, `balanceOf[account]` starts `0`, `userRewardPerTokenPaid=0`, `rewards=0`, `totalStaked=0`, `rewardPerTokenStored=0`. When user later `approve` + `stake(amount)` on new, `updateReward(msg.sender)` checkpoints with `earned=0` (since all prior global accrual is on old), `balanceOf` becomes `amount`, `totalStaked` increases, `userRewardPerTokenPaid` set to current global `rewardPerTokenStored`. New pending starts accruing from `lastUpdateTime` of new pool.

**Result:** Old pending is **paid out**, not transferred. New pending starts fresh. No byte is copied; the user’s total MPGR (principal+claimed pending) is preserved in their wallet, then re-staked.

### What is *not* preserved and why that is correct

- `rewardPerTokenStored`/`lastUpdateTime` of old are **not** copied to new. They are history of old emissions. New pool has its own 25M schedule; copying would double-count.
- `currentAPRBps`/`rewardRate`/`periodFinish` of old are **not** copied. New pool’s schedule is independent.

---

## 2. Avoid starting the new reward schedule too early while users migrate gradually

### Problem if funded immediately

`depositRewards(amount)` when `rate==0 || block.timestamp >= periodFinish` does:
```solidity
rewardState.rewardRate = amount / REWARDS_DURATION; // e.g. 25M/730d ≈ 396e12 wei/sec
rewardState.periodFinish = block.timestamp + REWARDS_DURATION; // 730d from T_FUND
rewardState.lastUpdateTime = block.timestamp;
currentAPRBps = INITIAL_APR_BPS;
emit RewardAdded(...);
```
`rewardPerToken()` then accrues as `(now - lastUpdateTime) * rate / totalStaked`. If `totalStaked` is small during early migration (only first movers), early movers get **disproportionate** `rewardPerToken` delta (same `rate` divided by small `totalStaked` → high per-token). Later movers, who were still accruing (or frozen) on old, get less than fair share on new.

### Design: **Deploy unfunded, stake without emission, fund at cutover**

- **T_DEPLOY:** Deploy fixed `MPGRStaking` at `TBD_NEW_ADDRESS` with constructor `(_mpgrToken=0xB200..., _initialOwner=NEW_OWNER)`. Constructor sets:
  ```
  rewardState = { rewardRate:0, periodFinish: block.timestamp, lastUpdateTime:block.timestamp, rewardPerTokenStored:0 }
  totalStaked=0, rewardPoolBalance=0, currentAPRBps=0
  ```
  **No `depositRewards` yet.** `rewardRate==0` → `rewardPerToken()` returns `rewardPerTokenStored` unchanged (frozen) regardless of `totalStaked`. Accrual is **zero**.

- **T_DEPLOY → T_FUND window (migration window, e.g., 14 days):** Users may `stake` on new. `stake()` path:
  ```solidity
  if (rate==0 && currentAPRBps>0 && block.timestamp < periodFinish) { activatedRate = totalStaked*currentAPRBps/10000/365d; ... }
  ```
  With `currentAPRBps==0` and `periodFinish==T_DEPLOY` (expired), **condition false** → `rate` stays `0`, no `InsufficientFundedRewards` check, no emission. Stakes succeed, `totalStaked` grows, but `rewardPerToken()` stays `0`. Early and late migrators **equally earn 0** — fair.

- **T_FUND (single block, after window):** Owner calls `depositRewards(25_000_000e18)` on **new** (now `rate==0 || now>=periodFinish` true). Modifier `updateReward(address(0))` checkpoints frozen state (no-op, but correct), then `rate = 25M/730d`, `periodFinish = T_FUND + 730d`, `lastUpdateTime = T_FUND`, `currentAPRBps = 2000`. Emission **starts at T_FUND for everyone** who has staked by then, and for those who stake after, they join mid-schedule (existing `rewardPerTokenStored` accounts for prior emission correctly via `updateReward`).

This matches `extendRewardSchedule` semantics (which preserves `leftover`) but for a **fresh** pool we want **no leftover** — start clean at T_FUND. Alternative of funding immediately would create a high early `rewardPerToken` spike; keeping unfunded until window closes is the fair “no early emission” design.

**Why not `pause()` new?** `pause()` only blocks `stake`, not helpful. Keeping `rate==0` is a natural, code-enforced pause of **rewards**, not of **staking**, exactly what gradual migration needs.

---

## 3. Exactly when the new reward schedule starts

**Single atomic moment: the block that includes `depositRewards(25M)` on the new contract.**

- **Before that block:** `rewardState` = `{rate:0, periodFinish:T_DEPLOY, lastUpdate: T_DEPLOY, stored:0}` → `rewardPerToken() == 0`, `earned()==0` for all.
- **That block (T_FUND):** Transaction `updateReward(address(0))` checkpoints (still 0), then:
  ```
  rewardRate = 25_000_000e18 / 63072000s (≈ 3962721696... wei/sec for 25M? Exact: 25M*1e18/63072000 = 396...e? As in repro, 396372399797057331 for 25M? The precise value is deterministic.)
  periodFinish = T_FUND + 63072000  // 730*86400
  lastUpdateTime = T_FUND
  currentAPRBps = 2000
  rewardPoolBalance += 25M (via _pullRewardTokens, fee-on-transfer check)
  emit RewardAdded(25M, rate, periodFinish)
  emit RewardsDeposited
  ```
- **After that block:** For any `now <= periodFinish`, `rewardPerToken() = stored + (now - T_FUND)*rate*1e18/totalStaked`. If `totalStaked==0` at that instant (no migrators yet), accrual stays frozen at `stored` (no loss to void), and first `stake` thereafter starts accruing from its `lastUpdateTime`.

**Choosing T_FUND:** At the **end** of migration window, not at deploy. Window length proposal: **14 days** (covers two weekly `settlement` cycles if games existed; adjustable 7–21 days). Announce `T_DEPLOY`, `T_FUND` block timestamp in advance. If migration participation < threshold at T_FUND (e.g., `totalStaked < 50% of old totalStaked`), **extend window, do not fund yet** — funding is one-way (cannot undo `rate` without `setAPR`).

---

## 4. How old-contract users can safely exit and claim all accrued rewards

**Required single path: `exit()` (preferred) or `claimRewards()` + `unstake()`. Both remain available even if old is `paused()`.**

- **Why `exit()` not `unstake()` alone:** `unstake(amount)` checkpoints `rewards[account]=earned(account)` but **does not pay** it; it leaves `rewards[account]` claimable. A user who `unstake`s full balance and forgets `claimRewards` would leave MPGR stranded in `rewards` mapping. `exit()` does `_unstake(msg.sender, staked)` + `_payReward(msg.sender, rewards[msg.sender])` **atomically** in one tx, leaving `balanceOf==0, rewards==0`, and transfers principal+pending. **Design mandates `exit()` as the migration exit.**

- **Steps for user on old `0x1690…` (Base, chain 8453):**
  1. In UI, click “Legacy Pool — Exit” (or via Basescan `Write Contract`).
  2. `exit()` → `updateReward(msg.sender)` checkpoints `earned` into `rewards`, `userRewardPerTokenPaid = rewardPerTokenStored`.
  3. `_unstake` transfers `balanceOf` MPGR back to wallet.
  4. `_payReward` checks `reward <= rewardPoolBalance`, zeroes `rewards`, `rewardPoolBalance -= reward`, transfers rewards MPGR. Reverts `NoRewardToClaim` only if `rewards==0` and no stake; `exit` reverts `NothingStaked` only if `balanceOf==0` (but if `balanceOf==0` but `rewards>0`, user should call `claimRewards()` instead).

- **Accrual freeze note:** If old’s `block.timestamp >= periodFinish` (schedule expired, e.g., 730d after last `depositRewards`), `rewardPerToken()` is frozen at `periodFinish` (via `lastTimeRewardApplicable`). `earned()` is still claimable but no longer grows. Exit after expiry still pays the **frozen** amount — no further loss. The bug would have been `depositRewards` after expiry **without** checkpoint; since we **will not call `depositRewards` on old after T_DEPLOY**, the frozen amount is safe.

- **Gas:** ~120k gas (unstake+claim) on Base — negligible. B20 `approve` gas quirk does not apply to exit.

- **No owner action needed:** Owner cannot pull rewards for user; user must sign.

---

## 5. How users enter the new contract without losing rewards

**Steps on new `TBD_NEW_ADDRESS` (after T_DEPLOY, before or after T_FUND — both safe, but design encourages before T_FUND for fairness):**

1. `approve(TBD_NEW_ADDRESS, amount)` for MPGR token `0xB200…` — **must use 150k gas limit** (B20 Rust precompile; see `lib/staking/staking-client.ts: B20_APPROVE_GAS_LIMIT`).
2. `stake(amount)` — `updateReward(msg.sender)` (with `totalStaked` before stake), `safeTransferFrom` pulls MPGR, `totalStaked+=amount`, `balanceOf[msg.sender]+=amount`, emits `Staked`. If rate still 0 (pre-T_FUND), no APR activation, `earned` stays 0 until T_FUND.
3. If user staked **before T_FUND**, their `userRewardPerTokenPaid` is set to old `rewardPerTokenStored` (0), and after T_FUND they accrue normally. If user stakes **after T_FUND**, `updateReward` on new stake correctly computes `earned` for existing stakers via checkpoint, then sets `userRewardPerTokenPaid` to current global `rewardPerTokenStored` — no loss, no double-count.

**Preservation guarantee:** Old pending was already **paid** to wallet via `exit()` old; new pending starts from zero. No byte is “moved”; the user’s wallet holds the sum, then re-stakes principal. If user previously `claimRewards()`ed old, their wallet already holds pending; same flow.

**Frontend helper:** UI should sequence `exit` old → (optional `claimRewards` if `exit` not used) → `approve` new → `stake` new as a guided flow, showing both legacy and new positions (dual `stakingService` instances) during migration window.

---

## 6. Handling users who do not migrate immediately

- **Old contract stays live:** `pause()` is **not** required to be called at T_FUND. Even if `pause()` is called on old (blocks new `stake` on old), **`unstake`/`claimRewards`/`exit` remain callable forever** (no `whenNotPaused`). The design **recommends** `pause()` old at `T_DEPLOY` to prevent new stakes on buggy code (to contain the `depositRewards` bug surface), but **does not force** exits. Users who never migrate keep:

  - **Principal safe:** `balanceOf[account]` remains, `totalStaked` includes them, `stakingToken.balanceOf(old)` still holds `totalStaked+rewardPoolBalance` (invariant). They can exit at any future block.
  - **Pending safe but frozen:** If `now < periodFinish_old`, pending continues to accrue at old `rate` until `periodFinish_old`. If `now >= periodFinish_old`, pending frozen at expiry amount. **No further `depositRewards` will be called on old** (by design), so the buggy path is never triggered again, so frozen pending will not be lost.
  - **No auto-migration:** Their `balanceOf` on old does **not** appear on new. New’s `totalStaked` excludes them — new emission is shared only among migrators. This is intentional and communicated.

- **Late migrators:** At any later block `TLATE > T_FUND`, late user can still `exit()` old (pays frozen pending) then `stake()` new, joining mid-schedule. Their `earned` on new starts from `userRewardPerTokenPaid = current global stored`, so they are not retroactively compensated for emissions they missed — fair per `Synthetix` model.

- **Abandoned dust:** If some wallets never migrate and `totalStaked_old` >0 but `rewardPoolBalance_old` holds unclaimed rewards, those MPGR remain in old contract. No owner rescue (`recoverERC20` reverts for MPGR). Dust is effectively **stranded** but not lost to theft.

---

## 7. How the old contract remains available for withdrawals/claims after new staking is activated

- **Code guarantee:** `unstake`/`claimRewards`/`exit` lack `whenNotPaused`. Even if old is `paused()`, those three succeed. `pause()` only reverts `stake()` with `EnforcedPause`.
- **Design:** Old stays deployed at `0x1690…` forever. Frontend retains a **read-only legacy panel** (pinned old address) alongside primary new pool:

  ```ts
  // lib/chain/base.ts — post-cutover (example)
  export const MPGR_STAKING_ADDRESS_LEGACY = "0x1690C7b6d312284e30434d93498e56eE09fFa12c" as Address;
  export const MPGR_STAKING_ADDRESS = "TBD_NEW_ADDRESS" as Address; // primary
  ```

  `staking-client.ts` can be instantiated twice: `stakingClientLegacy` and `stakingClient` (or `stakingHistory` reads both via `readContract`). UI shows two cards: “MPGR Staking (New, 730d)” and “Legacy — Withdraw Only”.

- **No proxy removal:** The old address never self-destructs (`SELFDESTRUCT` not present). Basescan will always serve `readContract` for it.

- **Operational:** No `selfdestruct`, no `upgrade`, no timelock needed. Owner retains `owner()` on old (can `pause`/`unpause` but cannot move funds).

---

## 8. How the 25M MPGR reward pool should be funded and when

### Constants (from `MPGRStaking.sol`)

```
MINIMUM_STAKE = 100e18
REWARDS_DURATION = 730 days = 63,072,000 seconds
REWARD_POOL (informational, not enforced by code) = 25_000_000e18
INITIAL_APR_BPS = 2000 (20%)
```

Formula in `depositRewards`: `rewardRate = amount / REWARDS_DURATION`

### Funding math

- For `amount = 25_000_000e18`, `rewardRate ≈ 25e24 / 63072000 ≈ 396...` wei/sec (exact integer division; see repro `396372399797057331` for 25M? For 1M it’s `15854895991882293`).
- Invariant check in `setAPR`: `newRewardRate * remaining <= rewardPoolBalance` — with `rate = amount/730d` and `remaining <= 730d`, this holds as `amount <= rewardPoolBalance` (since `rate*remaining = amount*remaining/730d <= amount` when `remaining <=730d`).

### When

- **Single funding at T_FUND** (after migration window). **Not at T_DEPLOY.** T_DEPLOY → T_FUND window is **stake-without-emission** (rate 0). This avoids early emission skew.

### How much

**Option A (clean slate, recommended if treasury allows):** Mint/transfer-approved MPGR to owner, then `depositRewards(25_000_000e18)` on new. This replicates the original tokenomics: fresh 2-year schedule of 25M. Old pool’s remaining `rewardPoolBalance` (unclaimed) stays in old for legacy claims — **not duplicated** (it funds old pending). Total system allocation becomes **25M (old remaining) + 25M (new)** = up to 50M across two pools, but old remaining will be claimed and drained; new is future emissions. If tokenomics requires single 25M lifetime, fund new with **remaining budget** instead.

**Option B (budget-aware):** Snapshot old `rewardPoolBalance_old` and `totalClaimed` logic; fund new with `remaining = REWARD_POOL - alreadyClaimedOld` (or `remaining = min(REWARD_POOL, treasuryApproved)`). This keeps **lifetime 25M** across both deployments. Requires prior off-chain `totalClaimed` tally (sum of `RewardPaid` events).

**This design proposes Option A** (fresh 25M) **with disclosure**, because old remaining is **custodied** in old and cannot be reclaimed, and the original `REWARD_POOL` constant is informational, not a supply cap enforced by the contract (`_pullRewardTokens` does not check `REWARD_POOL`). If the project’s tokenomics demands single 25M, use Option B and document.

### Execution (treasury owner only)

```solidity
// Pre: owner holds >=25M MPGR and has approved new contract
stakingToken.approve(TBD_NEW_ADDRESS, 25_000_000e18);
// Single tx at T_FUND
depositRewards(25_000_000e18); // onlyOwner, updateReward(address(0)), nonReentrant, fee-on-transfer check
// Post: rewardPoolBalance ==25M, rate==25M/730d, periodFinish==T_FUND+730d, lastUpdate==T_FUND
```

**Fee-on-transfer check:** `_pullRewardTokens` does `balanceBefore+after` delta check and reverts `FeeOnTransferTokenUnsupported` if MPGR were fee-on-transfer (it is not, but check remains).

**Timing guard:** Must be **after** migration window, **before** users expect yield. Announce `T_FUND` block timestamp; if `totalStaked_new ==0` at T_FUND, still safe — `rewardPerToken()` freezes (totalStaked zero path in `RewardMath`), no reward lost to void; first `stake` thereafter will start accruing.

---

## 9. Temporary migration helper contract/function required?

### Answer: **No helper contract/function is required for correctness or safety. Recommend NOT implementing one.**

**Why not required:**

- Old contract already has `exit()` (atomic unstake+claim) that preserves all — no helper needed.
- New contract’s `stake()` + `approve` is the standard path.
- Owner **cannot** move `balanceOf` without user signature; any helper would still need `permit`/`transferFrom` allowance from each user → same two sigs as `exit`+`stake`, but with extra trust assumptions.

**Why not recommended:**

| Helper idea | Risk vs. user-driven |
|-------------|----------------------|
| `MigrationHelper` that `exit()` old on behalf of user via `call` then `stake()` new (needs user to `approve` helper for old `balanceOf`? Not possible — `balanceOf` is internal, not ERC20; only `unstake`/`exit` can move it, and they require `msg.sender == user`. A helper cannot impersonate `msg.sender`. | **Breaks auth** — `updateReward(msg.sender)` would checkpoint helper, not user; `msg.sender` check would prevent moving other’s stake. Would need explicit `migrateFor(user, sig)` with EIP-712 and new code on old — not present. Adding it = upgrade. |
| `BatchMigrator` that trusts off-chain snapshot and `setBalance` on new (owner sets `balanceOf`) | **Critical** — owner could forge `balanceOf`/`rewards`, break invariant `totalStaked+rewardPoolBalance <= tokenBalance`, and silently misprice `rewardPerToken`. Requires new storage layout and audit. |
| `Airdrop` new staking positions | **Centralization** — same forge risk, plus double-spend if old not exited. |

**Existing `extendRewardSchedule` is already the safe “migration” for rewards** (preserves `leftover`), but it applies to **single pool**, not cross-contract.

**Recommendation:** Keep migration **purely user-driven `exit()` old → `stake()` new**. The only “helper” needed is **frontend UX**: a two-step button that sequences `exit` then `stake` and shows both balances, plus a legacy panel. This is a UI helper, not a contract helper, and needs no new bytecode.

**If a helper were built anyway (NOT implemented):** It would be a **new standalone contract** `MPGRStakingMigrator` that is granted **no** privileged role; it would simply `call` old `exit()` via `msg.sender` being the user (so user must call migrator, migrator `delegatecall` is not used). Even this is just a batcher, not a trusted custodian, and still requires user tx. Not needed.

---

## 10. Required frontend / address / config changes

All changes are **one-source-of-truth** edits:

### Single address swap (required)

| File | Change | Detail |
|------|--------|--------|
| `lib/chain/base.ts` | **Required** | Update `MPGR_STAKING_ADDRESS` from `0x1690…` to `TBD_NEW_ADDRESS` (checksummed). Optionally add `MPGR_STAKING_ADDRESS_LEGACY = 0x1690…` for legacy reads. |
| `lib/staking/staking-config.ts` | **Transitive** | Imports `MPGR_STAKING_ADDRESS` — no edit needed beyond `base.ts`. |
| `lib/staking/staking-abi.ts` | **No change** | ABI unchanged (`depositRewards` signature same; modifier is internal). Hand-derived ABI still valid; re-verify via `forge inspect MPGRStaking abi`. |
| `lib/staking/staking-client.ts` | **No change** | Uses `MPGR_STAKING_CONFIG.address`. |
| `docs/WHITEPAPER-v2.md:262,449` | **Docs only** | Update staking address in deployed contracts tables. |
| `docs/ARCHITECTURE.md`, `lib/site.ts` | **Docs only** | Update if staking address listed. |
| `lib/chain/base.test.ts` | **Update test** | If test hard-codes `0x1690…`, update to new or make legacy-aware. Currently tests `CHAIN_ID` only, not address — likely no change, but verify. |

### No changes needed

- `.env.example`, `vercel.json`, `lib/wagmi.ts`, `package.json`, `foundry.toml`, `remappings.txt` — no staking address, no new env var.
- `NEXT_PUBLIC_BASE_RPC_URL` unchanged; chain 8453.
- No `DATABASE_URL`, no `BullMQ`.

### Optional but recommended for migration UX

- **Dual-client support:** In `lib/staking/staking-client.ts`, export `stakingClientLegacy = { address: MPGR_STAKING_ADDRESS_LEGACY, abi: STAKING_ABI }` for legacy reads, keep `stakingClient` for new. `hooks/useStaking` can optionally fetch both (`getStakedBalance` old/new) and expose `legacyStakedBalanceRaw`, `legacyEarnedRaw`.
- **Staking page:** `app/staking/page.tsx` add a “Legacy Pool — Withdraw Only” section reusing `StakingCard` with `isPoolPaused=true` style, `StakingStats` for legacy `totalStaked`/`rewardPoolBalance`.
- **Feature flag (optional):** `NEXT_PUBLIC_STAKING_MIGRATION_PHASE = "dual"` vs `"new-only"` to toggle legacy panel without code revert.
- **History:** `lib/staking/staking-history-reader.ts` hard-codes chunk size 10; add second reader for legacy address during migration so `totalRewardsClaimedRaw` includes both.

### Build & deploy coupling

Next.js build inlines `MPGR_STAKING_ADDRESS` at compile time (webpack/Turbopack). Changing `lib/chain/base.ts` requires **new Vercel build** from `main` after merge. Cache (`.next`) not reused across addresses; users’ browser cache refetches new JS with new address.

---

## 11. Rollback / emergency plan

### Before T_FUND (before funding new)

| Scenario | Action | Loss |
|----------|--------|------|
| New contract has bug, wrong constructor args, failed verification | **Do not fund.** Abandon `TBD_NEW_ADDRESS`, deploy another `TBD_NEW_ADDRESS2` with corrected bytecode, update `lib/chain/base.ts` again (still unfunded, so no emission). Old `0x1690…` untouched, users who already staked on new can `exit()` new (principal safe, no rewards) and return to old via `stake()` old. | None — no rewards accrued (rate 0). Gas only. |

### After T_FUND (post-funding, pre- or mid-migration)

The funding tx `depositRewards(25M)` is **irreversible** (sets `rate`, `periodFinish`, `lastUpdate`). Options:

1. **If new pool’s rate is wrong (e.g., funded  wrong amount):** Owner can `setAPR(newAPRBps)` to adjust `rate` without moving funds. `setAPR` is `updateReward(address(0))` → checkpoints, then `rate = totalStaked*newAPRBps/10000/365d`. Check `newRewardRate*remaining <= rewardPoolBalance` else `InsufficientFundedRewards`. This corrects `rate` but **does not refund excess funding**.

2. **If new pool must be abandoned:** Deploy `TBD_NEW_ADDRESS2`, **do not** move funds via `recoverERC20` (reverts for MPGR). Funds in `TBD_NEW_ADDRESS` are stuck as `rewardPoolBalance` unless claimed via staking rewards (only `unstake`/`claim` move MPGR, and only for stakers proportional to `earned`). Abandoning would strand `rewardPoolBalance` (loss of treasury MPGR). Mitigate by **funding with small test amount first** (e.g., `1_000e18`) and verifying `stake`/`earned`/`claim` on new before full 25M — design proposes **test-fund → verify → full-fund** (two `depositRewards` calls: first small, second larger; second when `rate!=0 && now<periodFinish` will **not** reset schedule, just increase `rewardPoolBalance` without changing `rate` — see §8 funding note). Therefore **do not fund 25M in one go if risk is high; fund 1k, test, then top-up via `depositRewards` (mid-period) or `extendRewardSchedule`.**

3. **If user migrates and new tx reverts (e.g., `BelowMinimumStake` 100 MPGR, `EnforcedPause`):** UI shows `StakingActionState` error, `readError` surfaced, no loss — principal never left old.

4. **If Vercel frontend with new address is buggy:** Revert `lib/chain/base.ts` change via `git revert` on `main`, redeploy Vercel to old `0x1690…`. New pool remains funded but idle. Users who already migrated to new can `exit()` new and return.

### Emergency pause

- **Old:** `pause()` old at any time (owner) — blocks new stakes on buggy code, but exits/claims stay. Use if exploit found.
- **New (fixed):** `pause()` new also blocks stakes on fixed code, exits remain. Useful if new bug discovered post-funding.

### Key invariant to monitor post-cutover

- `stakingToken.balanceOf(old) == totalStaked_old + rewardPoolBalance_old`
- `stakingToken.balanceOf(new) == totalStaked_new + rewardPoolBalance_new`
- Frontend `ProviderError` rate, `ReentrancyGuardReentrantCall`, `InsufficientRewardBalance`.

**No `selfdestruct`, no `kill` — both contracts stay forever.**

---

## 12. Clear separation of the five phases

| Phase | What happens | Who | Transaction / code | When | Approval |
|-------|--------------|-----|--------------------|------|----------|
| **A. Code PR** | Fix `depositRewards` with `updateReward(address(0))`, NatSpec, Foundry regression suite `test/MPGRStakingDepositRewardsCheckpoint.t.sol` (6 tests), `solc` compile, JS repro. | Eng | Commit `15941ba`, PR #24 **OPEN** (not merged) | Already done, **merged to `main` only after this design approval** | Maintainer + security review |
| **B. Contract deployment** | Deploy fixed `MPGRStaking` with `constructor(MPGR_TOKEN, NEW_OWNER)` to Base 8453 → `TBD_NEW_ADDRESS`. Verify on Basescan, no `depositRewards` yet (rate 0). | Deployer (owner key) | `forge create` (or Safe) — **DO NOT RUN** | After A merged, after snapshot, **before** funding | Deployer + owner key + Safe members if multisig (not enforced but recommended) |
| **C. Treasury funding** | Owner `approve` + `depositRewards(25M)` (or staged 1k test → 25M) on **new** at `T_FUND`. Sets `rewardRate=25M/730d`, `periodFinish=T_FUND+730d`, `currentAPRBps=2000`. Single irreversible schedule start. | Treasury owner | `depositRewards` tx — **DO NOT RUN** | **End of migration window** (e.g., T_DEPLOY+14d) | Treasury + owner |
| **D. User migration** | Users voluntarily `exit()` old (principal+pending to wallet) → `approve` new → `stake` new. Users who don’t migrate keep old `balanceOf`/`rewards` claimable forever. | Users (each signs) | `exit()` old, `approve`+`stake` new — **no admin tx** | Window `T_DEPLOY`→`T_FUND` (stake without emission) and after `T_FUND` (join mid-schedule) | No central approval; user consent |
| **E. Frontend cutover** | Update `lib/chain/base.ts` `MPGR_STAKING_ADDRESS` → new (keep legacy constant), update docs `WHITEPAPER-v2.md`, PR → merge `main` → Vercel build. Optionally dual-panel UI for legacy withdraw. | Eng | `lib/chain/base.ts` edit — **DO NOT MERGE YET** | **Between B and C** (after deploy, before funding) so UI points to new for stake, but legacy panel still reads old | Maintainer merge + Vercel deploy |

**Explicitly not merged/executed:** B/C/D/E are **design only**. No transaction has been sent, no address changed in this repo, no funds moved.

---

## Timeline diagram (proposed, not executed)

```
T_DEPLOY                T_FUND (T_DEPLOY+14d)              T_FUND+730d
   |                           |                                   |
   |-- deploy fixed ---------->|-- depositRewards(25M) ---------->| periodFinish
   |  rate=0, period=now       |  rate=25M/730d, start emission    |  accrual frozen
   |                           |                                   |
   |  [migration window]       |                                   |
   |  users may stake new      |  all migrators now earn           |
   |  but earn 0               |  late migrators join mid-schedule |
   |                           |                                   |
old 0x1690  rate old, periodFinish_old (maybe future)   --> pause() old (optional, blocks new stakes)
old pending: accrues until periodFinish_old, then frozen, claimable via exit() forever
```

If `totalStaked_new ==0` at `T_FUND`, `rewardPerToken()` stays frozen (totalStaked zero path), no void loss; first stake after `T_FUND` will checkpoint correctly.

---

## What must be snapshotted before any deployment (read-only)

At a pinned block `SNAP_BLOCK` (before `T_DEPLOY`):

```bash
# Example reads — DO NOT RUN (RPC blocked in sandbox, but required off-sandbox)
cast call 0x1690C7b6... "totalStaked()(uint256)" --block $SNAP_BLOCK --rpc-url $BASE_RPC_URL
cast call 0x1690C7b6... "rewardPoolBalance()(uint256)" --block $SNAP_BLOCK --rpc-url $BASE_RPC_URL
cast call 0x1690C7b6... "rewardState()(uint256,uint256,uint256,uint256)" --block $SNAP_BLOCK --rpc-url $BASE_RPC_URL
cast call 0x1690C7b6... "currentAPRBps()(uint256)" --block $SNAP_BLOCK --rpc-url $BASE_RPC_URL
cast call 0x1690C7b6... "paused()(bool)" --block $SNAP_BLOCK --rpc-url $BASE_RPC_URL
# per-user via staking-history-reader.ts getLogs Staked/Unstaked/RewardPaid for holder set, then loop:
cast call 0x1690C7b6... "balanceOf(address)(uint256)" $HOLDER --block $SNAP_BLOCK
cast call 0x1690C7b6... "rewards(address)(uint256)" $HOLDER --block $SNAP_BLOCK
cast call 0x1690C7b6... "userRewardPerTokenPaid(address)(uint256)" $HOLDER --block $SNAP_BLOCK
```

Export CSV + Merkle root for audit. This snapshot is the **rollback reference** if new deployment fails.

---

## Approvals required before proceeding (not granted)

- **Owner key holder** for `0x1690…` (verify via `owner()` on Basescan; if Safe, Safe owners).
- **Maintainer PR review** for `lib/chain/base.ts` address change + code PR #24 merge.
- **Security/audit** sign-off (per `docs/SECURITY_REMEDIATION.md`; staking is financial, needs external audit before funding).
- **Treasury** approval for `25M` (or staged) MPGR funding from treasury wallet.
- **Product/comm** approval for announcement text (explain `exit`+`stake` steps, not “auto-migrated”).

**Stop.** Design complete. All transactions remain **not executed**. Awaiting explicit approval to proceed to any of phases B–E. Do not start Task 3.

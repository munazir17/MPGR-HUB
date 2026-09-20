# Task 2 — Deployment Analysis (DO NOT DEPLOY)

**Branch analyzed:** `arena/01a0bcad-mpgr-hub` commit `15941ba` (fix) vs `main` @ `00efaca` (pre-fix)
**Deployed contract claim:** `0x1690C7b6d312284e30434d93498e56eE09fFa12c` on Base mainnet (8453)
**Analysis date:** 2026-09-20
**Mode:** READ-ONLY — no transactions sent, no pause/migrate, no config changed, no frontend redeployed.

---

## 1. Currently deployed MPGRStaking address

**Address:** `0x1690C7b6d312284e30434d93498e56eE09fFa12c`

**Chain:** Base mainnet, chain ID `8453` (`base` in wagmi/viem)

**Source of truth in repository:**

- `lib/chain/base.ts:22-23` — single typed registry (comments: “exact on-chain values already used by the live configs”)
  ```ts
  export const MPGR_STAKING_ADDRESS = "0x1690C7b6d312284e30434d93498e56eE09fFa12c" as Address;
  ```
- `lib/staking/staking-config.ts:13` imports `MPGR_STAKING_ADDRESS` from `lib/chain/base` and exposes `MPGR_STAKING_CONFIG.address` — no alternative address, no env override, no chain-switch.
- `docs/WHITEPAPER-v2.md:262,449` and `docs/ARCHITECTURE.md` list same address in the “Deployed contracts” table; `lib/site.ts` and `lib/staking/*` reference only via the chain registry.

**Verification limitation:** Direct on-chain existence check ( `eth_getCode` / Basescan ) from this sandbox fails — outbound TLS to `mainnet.base.org` and `api.basescan.org` is `ECONNRESET` (proxy blocks `release-assets`/`mainnet.base.org`; only `registry.npmjs.org`/`api.github.com`/`github.com` proxy works). Address therefore **verified from repository only**, not by live RPC in this environment. The address is consistently the same across all config, ABI, docs, and client files; no other staking address appears in the searched tree.

---

## 2. All source/config files that reference this contract address

Grepped for `0x1690`, `MPGR_STAKING_ADDRESS`, `staking.*address` across repo (excluding `node_modules`, `.git`, `.forge-deps`, `.next`, `out`, `cache`):

| File | How it references |
|------|-------------------|
| `lib/chain/base.ts` | **Definition** — `MPGR_STAKING_ADDRESS` constant (typed `Address`) |
| `lib/staking/staking-config.ts` | Re-exports `MPGR_STAKING_CONFIG.address = MPGR_STAKING_ADDRESS`; used by every staking read/write |
| `lib/staking/staking-abi.ts` | Comments: “exact contract deployed to Base Mainnet at `MPGR_STAKING_CONFIG.address`”; ABI derived from `contracts/MPGRStaking.sol`+`IMPGRStaking.sol` |
| `lib/staking/staking-client.ts` | `const STAKING_CONTRACT = { address: MPGR_STAKING_CONFIG.address, abi: STAKING_ABI, chainId: 8453 }` — all `readContract`/`writeContract` go here |
| `lib/staking/staking-service.ts` | Uses `stakingClient` (hence same address) |
| `hooks/useStaking.ts`, `hooks/useStakingHistory.ts` | Consume `stakingService`/`stakingClient` |
| `components/ui/Staking*` (`StakingCard`, `StakingStats`, etc.) | UI only, via hooks |
| `docs/WHITEPAPER-v2.md` | Documented deployment table (staking row) and Basescan link |
| `docs/ARCHITECTURE.md` (via `lib/chain/base.ts` citation) | References chain registry |
| `.next/*` (build cache) | Compiled output of above — not source; ignore |

**No env var** overrides the address. ` .env.example` contains `REWARD_MANAGER_PRIVATE_KEY`, `NEXT_PUBLIC_BASE_RPC_URL`, `KV_*`, `AUTH_*`, `CRON_SECRET`, `GAME_*` but **no** `MPGR_STAKING_ADDRESS` or `NEXT_PUBLIC_*STAKING*`. `vercel.json` contains only `buildCommand` and crons; no address. `lib/wagmi.ts` transports use `NEXT_PUBLIC_BASE_RPC_URL` but chain/address stay hard-coded in `lib/chain/base.ts`.

**Frontend impact:** Changing the deployed address requires editing **one source line** (`lib/chain/base.ts`) plus redeploying the Next.js app; all other staking files follow it. Docs would need updating but are not load-bearing.

---

## 3. Does deployed bytecode correspond to pre-Task-2 (buggy) implementation?

**Repository evidence: YES — deployed must be buggy.**

- **Pre-Task-2 (main @00efaca):** `contracts/MPGRStaking.sol:252`  
  ```solidity
  function depositRewards(uint256 amount) external onlyOwner nonReentrant {
  ```
  No `updateReward(address(0))`. Git log and file header say “Milestone 1C — adds setAPR(), recoverERC20(), … `depositRewards()` is behaviorally unchanged but now calls a shared private helper”. The `updateReward` modifier is applied to `stake`, `unstake`, `claimRewards`, `exit`, `setAPR`, `extendRewardSchedule` but **not** `depositRewards`.

- **Post-Task-2 (branch 15941ba):**
  ```solidity
  function depositRewards(uint256 amount) external onlyOwner nonReentrant updateReward(address(0)) {
  ```
  NatSpec updated: “Adds `updateReward(address(0))` (Milestone 1C fix): checkpoints global accrual at the old rewardRate before potentially resetting …”

- **Deploy history inference:** The branch `arena/01a0bcad-mpgr-hub` was created from `00efaca`, committed locally, pushed, and PR #24 opened as **OPEN, not merged** (`gh pr view 24` = `state: OPEN`). `main` still contains the buggy `depositRewards`. Production at `mpgrhub.xyz` deploys from `main` (Vercel linked to GitHub `main`; `vercel.json` and `README.md` say “deploy from `main`”). No deployment artifact, broadcast, or address update has been pushed to `main` since Task 2.

- **Bytecode direct verification:** **Cannot be verified from this sandbox** (see §1 RPC block). No local `out/`, `cache/`, `broadcast/`, or `ignition/` artifacts exist (`.gitignore` hides them; `ls` shows none). Even if the deployed contract’s bytecode were fetched via Basescan, the comparison would be: fetch `eth_getCode` at `0x1690…`, compare deployed initcode hash to local `forge build` output for pre-fix vs post-fix. That step requires live RPC/Basescan, which is blocked here. Explicitly **unverified on-chain** in this environment.

**Conclusion:** By repository, the only deployed address known to the app (`0x1690…`) was deployed from pre-fix source; the fix exists only on an unmerged branch and has not been broadcast to Base. Unless the team deployed the fix out-of-band (no evidence in repo, PR, or `docs/`), the live contract **still lacks** `updateReward(address(0))` and therefore **still has the bug**. The previous report’s “Redeploy needed: YES” is **accurate under repository assumptions**, with the caveat that on-chain bytecode was not directly fetched here.

---

## 4. Deployed contract’s owner/admin, pause, upgradeability, migration

Source: `contracts/MPGRStaking.sol` + `contracts/interfaces/IMPGRStaking.sol` + `lib/staking/staking-abi.ts`

### 4a. Owner / admin
- **Inheritance:** `contract MPGRStaking is IMPGRStaking, Ownable, Pausable, ReentrancyGuard`
- **Constructor:** `constructor(address _mpgrToken, address _initialOwner) Ownable(_initialOwner)` — owner set once at deployment, no `initializer` pattern.
- **Access control:** `onlyOwner` on: `depositRewards`, `setAPR`, `extendRewardSchedule`, `recoverERC20`, `pause`, `unpause`. `onlyOwner` is OpenZeppelin `Ownable` (single EOA; no multisig, no timelock in code).
- **Owner discovery:** **Cannot be verified on-chain from sandbox** (no RPC). On-chain `owner()` view exists (`staking-abi.ts` includes `owner()`); must be read via `cast call` / Basescan “Read as Proxy” on Base (e.g., `https://basescan.org/address/0x1690C7b6d312284e30434d93498e56eE09fFa12c#readContract`). Repository does not hard-code the owner address anywhere; no `.env` or config lists it.

### 4b. Pause mechanism
- **Exists:** `Pausable` + `pause()` / `unpause()` (`onlyOwner`). Event `Paused(address)`, `Unpaused(address)`. View `paused()`.
- **Semantics (per NatSpec & code):**
  - `stake()` has `whenNotPaused` — paused blocks **new stakes only**.
  - `unstake()`, `claimRewards()`, `exit()` have **no** `whenNotPaused` — **remain available while paused** (explicitly documented: “Staking exits remain available while new staking is paused.”).
  - `depositRewards`, `setAPR`, `extendRewardSchedule`, `recoverERC20` are owner-only and do **not** check pause.

### 4c. Upgradeability / proxy status
- **Not upgradeable.** No `UUPSUpgradeable`, `TransparentUpgradeableProxy`, `BeaconProxy`, `Diamond`, `Proxy` import, no `initialize()` function, no `__gap` storage, no `upgradeTo()` / `upgradeToAndCall()`. Constructor is a real `constructor`, not an initializer. The contract is a plain, **immutable** deployment. `foundry.toml` and remappings confirm no proxy plugin.
- **Consequence:** Logic cannot be replaced in place; bytecode at `0x1690…` is fixed forever.

### 4d. Migration mechanism
- **No migration function exists.** Searched entire `contracts/` for `migrate`, `import`, `setBalance`, `airdropRewards`, `batchStake`, `forceCheckpoint`. None found.
- `recoverERC20(address token, uint256 amount)` exists but **explicitly reverts** for the staking token:
  ```solidity
  if (token == address(stakingToken)) revert CannotRecoverStakingToken();
  ```
  Comment: “Because `stakingToken == rewardsToken` in this pool, every unit … is either user principal … or reward-pool funds … so recovery of MPGR is disallowed entirely.” This prevents owner rescue of MPGR.
- **No** `rescue`, `emergencyWithdraw`, or `adminUnstakeFor`.

**Summary:** Single `Ownable` owner, pausable (stake only), **immutable / non-proxy**, **no built-in migration**.

---

## 5. Can the current contract be fixed in place?

**No — immutable, cannot be fixed in place.**

- **Why:** `MPGRStaking.sol` is a non-proxy contract with a `constructor` and no delegatecall upgrade path. Ethereum/Base immutability: once deployed, the runtime bytecode at `0x1690…` cannot be altered. OpenZeppelin `Ownable`+`Pausable` provides no `upgradeTo`. No proxy admin, no beacon, no diamond-cut. The `updateReward` fix is a **bytecode change** (adds `SLOAD`/`SSTORE` for `rewardPerTokenStored`/`lastUpdateTime` before token pull). The only way to activate that logic is to **deploy a new contract at a new address**.

- **Could a new implementation be “linked” without new address?** No. `lib/chain/base.ts` hard-codes the address; no proxy delegation exists to redirect. Even if the frontend were pointed elsewhere, the old contract’s storage (balances, pools) stays at the old address and cannot be moved by the contract itself.

- **Is there any “escape hatch” that simulates a fix?** No. `setAPR`/`extendRewardSchedule` already have `updateReward`, but `depositRewards` is the funding path that triggers the 2-year schedule reset. Avoiding the bug by never calling `depositRewards` after expiry is not a sustainable fix — any future funding after expiry (or when `rate==0`) will re-trigger loss. The **only durable fix** is the modifier addition.

**Required action:** New deployment (new address) + state migration or user-driven restake (see §7). The old contract’s bytecode will forever remain buggy; it can only be abandoned (paused for new stakes, left to allow exits).

---

## 6. Contract architecture — exact state that must be preserved

The pool’s state is **not** a single variable; it is global + per-user. A loss would be **financial** (MPGR) or **accounting** (earned underpaid). All of the following live in **contract storage** (not Redis, not frontend cache):

### Global (shared) — `rewardState`, pool, Token balances
| Storage | Type | Meaning | Why preserve |
|---------|------|---------|--------------|
| `rewardState.rewardRate` | `uint256` | MPGR per second emitted across all stakers | Determines future accrual; wrong rate under/overpays |
| `rewardState.periodFinish` | `uint256` | Unix time emission schedule ends (`block.timestamp + REWARDS_DURATION` after last `depositRewards` reset) | Defines freeze point for `lastTimeRewardApplicable()` |
| `rewardState.lastUpdateTime` | `uint256` | Last global checkpoint (`min(now, periodFinish)`) | Base for `rewardPerToken()` delta; incorrect value loses past accrual |
| `rewardState.rewardPerTokenStored` | `uint256` (1e18) | Cumulative reward-per-token checkpoint | Core of `earned()`; reset loses all pre-reset accrual |
| `totalStaked` | `uint256` | Sum of all `balanceOf` | Denominator for per-token math; must match sum of user balances and contract MPGR reserve minus reward pool |
| `rewardPoolBalance` | `uint256` | MPGR credited as rewards (incremented by `_pullRewardTokens`, decremented by `_payReward`) | Sole source of truth for payout solvency; not derivable from `balanceOf(token)` because pool holds principal + rewards |
| `currentAPRBps` | `uint256` | Target APR in bps (0 until first `setAPR`, then `INITIAL_APR_BPS` after `depositRewards` reset) | Determines stake-activation rate when `rate==0 && totalStaked was 0` |
| Contract’s MPGR token balance (`stakingToken.balanceOf(address(this))`) | off-contract ERC20 state | Should equal `totalStaked + rewardPoolBalance` (invariant `invariant_accountingCannotExceedTokenBalance` in tests) | Principal + rewards custody; mismatched migration bricks withdrawals |

### Per-user (per `address`) — must be preserved per holder
| Mapping | Type | Meaning |
|---------|------|---------|
| `balanceOf[account]` | `uint256` | User’s staked principal |
| `userRewardPerTokenPaid[account]` | `uint256` | User’s snapshot of `rewardPerTokenStored` at last `updateReward` |
| `rewards[account]` (`accruedRewards` in `staking-client.ts`) | `uint256` | Checkpointed but unclaimed rewards (`earned` — `balance * delta / 1e18`) |

`earned(account)` is a **view** computed as `RewardMath.earned(balanceOf[account], rewardPerToken(), userRewardPerTokenPaid[account], rewards[account])`; it is **not stored** except via those three inputs + global `rewardPerToken()`. Preserving the three per-user values + global `rewardState` + `totalStaked` exactly reproduces pending rewards.

### Derived / view-only (recomputed, not stored)
- `lastTimeRewardApplicable()` = `min(block.timestamp, periodFinish)` — derived from global.
- `rewardPerToken()` — recomputed from stored values + time delta.
- `earned()` — recomputed.
- Frontend caches (`stakingService` in-memory `Map`, `localStorage`) — **not** source of truth; browser is untrusted per `AGENTS.md`.

### What happens if any piece is wrong?
- `rewardPerTokenStored` too low / `lastUpdateTime` too new → **past accrual erased** (the bug). In reproduction, 24,999,999 MPGR lost.
- `totalStaked` mismatched → per-token division wrong, dust or overpay.
- `rewardPoolBalance` too low → `_payReward` reverts `InsufficientRewardBalance`; too high → allows paying from principal (but contract prevents principal drain only via accounting).
- Per-user `userRewardPerTokenPaid` / `rewards` reset → that user’s pending rewards zeroed or doubled.

---

## 7. Migration options WITHOUT executing them

All options are **analysis only**.

### A. New contract + user unstake/restake (voluntary, trustless)

**Mechanism:**
1. Deploy fixed `MPGRStaking` at new address (constructor args same `_mpgrToken`, new `_initialOwner`).
2. Old contract: `pause()` (blocks new stakes, not exits). Announce.
3. Users call `unstake()` / `exit()` on **old** contract to withdraw principal + claim pending rewards (both remain available while paused).
4. Users `approve` + `stake` principal into **new** contract.
5. Owner funds new `rewardPoolBalance` via `depositRewards()` (and/or `extendRewardSchedule`) to replicate old pool’s funded rewards, setting initial `rewardRate = amount / REWARDS_DURATION`, `periodFinish = now + 730 days`, `lastUpdateTime = now`.

**Preservation:** Old pending rewards **must be claimed before migrating** — `earned` is paid via `_payReward` on old contract. If a user restakes without claiming, their `rewards[account]` + `userRewardPerTokenPaid` on old contract are abandoned (no auto-forward). New contract starts with `rewardPerTokenStored = 0`, so new `earned` starts from zero.

**Safer variant:** Require `exit()` (unstake all + claim) as the migration step, not `unstake()` alone.

### B. New contract + admin migration function (does it exist?)

**Answer: No migration function exists in the deployed contract.**

- No `migrate`, `batchMigrate`, `importState`, `setUserBalance`, `setRewards` owner function.
- `recoverERC20` refuses staking token, so owner cannot pull users’ principal to forward.
- `_unstake` and `_payReward` are `internal` and only callable via user-signed `unstake`/`exit`/`claimRewards`; owner cannot move a user’s `balanceOf` or `rewards`.

**Hypothetical** if a new contract **added** a migration helper (not in current repo): an owner-only `migrateBatch(address[] users, uint256[] amountsPaidRewards)` that mints virtual stakes — but that would require **new code** on the new contract plus user approval to pull old principal (ERC20 `transferFrom` needs allowance). Even then, copying `userRewardPerTokenPaid`/`rewards` exactly is error-prone and would need an on-chain snapshot Merkle root.

**Current reality:** Option B **not available** without deploying a new contract that **adds** migration logic and without off-chain coordination to get allowances.

### C. Proxy / upgrade (is it applicable?)

**Not applicable.** Contract is not behind a proxy. No `ProxyAdmin`, no `TransparentUpgradeableProxy`, no `UUPS`/`Diamond`. Storage is at the implementation address itself. There is no `upgradeTo(address)` to point at fixed logic. Deploying a proxy now does **not** retroactively make the old address upgradeable.

**Theoretical:** One could deploy a **new proxy + new implementation** and treat it as Option A (new address). The old contract cannot be upgraded.

### D. Any safer existing mechanism

- **Pause + extend via `extendRewardSchedule` on old contract:** `extendRewardSchedule` already has `updateReward(address(0))` and preserves `leftover` (unemitted rewards). But the bug is in `depositRewards` after expiry. Using `extendRewardSchedule` instead of `depositRewards` for future funding **avoids** the buggy path if the old contract’s `periodFinish` is still in the future and `extendRewardSchedule` is used. However, once the schedule **has expired** (`block.timestamp >= periodFinish`) or `rate==0`, a funding call **must** go through the buggy `depositRewards` to reactivate — `extendRewardSchedule` when expired computes `newRewardRate = additionalReward / additionalDuration` (without leftover) and **also** checkpoints, so it could be a workaround. But this is **not** a fix; it relies on operators remembering to never call `depositRewards` — fragile.

- **Do nothing until expiry:** If `periodFinish` is far in the future (730 days from last `depositRewards`) and no one calls `depositRewards`, the bug never triggers. The schedule depletes and rewards stop accruing, but no loss occurs. Safe only if next funding is via `extendRewardSchedule` and team discipline holds.

- **No safer automatic mechanism exists.** No timelock, no multisig in code (though owner could be a multisig EOA externally — not verifiable here).

---

## 8. Risks of each option, especially loss/alteration of accrued rewards

### Common risk for all: accounting inconsistency
If global `rewardPerTokenStored` / `lastUpdateTime` and per-user `userRewardPerTokenPaid`/`rewards` diverge, `earned()` becomes wrong. Unlike a simple token balance, staking rewards are **derived** — a snapshot error is silent until claim.

### Option A — User unstake/restake

| Risk | Detail | Severity |
|------|--------|----------|
| **Forgetting to claim before unstaking** | `unstake` checkpoints `rewards[account] = earned()` but leaves it claimable. If user unstakes partial and then migrates only principal, their pending `rewards` stay on old contract. If they never call `claimRewards`/`exit`, rewards stranded forever (no owner rescue for MPGR). | **High** — direct loss, user error. Mitigate by **instructing `exit()`** and UI that forces claim. |
| **Front-running / timing** | Between snapshot (reading `totalStaked`, `rewardPerTokenStored`) and new deployment, new stakes/claims/exits on old contract change global `totalStaked` and `rewardPerTokenStored`. New contract’s initial `totalStaked=0` will not match old total. APR-based `stake` activation (`if rate==0 && currentAPRBps>0 && now<periodFinish`) will compute different `activatedRate` on new contract vs old. | Medium — new pool’s early APR math differs; not loss but different yield. |
| **Reward pool funding mismatch** | New `rewardPoolBalance` must be funded from owner’s MPGR. If funded too little, `InsufficientFundedRewards` reverts on first `setAPR` or `stake` activation (`newRewardRate * remaining > rewardPoolBalance`). Too much → owner over-allocates. Requires exact calculation `amount / REWARDS_DURATION` vs old `rewardRate`. | Medium — deployment revert or overfund. |
| **User action dependency** | Requires **every** staker to sign two txs (exit old, stake new) + approve. Users who don’t migrate keep funds in old contract forever. | High — participation <100% guaranteed. |
| **Gas cost** | Each user pays Base gas for exit + approve + stake (~150k gas for B20 approve workaround). | Low on Base (~$0.01) but UX friction. |
| **Paused unstake griefing** | Old contract paused still allows exit, but if owner or user loses private key, funds stuck. | Low (same as today). |

**Reward loss mechanism for A if done correctly (exit before migrate):** **Zero loss for rewards claimed.** New contract starts fresh; old pending is paid. If user does `exit()` atomically (unstake all + claim), their `earned` is fully paid. **If they only `unstake` without `claim`,** `rewards[account]` remains, must be claimed separately; otherwise stranded.

### Option B — Admin migration function (hypothetical; not currently possible)

| Risk | Detail | Severity |
|------|--------|----------|
| **No function** | Owner cannot move principal or rewards without user `transferFrom` allowance. Attempting `recoverERC20` for MPGR reverts `CannotRecoverStakingToken`. | **Blocker** — option unavailable. |
| **If new contract added migration:** Copying storage via `SSTORE` from off-chain snapshot risks off-by-one on `rewardPerTokenStored` (1e18 scaling) or `lastUpdateTime`. One wrong slot → all future `earned` wrong. | **Critical** — silent accounting bug worse than original. |
| **Centralization** | Migration function would be `onlyOwner` and could forge balances. Needs audit, multisig, timelock. Current `Ownable` single owner is not multisig (per `AGENTS.md` audit gap). | High |

### Option C — Proxy

| Risk | Detail |
|------|--------|
| **Impossible** | No proxy. Deploying a proxy now is just Option A with extra indirection. No storage migration, same risks. False sense of “upgrade” without state copy. |

### Option D — Workaround (`extendRewardSchedule` instead of `depositRewards`)

| Risk | Detail | Severity |
|------|--------|----------|
| **Fragile discipline** | Future operator must remember to never call `depositRewards` after expiry. One accidental `depositRewards` call triggers loss of all accrued since last global checkpoint. | **High** — human error. |
| **No fix for `rate==0` case** | If `setAPR` while `totalStaked==0` leaves `rate=0`, next `stake` activation creates rate, but old schedule still at `rate=0`. Next `depositRewards` after expiry still buggy. | Medium |
| **Not a code fix** | Leaves vulnerable bytecode on-chain forever; audit will still flag P0. | Medium |

**Quantified loss if bug triggered (from Task 2 repro):** With `500e18` staked, `25_000_000e18` / 730 days → `~396372399797057331` wei/sec, 30 days → ~1,027,397 MPGR earned; at expiry (730 days) → ~25,000,000 MPGR across full pool. A `depositRewards` after expiry without checkpoint **drops earned to 0** for that holder (full loss). In repro, `earned` went `24999999999999999980832000` → `0`.

---

## 9. Would the current frontend need a new contract address after deployment?

**Yes — absolutely.**

- **Single source:** `lib/chain/base.ts` hard-codes `MPGR_STAKING_ADDRESS`.
- **All staking reads/writes** (`stakingClient`, `stakingService`, hooks, `StakingCard`, `StakingStats`, `RewardHub`, `HolderScoreCard`) derive from that constant.
- **No env var override:** `.env.example`, `lib/wagmi.ts`, `vercel.json` have no `NEXT_PUBLIC_STAKING_ADDRESS`.
- **No dynamic registry:** No on-chain address registry, no ENS, no `getStakingAddress()` view.
- **Docs:** `WHITEPAPER-v2.md`, `lib/site.ts` list same address but are informational; the load-bearing change is `lib/chain/base.ts` → `MPGR_STAKING_ADDRESS`.
- **Build:** Next.js build inlines the address at compile time (webpack/Turbopack); a new deployment requires a **new Vercel build + deploy** after editing `lib/chain/base.ts`.

**Steps if redeployed:** edit `lib/chain/base.ts` (new address), update `docs/WHITEPAPER-v2.md` and `docs/ARCHITECTURE.md` tables, bump `RUN_ASSET_VERSION` if needed (not staking), push to `main`, Vercel auto-deploys. Old users with cached JS will refetch new address on next load (no localStorage persistence for staking address; `stakingService` is memory-only).

---

## 10. Proposed migration sequence — DO NOT EXECUTE

> **Read-only proposal. No transactions have been sent. Do not execute without approvals in §11.**

### Pre-conditions (verify, don’t act)
0. Confirm current `owner()` via Basescan `readContract` (or `cast call 0x1690C7b6d312284e30434d93498e56eE09fFa12c "owner()(address)" --rpc-url $BASE_RPC_URL`). Confirm `paused()`, `totalStaked()`, `rewardState()`, `rewardPoolBalance()`, and contract MPGR `balanceOf` vs `totalStaked+rewardPoolBalance`. Confirm latest `depositRewards` timestamp and `periodFinish`.
1. Off-chain snapshot: for every holder, read `balanceOf`, `userRewardPerTokenPaid`, `rewards` (accrued), and global `totalStaked`/`rewardState` at a **specific block** (pin block number). Export CSV + Merkle root for audit. Use `staking-history-reader.ts` + `getLogs` for full holder set; do not rely on frontend.
2. Decide **new owner** (ideally multisig per `AGENTS.md` future-proofing; currently not enforced).

### Deploy
3. Deploy **new** `MPGRStaking.sol` **with fix** (commit `15941ba`) to Base mainnet:
   ```bash
   # example — DO NOT RUN
   forge create contracts/MPGRStaking.sol:MPGRStaking \
     --rpc-url $BASE_RPC_URL --private-key $DEPLOYER_KEY \
     --constructor-args $MPGR_TOKEN_ADDRESS $NEW_OWNER_ADDRESS \
     --verify --etherscan-api-key $BASESCAN_KEY
   ```
   Record new address, tx hash, block, `RewardAdded` event.

### Verify
4. Verify new contract on Basescan, confirm `currentAPRBps`, `rewardState` (should be `rate=0, periodFinish=block.timestamp, lastUpdateTime=block.timestamp, stored=0` pre-funding).
5. Run `forge test -vvv` against **new** address (read views) and local fork.

### Fund new pool
6. Owner `approve` MPGR to new contract, then `depositRewards(25_000_000e18)` (or replicate old pool’s remaining funded amount; if old pool had `rewardPoolBalance` leftover, consider `rewardPoolBalance + leftover` calculation like `extendRewardSchedule`). This sets `rewardRate = amount / 730 days`, `periodFinish = now+730d`, `currentAPRBps = INITIAL_APR_BPS (2000)`. If matching old schedule’s remaining time is desired, use `extendRewardSchedule` arithmetic instead, but for a **fresh** pool `depositRewards` is correct.

### Frontend cutover (do not auto-pause old before announcement)
7. Update `lib/chain/base.ts` `MPGR_STAKING_ADDRESS` to **new** address, open PR, get review, merge to `main`, Vercel builds.
8. **Announce** to users: old pool `pause()`d (blocks new stakes), new pool live, instructions: **call `exit()` on old** (unstakes + claims), then `stake` on new. Provide Basescan links for both.
9. Old contract: `pause()` (owner). This does **not** force users out; it only prevents new stakes from diluting old accounting. Exits/claims remain open indefinitely.

### User action phase (weeks)
10. Users voluntarily `exit()` old → `stake` new. Monitor `totalStaked` on both. No admin can force migration (see §4d).

### Cleanup
11. Keep old contract **unpaused for exits forever** (or at least until `totalStaked==0` and `rewardPoolBalance` drained via claims). Do **not** `recoverERC20` MPGR (reverts). After empty, optionally `pause()` permanently.

---

## 11. Final answers

### Is redeployment definitely required?

**Yes — if the fix is desired on-chain, redeployment is definitely required.** The deployed contract at `0x1690C7b6d312284e30434d93498e56eE09fFa12c` is **immutable** (no proxy, no upgrade function, `Ownable` only). The bug is in **bytecode** (`depositRewards` missing `updateReward`). No in-place patch exists. The fix exists only on branch `arena/01a0bcad-mpgr-hub` (unmerged); `main` still has buggy code and production still serves the old address.

**Caveat:** “Definitely” is **repository-definite** (code is immutable). **On-chain bytecode was not directly fetched in this sandbox** (RPC blocked), but given single hard-coded address and no proxy, the logical conclusion is redeployment is the only path. A direct `eth_getCode` comparison on a network-accessible host would make this **cryptographically definite**; in this environment we state **verified from repo, unverified live-bytecode due to network**.

### Why?

- Solidity contract without proxy → bytecode immutable by EVM design.
- `Ownable`+`Pausable` ≠ upgradeable; no `UUPS`/`TransparentProxy`/`Diamond`.
- `depositRewards` fix is an extra `SLOAD`/`SSTORE` before `SSTORE` of `lastUpdateTime` — cannot be injected without新code.
- `recoverERC20` explicitly **cannot** rescue MPGR; no admin `migrate` hook to move state.

### What exact state must be preserved?

**Global:** `totalStaked`, `rewardPoolBalance` (funded pool), `rewardState` (`rewardRate`, `periodFinish`, `lastUpdateTime`, `rewardPerTokenStored`), `currentAPRBps`, and the **off-chain MPGR token balance** at the contract (`balanceOf(token) == totalStaked+rewardPoolBalance`).

**Per-user (each staker):** `balanceOf[account]`, `userRewardPerTokenPaid[account]`, `rewards[account]` (pending). `earned()` is derived; preserving those three + global reproduces pending exactly.

**If migrating:** New contract starts with `totalStaked=0`, `rewardPerTokenStored=0`. Old pending must be **claimed on old** before restake, or it is lost. No storage slot is automatically copied.

### What exact user action, if any, would be required?

Under Option A (the only viable option):
- **Required:** Each staker must send **`exit()`** (or `unstake`+`claimRewards`) on **old** contract to withdraw principal and claim pending MPGR, then `approve` + `stake` principal on **new** contract.
- **Not optional:** Owner cannot move a user’s `balanceOf` without their signature/allowance. Users who do **nothing** keep funds in old contract (still claimable/exitable, but no longer accrue after `periodFinish`).
- **Gas:** 2–3 txs per user on Base.

**No user action** is required if the team chooses **not to migrate** and instead does `pause()` + never calls `depositRewards` again, but then staking yield stops — not a migration.

### What production changes would be required?

1. **Smart contract:** Deploy fixed `MPGRStaking` → new Base address.
2. **Frontend:** Edit `lib/chain/base.ts` `MPGR_STAKING_ADDRESS`, update docs (`WHITEPAPER-v2.md`), commit to `main`, Vercel rebuild. No env var change.
3. **On-chain owner actions:** `pause()` old, `depositRewards()` new (fund), possibly `setAPR()` new.
4. **Operational:** Announcements, explorer verification, Basescan `owner()` confirmation, monitoring `totalStaked` both pools.

### What approvals are needed before proceeding?

- **Owner/admin approval:** Holder of `owner()` key for `0x1690…` (single `Ownable`; per `AGENTS.md` should be multisig but is not enforced in code — verify if owner is EOA or Safe on Basescan before any pause).
- **Team/DAO / maintainer review:** PR review for `lib/chain/base.ts` change + `docs/` updates; **do not merge Task 2 fix to main without this deployment analysis** (per `GENERAL RULES`).
- **Security/audit sign-off:** Per `docs/SECURITY_REMEDIATION.md` and `AUDIT_AND_REVIEW_2026-08.md`, production funding and external audit are still required before financial rewards; staking re-deployment is a financial contract change and should be included in that audit.
- **Community communication approval:** Clear user comms about required `exit()`/`stake` steps; no silent migration.
- **Treasury / token funding approval:** `depositRewards` on new contract needs 25,000,000 MPGR (or remaining pool amount) from treasury — finance approval.
- **Vercel / deployment approval:** `APP_ORIGIN` and production env unchanged, but Vercel deploy of new address needs maintainer merge.

---

## What could NOT be verified from repository/deployment data

Explicitly **unverified** in this sandbox due to network egress (`mainnet.base.org`/`basescan.org` `ECONNRESET`):

- Live on-chain `owner()` address (is it EOA, Safe multisig, timelock?)
- Live `totalStaked`, `rewardPoolBalance`, `balanceOf` per user, `rewardState` values, `periodFinish` vs `now`
- Live `paused()` status
- Actual deployed bytecode hash vs local `forge build` artifact (no `out/` available)
- Whether any off-chain deployment of fixed code to a different address has already happened out-of-band
- Token holder snapshot / allowance data

These require a host with Base RPC access:
```bash
cast call $STAKING "owner()(address)" --rpc-url $BASE_RPC_URL
cast call $STAKING "rewardState()(uint256,uint256,uint256,uint256)" --rpc-url $BASE_RPC_URL
cast call $STAKING "totalStaked()(uint256)" --rpc-url $BASE_RPC_URL
cast etherscan address $STAKING --chain base --etherscan-api-key $KEY
```

---

## Stop note

Analysis complete. **No contract deployed, paused, migrated, unstaked, or funded. No frontend address changed. No production config modified.** Awaiting explicit approval before any migration or Task 3.

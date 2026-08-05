// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMPGRStaking} from "./interfaces/IMPGRStaking.sol";
import {RewardMath} from "./libraries/RewardMath.sol";

/// @title MPGRStaking
/// @notice Single-sided MPGR staking pool. No lock term — rewards accrue
///         continuously and can be staked, claimed, or unstaked at any time.
/// @dev MILESTONE 1C — adds setAPR(), recoverERC20(), and
///      extendRewardSchedule() on top of Milestones 1A/1B. Every prior
///      function (constructor, modifiers, rewardPerToken(), earned(),
///      stake(), unstake(), claimRewards(), exit(), pause()/unpause()) is
///      unchanged. depositRewards() is behaviorally unchanged but now
///      calls a shared private helper — see file header note in the
///      accompanying response for why.
contract MPGRStaking is IMPGRStaking, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Immutable config ------------------------------------------------

    /// @notice The MPGR token, used for both staking and rewards.
    IERC20 public immutable stakingToken;

    /// @notice Reward-denominated token. Equal to stakingToken for this
    ///         pool (MPGR rewards MPGR), kept as a separate name/typed
    ///         reference so a future pool paying a different reward token
    ///         can reuse this same contract shape without renaming state.
    IERC20 public immutable rewardsToken;

    // --- Program constants -------------------------------------------------

    /// @notice Minimum amount of MPGR a single stake must meet (18 decimals).
    uint256 public constant MINIMUM_STAKE = 100e18;

    /// @notice Total length of the reward-emission schedule: 2 years.
    uint256 public constant REWARDS_DURATION = 730 days;

    /// @notice Total MPGR allocated to this pool's reward schedule (18 decimals).
    uint256 public constant REWARD_POOL = 25_000_000e18;

    /// @notice Informational reference APR (basis points) at launch,
    ///         assuming total staked matches the pool's designed baseline.
    ///         Superseded at runtime by `currentAPRBps` once setAPR() has
    ///         been called at least once. Kept for display/history only.
    uint256 public constant INITIAL_APR_BPS = 2_000; // 20.00%

    /// @notice Lower bound accepted by setAPR(): 1%.
    uint256 public constant MIN_APR_BPS = 100;

    /// @notice Upper bound accepted by setAPR(): 100%.
    uint256 public constant MAX_APR_BPS = 10_000;

    // --- Reward accounting state -------------------------------------------

    /// @notice Global reward-accrual checkpoint. See IMPGRStaking.RewardState.
    RewardState public rewardState;

    /// @notice Total MPGR currently staked across all users.
    uint256 public totalStaked;

    /// @notice MPGR currently staked per account.
    mapping(address account => uint256 amount) public balanceOf;

    /// @notice Cumulative reward-per-token already checkpointed per account,
    ///         used to compute only the *newly* accrued share on next update.
    mapping(address account => uint256 rewardPerTokenPaid) public userRewardPerTokenPaid;

    /// @notice Reward already checkpointed into storage per account but not
    ///         yet paid out via claimRewards().
    mapping(address account => uint256 owedReward) public rewards;

    /// @notice MPGR currently available in the reward pool to pay out.
    /// @dev Tracked independently of stakingToken.balanceOf(address(this))
    ///      because stakingToken == rewardsToken here: the contract's raw
    ///      token balance is principal + reward pool combined. Using raw
    ///      balanceOf() as the payout check would let rewards be paid out
    ///      of user principal. This is the sole source of truth for "is
    ///      there enough reward left to pay this claim" — incremented only
    ///      by depositRewards()/extendRewardSchedule(), decremented only
    ///      by _payReward(). Never moves in stake()/unstake().
    uint256 public rewardPoolBalance;

    /// @notice Currently configured target APR, in basis points. 0 until
    ///         setAPR() is called for the first time — before that, the
    ///         effective rewardRate is whatever the constructor set (which
    ///         corresponds to INITIAL_APR_BPS at the pool's designed
    ///         baseline totalStaked, per Milestone 1A's original design).
    uint256 public currentAPRBps;

    // --- Constructor (Milestone 1A — unchanged) -------------------------------

    /// @param _mpgrToken Address of the deployed MPGR ERC-20 token. Used as
    ///        both the staking token and the reward token.
    /// @param _initialOwner Address to receive ownership (pause/recovery rights).
    /// @dev Establishes the reward schedule immediately at deployment:
    ///      REWARD_POOL emitted linearly over REWARDS_DURATION starting now.
    ///      Does NOT pull any MPGR into the contract — depositRewards()/
    ///      extendRewardSchedule() fund rewardPoolBalance separately, and
    ///      staking principal only ever arrives via stake().
    constructor(address _mpgrToken, address _initialOwner) Ownable(_initialOwner) {
        if (_mpgrToken == address(0)) revert ZeroAddress();
        if (_initialOwner == address(0)) revert ZeroAddress();

        stakingToken = IERC20(_mpgrToken);
        rewardsToken = IERC20(_mpgrToken);

        uint256 rewardRate = REWARD_POOL / REWARDS_DURATION;
        uint256 periodFinish = block.timestamp + REWARDS_DURATION;

        rewardState = RewardState({
            rewardRate: rewardRate,
            periodFinish: periodFinish,
            lastUpdateTime: block.timestamp,
            rewardPerTokenStored: 0
        });

        emit RewardAdded(REWARD_POOL, rewardRate, periodFinish);
    }

    // --- Modifiers (Milestone 1A — unchanged) ---------------------------------

    /// @notice Checkpoints global reward accounting, and — if `account` is
    ///         not the zero address — checkpoints that account's owed
    ///         reward too, before the wrapped function runs.
    /// @dev Applied to stake(), unstake(), claimRewards(), exit(), and
    ///      (Milestone 1C) setAPR()/extendRewardSchedule() with
    ///      account = address(0), so a schedule/APR change checkpoints
    ///      global accrual up to this moment without touching any
    ///      individual user's reward mapping — existing accrued rewards
    ///      are never reset.
    modifier updateReward(address account) {
        rewardState.rewardPerTokenStored = rewardPerToken();
        rewardState.lastUpdateTime = lastTimeRewardApplicable();

        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardState.rewardPerTokenStored;
        }
        _;
    }

    /// @notice Reverts if `addr` is the zero address.
    modifier nonZeroAddress(address addr) {
        if (addr == address(0)) revert ZeroAddress();
        _;
    }

    // --- Reward calculation views (Milestone 1A — unchanged) -------------------

    /// @inheritdoc IMPGRStaking
    function lastTimeRewardApplicable() public view returns (uint256) {
        return RewardMath.lastTimeRewardApplicable(rewardState.periodFinish);
    }

    /// @inheritdoc IMPGRStaking
    function rewardPerToken() public view returns (uint256) {
        return RewardMath.rewardPerToken(
            rewardState.rewardPerTokenStored,
            rewardState.lastUpdateTime,
            lastTimeRewardApplicable(),
            rewardState.rewardRate,
            totalStaked
        );
    }

    /// @inheritdoc IMPGRStaking
    function earned(address account) public view returns (uint256) {
        return RewardMath.earned(
            balanceOf[account],
            rewardPerToken(),
            userRewardPerTokenPaid[account],
            rewards[account]
        );
    }

    // --- Mutating functions (Milestone 1B — unchanged) ------------------------

    /// @inheritdoc IMPGRStaking
    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (amount < MINIMUM_STAKE) revert BelowMinimumStake(amount, MINIMUM_STAKE);

        unchecked {
            totalStaked += amount;
            balanceOf[msg.sender] += amount;
        }

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        emit Staked(msg.sender, amount);
    }

    /// @inheritdoc IMPGRStaking
    function unstake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        _unstake(msg.sender, amount);
    }

    /// @inheritdoc IMPGRStaking
    function claimRewards() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward == 0) revert NoRewardToClaim();

        _payReward(msg.sender, reward);
    }

    /// @inheritdoc IMPGRStaking
    function exit() external nonReentrant updateReward(msg.sender) {
        uint256 staked = balanceOf[msg.sender];
        if (staked == 0) revert NothingStaked();

        _unstake(msg.sender, staked);

        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            _payReward(msg.sender, reward);
        }
    }

    /// @inheritdoc IMPGRStaking
    /// @dev Behavior, signature, modifiers, checks, and emitted event are
    ///      unchanged from Milestone 1B. Only the internal token-pull step
    ///      was extracted into `_pullRewardTokens()` so
    ///      extendRewardSchedule() (Milestone 1C) can reuse it instead of
    ///      duplicating it.
    function depositRewards(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();

        _pullRewardTokens(amount);

        emit RewardsDeposited(msg.sender, amount);
    }

    // --- Reward schedule & recovery (Milestone 1C) -----------------------------

    /// @inheritdoc IMPGRStaking
    /// @dev No nonReentrant needed: this function makes no external calls.
    ///      updateReward(address(0)) checkpoints all pending global accrual
    ///      at the *old* rewardRate before it changes, and — because the
    ///      account argument is address(0) — never touches any individual
    ///      user's `rewards`/`userRewardPerTokenPaid` entry, so no user's
    ///      already-accrued reward is reset or altered.
    function setAPR(uint256 newAPRBps) external onlyOwner updateReward(address(0)) {
        if (newAPRBps < MIN_APR_BPS || newAPRBps > MAX_APR_BPS) {
            revert InvalidAPR(newAPRBps, MIN_APR_BPS, MAX_APR_BPS);
        }

        uint256 oldAPRBps = currentAPRBps;
        // Re-derive rewardRate from the live pool size at the requested
        // APR. Deliberately allowed to compute to 0 when totalStaked == 0
        // (nothing is accruing anyway — RewardMath.rewardPerToken freezes
        // accrual whenever totalStaked is 0, so a 0 rate here is inert,
        // not corrupting).
        uint256 newRewardRate = (totalStaked * newAPRBps) / 10_000 / 365 days;

        currentAPRBps = newAPRBps;
        rewardState.rewardRate = newRewardRate;

        emit APRUpdated(oldAPRBps, newAPRBps, newRewardRate);
    }

    /// @inheritdoc IMPGRStaking
    /// @dev Follows the standard "preserve unemitted budget" top-up
    ///      pattern: any reward from the current schedule that hasn't been
    ///      emitted yet (`leftover`) is folded into the new rate rather
    ///      than discarded, so extending the schedule never shortchanges
    ///      stakers who were already accruing under the old rate.
    ///      updateReward(address(0)) checkpoints global accrual at the old
    ///      rate first, exactly as in setAPR(), so no existing accrued
    ///      reward is reset. Effects (rewardState) are finalized before
    ///      the token pull (interaction) runs, in addition to the
    ///      nonReentrant guard.
    function extendRewardSchedule(
        uint256 additionalReward,
        uint256 additionalDuration
    ) external onlyOwner nonReentrant updateReward(address(0)) {
        if (additionalReward == 0) revert ZeroAmount();
        if (additionalDuration == 0) revert ZeroDuration();

        uint256 currentPeriodFinish = rewardState.periodFinish;
        uint256 newRewardRate;

        if (block.timestamp >= currentPeriodFinish) {
            newRewardRate = additionalReward / additionalDuration;
        } else {
            uint256 remaining = currentPeriodFinish - block.timestamp;
            uint256 leftover = remaining * rewardState.rewardRate;
            newRewardRate = (additionalReward + leftover) / additionalDuration;
        }

        if (newRewardRate == 0) revert ZeroRewardRate();

        uint256 newPeriodFinish = block.timestamp + additionalDuration;
        if (newPeriodFinish < currentPeriodFinish) {
            revert RewardScheduleWouldShrink(newPeriodFinish, currentPeriodFinish);
        }

        rewardState.rewardRate = newRewardRate;
        rewardState.periodFinish = newPeriodFinish;

        _pullRewardTokens(additionalReward);

        emit RewardScheduleExtended(additionalReward, newRewardRate, newPeriodFinish);
    }

    /// @inheritdoc IMPGRStaking
    /// @dev token == address(stakingToken) is always rejected. Because
    ///      stakingToken == rewardsToken in this pool, every unit of MPGR
    ///      this contract ever holds is either user principal (tracked by
    ///      totalStaked/balanceOf) or reward-pool funds (tracked by
    ///      rewardPoolBalance) — there is no code path that produces
    ///      "accidental" MPGR distinguishable from those two, so recovery
    ///      of MPGR is disallowed entirely rather than attempting an
    ///      unsafe surplus calculation. nonReentrant guards against a
    ///      malicious `token` implementation reentering on transfer.
    function recoverERC20(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == address(stakingToken)) revert CannotRecoverStakingToken();

        IERC20(token).safeTransfer(owner(), amount);

        emit TokenRecovered(token, amount);
    }

    // --- Internal helpers --------------------------------------------------

    /// @dev Shared by unstake() and exit(). Caller must have already run
    ///      the updateReward(msg.sender) modifier this transaction.
    function _unstake(address account, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();

        uint256 staked = balanceOf[account];
        if (amount > staked) revert InsufficientStakedBalance(amount, staked);

        unchecked {
            balanceOf[account] = staked - amount;
            totalStaked -= amount;
        }

        stakingToken.safeTransfer(account, amount);

        emit Unstaked(account, amount);
    }

    /// @dev Shared by claimRewards() and exit(). Caller must have already
    ///      run the updateReward(msg.sender) modifier this transaction and
    ///      confirmed reward > 0 where relevant. Checks rewardPoolBalance
    ///      (not raw token balance) before paying out.
    function _payReward(address account, uint256 reward) internal {
        if (reward > rewardPoolBalance) {
            revert InsufficientRewardBalance(reward, rewardPoolBalance);
        }

        rewards[account] = 0;
        unchecked {
            rewardPoolBalance -= reward;
        }

        rewardsToken.safeTransfer(account, reward);

        emit RewardPaid(account, reward);
    }

    /// @dev Shared by depositRewards() (Milestone 1B) and
    ///      extendRewardSchedule() (Milestone 1C). Pulls `amount` MPGR
    ///      from msg.sender and credits it to rewardPoolBalance only —
    ///      never totalStaked/balanceOf. Callers are responsible for their
    ///      own event emission, since the two callers emit different,
    ///      semantically distinct events.
    function _pullRewardTokens(uint256 amount) private {
        rewardPoolBalance += amount;
        rewardsToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    // --- Owner controls (Milestone 1A — unchanged) ------------------------
    // No owner function anywhere in this contract — old or new — can move
    // stakingToken out of a user's balanceOf, out of totalStaked, or out of
    // rewardPoolBalance. recoverERC20() explicitly refuses the staking token.

    /// @notice Pauses new stake() calls. unstake()/claimRewards()/exit()
    ///         remain available regardless of pause state.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes stake().
    function unpause() external onlyOwner {
        _unpause();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMPGRStaking
/// @notice Interface for the MPGR single-sided staking rewards pool.
/// @dev MILESTONE 1C: adds APR management, ERC20 recovery, and reward
///      schedule extension to the surface established in Milestones 1A/1B.
///      Nothing below this milestone's additions was changed. The unused
///      `Recovered` event from Milestone 1A (never emitted anywhere) has
///      been retired in favor of `TokenRecovered`, which recoverERC20()
///      actually emits.
interface IMPGRStaking {
    // --- Structs -------------------------------------------------------

    /// @notice Global reward-accrual state for the pool, checkpointed on
    ///         every stake/unstake/claim/APR-change/schedule-extension and
    ///         readable at any time via rewardPerToken()/earned().
    /// @param rewardRate MPGR emitted per second, across all stakers combined.
    /// @param periodFinish Unix timestamp the current reward schedule ends.
    /// @param lastUpdateTime Unix timestamp reward accounting was last checkpointed.
    /// @param rewardPerTokenStored Cumulative reward per staked token, scaled by 1e18.
    struct RewardState {
        uint256 rewardRate;
        uint256 periodFinish;
        uint256 lastUpdateTime;
        uint256 rewardPerTokenStored;
    }

    // --- Events ----------------------------------------------------------

    /// @notice Emitted when a user stakes MPGR.
    event Staked(address indexed user, uint256 amount);

    /// @notice Emitted when a user withdraws staked MPGR.
    event Unstaked(address indexed user, uint256 amount);

    /// @notice Emitted when a user claims accrued MPGR rewards.
    event RewardPaid(address indexed user, uint256 reward);

    /// @notice Emitted once at deployment when the reward schedule is established.
    event RewardAdded(uint256 rewardPool, uint256 rewardRate, uint256 periodFinish);

    /// @notice Emitted when the owner funds the reward pool without changing the schedule.
    event RewardsDeposited(address indexed from, uint256 amount);

    /// @notice Emitted when the owner changes the target APR.
    /// @param oldAPRBps Previous APR in basis points.
    /// @param newAPRBps New APR in basis points.
    /// @param newRewardRate Recomputed MPGR-per-second rate resulting from the change.
    event APRUpdated(uint256 oldAPRBps, uint256 newAPRBps, uint256 newRewardRate);

    /// @notice Emitted when the owner tops up the reward pool and extends the schedule.
    /// @param additionalReward MPGR added to the reward pool in this call.
    /// @param newRewardRate Recomputed MPGR-per-second rate covering the extended schedule.
    /// @param newPeriodFinish New Unix timestamp the reward schedule ends.
    event RewardScheduleExtended(uint256 additionalReward, uint256 newRewardRate, uint256 newPeriodFinish);

    /// @notice Emitted when the owner recovers an accidental non-staking ERC20 token.
    event TokenRecovered(address indexed token, uint256 amount);

    // --- Errors ------------------------------------------------------------

    /// @notice Thrown when a required address argument is the zero address.
    error ZeroAddress();

    /// @notice Thrown when a required amount argument is zero.
    error ZeroAmount();

    /// @notice Thrown when a stake amount is below MINIMUM_STAKE.
    error BelowMinimumStake(uint256 amount, uint256 minimum);

    /// @notice Thrown when the contract does not hold enough reward-pool MPGR to cover a payout.
    error InsufficientRewardBalance(uint256 requested, uint256 available);

    /// @notice Thrown when an action requiring the current reward period to be over is attempted early.
    error RewardPeriodNotFinished(uint256 periodFinish);

    /// @notice Thrown when an unstake amount exceeds the caller's staked balance.
    error InsufficientStakedBalance(uint256 requested, uint256 available);

    /// @notice Thrown when exit() is called by an account with nothing staked.
    error NothingStaked();

    /// @notice Thrown when claimRewards() is called with zero reward accrued.
    error NoRewardToClaim();

    /// @notice Thrown when setAPR() is called with a value outside [MIN_APR_BPS, MAX_APR_BPS].
    error InvalidAPR(uint256 requested, uint256 minAllowed, uint256 maxAllowed);

    /// @notice Thrown when extendRewardSchedule() is called with a zero additional duration.
    error ZeroDuration();

    /// @notice Thrown when a schedule change would result in a zero MPGR-per-second rate.
    error ZeroRewardRate();

    /// @notice Thrown when extendRewardSchedule() would move periodFinish earlier than it currently is.
    error RewardScheduleWouldShrink(uint256 attemptedPeriodFinish, uint256 currentPeriodFinish);

    /// @notice Thrown when recoverERC20() is called with the MPGR staking/reward token.
    error CannotRecoverStakingToken();

    // --- Views (implemented in Milestone 1A) ---------------------------------

    /// @notice Total MPGR currently staked across all users.
    function totalStaked() external view returns (uint256);

    /// @notice MPGR currently staked by a given account.
    function balanceOf(address account) external view returns (uint256);

    /// @notice The lesser of now and the reward period end — the last
    ///         moment reward was actively accruing.
    function lastTimeRewardApplicable() external view returns (uint256);

    /// @notice Up-to-date cumulative reward per staked token (scaled by 1e18).
    function rewardPerToken() external view returns (uint256);

    /// @notice Total unclaimed MPGR reward owed to an account right now.
    function earned(address account) external view returns (uint256);

    /// @notice MPGR currently available in the reward pool to pay out.
    function rewardPoolBalance() external view returns (uint256);

    // --- Mutating functions (implemented in Milestone 1B) ---------------------

    /// @notice Stakes `amount` MPGR. Requires prior ERC20 approval.
    function stake(uint256 amount) external;

    /// @notice Withdraws `amount` of the caller's staked MPGR.
    function unstake(uint256 amount) external;

    /// @notice Claims the caller's currently accrued MPGR reward.
    function claimRewards() external;

    /// @notice Withdraws the caller's full staked balance and claims all accrued reward.
    function exit() external;

    /// @notice Owner-only: funds the reward pool with `amount` MPGR, without changing the schedule.
    function depositRewards(uint256 amount) external;

    // --- Reward schedule & recovery (implemented in Milestone 1C) --------------

    /// @notice Currently configured target APR, in basis points.
    function currentAPRBps() external view returns (uint256);

    /// @notice Owner-only: sets a new target APR and recomputes rewardRate
    ///         from live totalStaked. Checkpoints all pending reward
    ///         accrual first so no existing accrued reward is lost.
    function setAPR(uint256 newAPRBps) external;

    /// @notice Owner-only: adds `additionalReward` MPGR to the reward pool
    ///         and extends the schedule by `additionalDuration` seconds,
    ///         preserving any not-yet-emitted reward from the current
    ///         schedule rather than discarding it.
    function extendRewardSchedule(uint256 additionalReward, uint256 additionalDuration) external;

    /// @notice Owner-only: recovers `amount` of `token` accidentally sent
    ///         to this contract. Always reverts for the MPGR staking/reward
    ///         token, since this contract's MPGR balance is entirely user
    ///         principal and reward-pool funds — never "accidental".
    function recoverERC20(address token, uint256 amount) external;
}

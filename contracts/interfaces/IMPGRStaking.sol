// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMPGRStaking
/// @notice Interface for the MPGR single-sided staking rewards pool.
/// @dev MILESTONE 1B: adds stake(), unstake(), claimRewards(), exit(), and
///      depositRewards() to the view/accounting surface established in
///      Milestone 1A. Nothing below this milestone's additions was changed.
interface IMPGRStaking {
    // --- Structs -------------------------------------------------------

    /// @notice Global reward-accrual state for the pool, checkpointed on
    ///         every stake/unstake/claim and readable at any time via
    ///         rewardPerToken()/earned().
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

    /// @notice Emitted when the owner funds the reward pool.
    event RewardsDeposited(address indexed from, uint256 amount);

    /// @notice Emitted if the owner recovers a non-staking token accidentally sent to the contract.
    event Recovered(address indexed token, uint256 amount);

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
    /// @dev Tracked separately from the contract's raw token balance
    ///      because stakingToken and rewardsToken are the same MPGR
    ///      contract — raw balanceOf(address(this)) would conflate staked
    ///      principal with reward-pool funds.
    function rewardPoolBalance() external view returns (uint256);

    // --- Mutating functions (implemented in Milestone 1B) ---------------------

    /// @notice Stakes `amount` MPGR. Requires prior ERC20 approval.
    /// @dev Reverts below MINIMUM_STAKE. No maximum.
    function stake(uint256 amount) external;

    /// @notice Withdraws `amount` of the caller's staked MPGR.
    /// @dev No lock period — callable any time, including while paused.
    function unstake(uint256 amount) external;

    /// @notice Claims the caller's currently accrued MPGR reward.
    /// @dev No lock period — callable any time, including while paused.
    function claimRewards() external;

    /// @notice Withdraws the caller's full staked balance and claims all
    ///         accrued reward in a single transaction.
    function exit() external;

    /// @notice Owner-only: funds the reward pool with `amount` MPGR.
    /// @dev Pulled from msg.sender via SafeERC20; never touches user principal.
    function depositRewards(uint256 amount) external;
}

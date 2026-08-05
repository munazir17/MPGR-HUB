// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMPGRStaking
/// @notice Interface for the MPGR single-sided staking rewards pool.
/// @dev MILESTONE 1 SCOPE: this interface declares only the struct, events,
///      errors, and view/accounting functions implemented as of Milestone 1.
///
///      stake(), unstake(), claimRewards(), and exit() are intentionally
///      NOT declared here. They land in Milestone 1B alongside their
///      implementations in MPGRStaking.sol. Declaring unimplemented
///      functions on this interface now would force MPGRStaking to either
///      implement them early (out of scope for this milestone) or be
///      declared `abstract` (which would fail "must compile as a concrete,
///      deployable contract"). Extend this interface, not the contract,
///      when Milestone 1B lands.
interface IMPGRStaking {
    // --- Structs -------------------------------------------------------

    /// @notice Global reward-accrual state for the pool, checkpointed on
    ///         every stake/unstake/claim (once those exist) and readable
    ///         at any time via rewardPerToken()/earned().
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

    /// @notice Emitted when a user stakes MPGR. (Emitted starting Milestone 1B.)
    event Staked(address indexed user, uint256 amount);

    /// @notice Emitted when a user withdraws staked MPGR. (Emitted starting Milestone 1B.)
    event Unstaked(address indexed user, uint256 amount);

    /// @notice Emitted when a user claims accrued MPGR rewards. (Emitted starting Milestone 1B.)
    event RewardPaid(address indexed user, uint256 reward);

    /// @notice Emitted once at deployment when the reward schedule is established.
    event RewardAdded(uint256 rewardPool, uint256 rewardRate, uint256 periodFinish);

    /// @notice Emitted if the owner recovers a non-staking token accidentally sent to the contract.
    event Recovered(address indexed token, uint256 amount);

    // --- Errors ------------------------------------------------------------

    /// @notice Thrown when a required address argument is the zero address.
    error ZeroAddress();

    /// @notice Thrown when a required amount argument is zero.
    error ZeroAmount();

    /// @notice Thrown when a stake amount is below MINIMUM_STAKE.
    error BelowMinimumStake(uint256 amount, uint256 minimum);

    /// @notice Thrown when the contract does not hold enough MPGR to cover a reward payout.
    error InsufficientRewardBalance(uint256 requested, uint256 available);

    /// @notice Thrown when an action requiring the current reward period to be over is attempted early.
    error RewardPeriodNotFinished(uint256 periodFinish);

    // --- Views (implemented in Milestone 1) ---------------------------------

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
}

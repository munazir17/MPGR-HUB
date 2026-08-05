// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RewardMath
/// @notice Pure/view reward-accrual math shared by MPGRStaking.
/// @dev Implements the standard cumulative reward-per-token accrual model
///      (as popularized by Synthetix StakingRewards). All monetary values
///      are 18-decimal fixed point, matching the MPGR token's decimals.
///      Kept as a library (not inlined in the contract) so the accrual
///      formulas can be unit-tested in isolation and reused if a second
///      staking pool is ever deployed.
library RewardMath {
    /// @dev Fixed-point scaling factor used for rewardPerToken accounting.
    uint256 internal constant PRECISION = 1e18;

    /// @notice Returns the lesser of the current block timestamp and the
    ///         reward period's end — the last moment reward was actively
    ///         accruing.
    /// @param periodFinish Timestamp the current reward schedule ends.
    function lastTimeRewardApplicable(uint256 periodFinish) internal view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    /// @notice Computes the up-to-date cumulative reward-per-token value.
    /// @dev If nothing is staked, reward accrual is frozen (returns the
    ///      stored value unchanged) rather than accruing into a void —
    ///      this prevents reward tokens from being silently lost while
    ///      totalStaked is zero.
    /// @param rewardPerTokenStored Last checkpointed cumulative reward per token.
    /// @param lastUpdateTime Timestamp accounting was last checkpointed.
    /// @param lastApplicableTime Result of lastTimeRewardApplicable() for the current call.
    /// @param rewardRate MPGR emitted per second, across all stakers.
    /// @param totalStaked Total MPGR currently staked in the pool.
    function rewardPerToken(
        uint256 rewardPerTokenStored,
        uint256 lastUpdateTime,
        uint256 lastApplicableTime,
        uint256 rewardRate,
        uint256 totalStaked
    ) internal pure returns (uint256) {
        if (totalStaked == 0) {
            return rewardPerTokenStored;
        }

        uint256 timeElapsed = lastApplicableTime - lastUpdateTime;
        return rewardPerTokenStored + (timeElapsed * rewardRate * PRECISION) / totalStaked;
    }

    /// @notice Computes total unclaimed reward owed to an account.
    /// @param balance Account's currently staked MPGR balance.
    /// @param currentRewardPerToken Result of rewardPerToken() for the current call.
    /// @param userRewardPerTokenPaid Cumulative reward-per-token already checkpointed for this account.
    /// @param accruedRewards Reward already checkpointed into storage for this account but not yet claimed.
    function earned(
        uint256 balance,
        uint256 currentRewardPerToken,
        uint256 userRewardPerTokenPaid,
        uint256 accruedRewards
    ) internal pure returns (uint256) {
        uint256 delta = currentRewardPerToken - userRewardPerTokenPaid;
        return (balance * delta) / PRECISION + accruedRewards;
    }
}

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
/// @notice Single-sided MPGR staking pool. Stakers lock no fixed term —
///         rewards accrue continuously and (once Milestone 1B lands) can
///         be claimed or unstaked at any time.
/// @dev MILESTONE 1 SCOPE — this contract currently implements only:
///        imports, storage, custom errors, events, structs, constructor,
///        modifiers, reward-calculation helpers, the updateReward
///        modifier, rewardPerToken(), and earned().
///      stake(), unstake(), claimRewards(), and exit() are NOT implemented
///      yet and are deliberately absent — they arrive in Milestone 1B.
///      The contract compiles and is deployable as-is; it simply has no
///      way to move tokens until Milestone 1B adds those functions.
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
    ///         NOT used in reward math — actual realized APR is a function
    ///         of rewardRate and totalStaked at any given moment, and
    ///         moves dynamically as stakers enter/exit. Kept on-chain
    ///         purely for front-end/display reference.
    uint256 public constant INITIAL_APR_BPS = 2_000; // 20.00%

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

    // --- Constructor ---------------------------------------------------------

    /// @param _mpgrToken Address of the deployed MPGR ERC-20 token. Used as
    ///        both the staking token and the reward token.
    /// @param _initialOwner Address to receive ownership (pause/recovery rights).
    /// @dev Establishes the reward schedule immediately at deployment:
    ///      REWARD_POOL emitted linearly over REWARDS_DURATION starting now.
    ///      This contract does NOT pull REWARD_POOL tokens into itself in
    ///      the constructor — funding the pool with the actual 25,000,000
    ///      MPGR (via a dedicated funding function, using SafeERC20) is
    ///      Milestone 1B scope, alongside stake()/claimRewards(). Until
    ///      funded, earned()/rewardPerToken() will compute correctly but
    ///      any payout would be unbacked — Milestone 1B's claim path must
    ///      check contract balance before paying out.
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

    // --- Modifiers -----------------------------------------------------------

    /// @notice Checkpoints global reward accounting, and — if `account` is
    ///         not the zero address — checkpoints that account's owed
    ///         reward too, before the wrapped function runs.
    /// @dev Applied to stake(), unstake(), claimRewards(), and exit() once
    ///      those land in Milestone 1B. Not applied to anything in this
    ///      milestone since none of those functions exist yet; included
    ///      now because it is itself one of this milestone's required
    ///      deliverables (the accrual checkpoint logic reward math depends
    ///      on).
    modifier updateReward(address account) {
        rewardState.rewardPerTokenStored = rewardPerToken();
        rewardState.lastUpdateTime = lastTimeRewardApplicable();

        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardState.rewardPerTokenStored;
        }
        _;
    }

    /// @notice Reverts if `addr` is the zero address. Reused by Milestone
    ///         1B's stake()/unstake() argument validation.
    modifier nonZeroAddress(address addr) {
        if (addr == address(0)) revert ZeroAddress();
        _;
    }

    // --- Reward calculation views --------------------------------------------

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

    // --- Owner controls (pause/unpause) --------------------------------------
    // Included because Pausable is a required dependency for this milestone;
    // without an exposed switch it would be dead weight. Not in the excluded
    // function list (stake/unstake/claimRewards/exit).

    /// @notice Pauses stake/unstake/claim actions once they exist in Milestone 1B.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes stake/unstake/claim actions.
    function unpause() external onlyOwner {
        _unpause();
    }
}

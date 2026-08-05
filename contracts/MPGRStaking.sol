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
/// @dev MILESTONE 1B — adds stake(), unstake(), claimRewards(), exit(), and
///      depositRewards() on top of Milestone 1A's accounting core. Every
///      Milestone 1A function (constructor, modifiers, rewardPerToken(),
///      earned(), pause()/unpause()) is unchanged.
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

    /// @notice MPGR currently available in the reward pool to pay out.
    /// @dev Tracked independently of stakingToken.balanceOf(address(this))
    ///      because stakingToken == rewardsToken here: the contract's raw
    ///      token balance is principal + reward pool combined. Using raw
    ///      balanceOf() as the payout check would let rewards be paid out
    ///      of user principal, and would let large stakes fake reward-pool
    ///      solvency. This variable is the sole source of truth for "is
    ///      there enough reward left to pay this claim" and is the only
    ///      thing depositRewards() increments / _payReward() decrements —
    ///      it never moves in stake()/unstake().
    uint256 public rewardPoolBalance;

    // --- Constructor (Milestone 1A — unchanged) -------------------------------

    /// @param _mpgrToken Address of the deployed MPGR ERC-20 token. Used as
    ///        both the staking token and the reward token.
    /// @param _initialOwner Address to receive ownership (pause/recovery rights).
    /// @dev Establishes the reward schedule immediately at deployment:
    ///      REWARD_POOL emitted linearly over REWARDS_DURATION starting now.
    ///      Does NOT pull any MPGR into the contract — depositRewards()
    ///      (Milestone 1B) funds rewardPoolBalance separately, and staking
    ///      principal only ever arrives via stake().
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
    /// @dev Applied to stake(), unstake(), claimRewards(), and exit().
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

    // --- Mutating functions (Milestone 1B) ------------------------------------

    /// @inheritdoc IMPGRStaking
    /// @dev whenNotPaused applies here only. Pausing stake() lets the owner
    ///      stop new inflows in an emergency without ever blocking a
    ///      user's ability to unstake or claim what they're already owed —
    ///      matching the "claim anytime / unstake anytime" design and
    ///      avoiding a pause path that could trap user funds.
    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (amount < MINIMUM_STAKE) revert BelowMinimumStake(amount, MINIMUM_STAKE);

        unchecked {
            // Safe: totalStaked and balanceOf only ever grow by `amount`
            // added here, both bounded well below uint256 max for any
            // realistic MPGR supply.
            totalStaked += amount;
            balanceOf[msg.sender] += amount;
        }

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        emit Staked(msg.sender, amount);
    }

    /// @inheritdoc IMPGRStaking
    /// @dev Deliberately NOT whenNotPaused — principal withdrawal must
    ///      always be available to users regardless of pause state.
    function unstake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        _unstake(msg.sender, amount);
    }

    /// @inheritdoc IMPGRStaking
    /// @dev Deliberately NOT whenNotPaused, matching unstake().
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
    /// @dev Increases rewardPoolBalance only — never touches totalStaked
    ///      or any user's balanceOf, so this can never be mistaken for (or
    ///      abused as) a path that affects staked principal.
    function depositRewards(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();

        rewardPoolBalance += amount;

        rewardsToken.safeTransferFrom(msg.sender, address(this), amount);

        emit RewardsDeposited(msg.sender, amount);
    }

    // --- Internal helpers --------------------------------------------------

    /// @dev Shared by unstake() and exit(). Caller must have already run
    ///      the updateReward(msg.sender) modifier this transaction.
    function _unstake(address account, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();

        uint256 staked = balanceOf[account];
        if (amount > staked) revert InsufficientStakedBalance(amount, staked);

        unchecked {
            // Safe: amount <= staked <= totalStaked is the pool's
            // standing invariant (totalStaked is the sum of all
            // balanceOf[*], and we just checked amount <= balanceOf[account]).
            balanceOf[account] = staked - amount;
            totalStaked -= amount;
        }

        stakingToken.safeTransfer(account, amount);

        emit Unstaked(account, amount);
    }

    /// @dev Shared by claimRewards() and exit(). Caller must have already
    ///      run the updateReward(msg.sender) modifier this transaction and
    ///      confirmed reward > 0 where relevant. Checks rewardPoolBalance
    ///      (not raw token balance) before paying out, per contract-level
    ///      invariant that rewardPoolBalance is the sole reward solvency
    ///      source of truth.
    function _payReward(address account, uint256 reward) internal {
        if (reward > rewardPoolBalance) {
            revert InsufficientRewardBalance(reward, rewardPoolBalance);
        }

        rewards[account] = 0;
        unchecked {
            // Safe: reward <= rewardPoolBalance was just checked above.
            rewardPoolBalance -= reward;
        }

        rewardsToken.safeTransfer(account, reward);

        emit RewardPaid(account, reward);
    }

    // --- Owner controls (Milestone 1A — unchanged) ------------------------
    // No owner function anywhere in this contract can move stakingToken out
    // of a user's balanceOf or out of totalStaked — pause()/unpause() only
    // gate stake(), and depositRewards() only ever adds to rewardPoolBalance.

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

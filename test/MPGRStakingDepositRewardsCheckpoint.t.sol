// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MPGRStaking} from "../contracts/MPGRStaking.sol";
import {IMPGRStaking} from "../contracts/interfaces/IMPGRStaking.sol";

contract MockMPGRCheckpoint is ERC20 {
    constructor() ERC20("MPGR", "MPGR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Regression tests for depositRewards missing checkpoint bug.
/// @dev Each test documents the exact scenario that lost rewards before the fix:
///      stake, let period end without interaction, depositRewards, check earned().
///      Before fix, lastUpdateTime was reset to block.timestamp without first
///      checkpointing rewardPerTokenStored, so accrued rewards were discarded.
contract MPGRStakingDepositRewardsCheckpointTest is Test {
    MockMPGRCheckpoint token;
    MPGRStaking staking;
    address owner = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        token = new MockMPGRCheckpoint();
        staking = new MPGRStaking(address(token), owner);
        token.mint(owner, 50_000_000e18);
        token.mint(alice, 10_000e18);
        token.mint(bob, 10_000e18);
        vm.startPrank(owner);
        token.approve(address(staking), type(uint256).max);
        staking.depositRewards(25_000_000e18);
        vm.stopPrank();
        vm.startPrank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        token.approve(address(staking), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice Core bug: stake, let period expire, depositRewards, earned() should be preserved.
    /// @dev Before fix, earned() would drop to near zero after depositRewards.
    function testDepositRewardsPreservesAccruedWhenPeriodExpired() public {
        // Alice stakes early in the schedule
        vm.prank(alice);
        staking.stake(500e18);

        // Warp to just before expiry and record earned
        uint256 periodFinish;
        ( , periodFinish, ,) = staking.rewardState();
        vm.warp(periodFinish - 1 days);
        uint256 earnedBeforeExpiry = staking.earned(alice);
        assertGt(earnedBeforeExpiry, 0, "should have accrued before expiry");

        // Warp past expiry without any interaction (no claim/stake/unstake)
        vm.warp(periodFinish + 10 days);
        uint256 earnedAtExpiry = staking.earned(alice);
        // Accrual freezes at periodFinish, so earned should be same as at expiry
        assertGe(earnedAtExpiry, earnedBeforeExpiry, "accrual should freeze at periodFinish");
        assertGt(earnedAtExpiry, 0, "still should have rewards");

        // Capture global state before re-funding
        (uint256 rptStoredBefore, , ,) = staking.rewardState();
        uint256 earnedBeforeDeposit = staking.earned(alice);

        // Owner re-funds via depositRewards (REWARDS_DURATION-based model)
        vm.startPrank(owner);
        token.approve(address(staking), type(uint256).max);
        staking.depositRewards(1_000_000e18);
        vm.stopPrank();

        uint256 earnedAfterDeposit = staking.earned(alice);
        // With checkpoint, earned must not decrease
        assertEq(earnedAfterDeposit, earnedBeforeDeposit, "depositRewards must not lose accrued rewards");

        // rewardPerTokenStored should have been checkpointed to include expired accrual
        (uint256 rptStoredAfter, , ,) = staking.rewardState();
        assertGe(rptStoredAfter, rptStoredBefore, "rewardPerTokenStored must not reset");

        // Alice should be able to claim the preserved amount
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        vm.prank(alice);
        staking.claimRewards();
        uint256 aliceBalanceAfter = token.balanceOf(alice);
        assertEq(aliceBalanceAfter - aliceBalanceBefore, earnedAfterDeposit, "claim should pay preserved rewards");
    }

    /// @notice When rewardRate is 0 (e.g., setAPR with zero stakers) and then reactivated,
    ///         depositRewards after expiry must still preserve accrual.
    function testDepositRewardsAfterZeroRateReactivationPreservesAccrued() public {
        // Fresh deployment scenario: setAPR while nobody staked makes rate 0
        // Use a fresh staking instance to isolate
        MockMPGRCheckpoint freshToken = new MockMPGRCheckpoint();
        MPGRStaking fresh = new MPGRStaking(address(freshToken), owner);
        freshToken.mint(owner, 50_000_000e18);
        freshToken.mint(alice, 5_000e18);
        vm.startPrank(owner);
        freshToken.approve(address(fresh), type(uint256).max);
        fresh.depositRewards(10_000_000e18);
        // Now setAPR while zero stakers => rate becomes 0 but currentAPRBps set
        fresh.setAPR(1_500);
        (uint256 rateZero, , ,) = fresh.rewardState();
        assertEq(rateZero, 0, "rate should be 0 when no stakers");
        vm.stopPrank();

        // First stake activates the APR-based rate via stake()'s activation logic
        vm.startPrank(alice);
        freshToken.approve(address(fresh), type(uint256).max);
        fresh.stake(500e18);
        vm.stopPrank();
        (uint256 rateAfterStake, , ,) = fresh.rewardState();
        assertGt(rateAfterStake, 0, "stake should activate configured APR");
        uint256 stakeAmt = 500e18;
        uint256 expectedRate = (stakeAmt * 1_500) / 10_000 / 365 days;
        assertEq(rateAfterStake, expectedRate, "activated rate must match APR formula");

        // Accrue, then expire
        (, uint256 finish, ,) = fresh.rewardState();
        vm.warp(finish - 1);
        uint256 earnedBefore = fresh.earned(alice);
        assertGt(earnedBefore, 0);

        vm.warp(finish + 5 days);
        uint256 earnedAtExpiry = fresh.earned(alice);
        assertGe(earnedAtExpiry, earnedBefore);

        // Re-fund via depositRewards (DURATION model) - must preserve
        vm.startPrank(owner);
        freshToken.approve(address(fresh), type(uint256).max);
        fresh.depositRewards(1_000_000e18);
        vm.stopPrank();

        uint256 earnedAfter = fresh.earned(alice);
        assertEq(earnedAfter, earnedAtExpiry, "zero-rate reactivation: deposit must preserve");

        // After deposit, rate should be DURATION-based and currentAPRBps reset to INITIAL
        (uint256 newRate, , ,) = fresh.rewardState();
        uint256 depAmt = 1_000_000e18;
        uint256 expectedDurRate = depAmt / 730 days;
        assertEq(newRate, expectedDurRate, "depositRewards uses DURATION model");
        assertEq(fresh.currentAPRBps(), fresh.INITIAL_APR_BPS(), "APR resets to INITIAL after DURATION deposit");
    }

    /// @notice setAPR (APR model) then depositRewards (DURATION model) staying consistent.
    function testSetAPRThenDepositRewardsPreservesAndModelsConsistent() public {
        vm.prank(alice);
        staking.stake(1_000e18);

        // APR model
        vm.prank(owner);
        staking.setAPR(2_500); // 25%
        (uint256 rateAPR, , ,) = staking.rewardState();
        uint256 stake1000 = 1_000e18;
        uint256 expectedAPRRate = (stake1000 * 2_500) / 10_000 / 365 days;
        assertEq(rateAPR, expectedAPRRate, "setAPR rate must follow APR formula");
        assertEq(staking.currentAPRBps(), 2_500);

        vm.warp(block.timestamp + 30 days);
        uint256 earnedAfterAPR = staking.earned(alice);
        assertGt(earnedAfterAPR, 0);

        // Warp to expiry
        (, uint256 finish, ,) = staking.rewardState();
        vm.warp(finish + 1 days);
        uint256 earnedAtExpiry = staking.earned(alice);
        assertGe(earnedAtExpiry, earnedAfterAPR);

        // DURATION model via depositRewards
        vm.startPrank(owner);
        token.approve(address(staking), type(uint256).max);
        staking.depositRewards(2_000_000e18);
        vm.stopPrank();

        uint256 earnedAfterDeposit = staking.earned(alice);
        assertEq(earnedAfterDeposit, earnedAtExpiry, "setAPR->depositRewards must preserve");

        (uint256 rateDuration, uint256 newFinish, ,) = staking.rewardState();
        uint256 dep2M = 2_000_000e18;
        uint256 expectedRateDuration = dep2M / 730 days;
        assertEq(rateDuration, expectedRateDuration, "depositRewards rate follows DURATION model");
        assertGt(newFinish, finish, "new finish must be later");
        assertEq(staking.currentAPRBps(), staking.INITIAL_APR_BPS(), "APR resets after duration deposit");

        // Warp further and ensure new accrual continues at new rate
        vm.warp(block.timestamp + 10 days);
        uint256 earnedLater = staking.earned(alice);
        assertGt(earnedLater, earnedAfterDeposit, "accrual should continue at new rate");
        uint256 actualAdditional = earnedLater - earnedAfterDeposit;
        // Allow small rounding (PRECISION 1e18)
        assertApproxEqAbs(actualAdditional, rateDuration * 10 days, 1e12, "new accrual approx rate*delta");
    }

    /// @notice Both rate models staying consistent across multiple switches.
    function testBothRateModelsConsistentAcrossSwitches() public {
        vm.prank(alice);
        staking.stake(500e18);

        // Start DURATION model (already from setUp)
        (uint256 initRate, , ,) = staking.rewardState();
        uint256 initAmt = 25_000_000e18;
        uint256 expectedInitRate = initAmt / 730 days;
        assertEq(initRate, expectedInitRate);

        // Switch to APR model
        vm.prank(owner);
        staking.setAPR(3_000); // 30%
        (uint256 aprRate1, , ,) = staking.rewardState();
        uint256 stake500 = 500e18;
        uint256 expected1 = (stake500 * 3_000) / 10_000 / 365 days;
        assertEq(aprRate1, expected1);

        vm.warp(block.timestamp + 15 days);
        uint256 earned1 = staking.earned(alice);
        assertGt(earned1, 0);

        // Switch back to APR different value - should checkpoint and not lose
        vm.prank(owner);
        staking.setAPR(1_000); // 10%
        uint256 earnedAfterSetAPR = staking.earned(alice);
        assertEq(earnedAfterSetAPR, earned1, "setAPR must preserve earned via checkpoint (baseline)");

        (uint256 aprRate2, , ,) = staking.rewardState();
        uint256 expected2 = (stake500 * 1_000) / 10_000 / 365 days;
        assertEq(aprRate2, expected2);

        // Let period expire then depositRewards (DURATION)
        (, uint256 finish, ,) = staking.rewardState();
        vm.warp(finish + 2 days);
        uint256 earnedAtExpiry = staking.earned(alice);
        assertGe(earnedAtExpiry, earnedAfterSetAPR);

        vm.startPrank(owner);
        token.approve(address(staking), type(uint256).max);
        staking.depositRewards(730_000e18); // 730k over 730 days => 1000e18 per day
        vm.stopPrank();

        uint256 earnedAfterDuration = staking.earned(alice);
        assertEq(earnedAfterDuration, earnedAtExpiry, "duration deposit must preserve across model switches");

        (uint256 durationRate, , ,) = staking.rewardState();
        uint256 dep730k = 730_000e18;
        uint256 expectedDur730 = dep730k / 730 days;
        assertEq(durationRate, expectedDur730);
    }

    /// @notice Deposit when period NOT expired should not reset schedule, just fund pool and checkpoint.
    function testDepositRewardsWhenPeriodNotExpiredDoesNotResetSchedule() public {
        vm.prank(alice);
        staking.stake(500e18);

        (, uint256 finishBefore, uint256 lastUpdateBefore, uint256 rptBefore) = staking.rewardState();
        uint256 earnedBefore = staking.earned(alice);

        vm.warp(block.timestamp + 30 days);
        uint256 earnedAfterWarp = staking.earned(alice);
        assertGt(earnedAfterWarp, earnedBefore);

        uint256 balanceBefore = staking.rewardPoolBalance();

        // Deposit while period still active - should NOT reset rate/finish
        vm.startPrank(owner);
        token.approve(address(staking), type(uint256).max);
        staking.depositRewards(1_000_000e18);
        vm.stopPrank();

        (, uint256 finishAfter, uint256 lastUpdateAfter, uint256 rptAfter) = staking.rewardState();
        assertEq(finishAfter, finishBefore, "finish should not change when depositing mid-period");
        // rate should stay same (since not resetting)
        (uint256 rateAfter, , ,) = staking.rewardState();
        uint256 depInitAmt = 25_000_000e18;
        uint256 expectedMidRate = depInitAmt / 730 days;
        assertEq(rateAfter, expectedMidRate, "rate should not change mid-period");

        // Checkpoint should have updated rpt and lastUpdate
        assertGe(rptAfter, rptBefore, "rpt should checkpoint");
        assertGe(lastUpdateAfter, lastUpdateBefore, "lastUpdate should checkpoint");

        uint256 earnedAfterDeposit = staking.earned(alice);
        // Earned should be preserved (checkpointed) and not lost, should be >= earnedAfterWarp
        assertGe(earnedAfterDeposit, earnedAfterWarp, "earned must not decrease on mid-period deposit");
        assertEq(staking.rewardPoolBalance(), balanceBefore + 1_000_000e18, "pool balance should increase");
    }

    /// @notice Multiple stakers: depositRewards must preserve all users' earned.
    function testDepositRewardsPreservesForMultipleStakers() public {
        vm.prank(alice);
        staking.stake(500e18);
        vm.prank(bob);
        staking.stake(500e18);

        vm.warp(block.timestamp + 60 days);
        uint256 earnedAliceBefore = staking.earned(alice);
        uint256 earnedBobBefore = staking.earned(bob);
        assertGt(earnedAliceBefore, 0);
        assertEq(earnedAliceBefore, earnedBobBefore, "equal stakes should earn equally");

        (, uint256 finish, ,) = staking.rewardState();
        vm.warp(finish + 5 days);
        uint256 earnedAliceAtExpiry = staking.earned(alice);
        uint256 earnedBobAtExpiry = staking.earned(bob);

        vm.startPrank(owner);
        token.approve(address(staking), type(uint256).max);
        staking.depositRewards(1_000_000e18);
        vm.stopPrank();

        assertEq(staking.earned(alice), earnedAliceAtExpiry, "alice preserved");
        assertEq(staking.earned(bob), earnedBobAtExpiry, "bob preserved");
    }
}

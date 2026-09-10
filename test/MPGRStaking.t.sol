// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MPGRStaking} from "../contracts/MPGRStaking.sol";
import {IMPGRStaking} from "../contracts/interfaces/IMPGRStaking.sol";

contract MockMPGR is ERC20 {
    constructor() ERC20("MPGR", "MPGR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract FeeOnTransferMPGR is MockMPGR {
    uint256 public constant FEE_BPS = 100; // 1%

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            uint256 fee = (value * FEE_BPS) / 10_000;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
            return;
        }
        super._update(from, to, value);
    }
}

contract MPGRStakingTest is Test {
    MockMPGR token;
    MPGRStaking staking;
    address alice = address(0xA11CE);
    address owner = address(0xBEEF);

    function setUp() public {
        token = new MockMPGR();
        staking = new MPGRStaking(address(token), owner);
        token.mint(owner, 50_000_000e18);
        token.mint(alice, 1_000e18);
        vm.startPrank(owner);
        token.approve(address(staking), type(uint256).max);
        staking.depositRewards(25_000_000e18);
        vm.stopPrank();
        vm.startPrank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.stopPrank();
    }

    function testDeploymentIsUnfundedUntilDeposit() public {
        MockMPGR freshToken = new MockMPGR();
        MPGRStaking fresh = new MPGRStaking(address(freshToken), owner);
        assertEq(fresh.rewardPoolBalance(), 0);
        (uint256 rate,,,) = fresh.rewardState();
        assertEq(rate, 0);
    }

    function testStakeAndUnstakePreservePrincipal() public {
        vm.prank(alice);
        staking.stake(500e18);
        assertEq(staking.balanceOf(alice), 500e18);
        assertEq(staking.totalStaked(), 500e18);
        vm.prank(alice);
        staking.unstake(500e18);
        assertEq(staking.balanceOf(alice), 0);
        assertEq(staking.totalStaked(), 0);
        assertEq(token.balanceOf(alice), 1_000e18);
    }

    function testRewardsCannotExceedFundedPool() public {
        vm.prank(owner);
        staking.setAPR(2_000);
        vm.prank(alice);
        staking.stake(500e18);
        vm.warp(block.timestamp + 30 days);
        uint256 earned = staking.earned(alice);
        assertLe(earned, staking.rewardPoolBalance());
    }

    function testPauseDoesNotBlockExit() public {
        vm.prank(alice);
        staking.stake(500e18);
        vm.prank(owner);
        staking.pause();
        vm.prank(alice);
        staking.exit();
        assertEq(staking.balanceOf(alice), 0);
    }

    function testFeeOnTransferTokenIsRejected() public {
        FeeOnTransferMPGR feeToken = new FeeOnTransferMPGR();
        MPGRStaking feeStaking = new MPGRStaking(address(feeToken), owner);
        feeToken.mint(alice, 1_000e18);
        vm.prank(alice);
        feeToken.approve(address(feeStaking), type(uint256).max);

        vm.expectRevert(IMPGRStaking.FeeOnTransferTokenUnsupported.selector);
        vm.prank(alice);
        feeStaking.stake(500e18);
    }

    function testSetAPRWithZeroStakersActivatesWhenFirstStakeArrives() public {
        vm.prank(owner);
        staking.setAPR(1_500);

        (uint256 rateBefore,,, ) = staking.rewardState();
        assertEq(rateBefore, 0);
        assertEq(staking.currentAPRBps(), 1_500);

        vm.prank(alice);
        staking.stake(500e18);

        (uint256 rateAfter,,, ) = staking.rewardState();
        assertGt(rateAfter, 0);
        assertEq(staking.currentAPRBps(), 1_500);
    }

    function testScheduleExtensionPreservesFundedAccounting() public {
        uint256 before = staking.rewardPoolBalance();
        (, uint256 beforeFinish,,) = staking.rewardState();

        vm.prank(owner);
        staking.extendRewardSchedule(1_000_000e18, 730 days);

        uint256 afterBalance = staking.rewardPoolBalance();
        (, uint256 afterFinish,,) = staking.rewardState();

        assertEq(afterBalance, before + 1_000_000e18);
        assertGe(afterFinish, beforeFinish);
    }

    function testCannotRecoverStakingToken() public {
        vm.expectRevert(IMPGRStaking.CannotRecoverStakingToken.selector);
        vm.prank(owner);
        staking.recoverERC20(address(token), 1e18);
    }

    function testExtendScheduleCannotShrinkExistingFinish() public {
        (, uint256 finish,,) = staking.rewardState();
        vm.expectRevert(IMPGRStaking.RewardScheduleWouldShrink.selector);
        vm.prank(owner);
        staking.extendRewardSchedule(1e18, 1 days);
        (, uint256 afterFinish,,) = staking.rewardState();
        assertEq(afterFinish, finish);
    }

    function testOnlyOwnerCanPauseAndChangeAPR() public {
        vm.expectRevert();
        vm.prank(alice);
        staking.pause();

        vm.expectRevert();
        vm.prank(alice);
        staking.setAPR(1_500);
    }
}

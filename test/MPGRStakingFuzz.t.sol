// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MPGRStaking} from "../contracts/MPGRStaking.sol";
contract FuzzToken is ERC20 { constructor() ERC20("MPGR","MPGR") {} function mint(address a,uint256 n) external {_mint(a,n);} }
contract MPGRStakingFuzzTest is Test {
    FuzzToken token; MPGRStaking staking; address owner=address(0xBEEF); address user=address(0xCAFE);
    function setUp() public { token=new FuzzToken(); staking=new MPGRStaking(address(token),owner); token.mint(owner,50_000_000e18); token.mint(user,1_000_000e18); vm.prank(owner); token.approve(address(staking),type(uint256).max); vm.prank(owner); staking.depositRewards(25_000_000e18); vm.prank(user); token.approve(address(staking),type(uint256).max); }
    function testFuzzStake(uint256 amount) public {
        amount = bound(amount, staking.MINIMUM_STAKE(), 1_000_000e18);
        vm.prank(user);
        staking.stake(amount);
        assertEq(staking.balanceOf(user), amount);
        assertEq(staking.totalStaked(), amount);
    }

    function testFuzzStakeThenUnstake(uint256 amount, uint256 withdrawal) public {
        amount = bound(amount, staking.MINIMUM_STAKE(), 1_000_000e18);
        vm.prank(user);
        staking.stake(amount);
        withdrawal = bound(withdrawal, 1, amount);
        vm.prank(user);
        staking.unstake(withdrawal);
        assertEq(staking.balanceOf(user), amount - withdrawal);
        assertEq(staking.totalStaked(), amount - withdrawal);
    }

    function testFuzzClaimNeverExceedsRewardPool(uint256 amount, uint256 secondsForward) public {
        amount = bound(amount, staking.MINIMUM_STAKE(), 1_000_000e18);
        vm.prank(user);
        staking.stake(amount);
        secondsForward = bound(secondsForward, 0, 365 days);
        vm.warp(block.timestamp + secondsForward);
        uint256 before = staking.rewardPoolBalance();
        uint256 earned = staking.earned(user);
        if (earned > 0) {
            vm.prank(user);
            staking.claimRewards();
            assertEq(staking.rewardPoolBalance(), before - earned);
            assertGe(token.balanceOf(address(staking)), staking.totalStaked() + staking.rewardPoolBalance());
        }
    }
}

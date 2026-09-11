// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MPGRStaking} from "../contracts/MPGRStaking.sol";

contract InvariantToken is ERC20 {
    constructor() ERC20("MPGR", "MPGR") {}
    function mint(address a, uint256 n) external { _mint(a, n); }
}

contract StakingHandler is Test {
    InvariantToken internal immutable token;
    MPGRStaking internal immutable staking;
    address internal immutable owner;
    address[] internal users;

    constructor(InvariantToken token_, MPGRStaking staking_, address owner_) {
        token = token_;
        staking = staking_;
        owner = owner_;
        users.push(address(0xCAFE));
        users.push(address(0xD00D));
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], 1_000_000e18);
            vm.prank(users[i]);
            token.approve(address(staking), type(uint256).max);
        }
    }

    function stake(uint256 amount, uint8 actor) external {
        address user = users[uint256(actor) % users.length];
        amount = bound(amount, staking.MINIMUM_STAKE(), 1_000_000e18);
        token.mint(user, amount);
        vm.prank(user);
        staking.stake(amount);
    }

    function unstake(uint256 amount, uint8 actor) external {
        address user = users[uint256(actor) % users.length];
        uint256 balance = staking.balanceOf(user);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.prank(user);
        staking.unstake(amount);
    }

    function claim(uint8 actor) external {
        address user = users[uint256(actor) % users.length];
        vm.prank(user);
        if (staking.earned(user) > 0) staking.claimRewards();
    }

    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1, 30 days));
    }
}

contract MPGRStakingInvariantTest is StdInvariant, Test {
    InvariantToken token;
    MPGRStaking staking;
    StakingHandler handler;
    address owner = address(0xBEEF);

    function setUp() public {
        token = new InvariantToken();
        staking = new MPGRStaking(address(token), owner);
        token.mint(owner, 50_000_000e18);

        vm.startPrank(owner);
        token.approve(address(staking), type(uint256).max);
        staking.depositRewards(25_000_000e18);
        vm.stopPrank();

        handler = new StakingHandler(token, staking, owner);
        targetContract(address(handler));
    }

    function invariant_accountingCannotExceedTokenBalance() public view {
        assertGe(
            token.balanceOf(address(staking)),
            staking.totalStaked() + staking.rewardPoolBalance()
        );
    }

    function invariant_stakedPrincipalIsCoveredByContractBalance() public view {
        assertGe(token.balanceOf(address(staking)), staking.totalStaked());
    }

    function invariant_rewardAccrualFreezesWhenNobodyIsStaked() public view {
        if (staking.totalStaked() == 0) {
            (,,, uint256 storedRewardPerToken) = staking.rewardState();
            assertEq(staking.rewardPerToken(), storedRewardPerToken);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {RewardMath} from "../contracts/libraries/RewardMath.sol";

contract RewardMathTest is Test {
    function testRewardPerTokenFreezesWhenNoStake() public pure {
        assertEq(RewardMath.rewardPerToken(123, 1, 100, 1000, 0), 123);
    }
    function testRewardPerTokenAccrues() public pure {
        uint256 result = RewardMath.rewardPerToken(0, 100, 200, 10e18, 100e18);
        assertEq(result, 10e18);
    }
}

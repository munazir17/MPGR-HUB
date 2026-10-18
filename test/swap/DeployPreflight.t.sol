// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployMPGRSwapExecutorBaseMainnet as D} from "../../script/DeployMPGRSwapExecutorBaseMainnet.s.sol";

/// @notice Regression tests for the deployment preflight fail-closed matrix.
///         Uses the well-known Anvil TEST key #1 (public, test-only, never a
///         production deployer) to exercise the exact env-var key flow the
///         workflow uses: BASE_MAINNET_DEPLOYER_PRIVATE_KEY -> vm.envUint ->
///         vm.addr for nonce/owner checks.
contract DeployPreflightTest is Test {
    uint256 internal constant TEST_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    address internal deployer;
    address internal multisig = address(0x5AFE);
    D internal d;

    function setUp() public {
        deployer = vm.addr(TEST_PK);
        d = new D();
        vm.etch(multisig, hex"6001600052602060006000f3"); // deployed-contract stand-in
        // Literal hex (vm.setEnv leaks across tests in a run; setUp pins both
        // env inputs deterministically for every case).
        vm.setEnv("BASE_MAINNET_DEPLOYER_PRIVATE_KEY", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
        vm.setEnv("MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED", "false");
    }

    function test_run_revertsOffBaseMainnet() public {
        vm.chainId(1);
        vm.expectRevert("chain: Base Mainnet only");
        d.run();
    }

    function test_run_revertsWithoutExplicitApprovalEnv() public {
        vm.chainId(8453);
        vm.setEnv("MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED", "false");
        vm.expectRevert("gate: MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED=true required");
        d.run();
    }

    function test_run_failsClosedWhileCommittedGateIsClosed() public {
        vm.chainId(8453);
        vm.setEnv("MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED", "true");
        vm.setEnv("SWAP_EXECUTOR_OWNER", "0x0000000000000000000000000000000000005AFE");
        // deployments/base-mainnet/deploy-config.json pins
        // swapExecutorDeployEnabled=false, so even the approval env alone
        // cannot reach a broadcast.
        vm.expectRevert("gate: deploy-config.json swapExecutorDeployEnabled must be true");
        d.run();
    }

    function test_preflight_rejectsUsedDeployerKey() public {
        vm.setNonce(deployer, 1);
        vm.expectRevert("preflight: deployer nonce must be 0 (fresh dedicated key)");
        d.preflightCheck(TEST_PK, multisig);
    }

    function test_preflight_rejectsDeployerAsOwner() public {
        vm.expectRevert("preflight: owner must be the governance multisig, not the ephemeral deployer");
        d.preflightCheck(TEST_PK, deployer);
    }

    function test_preflight_rejectsCodelessOwner() public {
        vm.expectRevert("preflight: SWAP_EXECUTOR_OWNER must be a deployed multisig contract on Base");
        d.preflightCheck(TEST_PK, address(0xBEEF));
    }

    function test_preflight_envWrapperReadsDedicatedKeyEnv() public view {
        // The env wrapper (used by run()) reads the same dedicated-key env var
        // the workflow sets; setUp pins it to the literal test key, so the
        // wrapper must accept a fresh key + deployed multisig without revert.
        // Malformed/missing-key fail-closed is covered by scripts/swap-deploy/
        // preflight.sh (`:?` guards) and vm.envUint parse reverts.
        d.preflightDeployerAndOwner(multisig);
    }

    function test_preflight_passesForFreshKeyAndDeployedMultisig() public view {
        d.preflightCheck(TEST_PK, multisig); // must not revert
    }
}

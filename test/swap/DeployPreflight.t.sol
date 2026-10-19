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

    /// @notice DEPLOYED STATE: the one authorized deployment happened via the
    ///         trusted pinned-SHA workflow and the sealed final manifest is
    ///         committed, so run() must now refuse a second deployment at the
    ///         manifest gate — before the owner preflight and long before
    ///         vm.startBroadcast(). (Pre-deployment, this same call proved the
    ///         owner preflight failed closed; that guard remains covered
    ///         directly by the test_preflight_* cases below.)
    function test_run_refusesSecondDeploymentWhileManifestExists() public {
        vm.chainId(8453);
        vm.setEnv("MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED", "true");
        vm.setEnv("SWAP_EXECUTOR_OWNER", "0x000000000000000000000000000000000000beef"); // codeless, never etched
        vm.expectRevert("gate: manifest already exists");
        d.run();
    }

    /// @notice The committed state must be exactly the reviewed post-deployment
    ///         record: gate values unchanged, chain/fee pins intact, the sealed
    ///         final manifest present with the independently verified Base
    ///         Mainnet deployment facts, and no staging record left behind.
    function test_committedStateIsTheReviewedDeploymentRecord() public view {
        string memory cfg = vm.readFile("./deployments/base-mainnet/deploy-config.json");
        assertTrue(vm.parseJsonBool(cfg, ".swapExecutorDeployEnabled"), "swap gate must be the reviewed open gate");
        assertFalse(vm.parseJsonBool(cfg, ".mainnetDeployEnabled"), "legacy mainnet gate must stay closed");
        assertEq(vm.parseJsonUint(cfg, ".chainId"), 8453, "chain id pin");
        assertEq(vm.parseJsonUint(cfg, ".feeBps"), 25, "fee bps pin");
        assertEq(vm.parseJsonUint(cfg, ".maxFeeBps"), 100, "max fee bps pin");
        assertTrue(vm.exists("./deployments/base-mainnet/mpgr-swap-executor.json"), "sealed deploy record must exist");
        assertFalse(vm.exists("./deployments/base-mainnet/mpgr-swap-executor.staging.json"), "no staging record");
        string memory m = vm.readFile("./deployments/base-mainnet/mpgr-swap-executor.json");
        assertEq(vm.parseJsonUint(m, ".chainId"), 8453, "manifest chain id");
        assertEq(
            vm.parseJsonAddress(m, ".executor"), 0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E, "manifest executor pin"
        );
        assertEq(vm.parseJsonAddress(m, ".owner"), 0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B, "manifest owner pin");
        assertTrue(
            vm.parseJsonAddress(m, ".owner") != vm.parseJsonAddress(m, ".deployer"), "owner is never the deployer"
        );
        assertEq(vm.parseJsonUint(m, ".deployBlock"), 52799525, "manifest deploy block");
        assertEq(vm.parseJsonUint(m, ".feeBps"), 25, "manifest fee pin");
        assertEq(
            vm.parseJsonString(m, ".deployTx"),
            "0x549a54c25a31c0fd47dff625bdfba821c27d892b5cb437473b1decc751efa4cc",
            "manifest deploy tx pin"
        );
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployMPGRExecutorDelegatedBaseMainnet} from "../../script/DeployMPGRExecutorDelegatedBaseMainnet.s.sol";
import {MPGRExecutorDelegated} from "../../contracts/executor/MPGRExecutorDelegated.sol";

/// @dev Local harness for the preflight and read-only simulation paths; never broadcasts or opens a network fork.
contract DelegatedMainnetDeployHarness is DeployMPGRExecutorDelegatedBaseMainnet {
    bool public recordExistsFlag;

    function setRecordExists(bool value) external {
        recordExistsFlag = value;
    }

    function _recordExists() internal view override returns (bool) {
        return recordExistsFlag;
    }

    function preflightForTest(Config memory c, Pins memory p) external view {
        preflight(c, p);
    }

    function simulationPreflightForTest(Config memory c, Pins memory p) external view {
        simulationPreflight(c, p);
    }

    function simulateForTest() external view returns (address) {
        return simulate();
    }

    function constructorArgsForTest(Config memory c) external pure returns (ConstructorArgs memory) {
        return _constructorArgs(c);
    }

    function pinsForTest() external view returns (Pins memory) {
        return _readPins();
    }

    function startBroadcastForTest(uint256 privateKey) external {
        _startBroadcast(privateKey);
    }
}

contract MockERC20MetadataForDeploy {
    function decimals() external pure returns (uint8) {
        return 6;
    }

    function totalSupply() external pure returns (uint256) {
        return 1_000_000_000e6;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

contract MockSlipstreamRouterForDeploy {
    function factory() external pure returns (address) {
        return 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    }

    function WETH9() external pure returns (address) {
        return 0x4200000000000000000000000000000000000006;
    }
}

contract MockUniswapRouterForDeploy {
    function WETH9() external pure returns (address) {
        return 0x4200000000000000000000000000000000000006;
    }
}

contract MockCodeForDeploy {}

/// Unit proof of the new mainnet delegated deployment guard. All infrastructure code is
/// locally etched; the tests never open an RPC connection or broadcast a transaction.
contract DeployMPGRExecutorDelegatedBaseMainnetTest is Test {
    address internal constant CANARY = 0xBF6c574b9543967f0D528ae49603b0A7574a280b;
    address internal constant OWNER = 0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e;
    address internal constant FEE_RECIPIENT = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    address internal constant SEPOLIA_DEPLOYER = 0xb67FCDF437B5FeF64E4b32952dc6d172dc9ec56e;

    DelegatedMainnetDeployHarness internal harness;
    uint256 internal deployerKey;
    address internal deployer;
    uint256 internal broadcasterKey;
    address internal broadcaster;

    function setUp() public {
        vm.chainId(8453);
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION", "");
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED", "");
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED_SECRET", "");
        vm.setEnv("BASE_MAINNET_DEPLOYER_PRIVATE_KEY", "");
        vm.setEnv("BASE_MAINNET_DEPLOYER_ADDRESS", "");
        vm.setEnv("MPGR_MAINNET_BROADCASTER_PRIVATE_KEY", "");
        vm.setEnv("MPGR_EXECUTOR_OWNER", vm.toString(OWNER));
        vm.setEnv("MPGR_EXECUTOR_FEE_RECIPIENT", vm.toString(FEE_RECIPIENT));
        harness = new DelegatedMainnetDeployHarness();
        deployerKey = uint256(keccak256("mpgr-delegated-mainnet-deploy-preflight-test"));
        deployer = vm.addr(deployerKey);
        broadcasterKey = uint256(keccak256("mpgr-dedicated-broadcaster-preflight-test"));
        broadcaster = vm.addr(broadcasterKey);
        vm.etch(deployer, "");
        vm.setNonceUnsafe(deployer, 0);
        vm.deal(deployer, 0.01 ether);
        _etchMainnetInfrastructure();
    }

    function _goodConfig() internal view returns (DeployMPGRExecutorDelegatedBaseMainnet.Config memory c) {
        c.pk = deployerKey;
        c.deployer = deployer;
        c.owner = OWNER;
        c.feeRecipient = FEE_RECIPIENT;
        c.broadcaster = broadcaster;
        c.envEnabled = true;
    }

    function _goodPins() internal pure returns (DeployMPGRExecutorDelegatedBaseMainnet.Pins memory p) {
        p.chainId = 8453;
        p.enabled = true;
        p.owner = OWNER;
        p.feeRecipient = FEE_RECIPIENT;
        p.feeBps = 25;
        p.maxFeeBps = 100;
        p.permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        p.weth = 0x4200000000000000000000000000000000000006;
    }

    function _etchMainnetInfrastructure() internal {
        MockERC20MetadataForDeploy erc20 = new MockERC20MetadataForDeploy();
        MockCodeForDeploy codeOnly = new MockCodeForDeploy();
        MockSlipstreamRouterForDeploy slip = new MockSlipstreamRouterForDeploy();
        MockUniswapRouterForDeploy uni = new MockUniswapRouterForDeploy();

        (address[] memory tokens,) = harness.productionTokens();
        for (uint256 i; i < tokens.length; ++i) {
            vm.etch(tokens[i], address(erc20).code);
        }
        vm.etch(0x000000000022D473030F116dDEE9F6B43aC78BA3, address(codeOnly).code);
        vm.etch(0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F, address(slip).code);
        vm.etch(0x2626664c2603336E57B271c5C0b26F421741e481, address(uni).code);
    }

    function _enableSimulationMode() internal {
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION", "true");
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED", "false");
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED_SECRET", "false");
        vm.setEnv("BASE_MAINNET_DEPLOYER_ADDRESS", vm.toString(deployer));
    }

    function test_PreflightPassesWithThePinnedMainnetConfigAndMockedLiveInfrastructure() public view {
        harness.preflightForTest(_goodConfig(), _goodPins());
    }

    function test_PreflightRejectsEveryNonMainnetChainBeforeAnyOtherCheck() public {
        vm.chainId(84532);
        vm.expectRevert(bytes("MPGR: BASE MAINNET (8453) ONLY - refusing to run"));
        harness.preflightForTest(_goodConfig(), _goodPins());
    }

    function test_PreflightRequiresBothIndependentEnableFlags() public {
        DeployMPGRExecutorDelegatedBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorDelegatedBaseMainnet.Pins memory p = _goodPins();

        c.envEnabled = false;
        vm.expectRevert(
            bytes("MPGR: MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED != true - mainnet delegated deploy not enabled")
        );
        harness.preflightForTest(c, p);

        c = _goodConfig();
        p.enabled = false;
        vm.expectRevert(bytes("MPGR: delegated-deploy-config.json mainnetDelegatedDeployEnabled != true"));
        harness.preflightForTest(c, p);
    }

    function test_PreflightRejectsAnExistingArtifactAndANonzeroDeployerNonce() public {
        DeployMPGRExecutorDelegatedBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorDelegatedBaseMainnet.Pins memory p = _goodPins();

        harness.setRecordExists(true);
        vm.expectRevert(bytes("MPGR: mpgr-executor-delegated.json exists - already deployed"));
        harness.preflightForTest(c, p);
        harness.setRecordExists(false);

        vm.setNonceUnsafe(deployer, 1);
        vm.expectRevert(bytes("MPGR: deployer nonce != 0 - use a fresh dedicated key (prevents a 2nd deploy)"));
        harness.preflightForTest(c, p);
    }

    function test_PreflightRejectsMismatchedPinsBeforeAnyDeployment() public {
        DeployMPGRExecutorDelegatedBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorDelegatedBaseMainnet.Pins memory p = _goodPins();

        p.chainId = 84532;
        vm.expectRevert(bytes("MPGR: config chainId != 8453"));
        harness.preflightForTest(c, p);

        p = _goodPins();
        p.feeBps = 26;
        vm.expectRevert(bytes("MPGR: config feeBps != 25"));
        harness.preflightForTest(c, p);

        p = _goodPins();
        p.permit2 = address(0x1234);
        vm.expectRevert(bytes("MPGR: config permit2 != canonical Permit2"));
        harness.preflightForTest(c, p);
    }

    function test_PreflightRejectsTheCanaryAsDeployerOwnerFeeRecipientOrBroadcaster() public {
        DeployMPGRExecutorDelegatedBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorDelegatedBaseMainnet.Pins memory p = _goodPins();

        c.deployer = CANARY;
        vm.expectRevert(bytes("MPGR: denied address used as deployer"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        c.owner = CANARY;
        p.owner = CANARY;
        vm.expectRevert(bytes("MPGR: denied address used as owner"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        p = _goodPins();
        c.feeRecipient = CANARY;
        p.feeRecipient = CANARY;
        vm.expectRevert(bytes("MPGR: denied address used as feeRecipient"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        p = _goodPins();
        c.broadcaster = CANARY;
        vm.expectRevert(bytes("MPGR: denied address used as production broadcaster"));
        harness.preflightForTest(c, p);
    }

    function test_PreflightSeparatesTheOneShotDeployerGovernanceFeeAndBroadcaster() public {
        DeployMPGRExecutorDelegatedBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorDelegatedBaseMainnet.Pins memory p = _goodPins();

        c.deployer = OWNER;
        vm.expectRevert(bytes("MPGR: deployer must not be the owner"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        c.deployer = FEE_RECIPIENT;
        vm.expectRevert(bytes("MPGR: deployer must not be the fee recipient"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        c.broadcaster = c.deployer;
        vm.expectRevert(bytes("MPGR: deployer must not be the production broadcaster"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        c.broadcaster = OWNER;
        vm.expectRevert(bytes("MPGR: broadcaster must not be the governance owner"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        c.broadcaster = FEE_RECIPIENT;
        vm.expectRevert(bytes("MPGR: broadcaster must not be the fee recipient"));
        harness.preflightForTest(c, p);
    }

    function test_PreflightRejectsBaseSepoliaAddressesFromProductionRoles() public {
        DeployMPGRExecutorDelegatedBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorDelegatedBaseMainnet.Pins memory p = _goodPins();

        c.owner = SEPOLIA_DEPLOYER;
        p.owner = SEPOLIA_DEPLOYER;
        vm.expectRevert(bytes("MPGR: Base Sepolia deployer used as owner"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        p = _goodPins();
        c.deployer = SEPOLIA_DEPLOYER;
        vm.expectRevert(bytes("MPGR: Base Sepolia deployer used as deployer"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        p = _goodPins();
        c.feeRecipient = SEPOLIA_DEPLOYER;
        p.feeRecipient = SEPOLIA_DEPLOYER;
        vm.expectRevert(bytes("MPGR: Base Sepolia deployer used as feeRecipient"));
        harness.preflightForTest(c, p);

        c = _goodConfig();
        p = _goodPins();
        c.broadcaster = SEPOLIA_DEPLOYER;
        vm.expectRevert(bytes("MPGR: Base Sepolia deployer used as production broadcaster"));
        harness.preflightForTest(c, p);
    }

    function test_SimulationPassesWithBothProductionFlagsFalseWithoutCreatingAnExecutorOrMutatingDeployerState()
        public
    {
        _enableSimulationMode();
        uint256 deployerBalanceBefore = deployer.balance;
        uint256 deployerNonceBefore = vm.getNonce(deployer);

        address predicted = harness.simulateForTest();

        assertEq(predicted, vm.computeCreateAddress(deployer, 0));
        assertEq(vm.getNonce(deployer), deployerNonceBefore);
        assertEq(deployer.balance, deployerBalanceBefore);
        assertEq(predicted.code.length, 0);
        assertEq(predicted.balance, 0);
        assertFalse(harness.recordExistsFlag());
    }

    function test_SimulationRequiresExplicitModeAndBothDeploymentFlagsFalse() public {
        _enableSimulationMode();
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED", "true");
        vm.expectRevert(bytes("MPGR: simulation requires environment deployment flag exactly false"));
        harness.simulateForTest();

        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED", "false");
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED_SECRET", "true");
        vm.expectRevert(bytes("MPGR: simulation requires secret deployment flag exactly false"));
        harness.simulateForTest();

        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED_SECRET", "false");
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION", "false");
        vm.expectRevert(bytes("MPGR: set MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION=true to use simulation mode"));
        harness.simulateForTest();
    }

    function test_SimulationPreflightKeepsTheCommittedConfigDeployFlagFalse() public {
        DeployMPGRExecutorDelegatedBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorDelegatedBaseMainnet.Pins memory p = _goodPins();
        c.envEnabled = false;
        p.enabled = false;
        harness.simulationPreflightForTest(c, p);

        p.enabled = true;
        vm.expectRevert(bytes("MPGR: simulation requires committed deployment flag false"));
        harness.simulationPreflightForTest(c, p);

        p.enabled = false;
        c.envEnabled = true;
        vm.expectRevert(bytes("MPGR: simulation requires environment deployment flag false"));
        harness.simulationPreflightForTest(c, p);
    }

    function test_SimulationModeCannotReachBroadcastHelper() public {
        _enableSimulationMode();
        vm.expectRevert(bytes("MPGR: simulation mode cannot broadcast"));
        harness.startBroadcastForTest(deployerKey);
    }

    function test_ProductionRunStillRefusesWhenEnvironmentEnableFlagIsFalse() public {
        vm.setEnv("BASE_MAINNET_DEPLOYER_PRIVATE_KEY", vm.toString(deployerKey));
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION", "false");
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED", "false");
        vm.expectRevert(
            bytes("MPGR: MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED != true - mainnet delegated deploy not enabled")
        );
        harness.run();
    }

    function test_ProductionRunStillRefusesWhenCommittedEnableFlagIsFalse() public {
        vm.setEnv("BASE_MAINNET_DEPLOYER_PRIVATE_KEY", vm.toString(deployerKey));
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION", "false");
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_ENABLED", "true");
        vm.expectRevert(bytes("MPGR: delegated-deploy-config.json mainnetDelegatedDeployEnabled != true"));
        harness.run();
    }

    function test_ProductionRunRefusesSimulationBeforeReadingTheDeployerKey() public {
        vm.setEnv("MPGR_MAINNET_DELEGATED_DEPLOY_SIMULATION", "true");
        vm.setEnv("BASE_MAINNET_DEPLOYER_PRIVATE_KEY", "");
        vm.expectRevert(bytes("MPGR: simulation mode must use simulate(); production run refused"));
        harness.run();
    }

    function test_ConstructorArgumentsAndInitialPostureMatchTheProductionPlan() public {
        DeployMPGRExecutorDelegatedBaseMainnet.Config memory c = _goodConfig();
        DeployMPGRExecutorDelegatedBaseMainnet.ConstructorArgs memory args = harness.constructorArgsForTest(c);
        DeployMPGRExecutorDelegatedBaseMainnet.Pins memory pins = harness.pinsForTest();

        assertEq(args.owner, pins.owner);
        assertEq(args.feeRecipient, pins.feeRecipient);
        assertEq(args.feeBps, 25);
        assertEq(args.weth, pins.weth);
        assertEq(args.permit2, pins.permit2);
        assertEq(pins.chainId, 8453);
        assertFalse(pins.enabled);
        assertEq(pins.feeBps, 25);
        assertEq(pins.maxFeeBps, 100);

        MPGRExecutorDelegated.RouterConfig[] memory productionRouters = harness.productionRouters();
        assertEq(args.routers.length, 2);
        for (uint256 i; i < args.routers.length; ++i) {
            assertEq(args.routers[i].router, productionRouters[i].router);
            assertEq(uint256(args.routers[i].kind), uint256(productionRouters[i].kind));
        }
        assertEq(args.routers[0].router, 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F);
        assertEq(uint256(args.routers[0].kind), uint256(MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM));
        assertEq(args.routers[1].router, 0x2626664c2603336E57B271c5C0b26F421741e481);
        assertEq(uint256(args.routers[1].kind), uint256(MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02));

        (address[] memory expectedTokens,) = harness.productionTokens();
        assertEq(args.tokens.length, 15);
        for (uint256 i; i < args.tokens.length; ++i) {
            assertEq(args.tokens[i], expectedTokens[i]);
        }

        MPGRExecutorDelegated dex = new MPGRExecutorDelegated(
            args.owner, args.feeRecipient, args.feeBps, args.weth, args.permit2, args.routers, args.tokens
        );
        assertEq(dex.owner(), OWNER);
        assertEq(dex.pendingOwner(), address(0));
        assertEq(dex.feeBps(), 25);
        assertEq(dex.MAX_FEE_BPS(), 100);
        assertEq(dex.feeRecipient(), FEE_RECIPIENT);
        assertEq(address(dex.PERMIT2()), pins.permit2);
        assertEq(address(dex.WETH()), pins.weth);
        assertFalse(dex.paused());
        assertEq(
            dex.WITNESS_TYPE_STRING(),
            "ActionWitness witness)ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)TokenPermissions(address token,uint256 amount)"
        );

        for (uint256 i; i < productionRouters.length; ++i) {
            assertEq(uint256(dex.routerKind(productionRouters[i].router)), uint256(productionRouters[i].kind));
            assertEq(dex.swapModuleForRouter(productionRouters[i].router), address(0));
            assertEq(dex.swapModuleCodeHash(productionRouters[i].router), bytes32(0));
        }
        address[] memory denied = harness.deniedAddresses();
        for (uint256 i; i < denied.length; ++i) {
            assertEq(uint256(dex.routerKind(denied[i])), uint256(MPGRExecutorDelegated.RouterKind.NONE));
            assertEq(dex.swapModuleForRouter(denied[i]), address(0));
            assertEq(dex.swapModuleCodeHash(denied[i]), bytes32(0));
            assertFalse(dex.isTokenAllowed(denied[i]));
        }
        assertEq(uint256(dex.routerKind(SEPOLIA_DEPLOYER)), uint256(MPGRExecutorDelegated.RouterKind.NONE));
        assertFalse(dex.isTokenAllowed(SEPOLIA_DEPLOYER));
        for (uint256 i; i < expectedTokens.length; ++i) {
            assertTrue(dex.isTokenAllowed(expectedTokens[i]));
            assertEq(MockERC20MetadataForDeploy(expectedTokens[i]).balanceOf(address(dex)), 0);
        }
        assertEq(address(dex).balance, 0);
    }
}

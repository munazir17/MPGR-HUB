// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";
import {DeployMPGRExecutorBaseMainnet} from "../../script/DeployMPGRExecutorBaseMainnet.s.sol";
import {MainnetDeployHarness} from "../fork/MPGRExecutorBaseMainnetDeploy.t.sol";

contract StubSlipRouter {
    function factory() external pure returns (address) {
        return 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    }

    function WETH9() external pure returns (address) {
        return 0x4200000000000000000000000000000000000006;
    }
}

contract StubSlipQuoter {
    function factory() external pure returns (address) {
        return 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    }
}

contract StubToken6 {
    function decimals() external pure returns (uint8) {
        return 6;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function totalSupply() external pure returns (uint256) {
        return 1e18;
    }
}

/// Offline (no RPC) run of the real mainnet deploy script: stand-in bytecode is etched at the
/// production addresses so run()/preflight()/postflight()/JSON output are exercised in the
/// regular `contracts` CI job. The fork suite repeats this against real Base Mainnet state.
contract DeployMPGRExecutorBaseMainnetScriptTest is Test {
    MainnetDeployHarness internal h;
    uint256 internal deployerKey = uint256(keccak256("mpgr-mainnet-deploy-offline-v1"));
    address internal deployer;
    DeployMPGRExecutorBaseMainnet.Pins internal pins;
    string internal constant OUT = "deployments/base-mainnet/.fork-dry-run.json";

    function setUp() public {
        vm.chainId(8453);
        (address[] memory tokens,) = new DeployMPGRExecutorBaseMainnet().productionTokens();
        bytes memory tokenCode = address(new StubToken6()).code;
        for (uint256 i = 0; i < tokens.length; ++i) {
            vm.etch(tokens[i], tokenCode);
        }
        vm.etch(0x000000000022D473030F116dDEE9F6B43aC78BA3, hex"00");
        vm.etch(0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F, address(new StubSlipRouter()).code);
        vm.etch(0x514c8B5f54112481E28028F1166Bd78501089259, address(new StubSlipQuoter()).code);

        h = new MainnetDeployHarness();
        deployer = vm.addr(deployerKey);
        vm.deal(deployer, 0.003 ether);
        pins = h.committedPins();
        DeployMPGRExecutorBaseMainnet.Config memory c;
        c.pk = deployerKey;
        c.deployer = deployer;
        c.owner = pins.owner;
        c.feeRecipient = pins.feeRecipient;
        c.envEnabled = true;
        h.setConfig(c);
    }

    function test_Offline_Run_DeploysExactlyTheProductionConfig() public {
        MPGRExecutor ex = h.run();
        assertEq(address(ex), vm.computeCreateAddress(deployer, 0));
        assertEq(ex.owner(), 0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e);
        assertEq(ex.feeRecipient(), 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4);
        assertEq(ex.feeBps(), 25);
        assertEq(ex.MAX_FEE_BPS(), 100);

        string memory json = vm.readFile(OUT);
        vm.removeFile(OUT);
        assertEq(vm.parseJsonUint(json, ".chainId"), 8453);
        assertEq(vm.parseJsonAddress(json, ".executor"), address(ex));
        assertEq(vm.parseJsonAddress(json, ".deployer"), deployer);
        assertEq(vm.parseJsonAddress(json, ".owner"), pins.owner);
        assertEq(vm.parseJsonAddress(json, ".feeRecipient"), pins.feeRecipient);
        assertEq(vm.parseJsonUint(json, ".feeBps"), 25);
        assertEq(vm.parseJsonUint(json, ".maxFeeBps"), 100);
        assertFalse(vm.parseJsonBool(json, ".appRoutingEnabled"));
        assertEq(vm.parseJsonAddress(json, ".router.router"), 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F);
        assertEq(vm.parseJsonString(json, ".router.kind"), "AERODROME_SLIPSTREAM");
        assertEq(vm.parseJsonAddress(json, ".allowedTokens.USDC"), 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
        assertEq(vm.parseJsonAddress(json, ".allowedTokens.TSLAc"), 0xb2000000000000000000001e800a7f5189430cD0);
        assertEq(vm.parseJsonKeys(json, ".allowedTokens").length, 15);
        address[] memory ra = vm.parseJsonAddressArray(json, ".routerAllowlist");
        assertEq(ra.length, 1);
        assertEq(ra[0], 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F);
    }

    function test_Offline_Run_RefusesWhenNotEnabled() public {
        DeployMPGRExecutorBaseMainnet.Config memory c;
        c.pk = deployerKey;
        c.deployer = deployer;
        c.owner = pins.owner;
        c.feeRecipient = pins.feeRecipient;
        c.envEnabled = false;
        h.setConfig(c);
        vm.expectRevert(bytes("MPGR: MPGR_MAINNET_DEPLOY_ENABLED != true - mainnet deploy not enabled"));
        h.run();
    }

    function test_Offline_Run_RefusesOnBaseSepolia() public {
        vm.chainId(84532);
        vm.expectRevert(bytes("MPGR: BASE MAINNET (8453) ONLY - refusing to run"));
        h.run();
    }

    function test_Offline_Run_RefusesSecondDeploymentFromSameKey() public {
        h.run();
        vm.removeFile(OUT);
        vm.expectRevert(bytes("MPGR: deployer nonce != 0 - use a fresh dedicated key (prevents a 2nd deploy)"));
        h.run();
    }

    function test_Offline_Run_RefusesUsdcWithCodeButNoErc20() public {
        vm.etch(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, hex"00");
        vm.expectRevert(bytes("MPGR: USDC is not a live ERC-20 on 8453 (decimals/totalSupply/balanceOf failed)"));
        h.run();
    }

    function test_Offline_Run_B20PrecompileMarkerIsNeverCalled() public {
        // Like real Base, B20 addresses carry non-executable placeholder code (the node runs the
        // precompile). The script must deploy without ever calling them.
        (address[] memory tokens,) = h.productionTokens();
        for (uint256 i = 2; i < tokens.length; ++i) {
            vm.etch(tokens[i], hex"fe");
        }
        MPGRExecutor ex = h.run();
        vm.removeFile(OUT);
        for (uint256 i = 0; i < tokens.length; ++i) {
            assertTrue(ex.isTokenAllowed(tokens[i]));
        }
    }

    function test_Offline_Run_RefusesB20WithoutCode() public {
        vm.etch(0xb2000000000000000000001e800a7f5189430cD0, "");
        vm.expectRevert(bytes("MPGR: TSLAc has no code on 8453"));
        h.run();
    }

    function test_Offline_Run_RefusesWrongRouterBinding() public {
        vm.etch(0x514c8B5f54112481E28028F1166Bd78501089259, address(new StubSlipRouter()).code);
        vm.etch(0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F, address(new StubToken6()).code);
        vm.expectRevert();
        h.run();
    }
}

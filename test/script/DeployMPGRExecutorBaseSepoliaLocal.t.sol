// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployMPGRExecutorBaseSepolia} from "../../script/DeployMPGRExecutorBaseSepolia.s.sol";
import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";
import {MockWETH9} from "../executor/mocks/ExecutorMocks.sol";

/// @dev Same script, local infrastructure. Only `_infra()` and `_outFile()`
///      differ from production; every require/fee assertion runs unchanged.
contract LocalDeployHarness is DeployMPGRExecutorBaseSepolia {
    Infra internal localInfra;
    uint256 internal pk;
    address internal owner;
    address internal feeRecipient;

    function setInfra(Infra memory i) external {
        localInfra = i;
    }

    function setConfig(uint256 pk_, address owner_, address feeRecipient_) external {
        (pk, owner, feeRecipient) = (pk_, owner_, feeRecipient_);
    }

    function _readConfig() internal view override returns (uint256, address, address) {
        return (pk, owner, feeRecipient);
    }

    function _infra() internal view override returns (Infra memory) {
        return localInfra;
    }

    function _outDir() internal pure override returns (string memory) {
        return "deployments/.local";
    }

    function _outFile() internal pure override returns (string memory) {
        return "deployments/.local/mpgr-executor.json";
    }
}

/// @notice Dry-runs script/DeployMPGRExecutorBaseSepolia.s.sol end-to-end on a
///         local EVM (chainId forced to 84532) against REAL Uniswap V3 Factory /
///         NonfungiblePositionManager / SwapRouter02 / QuoterV2 bytecode (the npm
///         Uniswap packages) and REAL Permit2 (built from Uniswap/permit2).
///         Skips when `.uniswap-artifacts/` has not been prepared — see
///         script/prepare-uniswap-artifacts.sh (run by the CI `contracts` job).
contract DeployMPGRExecutorBaseSepoliaLocalTest is Test {
    string internal constant ART = ".uniswap-artifacts/";
    uint256 internal constant DEPLOYER_KEY = 0xD3910E5;
    address internal owner = makeAddr("designated-owner");

    LocalDeployHarness internal harness;
    address internal deployer;

    function setUp() public {
        if (!vm.exists(string.concat(ART, "Permit2.json"))) {
            // CI sets this so the dry-run can never silently skip there.
            require(!vm.envOr("MPGR_REQUIRE_UNISWAP_ARTIFACTS", false), "uniswap artifacts required but missing");
            return;
        }
        vm.chainId(84532);
        vm.warp(1_800_000_000);
        deployer = vm.addr(DEPLOYER_KEY);
        vm.deal(deployer, 1 ether);

        MockWETH9 weth = new MockWETH9();
        address permit2 = deployCode(string.concat(ART, "Permit2.json"));
        address factory = deployCode(string.concat(ART, "UniswapV3Factory.json"));
        address npm = deployCode(
            string.concat(ART, "NonfungiblePositionManager.json"), abi.encode(factory, address(weth), address(0xdead))
        );
        address router =
            deployCode(string.concat(ART, "SwapRouter02.json"), abi.encode(address(0), factory, npm, address(weth)));
        address quoter = deployCode(string.concat(ART, "QuoterV2.json"), abi.encode(factory, address(weth)));

        harness = new LocalDeployHarness();
        harness.setInfra(
            DeployMPGRExecutorBaseSepolia.Infra({
                weth: address(weth),
                permit2: permit2,
                factory: factory,
                npm: npm,
                quoter: quoter,
                router: router
            })
        );
        harness.setConfig(DEPLOYER_KEY, owner, owner); // fee recipient = owner (user's choice)
    }

    modifier prepared() {
        if (address(harness) == address(0)) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_DeployScript_EndToEnd_RealUniswapV3AndPermit2() public prepared {
        harness.run();

        string memory json = vm.readFile("deployments/.local/mpgr-executor.json");
        MPGRExecutor ex = MPGRExecutor(payable(vm.parseJsonAddress(json, ".executor")));
        assertEq(vm.parseJsonUint(json, ".chainId"), 84532);
        assertEq(ex.owner(), owner, "owner = designated wallet, not the deployer");
        assertTrue(ex.owner() != deployer);
        assertEq(ex.pendingOwner(), address(0));
        assertEq(ex.feeBps(), 25);
        assertEq(ex.feeRecipient(), owner);
        assertEq(vm.parseJsonAddress(json, ".owner"), owner);

        // Exact fees landed with the fee recipient, in each SELL asset.
        address tUSD = vm.parseJsonAddress(json, ".testTokenUSD");
        address tSTOCK = vm.parseJsonAddress(json, ".testTokenStock");
        // tUSD sells: 100 + 50 + 25 + 0.2 tUSD  -> 0.25 + 0.125 + 0.0625 + 0.0005
        assertEq(IERC20(tUSD).balanceOf(owner), 250_000 + 125_000 + 62_500 + 500);
        // tSTOCK sell: 0.5 tSTOCK -> 0.00125 tSTOCK
        assertEq(IERC20(tSTOCK).balanceOf(owner), 0.00125e18);
        // Native ETH sell: 0.0001 ETH -> 0.00000025 ETH
        assertEq(owner.balance, 0.00000025 ether);
        // Executor holds nothing.
        assertEq(IERC20(tUSD).balanceOf(address(ex)), 0);
        assertEq(IERC20(tSTOCK).balanceOf(address(ex)), 0);
        assertEq(address(ex).balance, 0);
    }

    function test_DeployScript_RefusesNonSepoliaChains() public prepared {
        vm.chainId(8453);
        vm.expectRevert(bytes("MPGR: BASE SEPOLIA (84532) ONLY - refusing to run"));
        harness.run();
    }

    function test_DeployScript_RefusesFeeRecipientEqualToDeployer() public prepared {
        harness.setConfig(DEPLOYER_KEY, owner, deployer);
        vm.expectRevert(bytes("MPGR: fee recipient must differ from the deployer/test taker"));
        harness.run();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";

interface IUniV3FactoryLite {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IUniV3QuoterV2Lite {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

interface IOwnable2StepLite {
    function pendingOwner() external view returns (address);
}

/// @title Base Sepolia deployment verification
/// @notice Proves that the COMMITTED deployment record
///         (deployments/base-sepolia/mpgr-executor.json), which the app's
///         executor registry mirrors, points at a live contract that:
///           * runs exactly this repository's MPGRExecutor bytecode;
///           * has the expected owner, fee recipient, fee, cap, router and token allowlist;
///           * holds no funds; and
///           * executes a real exact-fee swap (on a local fork, nothing broadcast).
///         Fork tests are skipped unless BASE_SEPOLIA_RPC_URL is set (CI job `contracts-fork`).
///         The record-consistency test always runs.
contract MPGRExecutorBaseSepoliaDeploymentTest is Test {
    string internal constant RECORD = "deployments/base-sepolia/mpgr-executor.json";

    string internal json;
    bool internal forked;

    MPGRExecutor internal ex;
    address internal owner;
    address internal feeRecipient;
    address internal weth;
    address internal permit2;
    address internal router;
    address internal factory;
    address internal quoter;
    address internal tUSD;
    address internal tSTOCK;
    uint24 internal poolFee;

    function setUp() public {
        json = vm.readFile(RECORD);
        ex = MPGRExecutor(payable(vm.parseJsonAddress(json, ".executor")));
        owner = vm.parseJsonAddress(json, ".owner");
        feeRecipient = vm.parseJsonAddress(json, ".feeRecipient");
        weth = vm.parseJsonAddress(json, ".weth");
        permit2 = vm.parseJsonAddress(json, ".permit2");
        router = vm.parseJsonAddress(json, ".uniswapV3SwapRouter02");
        factory = vm.parseJsonAddress(json, ".uniswapV3Factory");
        quoter = vm.parseJsonAddress(json, ".uniswapV3QuoterV2");
        tUSD = vm.parseJsonAddress(json, ".testTokenUSD");
        tSTOCK = vm.parseJsonAddress(json, ".testTokenStock");
        poolFee = uint24(vm.parseJsonUint(json, ".uniswapV3PoolFee"));

        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        require(block.chainid == 84532, "fork must be Base Sepolia");
        forked = true;
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    // ------------------------------------------------------------------ offline

    /// Record sanity: chain, fee policy and every recorded swap's fee == floor(gross * 25 / 10_000).
    function test_Record_IsConsistent() public view {
        assertEq(vm.parseJsonUint(json, ".chainId"), 84532, "chainId");
        assertEq(vm.parseJsonUint(json, ".feeBps"), 25, "feeBps");
        assertEq(vm.parseJsonUint(json, ".maxFeeBps"), 100, "maxFeeBps");
        assertTrue(address(ex) != address(0) && owner != address(0) && feeRecipient != address(0), "zero address");
        assertEq(poolFee, 3000, "pool fee");
        for (uint256 i = 0; i < 6; i++) {
            string memory k = string.concat(".swaps[", vm.toString(i), "]");
            uint256 gross = vm.parseUint(vm.parseJsonString(json, string.concat(k, ".grossAmountIn")));
            uint256 fee = vm.parseUint(vm.parseJsonString(json, string.concat(k, ".feeAmount")));
            assertEq(fee, (gross * 25) / 10_000, "recorded fee is not exact");
            assertEq(vm.parseJsonString(json, string.concat(k, ".status")), "0x1", "swap not successful");
        }
    }

    // ------------------------------------------------------------------ on-chain (fork)

    /// The address runs EXACTLY this repo's MPGRExecutor: a fresh deployment with the same
    /// constructor immutables (WETH, PERMIT2) yields byte-identical runtime code (incl. metadata hash).
    function test_Fork_Code_MatchesRepositorySource() public onlyFork {
        assertGt(address(ex).code.length, 0, "no code at executor");
        MPGRExecutor.RouterConfig[] memory routers = new MPGRExecutor.RouterConfig[](1);
        routers[0] = MPGRExecutor.RouterConfig({router: router, kind: MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02});
        address[] memory tokens = new address[](3);
        tokens[0] = weth;
        tokens[1] = tUSD;
        tokens[2] = tSTOCK;
        MPGRExecutor fresh = new MPGRExecutor(owner, feeRecipient, 25, weth, permit2, routers, tokens);
        bytes memory onchain = address(ex).code;
        bytes memory local = address(fresh).code;
        console2.log("deployed runtime size", onchain.length);
        if (keccak256(onchain) != keccak256(local)) {
            // Distinguish a metadata-only difference (e.g. different remapping paths on the build
            // machine) from different executable code, then fail either way.
            bool sameExecutable = keccak256(_stripCbor(onchain)) == keccak256(_stripCbor(local));
            console2.log("executable code (CBOR metadata stripped) identical:", sameExecutable);
            revert("runtime bytecode differs from repo source");
        }
    }

    /// Drops the trailing solc CBOR metadata (its length is the last 2 bytes).
    function _stripCbor(bytes memory code) internal pure returns (bytes memory out) {
        uint256 n = code.length;
        if (n < 2) return code;
        uint256 metaLen = (uint256(uint8(code[n - 2])) << 8) | uint256(uint8(code[n - 1]));
        if (metaLen + 2 > n) return code;
        out = new bytes(n - metaLen - 2);
        for (uint256 i; i < out.length; ++i) {
            out[i] = code[i];
        }
    }

    function test_Fork_Config_MatchesRecord() public onlyFork {
        assertEq(ex.owner(), owner, "owner");
        assertEq(IOwnable2StepLite(address(ex)).pendingOwner(), address(0), "pending ownership transfer");
        assertEq(ex.feeRecipient(), feeRecipient, "feeRecipient");
        assertEq(ex.feeBps(), 25, "feeBps");
        assertEq(ex.MAX_FEE_BPS(), 100, "MAX_FEE_BPS");
        assertFalse(ex.paused(), "paused");
        assertEq(address(ex.WETH()), weth, "WETH");
        assertEq(address(ex.PERMIT2()), permit2, "PERMIT2");
        assertEq(uint8(ex.routerKind(router)), uint8(MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02), "router kind");
        assertTrue(ex.isTokenAllowed(weth) && ex.isTokenAllowed(tUSD) && ex.isTokenAllowed(tSTOCK), "token allowlist");
        assertEq(IERC20Metadata(tUSD).decimals(), 6, "tUSD decimals");
        assertEq(IERC20Metadata(tSTOCK).decimals(), 18, "tSTOCK decimals");
        assertEq(IERC20Metadata(tUSD).symbol(), "tUSD", "tUSD symbol");
        assertEq(IERC20Metadata(tSTOCK).symbol(), "tSTOCK", "tSTOCK symbol");
        // No custody.
        assertEq(address(ex).balance, 0, "executor holds ETH");
        assertEq(IERC20(weth).balanceOf(address(ex)), 0, "executor holds WETH");
        assertEq(IERC20(tUSD).balanceOf(address(ex)), 0, "executor holds tUSD");
        assertEq(IERC20(tSTOCK).balanceOf(address(ex)), 0, "executor holds tSTOCK");
        console2.log("owner", ex.owner());
        console2.log("feeRecipient", ex.feeRecipient());
    }

    /// The pools and quoter the app's registry routes through exist and price trades.
    function test_Fork_RegistryRoutes_AreLive() public onlyFork {
        assertTrue(IUniV3FactoryLite(factory).getPool(tUSD, tSTOCK, poolFee) != address(0), "tUSD/tSTOCK pool");
        assertTrue(IUniV3FactoryLite(factory).getPool(weth, tUSD, poolFee) != address(0), "WETH/tUSD pool");
        (uint256 out,,,) = IUniV3QuoterV2Lite(quoter)
            .quoteExactInputSingle(IUniV3QuoterV2Lite.QuoteExactInputSingleParams(tUSD, tSTOCK, 1_000_000, poolFee, 0));
        assertGt(out, 0, "quoter returned zero");
    }

    /// A real APPROVAL-mode swap through the deployed executor on a local fork (nothing broadcast):
    /// exact 25 bps sell-token fee to the recorded fee recipient, output to the taker, no custody.
    function test_Fork_DeployedExecutor_ExactFeeSwap() public onlyFork {
        address taker = vm.addr(uint256(keccak256("mpgr-sepolia-verify-taker-v1")));
        vm.etch(taker, "");
        uint256 gross = 10_000_000; // 10 tUSD
        uint256 fee = (gross * 25) / 10_000;
        deal(tUSD, taker, gross);
        (uint256 quoted,,,) = IUniV3QuoterV2Lite(quoter)
            .quoteExactInputSingle(
                IUniV3QuoterV2Lite.QuoteExactInputSingleParams(tUSD, tSTOCK, gross - fee, poolFee, 0)
            );
        uint256 minOut = (quoted * 9_900) / 10_000;

        uint256 feeBefore = IERC20(tUSD).balanceOf(feeRecipient);
        uint256 outBefore = IERC20(tSTOCK).balanceOf(taker);

        vm.startPrank(taker);
        IERC20(tUSD).approve(address(ex), gross);
        MPGRExecutor.Authorization memory auth;
        auth.kind = MPGRExecutor.AuthKind.APPROVAL;
        uint256 out = ex.swapUniswapV3ExactInputSingle(
            MPGRExecutor.SwapParams({
                router: router,
                tokenIn: tUSD,
                tokenOut: tSTOCK,
                grossAmountIn: gross,
                expectedFeeAmount: fee,
                amountOutMinimum: minOut,
                recipient: taker,
                deadline: block.timestamp + 600,
                intentId: keccak256("mpgr-sepolia-verify"),
                unwrapNativeOut: false
            }),
            poolFee,
            auth
        );
        vm.stopPrank();

        assertEq(IERC20(tUSD).balanceOf(feeRecipient) - feeBefore, fee, "fee not exact");
        assertEq(IERC20(tSTOCK).balanceOf(taker) - outBefore, out, "output not delivered to taker");
        assertGe(out, minOut, "below minOut");
        assertEq(IERC20(tUSD).balanceOf(taker), 0, "taker charged more than gross");
        assertEq(IERC20(tUSD).balanceOf(address(ex)), 0, "executor kept tUSD");
        assertEq(IERC20(tUSD).allowance(address(ex), router), 0, "dangling router allowance");
    }
}

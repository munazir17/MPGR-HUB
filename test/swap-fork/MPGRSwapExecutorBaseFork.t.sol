// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MPGRSwapExecutor as E} from "../../contracts/swap/MPGRSwapExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPoolLiquidity {
    function liquidity() external view returns (uint128);
}

/// @notice REAL Base Mainnet fork tests for every typed adapter and multi-hop
///         routes. Requires BASE_MAINNET_RPC_URL; every test SKIPS honestly
///         when the env is absent or the venue has no live pool for the pair.
///         These are fork tests, NOT live settlements.
contract MPGRSwapExecutorBaseForkTest is Test {
    E ex;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant FEE = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    address taker = address(0xA11CE);

    address constant UNI_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address constant V2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant V2_FACTORY = 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6;
    address constant CLASSIC_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant CLASSIC_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant PANCAKE_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address constant PANCAKE_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;

    function setUp() public {
        if (bytes(vm.envOr("BASE_MAINNET_RPC_URL", string(""))).length == 0) return;
        vm.createSelectFork(vm.envString("BASE_MAINNET_RPC_URL"));
        E.RouterConfig[] memory routers = new E.RouterConfig[](5);
        routers[0] = E.RouterConfig(UNI_V3_ROUTER, E.RouterKind.UNISWAP_V3_ROUTER02, UNI_V3_FACTORY);
        routers[1] = E.RouterConfig(SLIP_ROUTER, E.RouterKind.AERODROME_SLIPSTREAM, SLIP_FACTORY);
        routers[2] = E.RouterConfig(V2_ROUTER, E.RouterKind.UNISWAP_V2_ROUTER02, V2_FACTORY);
        routers[3] = E.RouterConfig(CLASSIC_ROUTER, E.RouterKind.AERODROME_CLASSIC, CLASSIC_FACTORY);
        routers[4] = E.RouterConfig(PANCAKE_ROUTER, E.RouterKind.PANCAKE_V3, PANCAKE_FACTORY);
        ex = new E(address(this), WETH, PERMIT2, routers, 25, FEE);
        deal(USDC, taker, 10_000e6);
        vm.prank(taker);
        IERC20(USDC).approve(address(ex), type(uint256).max);
    }

    function live() internal view returns (bool) {
        return address(ex) != address(0);
    }

    function poolOf(address factory, bytes4 sig, address a, address b, uint256 key, bool stable) internal view returns (address) {
        (bool ok, bytes memory ret) = factory.staticcall(abi.encodeWithSelector(sig, a, b, key));
        if (!ok || ret.length < 32) return address(0);
        if (sig == bytes4(keccak256("getPool(address,address,bool)"))) {
            (bool sOk, bytes memory sRet) = factory.staticcall(abi.encodeWithSelector(bytes4(keccak256("getPool(address,address,bool)")), a, b, stable));
            return sOk && sRet.length == 32 ? abi.decode(sRet, (address)) : address(0);
        }
        return abi.decode(ret, (address));
    }

    function runUsdcWeth(uint8 kindIdx, uint24 fee, int24 spacing, bool stable) internal {
        if (!live()) { vm.skip(true); return; }
        address factory = kindIdx == 0 ? UNI_V3_FACTORY : kindIdx == 1 ? SLIP_FACTORY : kindIdx == 2 ? V2_FACTORY : kindIdx == 3 ? CLASSIC_FACTORY : PANCAKE_FACTORY;
        address router = kindIdx == 0 ? UNI_V3_ROUTER : kindIdx == 1 ? SLIP_ROUTER : kindIdx == 2 ? V2_ROUTER : kindIdx == 3 ? CLASSIC_ROUTER : PANCAKE_ROUTER;
        address pool;
        if (kindIdx == 2) pool = poolOf(factory, bytes4(keccak256("getPair(address,address)")), USDC, WETH, 0, false);
        else if (kindIdx == 3) pool = poolOf(factory, bytes4(keccak256("getPool(address,address,bool)")), USDC, WETH, 0, stable);
        else if (kindIdx == 1) pool = poolOf(factory, bytes4(keccak256("getPool(address,address,int24)")), USDC, WETH, uint256(uint24(spacing)), false);
        else pool = poolOf(factory, bytes4(keccak256("getPool(address,address,uint24)")), USDC, WETH, fee, false);
        if (pool == address(0) || pool.code.length == 0) { vm.skip(true); return; } // honest: venue has no live pool for this pair
        // A V3-family pool can exist with zero in-range liquidity; swapping
        // into it can only revert. That is "venue unusable right now", the
        // same honest skip as a missing pool — never a silent pass.
        if (kindIdx == 0 || kindIdx == 1 || kindIdx == 4) {
            try IPoolLiquidity(pool).liquidity() returns (uint128 liq) {
                if (liq == 0) { vm.skip(true); return; }
            } catch { vm.skip(true); return; }
        }
        uint256 gross = 100e6;
        uint256 feeAmt = gross * 25 / 10000;
        E.SwapParams memory p = E.SwapParams(router, USDC, WETH, gross, feeAmt, 1, taker, block.timestamp + 300, bytes32("fork"), false);
        E.Hop[] memory path = new E.Hop[](1);
        E.RouterKind kind = kindIdx == 0 ? E.RouterKind.UNISWAP_V3_ROUTER02 : kindIdx == 1 ? E.RouterKind.AERODROME_SLIPSTREAM : kindIdx == 2 ? E.RouterKind.UNISWAP_V2_ROUTER02 : kindIdx == 3 ? E.RouterKind.AERODROME_CLASSIC : E.RouterKind.PANCAKE_V3;
        path[0] = E.Hop(router, WETH, kind, fee, spacing, stable, pool);
        uint256 wethBefore = IERC20(WETH).balanceOf(taker);
        // Delta, not absolute balance: the treasury is a live mainnet
        // address that already holds previously collected fees on the fork.
        uint256 feeBefore = IERC20(USDC).balanceOf(FEE);
        vm.prank(taker);
        uint256 out = ex.swapExactInput(p, path, auth());
        assertGt(out, 0, "measured output");
        assertEq(IERC20(WETH).balanceOf(taker) - wethBefore, out);
        assertEq(IERC20(USDC).balanceOf(FEE) - feeBefore, feeAmt, "atomic fee delivered to treasury");
    }

    function auth() internal pure returns (E.Authorization memory z) {}

    function testFork_UniswapV3Direct() public { runUsdcWeth(0, 500, 0, false); }
    function testFork_SlipstreamDirect() public { runUsdcWeth(1, 0, 100, false); }
    function testFork_UniswapV2Direct() public { runUsdcWeth(2, 0, 0, false); }
    function testFork_AerodromeClassicDirect() public { runUsdcWeth(3, 0, 0, false); }
    /// @notice KNOWN LIMITATION (verified 2026-10-19 against the router's
    ///         verified source): the executor's Pancake adapter encodes the
    ///         no-deadline exactInputSingle, but the live PancakeSwap V3
    ///         SwapRouter on Base (0x1b81D678…) requires the deadline-bearing
    ///         struct — a different selector — so Pancake swaps revert.
    ///         This tripwire asserts the current truth; it MUST be flipped
    ///         back to a success test in the same change that (via
    ///         governance) re-registers PANCAKE_V3 to a compatible router.
    function testFork_PancakeV3AdapterRevertsOnLiveRouter() public {
        if (!live()) { vm.skip(true); return; }
        address pool = poolOf(PANCAKE_FACTORY, bytes4(keccak256("getPool(address,address,uint24)")), USDC, WETH, 500, false);
        if (pool == address(0) || pool.code.length == 0) { vm.skip(true); return; }
        try IPoolLiquidity(pool).liquidity() returns (uint128 liq) {
            if (liq == 0) { vm.skip(true); return; }
        } catch { vm.skip(true); return; }
        uint256 gross = 100e6;
        E.SwapParams memory p = E.SwapParams(PANCAKE_ROUTER, USDC, WETH, gross, gross * 25 / 10000, 1, taker, block.timestamp + 300, bytes32("fork"), false);
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = E.Hop(PANCAKE_ROUTER, WETH, E.RouterKind.PANCAKE_V3, 500, 0, false, pool);
        vm.expectRevert();
        vm.prank(taker);
        ex.swapExactInput(p, path, auth());
    }

    function testFork_TwoHopV3ThenSlipstream() public {
        if (!live()) { vm.skip(true); return; }
        address p1 = poolOf(UNI_V3_FACTORY, bytes4(keccak256("getPool(address,address,uint24)")), USDC, WETH, 500, false);
        address p2 = poolOf(SLIP_FACTORY, bytes4(keccak256("getPool(address,address,int24)")), WETH, USDC, 100, false);
        if (p1 == address(0) || p2 == address(0)) { vm.skip(true); return; }
        uint256 gross = 50e6;
        E.SwapParams memory p = E.SwapParams(UNI_V3_ROUTER, USDC, USDC, gross, gross * 25 / 10000, 1, taker, block.timestamp + 300, bytes32("fork2"), false);
        E.Hop[] memory path = new E.Hop[](2);
        path[0] = E.Hop(UNI_V3_ROUTER, WETH, E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0, false, p1);
        address p3 = poolOf(SLIP_FACTORY, bytes4(keccak256("getPool(address,address,int24)")), WETH, USDC, 100, false);
        if (p3 == address(0)) { vm.skip(true); return; }
        path[1] = E.Hop(SLIP_ROUTER, USDC, E.RouterKind.AERODROME_SLIPSTREAM, 0, 100, false, p3);
        uint256 before = IERC20(USDC).balanceOf(taker);
        vm.prank(taker);
        uint256 out = ex.swapExactInput(p, path, auth());
        assertGt(out, 0);
        assertEq(IERC20(USDC).balanceOf(taker) - (before - gross), out);
    }

    function testFork_MalformedPoolAndUnknownRouterCannotExecute() public {
        if (!live()) { vm.skip(true); return; }
        uint256 gross = 10e6;
        E.SwapParams memory p = E.SwapParams(UNI_V3_ROUTER, USDC, WETH, gross, gross * 25 / 10000, 1, taker, block.timestamp + 300, bytes32("bad"), false);
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = E.Hop(UNI_V3_ROUTER, WETH, E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0, false, USDC); // counterfeit pool
        vm.expectRevert(E.InvalidPath.selector);
        vm.prank(taker);
        ex.swapExactInput(p, path, auth());
        path[0] = E.Hop(V2_ROUTER, WETH, E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0, false, USDC); // kind/router mismatch
        vm.expectRevert();
        vm.prank(taker);
        ex.swapExactInput(p, path, auth());
    }

    function testFork_FeeGovernancePinsAndTimelock() public {
        if (!live()) { vm.skip(true); return; }
        (uint16 bps, uint16 maxBps, address rec,,, uint48 eff,) = ex.feeGovernance();
        assertEq(bps, 25); assertEq(maxBps, 100); assertEq(rec, FEE); assertEq(eff, 0);
        vm.expectRevert();
        ex.proposeFeeChange(101, FEE);
    }
}

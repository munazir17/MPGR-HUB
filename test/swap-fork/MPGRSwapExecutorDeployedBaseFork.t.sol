// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MPGRSwapExecutor as E} from "../../contracts/swap/MPGRSwapExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWETH9Fork {
    function deposit() external payable;
}

interface IPoolLiquidityFork {
    function liquidity() external view returns (uint128);
}

// Minimal 0x Settler / AllowanceHolder surface (0x-settler ISettlerActions,
// ISettlerBase, IAllowanceHolder) used to hand-encode one genuine payload.
struct TokenPermissionsFork {
    address token;
    uint256 amount;
}

struct PermitTransferFromFork {
    TokenPermissionsFork permitted;
    uint256 nonce;
    uint256 deadline;
}

interface ISettlerActionsFork {
    function TRANSFER_FROM(address recipient, PermitTransferFromFork memory permit, bytes memory sig) external;
    function UNISWAPV3(address recipient, uint256 ppm, bytes memory path, uint256 amountOutMin) external;
}

interface ISettlerFork {
    struct AllowedSlippage {
        address recipient;
        address buyToken;
        uint256 minAmountOut;
    }

    function execute(AllowedSlippage calldata slippage, bytes[] calldata actions, bytes32 zid)
        external
        payable
        returns (bool);
}

interface IAllowanceHolderFork {
    function exec(address operator, address token, uint256 amount, address payable target, bytes calldata data)
        external
        payable
        returns (bytes memory);
}

interface IERC721OwnerOfFork {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Fork verification of the DEPLOYED Base Mainnet MPGRSwapExecutor
///         (deployments/base-mainnet/mpgr-swap-executor.json): the tests call
///         the live contract at the pinned address on forked mainnet state —
///         no fresh deployment, no broadcast, no real funds. Pins below must
///         match the sealed manifest; any governance change (fee timelock,
///         pause, router updates) makes this suite fail loudly until the
///         manifest and lib/swap/swap-executor-config.ts are re-reviewed.
///         Requires BASE_MAINNET_RPC_URL; every test SKIPS honestly when the
///         env is absent or no live pool exists for the pair.
contract MPGRSwapExecutorDeployedBaseForkTest is Test {
    E ex = E(payable(0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E));

    address constant EXECUTOR = 0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E;
    address constant OWNER = 0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant MPGR = 0xB2000000000000000000008d204203177a78AF01;
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

    struct Route {
        bool found;
        address router;
        E.RouterKind kind;
        uint24 poolFee;
        int24 tickSpacing;
        bool stable;
        address pool;
    }

    function setUp() public {
        if (bytes(vm.envOr("BASE_MAINNET_RPC_URL", string(""))).length == 0) return;
        vm.createSelectFork(vm.envString("BASE_MAINNET_RPC_URL"));
        if (!live()) return;
        deal(USDC, taker, 10_000e6);
        vm.deal(taker, 100 ether);
        // Only the USDC approval is set up front (the shape the sibling
        // fork suite already proves on this RPC); WETH/MPGR approvals are
        // granted lazily inside the tests that spend them.
        vm.prank(taker);
        IERC20(USDC).approve(EXECUTOR, type(uint256).max);
    }

    function live() internal view returns (bool) {
        return EXECUTOR.code.length > 0;
    }

    function auth() internal pure returns (E.Authorization memory z) {}

    function poolOf(address factory, bytes4 sig, address a, address b, uint256 key, bool stable) internal view returns (address) {
        (bool ok, bytes memory ret) = factory.staticcall(abi.encodeWithSelector(sig, a, b, key));
        if (!ok || ret.length < 32) return address(0);
        if (sig == bytes4(keccak256("getPool(address,address,bool)"))) {
            (bool sOk, bytes memory sRet) = factory.staticcall(abi.encodeWithSelector(bytes4(keccak256("getPool(address,address,bool)")), a, b, stable));
            return sOk && sRet.length == 32 ? abi.decode(sRet, (address)) : address(0);
        }
        return abi.decode(ret, (address));
    }

    /// @dev A V3-family pool can exist with zero in-range liquidity; such a
    ///      pool can only revert a swap, so probing continues past it.
    function hasLiquidity(address pool) internal view returns (bool) {
        try IPoolLiquidityFork(pool).liquidity() returns (uint128 liq) {
            return liq > 0;
        } catch {
            return false;
        }
    }

    /// @dev Probes the five manifest venues for a direct factory-verified
    ///      pool, deep-liquidity concentrated venues first.
    function findRoute(address a, address b) internal view returns (Route memory r) {
        address pool;
        int24[6] memory spacings = [int24(100), 50, 200, 2000, 10, 1];
        for (uint256 i; i < spacings.length; ++i) {
            pool = poolOf(SLIP_FACTORY, bytes4(keccak256("getPool(address,address,int24)")), a, b, uint256(uint24(spacings[i])), false);
            if (pool != address(0) && pool.code.length > 0 && hasLiquidity(pool)) {
                return Route(true, SLIP_ROUTER, E.RouterKind.AERODROME_SLIPSTREAM, 0, spacings[i], false, pool);
            }
        }
        uint24[4] memory v3Fees = [uint24(500), 3000, 100, 10000];
        for (uint256 i; i < v3Fees.length; ++i) {
            pool = poolOf(UNI_V3_FACTORY, bytes4(keccak256("getPool(address,address,uint24)")), a, b, v3Fees[i], false);
            if (pool != address(0) && pool.code.length > 0 && hasLiquidity(pool)) {
                return Route(true, UNI_V3_ROUTER, E.RouterKind.UNISWAP_V3_ROUTER02, v3Fees[i], 0, false, pool);
            }
        }
        // Pancake V3 is intentionally NOT probed as a usable route: the
        // deployed adapter's no-deadline exactInputSingle does not match
        // the live router's deadline-bearing ABI (see the dedicated
        // known-revert tripwire test below).
        pool = poolOf(CLASSIC_FACTORY, bytes4(keccak256("getPool(address,address,bool)")), a, b, 0, false);
        if (pool != address(0) && pool.code.length > 0) {
            return Route(true, CLASSIC_ROUTER, E.RouterKind.AERODROME_CLASSIC, 0, 0, false, pool);
        }
        pool = poolOf(V2_FACTORY, bytes4(keccak256("getPair(address,address)")), a, b, 0, false);
        if (pool != address(0) && pool.code.length > 0) {
            return Route(true, V2_ROUTER, E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false, pool);
        }
    }

    function swap1(address tokenIn, address tokenOut, uint256 gross, Route memory r) internal returns (uint256) {
        uint256 feeAmt = gross * 25 / 10000;
        E.SwapParams memory p =
            E.SwapParams(r.router, tokenIn, tokenOut, gross, feeAmt, 1, taker, block.timestamp + 300, bytes32("deployed"), false);
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = E.Hop(r.router, tokenOut, r.kind, r.poolFee, r.tickSpacing, r.stable, r.pool);
        vm.prank(taker);
        return ex.swapExactInput(p, path, auth());
    }

    function swap2(address tokenIn, address bridge, address tokenOut, uint256 gross, Route memory leg1, Route memory leg2)
        internal
        returns (uint256)
    {
        uint256 feeAmt = gross * 25 / 10000;
        E.SwapParams memory p =
            E.SwapParams(leg1.router, tokenIn, tokenOut, gross, feeAmt, 1, taker, block.timestamp + 300, bytes32("deployed"), false);
        E.Hop[] memory path = new E.Hop[](2);
        path[0] = E.Hop(leg1.router, bridge, leg1.kind, leg1.poolFee, leg1.tickSpacing, leg1.stable, leg1.pool);
        path[1] = E.Hop(leg2.router, tokenOut, leg2.kind, leg2.poolFee, leg2.tickSpacing, leg2.stable, leg2.pool);
        vm.prank(taker);
        return ex.swapExactInput(p, path, auth());
    }

    /// @notice Every manifest pin must match the live contract exactly.
    function testFork_Deployed_PosturePins() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        assertEq(ex.owner(), OWNER, "owner is the governance Safe");
        assertEq(uint256(ex.feeBps()), 25, "fee 25 bps");
        assertEq(uint256(ex.MAX_FEE_BPS()), 100, "hard cap 100 bps");
        assertEq(uint256(ex.FEE_TIMELOCK_SECONDS()), 172800, "48h timelock");
        assertEq(uint256(ex.pendingEffectiveAt()), 0, "no pending fee change");
        assertEq(ex.feeRecipient(), FEE, "fee recipient pin");
        assertEq(address(ex.WETH()), WETH, "WETH pin");
        assertEq(address(ex.PERMIT2()), PERMIT2, "Permit2 pin");
        assertFalse(ex.paused(), "executor is not paused");
        assertTrue(ex.routerKind(UNI_V3_ROUTER) == E.RouterKind.UNISWAP_V3_ROUTER02, "uniswap v3 kind");
        assertEq(ex.routerFactory(UNI_V3_ROUTER), UNI_V3_FACTORY, "uniswap v3 factory");
        assertTrue(ex.routerKind(SLIP_ROUTER) == E.RouterKind.AERODROME_SLIPSTREAM, "slipstream kind");
        assertEq(ex.routerFactory(SLIP_ROUTER), SLIP_FACTORY, "slipstream factory");
        assertTrue(ex.routerKind(V2_ROUTER) == E.RouterKind.UNISWAP_V2_ROUTER02, "uniswap v2 kind");
        assertEq(ex.routerFactory(V2_ROUTER), V2_FACTORY, "uniswap v2 factory");
        assertTrue(ex.routerKind(CLASSIC_ROUTER) == E.RouterKind.AERODROME_CLASSIC, "classic kind");
        assertEq(ex.routerFactory(CLASSIC_ROUTER), CLASSIC_FACTORY, "classic factory");
        assertTrue(ex.routerKind(PANCAKE_ROUTER) == E.RouterKind.PANCAKE_V3, "pancake kind");
        assertEq(ex.routerFactory(PANCAKE_ROUTER), PANCAKE_FACTORY, "pancake factory");
        (uint256 fee, uint256 swapAmount) = ex.quoteFee(1_000_000);
        assertEq(fee, 2_500, "quoteFee exact floor");
        assertEq(swapAmount, 997_500, "quoteFee swap amount");
    }

    function testFork_Deployed_UsdcToWeth() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        Route memory r = findRoute(USDC, WETH);
        if (!r.found) {
            vm.skip(true);
            return;
        }
        uint256 gross = 100e6;
        uint256 feeAmt = gross * 25 / 10000;
        uint256 wethBefore = IERC20(WETH).balanceOf(taker);
        uint256 feeBefore = IERC20(USDC).balanceOf(FEE);
        uint256 out = swap1(USDC, WETH, gross, r);
        assertGt(out, 0, "measured output");
        assertEq(IERC20(WETH).balanceOf(taker) - wethBefore, out, "taker receives measured WETH");
        assertEq(IERC20(USDC).balanceOf(FEE) - feeBefore, feeAmt, "atomic 25bps fee delivered in USDC");
    }

    function testFork_Deployed_WethToUsdc() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        Route memory r = findRoute(WETH, USDC);
        if (!r.found) {
            vm.skip(true);
            return;
        }
        vm.prank(taker);
        IWETH9Fork(WETH).deposit{value: 1 ether}();
        vm.prank(taker);
        IERC20(WETH).approve(EXECUTOR, type(uint256).max);
        uint256 gross = 0.1 ether;
        uint256 feeAmt = gross * 25 / 10000;
        uint256 usdcBefore = IERC20(USDC).balanceOf(taker);
        uint256 feeBefore = IERC20(WETH).balanceOf(FEE);
        uint256 out = swap1(WETH, USDC, gross, r);
        assertGt(out, 0, "measured output");
        assertEq(IERC20(USDC).balanceOf(taker) - usdcBefore, out, "taker receives measured USDC");
        assertEq(IERC20(WETH).balanceOf(FEE) - feeBefore, feeAmt, "atomic 25bps fee delivered in WETH");
    }

    function testFork_Deployed_NativeEthIn() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        Route memory r = findRoute(WETH, USDC);
        if (!r.found) {
            vm.skip(true);
            return;
        }
        uint256 gross = 0.1 ether;
        uint256 feeAmt = gross * 25 / 10000;
        E.SwapParams memory p =
            E.SwapParams(r.router, WETH, USDC, gross, feeAmt, 1, taker, block.timestamp + 300, bytes32("deployed"), false);
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = E.Hop(r.router, USDC, r.kind, r.poolFee, r.tickSpacing, r.stable, r.pool);
        uint256 ethBefore = taker.balance;
        uint256 usdcBefore = IERC20(USDC).balanceOf(taker);
        uint256 feeEthBefore = FEE.balance;
        vm.prank(taker);
        uint256 out = ex.swapExactInput{value: gross}(p, path, auth());
        assertGt(out, 0, "measured output");
        assertEq(ethBefore - taker.balance, gross, "exactly the gross ETH was consumed");
        assertEq(IERC20(USDC).balanceOf(taker) - usdcBefore, out, "taker receives measured USDC");
        assertEq(FEE.balance - feeEthBefore, feeAmt, "native-in fee delivered in ETH");
    }

    function testFork_Deployed_NativeEthOut() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        Route memory r = findRoute(USDC, WETH);
        if (!r.found) {
            vm.skip(true);
            return;
        }
        uint256 gross = 100e6;
        uint256 feeAmt = gross * 25 / 10000;
        E.SwapParams memory p =
            E.SwapParams(r.router, USDC, WETH, gross, feeAmt, 1, taker, block.timestamp + 300, bytes32("deployed"), true);
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = E.Hop(r.router, WETH, r.kind, r.poolFee, r.tickSpacing, r.stable, r.pool);
        uint256 ethBefore = taker.balance;
        uint256 wethBefore = IERC20(WETH).balanceOf(taker);
        vm.prank(taker);
        uint256 out = ex.swapExactInput(p, path, auth());
        assertGt(out, 0, "measured output");
        assertEq(taker.balance - ethBefore, out, "taker receives unwrapped native ETH");
        assertEq(IERC20(WETH).balanceOf(taker), wethBefore, "no WETH is left with the taker");
    }

    /// @notice KNOWN LIMITATION tripwire at the DEPLOYED address: the
    ///         executor's Pancake adapter encodes the no-deadline
    ///         exactInputSingle, but the live PancakeSwap V3 SwapRouter
    ///         (0x1b81D678…) requires the deadline-bearing struct (a
    ///         different selector — verified against its verified source,
    ///         2026-10-19), so Pancake swaps revert. The app never quotes
    ///         Pancake candidates. Flip this to a success assertion in the
    ///         same change that (via governance) re-registers PANCAKE_V3
    ///         to a compatible router.
    function testFork_Deployed_PancakeVenueRevertsKnown() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        address pool = poolOf(PANCAKE_FACTORY, bytes4(keccak256("getPool(address,address,uint24)")), USDC, WETH, 500, false);
        if (pool == address(0) || pool.code.length == 0 || !hasLiquidity(pool)) {
            vm.skip(true);
            return;
        }
        uint256 gross = 100e6;
        Route memory r = Route(true, PANCAKE_ROUTER, E.RouterKind.PANCAKE_V3, 500, 0, false, pool);
        E.SwapParams memory p =
            E.SwapParams(r.router, USDC, WETH, gross, gross * 25 / 10000, 1, taker, block.timestamp + 300, bytes32("deployed"), false);
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = E.Hop(r.router, WETH, r.kind, r.poolFee, r.tickSpacing, r.stable, r.pool);
        vm.expectRevert();
        vm.prank(taker);
        ex.swapExactInput(p, path, auth());
    }

    /// @notice Both MPGR directions through the deployed executor: buy MPGR
    ///         with USDC, then sell half back. Direct venues are probed first,
    ///         then a typed two-hop route via WETH. Skips honestly if no
    ///         factory-verified pool exists for the pair right now.
    function testFork_Deployed_UsdcToMpgr_AndBack() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        uint256 gross = 50e6;
        uint256 feeAmt = gross * 25 / 10000;
        uint256 feeBefore = IERC20(USDC).balanceOf(FEE);
        uint256 mpgrOut;
        Route memory direct = findRoute(USDC, MPGR);
        if (direct.found) {
            mpgrOut = swap1(USDC, MPGR, gross, direct);
        } else {
            Route memory leg1 = findRoute(USDC, WETH);
            Route memory leg2 = findRoute(WETH, MPGR);
            if (!leg1.found || !leg2.found) {
                vm.skip(true);
                return;
            }
            mpgrOut = swap2(USDC, WETH, MPGR, gross, leg1, leg2);
        }
        assertGt(mpgrOut, 0, "measured MPGR output");
        assertEq(IERC20(MPGR).balanceOf(taker), mpgrOut, "taker receives measured MPGR");
        assertEq(IERC20(USDC).balanceOf(FEE) - feeBefore, feeAmt, "buy fee delivered in USDC");

        vm.prank(taker);
        IERC20(MPGR).approve(EXECUTOR, type(uint256).max);
        uint256 sellGross = mpgrOut / 2;
        if (sellGross * 25 / 10000 == 0) {
            vm.skip(true);
            return;
        }
        uint256 sellFee = sellGross * 25 / 10000;
        uint256 feeMpgrBefore = IERC20(MPGR).balanceOf(FEE);
        uint256 usdcBefore = IERC20(USDC).balanceOf(taker);
        uint256 usdcOut;
        Route memory back = findRoute(MPGR, USDC);
        if (back.found) {
            usdcOut = swap1(MPGR, USDC, sellGross, back);
        } else {
            Route memory b1 = findRoute(MPGR, WETH);
            Route memory b2 = findRoute(WETH, USDC);
            if (!b1.found || !b2.found) {
                vm.skip(true);
                return;
            }
            usdcOut = swap2(MPGR, WETH, USDC, sellGross, b1, b2);
        }
        assertGt(usdcOut, 0, "measured USDC output on sell-back");
        assertEq(IERC20(USDC).balanceOf(taker) - usdcBefore, usdcOut, "taker receives measured USDC");
        assertEq(IERC20(MPGR).balanceOf(FEE) - feeMpgrBefore, sellFee, "sell fee delivered in MPGR");
    }

    // ---- Aggregator (0x Settler) leg — known-inoperable tripwires ----
    //
    // The deployed swapViaAggregator authenticates agg.target against the
    // 0x registry (ownerOf(2) = taker-submitted Settler) and calls it
    // DIRECTLY with agg.data, after exact-approving (G - fee) to
    // AllowanceHolder. A genuine 0x payload, however, only moves funds when
    // routed through AllowanceHolder.exec(...): the holder records an
    // ephemeral (transient) allowance that the Settler later debits via
    // holder.transferFrom. Called directly, the Settler has no ephemeral
    // allowance to debit (the ERC-20 approval alone is inert), and the
    // Permit2 fallback needs a signature from the payer — the executor —
    // which cannot sign. So no genuine payload can settle through
    // swapViaAggregator as deployed; any attempt reverts atomically and no
    // funds move. The control test proves the payload itself is genuine.

    address constant HOLDER = 0x0000000000001fF3684f28c67538d4D072C22734;
    address constant SETTLER_DEPLOYER = 0x00000000000004533Fe15556B1E086BB1A72cEae;

    function liveSettler() internal view returns (address settler) {
        try IERC721OwnerOfFork(SETTLER_DEPLOYER).ownerOf(2) returns (address s) {
            settler = s;
        } catch {}
    }

    /// @dev One genuine 0x payload (the 0x-settler AllowanceHolderPairTest
    ///      pattern): TRANSFER_FROM into the Settler, then a single-hop
    ///      UniV3 (forkId 0) USDC->WETH 500-tier swap paying the taker.
    function settlerExecuteData(address settler, uint256 amount) internal view returns (bytes memory) {
        bytes memory v3Path = abi.encodePacked(
            USDC, uint8(0), uint24(500), uint160(1461446703485210103287273052203988822378723970341), WETH
        );
        bytes[] memory actions = new bytes[](2);
        actions[0] = abi.encodeCall(
            ISettlerActionsFork.TRANSFER_FROM,
            (settler, PermitTransferFromFork(TokenPermissionsFork(USDC, amount), 0, block.timestamp + 300), bytes(""))
        );
        actions[1] = abi.encodeCall(ISettlerActionsFork.UNISWAPV3, (taker, 1_000_000, v3Path, uint256(0)));
        return abi.encodeCall(
            ISettlerFork.execute, (ISettlerFork.AllowedSlippage(address(0), address(0), 0), actions, bytes32(0))
        );
    }

    function settlerFixtures() internal view returns (address settler, bool ready) {
        settler = liveSettler();
        address pool = poolOf(UNI_V3_FACTORY, bytes4(keccak256("getPool(address,address,uint24)")), USDC, WETH, 500, false);
        ready = settler != address(0) && pool != address(0) && pool.code.length > 0 && hasLiquidity(pool);
    }

    /// @notice CONTROL: the hand-encoded payload is genuine — it settles end
    ///         to end when submitted the way 0x designs it (through
    ///         AllowanceHolder.exec by the taker directly).
    function testFork_Deployed_SettlerControlSettlesDirectly() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        (address settler, bool ready) = settlerFixtures();
        if (!ready) {
            vm.skip(true);
            return;
        }
        uint256 amount = 100e6;
        bytes memory executeData = settlerExecuteData(settler, amount);
        vm.startPrank(taker, taker);
        IERC20(USDC).approve(HOLDER, amount);
        uint256 wethBefore = IERC20(WETH).balanceOf(taker);
        IAllowanceHolderFork(HOLDER).exec(settler, USDC, amount, payable(settler), executeData);
        vm.stopPrank();
        assertGt(IERC20(WETH).balanceOf(taker) - wethBefore, 0, "genuine payload settles via holder.exec");
    }

    /// @notice KNOWN LIMITATION (tripwire): neither feedable payload shape
    ///         can settle through the deployed swapViaAggregator — (1) the
    ///         API shape (target = AllowanceHolder, data = exec(...)) fails
    ///         the executor's own registry authentication, and (2) the
    ///         executor's shape (target = Settler, data = execute(...))
    ///         authenticates but reverts in the Settler payment step. Both
    ///         revert atomically with no funds moved. If a future executor
    ///         fixes the mechanics, this test must flip to success
    ///         assertions in the same reviewed change.
    function testFork_Deployed_AggregatorShapesRevertKnown() public {
        if (!live()) {
            vm.skip(true);
            return;
        }
        (address settler, bool ready) = settlerFixtures();
        if (!ready) {
            vm.skip(true);
            return;
        }
        uint256 gross = 100e6;
        uint256 net = gross - gross * 25 / 10000;
        bytes memory executeData = settlerExecuteData(settler, net);
        uint256 usdcBefore = IERC20(USDC).balanceOf(taker);
        uint256 feeBefore = IERC20(USDC).balanceOf(FEE);

        // (1) API shape: rejected by the executor's registry check.
        bytes memory execData = abi.encodeCall(IAllowanceHolderFork.exec, (settler, USDC, net, payable(settler), executeData));
        E.SwapParams memory p1 =
            E.SwapParams(HOLDER, USDC, WETH, gross, gross * 25 / 10000, 1, taker, block.timestamp + 300, bytes32("deployed"), false);
        E.AggregatorCall memory agg1 = E.AggregatorCall(HOLDER, execData, block.timestamp + 300);
        vm.expectRevert();
        vm.prank(taker);
        ex.swapViaAggregator(p1, agg1, auth());

        // (2) Executor shape: authenticates, then the Settler reverts.
        E.SwapParams memory p2 =
            E.SwapParams(settler, USDC, WETH, gross, gross * 25 / 10000, 1, taker, block.timestamp + 300, bytes32("deployed"), false);
        E.AggregatorCall memory agg2 = E.AggregatorCall(settler, executeData, block.timestamp + 300);
        vm.expectRevert();
        vm.prank(taker);
        ex.swapViaAggregator(p2, agg2, auth());

        // Atomic: no funds moved and no fee collected in either failed shape.
        assertEq(IERC20(USDC).balanceOf(taker), usdcBefore, "reverted aggregator shapes move no taker funds");
        assertEq(IERC20(USDC).balanceOf(FEE), feeBefore, "reverted aggregator shapes collect no fee");
    }
}

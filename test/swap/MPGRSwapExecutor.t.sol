// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MPGRSwapExecutor as E} from "../../contracts/swap/MPGRSwapExecutor.sol";
import {
    MockPermitToken,
    MockWETH9,
    MockPermit2,
    MockRouterBase,
    MockSlipstreamRouter,
    MockUniswapV3Router02
} from "../executor/mocks/ExecutorMocks.sol";

/// @dev Deterministic typed V2 fixture, not a Base pool/router or settlement proof.
contract MockSwapV2Router is MockRouterBase {
    address public lastPathIn;
    address public lastPathOut;

    function swapExactTokensForTokens(
        uint256 amount,
        uint256 minimum,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2, "exactly one pair");
        require(deadline >= block.timestamp, "expired");
        lastDeadline = deadline;
        lastPathIn = path[0];
        lastPathOut = path[1];
        uint256 out = _swap(path[0], path[1], to, amount, minimum, 0);
        amounts = new uint256[](2);
        amounts[0] = amount;
        amounts[1] = out;
    }
}

/// @dev Deterministic Aerodrome Classic fixture (Route[] shape only).
contract MockClassicRouter is MockRouterBase {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }
    address public lastFrom;
    address public lastTo;
    bool public lastStable;
    address public lastFactory;

    function swapExactTokensForTokens(
        uint256 amount,
        uint256 minimum,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(routes.length == 1, "exactly one route");
        require(deadline >= block.timestamp, "expired");
        lastDeadline = deadline;
        lastFrom = routes[0].from;
        lastTo = routes[0].to;
        lastStable = routes[0].stable;
        lastFactory = routes[0].factory;
        uint256 out = _swap(routes[0].from, routes[0].to, to, amount, minimum, 0);
        amounts = new uint256[](2);
        amounts[0] = amount;
        amounts[1] = out;
    }
}

contract MockPool {}

/// @dev One hub answering every factory shape the executor validates against.
contract MockFactoryHub {
    mapping(bytes32 => address) public poolOf;

    function key(address a, address b, bytes32 tag) internal pure returns (bytes32) {
        return keccak256(abi.encode(a < b ? a : b, a < b ? b : a, tag));
    }

    function set(address a, address b, bytes32 tag, address pool) external {
        poolOf[key(a, b, tag)] = pool;
    }

    function getPair(address a, address b) external view returns (address) {
        return poolOf[key(a, b, "v2")];
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return poolOf[key(a, b, keccak256(abi.encodePacked("v3", fee)))];
    }

    function getPool(address a, address b, int24 spacing) external view returns (address) {
        return poolOf[key(a, b, keccak256(abi.encodePacked("slip", spacing)))];
    }

    function getPool(address a, address b, bool stable) external view returns (address) {
        return poolOf[key(a, b, stable ? bytes32("stable") : bytes32("volatile"))];
    }
}

/// @notice Release-candidate executor: fixed 25 bps fee, typed 1-3 hop paths.
///         NOT DEPLOYED. Mock venues are fixtures, not Base pools.
contract MPGRSwapExecutorTest is Test {
    E ex;
    MockPermitToken a;
    MockPermitToken b;
    MockWETH9 w;
    MockSwapV2Router v2;
    MockClassicRouter classic;
    MockSlipstreamRouter slip;
    MockUniswapV3Router02 uni;
    MockFactoryHub hub;
    MockPool pool;
    address taker = address(0xA11CE);
    address stranger = address(0xB0B);
    address fee = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    uint256 constant G = 1_000_000;

    function setUp() public {
        a = new MockPermitToken("USDC mock", "USDC", 6);
        b = new MockPermitToken("Arbitrary token mock", "TOKEN", 18);
        w = new MockWETH9();
        v2 = new MockSwapV2Router();
        classic = new MockClassicRouter();
        slip = new MockSlipstreamRouter();
        uni = new MockUniswapV3Router02();
        hub = new MockFactoryHub();
        pool = new MockPool();
        E.RouterConfig[] memory routers = new E.RouterConfig[](4);
        routers[0] = E.RouterConfig(address(v2), E.RouterKind.UNISWAP_V2_ROUTER02, address(hub));
        routers[1] = E.RouterConfig(address(classic), E.RouterKind.AERODROME_CLASSIC, address(hub));
        routers[2] = E.RouterConfig(address(slip), E.RouterKind.AERODROME_SLIPSTREAM, address(hub));
        routers[3] = E.RouterConfig(address(uni), E.RouterKind.UNISWAP_V3_ROUTER02, address(hub));
        ex = new E(address(this), address(w), address(new MockPermit2()), routers, 25, fee);
        a.mint(taker, 1e24);
        b.mint(taker, 1e24);
        address[4] memory venues = [address(v2), address(classic), address(slip), address(uni)];
        for (uint256 i; i < 4; i++) {
            a.mint(venues[i], 1e24);
            b.mint(venues[i], 1e24);
            w.deposit{value: 1e23}();
            w.transfer(venues[i], 1e22);
        }
        vm.deal(taker, 100 ether);
        vm.startPrank(taker);
        a.approve(address(ex), type(uint256).max);
        b.approve(address(ex), type(uint256).max);
        w.deposit{value: 10 ether}();
        w.approve(address(ex), type(uint256).max);
        vm.stopPrank();
        // Canonical pool registrations the typed hops must match exactly.
        hub.set(address(a), address(b), bytes32("v2"), address(pool));
        hub.set(address(a), address(w), bytes32("v2"), address(pool));
        hub.set(address(w), address(b), bytes32("v2"), address(pool));
        hub.set(address(a), address(b), bytes32("volatile"), address(pool));
        hub.set(address(a), address(b), bytes32("stable"), address(pool));
        hub.set(address(a), address(w), keccak256(abi.encodePacked("v3", uint24(500))), address(pool));
        hub.set(address(w), address(b), keccak256(abi.encodePacked("slip", int24(10))), address(pool));
    }

    function params(address sell, address buy, uint256 gross, bool nativeOut)
        internal
        view
        returns (E.SwapParams memory)
    {
        return E.SwapParams(
            address(v2),
            sell,
            buy,
            gross,
            gross * 25 / 10000,
            1,
            taker,
            block.timestamp + 300,
            bytes32("swap-executor-rc"),
            nativeOut
        );
    }

    function auth() internal pure returns (E.Authorization memory v) {
        v.kind = E.AuthKind.APPROVAL;
    }

    function hop(address router, address out, E.RouterKind kind, uint24 poolFee, int24 spacing, bool stable)
        internal
        view
        returns (E.Hop memory)
    {
        return E.Hop(router, out, kind, poolFee, spacing, stable, address(pool));
    }

    function oneHop(E.SwapParams memory p, E.Hop memory h) internal returns (uint256 out) {
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = h;
        p.router = h.router;
        vm.prank(taker);
        out = ex.swapExactInput(p, path, auth());
    }

    function testFuzzDirectV2AndClassicFloorFee(uint96 raw, bool sell, bool stable) public {
        uint256 gross = bound(uint256(raw), 400, 1e20);
        MockPermitToken input = sell ? b : a;
        MockPermitToken output = sell ? a : b;
        E.SwapParams memory p = params(address(input), address(output), gross, false);
        E.Hop memory h = stable
            ? hop(address(classic), address(output), E.RouterKind.AERODROME_CLASSIC, 0, 0, stable)
            : hop(address(v2), address(output), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        hub.set(address(input), address(output), stable ? bytes32("stable") : bytes32("v2"), address(pool));
        uint256 before = output.balanceOf(taker);
        uint256 out = oneHop(p, h);
        assertEq(out, gross - gross * 25 / 10000, "net after floor fee");
        assertEq(output.balanceOf(fee), 0, "fee is taken in the sell token");
        assertEq(input.balanceOf(fee), gross * 25 / 10000, "floor(gross*25/10000)");
        assertEq(output.balanceOf(taker) - before, out);
        assertEq(input.allowance(address(ex), h.router), 0, "no dangling router allowance");
    }

    function testDirectV3AndSlipstreamMeasuredOutput() public {
        E.SwapParams memory p = params(address(a), address(w), G, false);
        uint256 out = oneHop(p, hop(address(uni), address(w), E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0, false));
        assertEq(out, G - G * 25 / 10000);
        assertEq(uni.lastFee(), 500);
        p = params(address(w), address(b), G, false);
        out = oneHop(p, hop(address(slip), address(b), E.RouterKind.AERODROME_SLIPSTREAM, 0, 10, false));
        assertEq(out, G - G * 25 / 10000);
        assertEq(slip.lastTickSpacing(), 10);
    }

    function testTwoHopMixedV2ThenSlipChargesFeeOnce() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        E.Hop[] memory path = new E.Hop[](2);
        path[0] = hop(address(v2), address(w), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        path[1] = hop(address(slip), address(b), E.RouterKind.AERODROME_SLIPSTREAM, 0, 10, false);
        p.router = path[0].router;
        vm.prank(taker);
        uint256 out = ex.swapExactInput(p, path, auth());
        assertEq(out, G - G * 25 / 10000);
        assertEq(a.balanceOf(fee), G * 25 / 10000, "single atomic fee on gross");
        assertEq(w.balanceOf(address(ex)), 0, "bridge fully consumed");
        assertEq(w.allowance(address(ex), address(slip)), 0);
        assertEq(v2.lastRecipient(), address(ex), "bridge stays inside executor");
        assertEq(slip.lastRecipient(), taker, "final output to taker");
        assertEq(v2.lastAmountOutMinimum(), 1, "intermediate hop has no taker minimum");
        assertEq(slip.lastAmountOutMinimum(), 1, "final minimum from params");
    }

    function testThreeHopV2V3SlipAndPathCycleGuards() public {
        MockPermitToken c = new MockPermitToken("Third mock", "C", 18); // permissionless: no allowlist call
        hub.set(address(w), address(b), keccak256(abi.encodePacked("v3", uint24(3000))), address(pool));
        hub.set(address(b), address(c), keccak256(abi.encodePacked("slip", int24(10))), address(pool));
        c.mint(address(slip), 1e24);
        E.SwapParams memory p = params(address(a), address(c), G, false);
        E.Hop[] memory path = new E.Hop[](3);
        path[0] = hop(address(v2), address(w), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        path[1] = hop(address(uni), address(b), E.RouterKind.UNISWAP_V3_ROUTER02, 3000, 0, false);
        path[2] = hop(address(slip), address(c), E.RouterKind.AERODROME_SLIPSTREAM, 0, 10, false);
        p.router = path[0].router;
        vm.prank(taker);
        uint256 out = ex.swapExactInput(p, path, auth());
        assertEq(out, G - G * 25 / 10000, "fee once across three venues");
        assertEq(a.balanceOf(fee), G * 25 / 10000);
        assertEq(w.balanceOf(address(ex)), 0);
        assertEq(b.balanceOf(address(ex)), 0);
        // Cycles / repeats are rejected: intermediate equals input or output.
        E.Hop[] memory bad = new E.Hop[](3);
        bad[0] = hop(address(v2), address(w), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        bad[1] = hop(address(uni), address(a), E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0, false);
        bad[2] = hop(address(slip), address(c), E.RouterKind.AERODROME_SLIPSTREAM, 0, 10, false);
        vm.expectRevert(E.InvalidPath.selector);
        ex.swapExactInput(p, bad, auth());
        bad[1] = hop(address(uni), address(c), E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0, false);
        vm.prank(taker);
        vm.expectRevert(E.InvalidPath.selector);
        ex.swapExactInput(p, bad, auth());
    }

    function testPathShapeLimits() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        E.Hop[] memory empty = new E.Hop[](0);
        vm.prank(taker);
        vm.expectRevert(E.InvalidPath.selector);
        ex.swapExactInput(p, empty, auth());
        E.Hop[] memory four = new E.Hop[](4);
        for (uint256 i; i < 4; i++) four[i] = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.prank(taker);
        vm.expectRevert(E.InvalidPath.selector);
        ex.swapExactInput(p, four, auth());
        E.Hop[] memory one = new E.Hop[](1);
        one[0] = hop(address(v2), address(a), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.prank(taker);
        vm.expectRevert(E.InvalidPath.selector);
        ex.swapExactInput(p, one, auth());
        one[0] = hop(address(slip), address(b), E.RouterKind.AERODROME_SLIPSTREAM, 0, 10, false);
        vm.prank(taker);
        vm.expectRevert(E.InvalidPath.selector);
        ex.swapExactInput(p, one, auth());
    }

    function testHopPoolAndKindValidation() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        h.pool = address(hub); // real contract but not the factory-registered pair
        vm.expectRevert(E.InvalidPath.selector);
        oneHop(p, h);
        h.pool = address(0);
        vm.expectRevert(E.InvalidPath.selector);
        oneHop(p, h);
        h = hop(address(v2), address(b), E.RouterKind.AERODROME_SLIPSTREAM, 0, 10, false);
        vm.expectRevert(abi.encodeWithSelector(E.RouterNotAllowed.selector, address(v2), E.RouterKind.AERODROME_SLIPSTREAM));
        oneHop(p, h);
        h = hop(address(stranger), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert(abi.encodeWithSelector(E.RouterNotAllowed.selector, stranger, E.RouterKind.UNISWAP_V2_ROUTER02));
        oneHop(p, h);
        h = hop(address(uni), address(b), E.RouterKind.UNISWAP_V3_ROUTER02, 300, 0, false);
        vm.expectRevert(abi.encodeWithSelector(E.InvalidPoolFee.selector, 300));
        oneHop(p, h);
        h = hop(address(slip), address(b), E.RouterKind.AERODROME_SLIPSTREAM, 0, 0, false);
        vm.expectRevert(abi.encodeWithSelector(E.InvalidTickSpacing.selector, 0));
        oneHop(p, h);
        h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, true);
        vm.expectRevert(E.InvalidPath.selector);
        oneHop(p, h);
        h = hop(address(classic), address(b), E.RouterKind.AERODROME_CLASSIC, 500, 0, false);
        vm.expectRevert(E.InvalidPath.selector);
        oneHop(p, h);
    }

    function testPermissionlessNeverSeenTokenTradesWithoutAllowlist() public {
        MockPermitToken c = new MockPermitToken("Brand new", "NEW", 18);
        hub.set(address(a), address(c), bytes32("v2"), address(pool));
        c.mint(address(v2), 1e24);
        E.SwapParams memory p = params(address(a), address(c), G, false);
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = hop(address(v2), address(c), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        p.router = path[0].router;
        vm.prank(taker);
        uint256 out = ex.swapExactInput(p, path, auth());
        assertGt(out, 0, "never-allowlisted token executed");
        assertEq(c.balanceOf(taker), out);
    }

    function testInfrastructureAndCodelessAccountsCannotPoseAsTokens() public {
        // p.tokenOut mirrors the hostile hop output so the path-shape guard
        // passes and the typed token validation is what rejects the hop.
        E.SwapParams memory p = params(address(a), address(v2), G, false);
        E.Hop memory h = hop(address(v2), address(v2), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert(abi.encodeWithSelector(E.TokenIsInfrastructure.selector, address(v2)));
        oneHop(p, h);
        p = params(address(a), address(ex), G, false);
        h = hop(address(v2), address(ex), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert(abi.encodeWithSelector(E.TokenIsInfrastructure.selector, address(ex)));
        oneHop(p, h);
        p = params(address(a), stranger, G, false);
        h = hop(address(v2), stranger, E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert(abi.encodeWithSelector(E.TokenNotAContract.selector, stranger));
        oneHop(p, h);
    }

    function testMeasuredOutputDefendsAgainstLyingRouter() public {
        uni.setMode(MockRouterBase.Mode.LIE_ABOUT_OUTPUT);
        E.SwapParams memory p = params(address(a), address(w), G, false);
        E.Hop memory h = hop(address(uni), address(w), E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0, false);
        uint256 before = w.balanceOf(taker);
        uint256 out = oneHop(p, h);
        assertEq(out, (G - G * 25 / 10000) / 2, "measured balance delta, not router claim");
        assertEq(w.balanceOf(taker) - before, out);
    }

    function testRedirectedOrShortOutputReverts() public {
        uni.setMode(MockRouterBase.Mode.REDIRECT_OUTPUT);
        uni.setAttack(stranger, taker);
        E.SwapParams memory p = params(address(a), address(w), G, false);
        E.Hop memory h = hop(address(uni), address(w), E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0, false);
        vm.expectRevert(E.ZeroAmount.selector);
        oneHop(p, h);
        uni.setMode(MockRouterBase.Mode.LIE_ABOUT_OUTPUT);
        uint256 net = G - G * 25 / 10000;
        p.amountOutMinimum = net;
        vm.expectRevert(abi.encodeWithSelector(E.InsufficientOutput.selector, net / 2, net));
        oneHop(p, h);
    }

    function testIntermediateHopZeroOutputReverts() public {
        v2.setMode(MockRouterBase.Mode.REDIRECT_OUTPUT);
        v2.setAttack(stranger, taker);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        E.Hop[] memory path = new E.Hop[](2);
        path[0] = hop(address(v2), address(w), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        path[1] = hop(address(slip), address(b), E.RouterKind.AERODROME_SLIPSTREAM, 0, 10, false);
        p.router = path[0].router;
        vm.prank(taker);
        vm.expectRevert(E.ZeroAmount.selector);
        ex.swapExactInput(p, path, auth());
    }

    function testRouterReturningInputIsCaught() public {
        v2.setMode(MockRouterBase.Mode.RETURN_INPUT);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert();
        oneHop(p, h);
    }

    function testNativeInputAndOutput() public {
        uint256 gross = 0.0001 ether;
        uint256 feeBefore = fee.balance;
        E.SwapParams memory p = params(address(w), address(b), gross, false);
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        p.router = h.router;
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = h;
        vm.prank(taker);
        ex.swapExactInput{value: gross}(p, path, auth());
        assertEq(fee.balance - feeBefore, gross * 25 / 10000, "atomic native fee");
        assertEq(w.balanceOf(address(ex)), 0);

        p = params(address(a), address(w), G, true);
        E.Hop memory h2 = hop(address(v2), address(w), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        uint256 before = taker.balance;
        uint256 out = oneHop(p, h2);
        assertEq(taker.balance - before, out, "unwrapped native delivered");
        assertEq(a.balanceOf(fee), G * 25 / 10000, "second fee in the sell token");
    }

    function testNativeValueMismatchAndUnwrapRules() public {
        E.SwapParams memory p = params(address(w), address(b), G, false);
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        E.Hop[] memory path = new E.Hop[](1);
        path[0] = h;
        p.router = h.router;
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(E.NativeValueMismatch.selector, G - 1, G));
        ex.swapExactInput{value: G - 1}(p, path, auth());
        p = params(address(a), address(b), G, true);
        vm.prank(taker);
        vm.expectRevert(E.UnwrapRequiresWethOut.selector);
        ex.swapExactInput(p, path, auth());
    }

    function testFeeQuoteMatchesExactFloorArithmetic() public view {
        assertEq(ex.feeBps(), 25);
        assertEq(ex.feeRecipient(), fee);
        assertEq(ex.MAX_FEE_BPS(), 100);
        assertEq(ex.FEE_TIMELOCK_SECONDS(), 48 hours);
        (uint256 paid, uint256 net) = ex.quoteFee(type(uint256).max);
        assertEq(paid, (type(uint256).max / 10000) * 25 + ((type(uint256).max % 10000) * 25) / 10000);
        assertEq(net, type(uint256).max - paid);
        (paid, net) = ex.quoteFee(399);
        assertEq(paid, 0, "dust below one fee unit");
        assertEq(net, 399);
    }

    function testFeeGovernanceRequiresTimelockAndRespectsHardCap() public {
        address treasury2 = address(0xC0FFEE);
        // No pending change at birth and no immediate mutation path exists.
        (uint16 cBps, uint16 cMax, address cRec, uint16 nBps, address nRec, uint48 effAt, uint48 tl) = ex.feeGovernance();
        assertEq(cBps, 25); assertEq(cMax, 100); assertEq(cRec, fee); assertEq(nBps, 0); assertEq(nRec, address(0)); assertEq(effAt, 0); assertEq(tl, 48 hours);
        vm.expectRevert(E.FeeChangeNotPending.selector);
        ex.applyFeeChange();

        // Propose above the on-chain cap is impossible, even by the owner.
        vm.expectRevert(abi.encodeWithSelector(E.FeeBpsAboveCap.selector, 101, 100));
        ex.proposeFeeChange(101, treasury2);
        vm.expectRevert(abi.encodeWithSelector(E.InvalidFeeRecipient.selector, address(0)));
        ex.proposeFeeChange(50, address(0));
        // Strangers cannot propose.
        vm.prank(stranger);
        vm.expectRevert();
        ex.proposeFeeChange(50, treasury2);

        // Valid proposal: pending visible, current untouched, timelock armed.
        vm.expectEmit(true, true, true, true);
        emit E.FeeChangeProposed(100, treasury2, uint48(block.timestamp) + 48 hours);
        ex.proposeFeeChange(100, treasury2);
        assertEq(ex.feeBps(), 25, "current fee unchanged during timelock");
        assertEq(ex.pendingFeeBps(), 100);
        assertEq(ex.pendingFeeRecipient(), treasury2);
        assertEq(ex.pendingEffectiveAt(), block.timestamp + 48 hours);

        // Applying early reverts; cancelling clears; re-propose then wait.
        vm.expectRevert(abi.encodeWithSelector(E.TimelockNotElapsed.selector, uint48(block.timestamp + 48 hours), block.timestamp));
        ex.applyFeeChange();
        ex.cancelFeeChange();
        assertEq(ex.pendingEffectiveAt(), 0);
        vm.expectRevert(E.FeeChangeNotPending.selector);
        ex.applyFeeChange();

        ex.proposeFeeChange(40, treasury2);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        ex.applyFeeChange();
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, true, true);
        emit E.FeeChangeApplied(25, 40, fee, treasury2);
        ex.applyFeeChange(); // permissionless apply after the delay
        assertEq(ex.feeBps(), 40);
        assertEq(ex.feeRecipient(), treasury2);
        assertEq(ex.pendingEffectiveAt(), 0);
        // The new fee is what trades and quotes use, with exact arithmetic.
        (uint256 paid,) = ex.quoteFee(10_000);
        assertEq(paid, 40);
    }

    function testWrongFeeExpectationReverts() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        p.expectedFeeAmount = G * 25 / 10000 - 1;
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert();
        oneHop(p, h);
    }

    function testRecipientAndDeadlineGuards() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        p.recipient = stranger;
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert(abi.encodeWithSelector(E.InvalidRecipient.selector, stranger, taker));
        oneHop(p, h);
        p = params(address(a), address(b), G, false);
        p.deadline = block.timestamp - 1;
        vm.expectRevert(abi.encodeWithSelector(E.DeadlineExpired.selector, block.timestamp - 1, block.timestamp));
        oneHop(p, h);
        p = params(address(a), address(b), 0, false);
        vm.expectRevert(E.ZeroAmount.selector);
        oneHop(p, h);
        p = params(address(a), address(b), G, false);
        p.amountOutMinimum = 0;
        vm.expectRevert(E.ZeroMinimumOutput.selector);
        oneHop(p, h);
    }

    function testTakerCannotBeFeeRecipient() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        p.recipient = fee;
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.prank(fee);
        vm.expectRevert(E.TakerIsFeeRecipient.selector);
        ex.swapExactInput(p, single(h), auth());
    }

    function single(E.Hop memory h) internal pure returns (E.Hop[] memory path) {
        path = new E.Hop[](1);
        path[0] = h;
    }

    function testPauseBlocksTradingAndOwnerRescueWorks() public {
        ex.pause();
        E.SwapParams memory p = params(address(a), address(b), G, false);
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert();
        oneHop(p, h);
        ex.unpause();
        uint256 out = oneHop(p, h);
        assertGt(out, 0);
        a.mint(address(ex), 77);
        vm.prank(stranger);
        vm.expectRevert();
        ex.rescueERC20(address(a), stranger, 77);
        ex.rescueERC20(address(a), stranger, 77);
        assertEq(a.balanceOf(stranger), 77);
    }

    function testRouterAdministrationRequiresFactoryContract() public {
        MockSwapV2Router extra = new MockSwapV2Router();
        vm.expectRevert(abi.encodeWithSelector(E.NotAContract.selector, taker));
        ex.setRouter(address(extra), E.RouterKind.UNISWAP_V2_ROUTER02, taker);
        ex.setRouter(address(extra), E.RouterKind.UNISWAP_V2_ROUTER02, address(hub));
        assertEq(uint8(ex.routerKind(address(extra))), uint8(E.RouterKind.UNISWAP_V2_ROUTER02));
        assertEq(ex.routerFactory(address(extra)), address(hub));
        ex.setRouter(address(extra), E.RouterKind.NONE, address(0));
        assertEq(uint8(ex.routerKind(address(extra))), uint8(E.RouterKind.NONE));
        assertEq(ex.routerFactory(address(extra)), address(0));
        vm.prank(stranger);
        vm.expectRevert();
        ex.setRouter(address(extra), E.RouterKind.UNISWAP_V2_ROUTER02, address(hub));
    }

    function testReentrancyBlocked() public {
        v2.setMode(MockRouterBase.Mode.REENTER);
        v2.setReenter(address(ex), abi.encodeWithSelector(E.rescueERC20.selector, address(a), stranger, 1));
        E.SwapParams memory p = params(address(a), address(b), G, false);
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        vm.expectRevert();
        oneHop(p, h);
    }

    function testPermit2AuthorizationPath() public {
        uint256 sk = 0xB0B0;
        address signer = vm.addr(sk);
        MockPermit2 p2 = new MockPermit2();
        E.RouterConfig[] memory routers = new E.RouterConfig[](1);
        routers[0] = E.RouterConfig(address(v2), E.RouterKind.UNISWAP_V2_ROUTER02, address(hub));
        E ex2 = new E(address(this), address(w), address(p2), routers, 25, fee);
        a.mint(signer, G);
        vm.prank(signer);
        a.approve(address(p2), type(uint256).max); // real Permit2 spender is the Permit2 contract
        E.SwapParams memory p = params(address(a), address(b), G, false);
        p.recipient = signer;
        E.Hop memory h = hop(address(v2), address(b), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        E.Authorization memory authz;
        authz.kind = E.AuthKind.PERMIT2;
        authz.nonce = 1;
        authz.deadline = block.timestamp + 60;
        (uint8 v_, bytes32 r_, bytes32 s_) = vm.sign(sk, p2.digest(address(a), G, 1, block.timestamp + 60, address(ex2)));
        authz.signature = abi.encodePacked(r_, s_, v_);
        p.router = h.router;
        vm.prank(signer);
        uint256 out = ex2.swapExactInput(p, single(h), authz);
        assertEq(out, G - G * 25 / 10000);
        assertTrue(p2.nonceUsed(signer, 1));
    }

    function testEventCarriesPathProof() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        E.Hop[] memory path = new E.Hop[](2);
        path[0] = hop(address(v2), address(w), E.RouterKind.UNISWAP_V2_ROUTER02, 0, 0, false);
        path[1] = hop(address(slip), address(b), E.RouterKind.AERODROME_SLIPSTREAM, 0, 10, false);
        p.router = path[0].router;
        vm.expectEmit(true, true, true, true);
        emit E.SwapExecuted(taker, address(v2), p.intentId, address(a), address(b), G, G * 25 / 10000, G - G * 25 / 10000, G - G * 25 / 10000, fee, 25, E.RouterKind.UNISWAP_V2_ROUTER02, 0);
        vm.prank(taker);
        ex.swapExactInput(p, path, auth());
    }
}

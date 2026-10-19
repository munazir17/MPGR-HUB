// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MPGRSwapPathExecutorDraft as E} from "../../contracts/executor/drafts/MPGRSwapPathExecutorDraft.sol";
import {
    MockPermitToken,
    MockWETH9,
    MockPermit2,
    MockRouterBase,
    MockSlipstreamRouter,
    MockUniswapV3Router02
} from "./mocks/ExecutorMocks.sol";

/// @dev Deterministic typed V2 fixture, not a Base pool/router or settlement proof.
contract MockSwapV2DraftRouter is MockRouterBase {
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

contract MPGRSwapV2DraftTest is Test {
    E ex;
    MockPermitToken a;
    MockPermitToken b;
    MockWETH9 w;
    MockSwapV2DraftRouter v2;
    MockSlipstreamRouter slip;
    address taker = address(0xA11CE);
    address fee = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    uint256 constant G = 1_000_000;

    function setUp() public {
        a = new MockPermitToken("USDC mock", "USDC", 6);
        b = new MockPermitToken("Arbitrary token mock", "TOKEN", 18);
        w = new MockWETH9();
        v2 = new MockSwapV2DraftRouter();
        slip = new MockSlipstreamRouter();
        E.RouterConfig[] memory routers = new E.RouterConfig[](2);
        routers[0] = E.RouterConfig(address(v2), E.RouterKind.UNISWAP_V2_ROUTER02);
        routers[1] = E.RouterConfig(address(slip), E.RouterKind.AERODROME_SLIPSTREAM);
        address[] memory tokens = new address[](3);
        tokens[0] = address(a);
        tokens[1] = address(b);
        tokens[2] = address(w);
        ex = new E(address(this), address(w), address(new MockPermit2()), routers, tokens);
        a.mint(taker, 1e24);
        b.mint(taker, 1e24);
        a.mint(address(v2), 1e24);
        b.mint(address(v2), 1e24);
        a.mint(address(slip), 1e24);
        b.mint(address(slip), 1e24);
        vm.deal(address(this), 1e25);
        w.deposit{value: 1e24}();
        w.transfer(address(v2), 1e22);
        w.transfer(address(slip), 1e22);
        vm.deal(taker, 1 ether);
        vm.startPrank(taker);
        a.approve(address(ex), type(uint256).max);
        b.approve(address(ex), type(uint256).max);
        vm.stopPrank();
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
            bytes32("v2-draft"),
            nativeOut
        );
    }

    function auth() internal pure returns (E.Authorization memory v) {
        v.kind = E.AuthKind.APPROVAL;
    }

    function hops(bool firstV2) internal view returns (E.Hop memory h0, E.Hop memory h1) {
        h0 = E.Hop(
            firstV2 ? address(v2) : address(slip),
            address(w),
            firstV2 ? E.RouterKind.UNISWAP_V2_ROUTER02 : E.RouterKind.AERODROME_SLIPSTREAM,
            0,
            firstV2 ? int24(0) : int24(10)
        );
        h1 = E.Hop(
            firstV2 ? address(slip) : address(v2),
            address(b),
            firstV2 ? E.RouterKind.AERODROME_SLIPSTREAM : E.RouterKind.UNISWAP_V2_ROUTER02,
            0,
            firstV2 ? int24(10) : int24(0)
        );
    }

    function testFuzzV2BuySellFloorFee(uint96 raw, bool sell) public {
        uint256 gross = bound(uint256(raw), 400, 1e20);
        MockPermitToken input = sell ? b : a;
        MockPermitToken output = sell ? a : b;
        E.SwapParams memory p = params(address(input), address(output), gross, false);
        uint256 before = output.balanceOf(taker);
        vm.prank(taker);
        uint256 out = ex.swapUniswapV2ExactInputSingle(p, auth());
        assertEq(input.balanceOf(fee), gross * 25 / 10000);
        assertEq(out, gross - gross * 25 / 10000);
        assertEq(output.balanceOf(taker) - before, out);
        assertEq(input.allowance(address(ex), address(v2)), 0);
        assertEq(v2.lastPathIn(), address(input));
        assertEq(v2.lastPathOut(), address(output));
        assertEq(v2.lastDeadline(), p.deadline);
    }

    function testFullUint256FeePreviewDoesNotOverflow() public view {
        uint256 gross = type(uint256).max;
        (uint256 paid, uint256 net) = ex.quoteFee(gross);
        assertEq(paid, (gross / 10000) * 25 + ((gross % 10000) * 25) / 10000);
        assertEq(net, gross - paid);
    }

    function testV2NativeInputAtomicFee() public {
        uint256 gross = 0.0001 ether;
        uint256 before = fee.balance;
        E.SwapParams memory p = params(address(w), address(b), gross, false);
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle{value: gross}(p, auth());
        assertEq(fee.balance - before, gross * 25 / 10000);
        assertEq(w.balanceOf(address(ex)), 0);
    }

    function testV2NativeOutput() public {
        uint256 before = taker.balance;
        E.SwapParams memory p = params(address(a), address(w), G, true);
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle(p, auth());
        assertEq(taker.balance - before, G - G * 25 / 10000);
        assertEq(a.balanceOf(fee), G * 25 / 10000);
    }

    function testV2ThenSlipAndSlipThenV2ChargeOnlyOnceEach() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        for (uint256 i; i < 2; i++) {
            (E.Hop memory h0, E.Hop memory h1) = hops(i == 0);
            p.router = h0.router;
            vm.prank(taker);
            ex.swapExactInputTwoHop(p, h0, h1, auth());
            assertEq(a.balanceOf(fee), (i + 1) * G * 25 / 10000);
            assertEq(w.balanceOf(address(ex)), 0);
            assertEq(w.allowance(address(ex), h1.router), 0);
        }
    }

    function testV2AndUniV3MixedEitherOrder() public {
        MockUniswapV3Router02 uni = new MockUniswapV3Router02();
        ex.setRouter(address(uni), E.RouterKind.UNISWAP_V3_ROUTER02);
        b.mint(address(uni), 1e24);
        w.transfer(address(uni), 1e20);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        for (uint256 i; i < 2; i++) {
            E.Hop memory h0 = E.Hop(
                i == 0 ? address(v2) : address(uni),
                address(w),
                i == 0 ? E.RouterKind.UNISWAP_V2_ROUTER02 : E.RouterKind.UNISWAP_V3_ROUTER02,
                i == 0 ? uint24(0) : uint24(500),
                0
            );
            E.Hop memory h1 = E.Hop(
                i == 0 ? address(uni) : address(v2),
                address(b),
                i == 0 ? E.RouterKind.UNISWAP_V3_ROUTER02 : E.RouterKind.UNISWAP_V2_ROUTER02,
                i == 0 ? uint24(500) : uint24(0),
                0
            );
            p.router = h0.router;
            vm.prank(taker);
            ex.swapExactInputTwoHop(p, h0, h1, auth());
            assertEq(a.balanceOf(fee), (i + 1) * G * 25 / 10000);
            assertEq(w.balanceOf(address(ex)), 0);
        }
    }

    function testV2SecondHopRevertRollsBackAll() public {
        v2.setMode(MockRouterBase.Mode.REVERT);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(false);
        p.router = h0.router;
        uint256 before = a.balanceOf(taker);
        vm.expectRevert();
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), 0);
        assertEq(a.balanceOf(taker), before);
        assertEq(slip.callCount(), 0);
    }

    function testV2CannotLieAboutMinimum() public {
        v2.setMode(MockRouterBase.Mode.LIE_ABOUT_OUTPUT);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        p.amountOutMinimum = G - G * 25 / 10000;
        vm.expectPartialRevert(E.InsufficientOutput.selector);
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle(p, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testV2CannotLeaveInputBehind() public {
        v2.setMode(MockRouterBase.Mode.PULL_LESS);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        vm.expectPartialRevert(E.InputNotFullyConsumed.selector);
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle(p, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testV2WrongKindCannotBypassPermissions() public {
        ex.setRouter(address(v2), E.RouterKind.AERODROME_SLIPSTREAM);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        vm.expectPartialRevert(E.RouterNotAllowed.selector);
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle(p, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testV2CannotTakeV3FeeKeyOrSlipSpacing() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(true);
        h0.poolFee = 500;
        vm.expectRevert(E.InvalidPath.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        h0.poolFee = 0;
        h0.tickSpacing = 10;
        vm.expectRevert(E.InvalidPath.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testV2MissingBridgePermissionBlocksBeforeFee() public {
        ex.setTokenAllowed(address(w), false);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(true);
        vm.expectPartialRevert(E.TokenNotAllowed.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testV2FeeOmissionAndDustBlocked() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        p.expectedFeeAmount = 0;
        vm.expectPartialRevert(E.FeeMismatch.selector);
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle(p, auth());
        p = params(address(a), address(b), 399, false);
        vm.expectPartialRevert(E.FeeRoundsToZero.selector);
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle(p, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testV2OwnerCallbackCannotMutateRoutePermissions() public {
        ex.transferOwnership(address(v2));
        vm.prank(address(v2));
        ex.acceptOwnership();
        v2.setMode(MockRouterBase.Mode.REENTER);
        v2.setReenter(address(ex), abi.encodeCall(ex.setTokenAllowed, (address(b), false)));
        E.SwapParams memory p = params(address(a), address(b), G, false);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle(p, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    struct UnknownHop {
        address router;
        address tokenOut;
        uint8 kind;
        uint24 poolFee;
        int24 tickSpacing;
    }

    function testUnassignedKindCannotSmuggleClassicOrV4Commands() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory first,) = hops(true);
        UnknownHop memory second = UnknownHop(address(slip), address(b), 4, 0, 10);
        bytes memory data = abi.encodeWithSelector(ex.swapExactInputTwoHop.selector, p, first, second, auth());
        vm.prank(taker);
        (bool ok,) = address(ex).call(data);
        assertFalse(ok);
        assertEq(a.balanceOf(fee), 0);
    }

    function testV2DeadlineAndValueMismatchFailClosed() public {
        E.SwapParams memory p = params(address(w), address(b), G, false);
        p.deadline = block.timestamp - 1;
        vm.expectRevert();
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle{value: G}(p, auth());
        p.deadline = block.timestamp + 300;
        vm.expectRevert();
        vm.prank(taker);
        ex.swapUniswapV2ExactInputSingle{value: G + 1}(p, auth());
        assertEq(fee.balance, 0);
    }
}

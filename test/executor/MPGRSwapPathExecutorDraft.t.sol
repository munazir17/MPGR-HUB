// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MPGRSwapPathExecutorDraft as E} from "../../contracts/executor/drafts/MPGRSwapPathExecutorDraft.sol";
import {
    MockPermitToken,
    MockWETH9,
    MockSlipstreamRouter,
    MockUniswapV3Router02,
    MockPermit2,
    MockRouterBase
} from "./mocks/ExecutorMocks.sol";

contract DraftRecipientTaxToken is MockPermitToken {
    address constant FEE = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    constructor() MockPermitToken("Recipient-tax mock", "TAX", 6) {}

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to == FEE && amount > 0) {
            super._update(from, to, amount - 1);
            super._update(from, address(0xdead), 1);
        } else {
            super._update(from, to, amount);
        }
    }
}

/// @dev Offline EVM tests only. Tokens/routers are mocks, NOT Base liquidity or
/// live-route evidence. Existing production Executor/source/ABI are untouched.
contract MPGRSwapPathExecutorDraftTest is Test {
    E ex;
    MockPermitToken a;
    MockPermitToken b;
    MockWETH9 w;
    MockSlipstreamRouter slip;
    MockUniswapV3Router02 uni;
    address taker = address(0xA11CE);
    address fee = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    uint256 constant G = 1_000_000;

    function setUp() public {
        a = new MockPermitToken("USDC mock", "USDC", 6);
        b = new MockPermitToken("Stock mock", "STOCK", 18);
        w = new MockWETH9();
        slip = new MockSlipstreamRouter();
        uni = new MockUniswapV3Router02();
        E.RouterConfig[] memory routers = new E.RouterConfig[](2);
        routers[0] = E.RouterConfig(address(uni), E.RouterKind.UNISWAP_V3_ROUTER02);
        routers[1] = E.RouterConfig(address(slip), E.RouterKind.AERODROME_SLIPSTREAM);
        address[] memory tokens = new address[](3);
        tokens[0] = address(a);
        tokens[1] = address(b);
        tokens[2] = address(w);
        ex = new E(address(this), address(w), address(new MockPermit2()), routers, tokens);
        a.mint(taker, 1e24);
        b.mint(taker, 1e24);
        a.mint(address(uni), 1e24);
        a.mint(address(slip), 1e24);
        b.mint(address(uni), 1e24);
        b.mint(address(slip), 1e24);
        vm.deal(address(this), 1e25);
        w.deposit{value: 1e24}();
        w.transfer(address(uni), 1e22);
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
            address(uni),
            sell,
            buy,
            gross,
            gross * 25 / 10000,
            1,
            taker,
            block.timestamp + 300,
            bytes32("draft-only"),
            nativeOut
        );
    }

    function auth() internal pure returns (E.Authorization memory v) {
        v.kind = E.AuthKind.APPROVAL;
    }

    function hops(address bridge, address out) internal view returns (E.Hop memory first, E.Hop memory second) {
        first = E.Hop(address(uni), bridge, E.RouterKind.UNISWAP_V3_ROUTER02, 500, 0);
        second = E.Hop(address(slip), out, E.RouterKind.AERODROME_SLIPSTREAM, 0, 10);
    }

    function testMixedBuy() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        uint256 before = b.balanceOf(taker);
        vm.prank(taker);
        uint256 out = ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(out, G - G * 25 / 10000);
        assertEq(b.balanceOf(taker) - before, out);
        assertEq(a.balanceOf(fee), G * 25 / 10000);
        assertEq(a.allowance(address(ex), address(uni)), 0);
        assertEq(w.allowance(address(ex), address(slip)), 0);
        assertEq(a.balanceOf(address(ex)), 0);
        assertEq(w.balanceOf(address(ex)), 0);
    }

    function testMixedSell() public {
        E.SwapParams memory p = params(address(b), address(a), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(a));
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(b.balanceOf(fee), G * 25 / 10000);
    }

    function testRequestedNativeEthAmountWithMixedRoute() public {
        uint256 gross = 0.0001 ether;
        E.SwapParams memory p = params(address(w), address(b), gross, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(a), address(b));
        uint256 before = fee.balance;
        vm.prank(taker);
        ex.swapExactInputTwoHop{value: gross}(p, h0, h1, auth());
        assertEq(fee.balance - before, gross * 25 / 10000);
        assertEq(b.balanceOf(taker), 1e24 + gross - gross * 25 / 10000);
    }

    function testNativeOutput() public {
        E.SwapParams memory p = params(address(b), address(w), G, true);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(a), address(w));
        uint256 before = taker.balance;
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(taker.balance - before, G - G * 25 / 10000);
    }

    function testNoFeeSettersOrFeeLessPath() public {
        assertEq(ex.feeBps(), 25);
        assertEq(ex.feeRecipient(), fee);
        (bool ok,) = address(ex).call(abi.encodeWithSignature("setFeeBps(uint16)", 0));
        assertFalse(ok);
        (ok,) = address(ex).call(abi.encodeWithSignature("setFeeRecipient(address)", taker));
        assertFalse(ok);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        p.expectedFeeAmount = 0;
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectRevert(abi.encodeWithSelector(E.FeeMismatch.selector, 0, G * 25 / 10000));
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
    }

    function testSecondHopRevertRollsBackFeeAndFirstHop() public {
        slip.setMode(MockRouterBase.Mode.REVERT);
        uint256 before = a.balanceOf(taker);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectRevert();
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), 0);
        assertEq(a.balanceOf(taker), before);
        assertEq(uni.callCount(), 0);
    }

    function testFirstHopMustConsumeExactBudget() public {
        uni.setMode(MockRouterBase.Mode.PULL_LESS);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectPartialRevert(E.InputNotFullyConsumed.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testSecondHopCannotLieAboutOutputOrViolateMinimum() public {
        slip.setMode(MockRouterBase.Mode.LIE_ABOUT_OUTPUT);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        p.amountOutMinimum = G - G * 25 / 10000;
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectPartialRevert(E.InsufficientOutput.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testBridgeDustCannotBeSpent() public {
        w.transfer(address(ex), 100);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(w.balanceOf(address(ex)), 100);
    }

    function testMissingBridgePermission() public {
        ex.setTokenAllowed(address(w), false);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectPartialRevert(E.TokenNotAllowed.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
    }

    function testMissingSecondRouterPermission() public {
        ex.setRouter(address(slip), E.RouterKind.NONE);
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectPartialRevert(E.RouterNotAllowed.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
    }

    function testInvalidPathAndRecipient() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(a), address(b));
        vm.expectRevert(E.InvalidPath.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        h0.tokenOut = address(w);
        p.recipient = address(this);
        vm.expectPartialRevert(E.InvalidRecipient.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
    }

    function testOwnerCallbackCannotMutatePermissions() public {
        ex.transferOwnership(address(uni));
        vm.prank(address(uni));
        ex.acceptOwnership();
        uni.setMode(MockRouterBase.Mode.REENTER);
        uni.setReenter(address(ex), abi.encodeCall(ex.setTokenAllowed, (address(b), false)));
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    struct UnsupportedHop {
        address router;
        address tokenOut;
        uint8 kind;
        uint24 poolFee;
        int24 tickSpacing;
    }

    function testUnsupportedV4KindCannotBeEncodedAsV3() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        (E.Hop memory h0,) = hops(address(w), address(b));
        UnsupportedHop memory h1 = UnsupportedHop(address(slip), address(b), 3, 0, 10);
        bytes memory data = abi.encodeWithSelector(ex.swapExactInputTwoHop.selector, p, h0, h1, auth());
        vm.prank(taker);
        (bool ok,) = address(ex).call(data);
        assertFalse(ok);
        assertEq(a.balanceOf(fee), 0);
    }

    function testDirectEntrypointsAlsoEnforceFixedFee() public {
        E.SwapParams memory p = params(address(a), address(b), G, false);
        vm.prank(taker);
        ex.swapUniswapV3ExactInputSingle(p, 500, auth());
        p.router = address(slip);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, 10, auth());
        assertEq(a.balanceOf(fee), 2 * G * 25 / 10000);
    }

    function testFeeDustCannotSucceedWithoutPayment() public {
        E.SwapParams memory p = params(address(a), address(b), 399, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectRevert(abi.encodeWithSelector(E.FeeRoundsToZero.selector, 399));
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), 0);
    }

    function testShortFeeDeliveryCannotSucceed() public {
        DraftRecipientTaxToken taxed = new DraftRecipientTaxToken();
        taxed.mint(taker, G);
        ex.setTokenAllowed(address(taxed), true);
        vm.prank(taker);
        taxed.approve(address(ex), G);
        E.SwapParams memory p = params(address(taxed), address(b), G, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.expectRevert(E.FeeDeliveryMismatch.selector);
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(taxed.balanceOf(taker), G);
        assertEq(taxed.balanceOf(fee), 0);
        assertEq(uni.callCount(), 0);
    }

    function testFuzzExactFloorOnGross(uint128 raw) public {
        uint256 gross = bound(uint256(raw), 400, 1e20);
        E.SwapParams memory p = params(address(a), address(b), gross, false);
        (E.Hop memory h0, E.Hop memory h1) = hops(address(w), address(b));
        vm.prank(taker);
        ex.swapExactInputTwoHop(p, h0, h1, auth());
        assertEq(a.balanceOf(fee), gross * 25 / 10000);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";
import {
    MockPermitToken,
    MockFeeOnTransferToken,
    MockWETH9,
    MockRouterBase,
    MockSlipstreamRouter,
    MockUniswapV3Router02,
    MockPermit2,
    ReenteringReceiver,
    NativeRejecter
} from "./mocks/ExecutorMocks.sol";

contract MPGRExecutorTest is Test {
    MPGRExecutor internal ex;
    MockPermitToken internal usdc; // 6 decimals
    MockPermitToken internal stock; // 18 decimals (B20-like)
    MockWETH9 internal weth;
    MockSlipstreamRouter internal slip;
    MockUniswapV3Router02 internal uni;
    MockPermit2 internal permit2;

    address internal owner = makeAddr("owner");
    address internal feeWallet = makeAddr("feeWallet");
    address internal deployer = makeAddr("deployer");
    address internal attacker = makeAddr("attacker");
    uint256 internal takerKey = 0xA11CE;
    address internal taker;
    uint256 internal victimKey = 0xB0B;
    address internal victim;

    int24 internal constant TICK = 10;
    uint24 internal constant POOL_FEE = 3000;
    uint256 internal constant G = 1_000e6; // 1000 USDC
    /// @dev Mirrors ex.feeBps() WITHOUT an external call (an external call in
    ///      a helper would consume vm.prank / vm.expectRevert).
    uint16 internal curBps = 25;

    function setUp() public {
        taker = vm.addr(takerKey);
        victim = vm.addr(victimKey);
        vm.warp(1_800_000_000);

        usdc = new MockPermitToken("USD Coin", "USDC", 6);
        stock = new MockPermitToken("Apple B20", "AAPLc", 18);
        weth = new MockWETH9();
        slip = new MockSlipstreamRouter();
        uni = new MockUniswapV3Router02();
        permit2 = new MockPermit2();

        MPGRExecutor.RouterConfig[] memory routers = new MPGRExecutor.RouterConfig[](2);
        routers[0] = MPGRExecutor.RouterConfig(address(slip), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
        routers[1] = MPGRExecutor.RouterConfig(address(uni), MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02);
        address[] memory tokens = new address[](3);
        tokens[0] = address(usdc);
        tokens[1] = address(stock);
        tokens[2] = address(weth);

        vm.prank(deployer);
        ex = new MPGRExecutor(owner, feeWallet, 25, address(weth), address(permit2), routers, tokens);

        // Router liquidity (output side). Rate: 1 USDC (1e6) -> 1e12 * 1e6 = 1e18 stock-wei? keep 1:1e12.
        stock.mint(address(slip), 1e30);
        stock.mint(address(uni), 1e30);
        usdc.mint(address(slip), 1e24);
        usdc.mint(address(uni), 1e24);
        vm.deal(address(this), 1_000 ether);
        weth.deposit{value: 500 ether}();
        weth.transfer(address(slip), 250 ether);
        weth.transfer(address(uni), 250 ether);
        slip.setRate(1e12, 1); // USDC(6) -> stock(18) 1:1 in whole units
        uni.setRate(1e12, 1);

        usdc.mint(taker, 1_000_000e6);
        vm.deal(taker, 100 ether);
        vm.prank(taker);
        usdc.approve(address(ex), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _params(address router, address tokenIn, address tokenOut, uint256 gross, uint256 minOut)
        internal
        view
        returns (MPGRExecutor.SwapParams memory p)
    {
        p = MPGRExecutor.SwapParams({
            router: router,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            grossAmountIn: gross,
            expectedFeeAmount: (gross * curBps) / 10_000,
            amountOutMinimum: minOut,
            recipient: taker,
            deadline: block.timestamp + 180,
            intentId: keccak256("quote-1"),
            unwrapNativeOut: false
        });
    }

    function _usdcToStock(uint256 gross) internal view returns (MPGRExecutor.SwapParams memory) {
        uint256 net = gross - (gross * curBps) / 10_000;
        return _params(address(slip), address(usdc), address(stock), gross, (net * 1e12 * 99) / 100);
    }

    function _approvalAuth() internal pure returns (MPGRExecutor.Authorization memory a) {
        a.kind = MPGRExecutor.AuthKind.APPROVAL;
    }

    struct Snap {
        uint256 takerIn;
        uint256 takerOut;
        uint256 feeIn;
        uint256 exIn;
        uint256 exOut;
        uint256 routerIn;
    }

    function _snap(address tokenIn, address tokenOut, address router) internal view returns (Snap memory s) {
        s.takerIn = MockPermitToken(tokenIn).balanceOf(taker);
        s.takerOut = MockPermitToken(tokenOut).balanceOf(taker);
        s.feeIn = MockPermitToken(tokenIn).balanceOf(feeWallet);
        s.exIn = MockPermitToken(tokenIn).balanceOf(address(ex));
        s.exOut = MockPermitToken(tokenOut).balanceOf(address(ex));
        s.routerIn = MockPermitToken(tokenIn).balanceOf(router);
    }

    function _assertUnchanged(Snap memory a, Snap memory b) internal pure {
        assertEq(a.takerIn, b.takerIn, "taker sell balance changed");
        assertEq(a.takerOut, b.takerOut, "taker buy balance changed");
        assertEq(a.feeIn, b.feeIn, "fee wallet balance changed");
        assertEq(a.exIn, b.exIn, "executor sell balance changed");
        assertEq(a.exOut, b.exOut, "executor buy balance changed");
        assertEq(a.routerIn, b.routerIn, "router sell balance changed");
    }

    // ------------------------------------------------------------------
    // Deployment / ownership
    // ------------------------------------------------------------------

    function test_Constructor_SetsConfigAndOwnerNotDeployer() public view {
        assertEq(ex.owner(), owner);
        assertTrue(ex.owner() != deployer);
        assertEq(ex.pendingOwner(), address(0));
        assertEq(ex.feeRecipient(), feeWallet);
        assertEq(ex.feeBps(), 25);
        assertEq(ex.MAX_FEE_BPS(), 100);
        assertEq(address(ex.WETH()), address(weth));
        assertEq(address(ex.PERMIT2()), address(permit2));
        assertEq(uint8(ex.routerKind(address(slip))), uint8(MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM));
        assertEq(uint8(ex.routerKind(address(uni))), uint8(MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02));
        assertTrue(ex.isTokenAllowed(address(usdc)));
        assertTrue(ex.isTokenAllowed(address(weth)));
    }

    function test_DeployerHasNoAdminPowers() public {
        vm.startPrank(deployer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        ex.setFeeBps(50);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        ex.setFeeRecipient(deployer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        ex.setRouter(address(uni), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        ex.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        ex.rescueERC20(address(usdc), deployer, 1);
        vm.stopPrank();
    }

    function test_Constructor_RejectsBadConfig() public {
        MPGRExecutor.RouterConfig[] memory none = new MPGRExecutor.RouterConfig[](0);
        address[] memory noTokens = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MPGRExecutor(address(0), feeWallet, 25, address(weth), address(permit2), none, noTokens);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InvalidFeeRecipient.selector, address(0)));
        new MPGRExecutor(owner, address(0), 25, address(weth), address(permit2), none, noTokens);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeBpsAboveCap.selector, uint16(101), uint16(100)));
        new MPGRExecutor(owner, feeWallet, 101, address(weth), address(permit2), none, noTokens);
        vm.expectRevert(MPGRExecutor.ZeroAddress.selector);
        new MPGRExecutor(owner, feeWallet, 25, address(0), address(permit2), none, noTokens);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.NotAContract.selector, address(0x1234)));
        new MPGRExecutor(owner, feeWallet, 25, address(0x1234), address(permit2), none, noTokens);
    }

    function test_Ownable2Step_TransferRequiresAcceptance() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        ex.transferOwnership(newOwner);
        assertEq(ex.owner(), owner, "ownership must not move before acceptance");
        assertEq(ex.pendingOwner(), newOwner);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        ex.acceptOwnership();
        vm.prank(newOwner);
        ex.acceptOwnership();
        assertEq(ex.owner(), newOwner);
    }

    function test_RenounceOwnershipDisabled() public {
        vm.prank(owner);
        vm.expectRevert(MPGRExecutor.RenounceDisabled.selector);
        ex.renounceOwnership();
        assertEq(ex.owner(), owner);
    }

    // ------------------------------------------------------------------
    // Exact fee math
    // ------------------------------------------------------------------

    function test_ExactFee_25Bps_1000USDC() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        assertEq(p.expectedFeeAmount, 2_500_000, "1000 USDC -> 2.5 USDC fee");
        uint256 takerBefore = usdc.balanceOf(taker);
        vm.prank(taker);
        uint256 out = ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());

        assertEq(usdc.balanceOf(feeWallet), 2_500_000, "fee wallet gets exactly 2.5 USDC");
        assertEq(usdc.balanceOf(address(slip)), 1e24 + 997_500_000, "router gets exactly 997.5 USDC");
        assertEq(slip.lastAmountIn(), 997_500_000);
        assertEq(takerBefore - usdc.balanceOf(taker), G, "taker pays exactly G");
        assertEq(out, 997_500_000 * 1e12);
        assertEq(stock.balanceOf(taker), out, "output goes to taker");
        assertEq(usdc.balanceOf(address(ex)), 0, "no custody");
        assertEq(stock.balanceOf(address(ex)), 0, "no custody");
        assertEq(usdc.allowance(address(ex), address(slip)), 0, "no dangling allowance");
    }

    function test_FloorRounding() public {
        // 1999 * 25 / 10000 = 4.9975 -> 4
        (uint256 fee, uint256 net) = ex.quoteFee(1999);
        assertEq(fee, 4);
        assertEq(net, 1995);
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(usdc), address(stock), 1999, 1);
        assertEq(p.expectedFeeAmount, 4);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(usdc.balanceOf(feeWallet), 4);
        assertEq(slip.lastAmountIn(), 1995);
    }

    function test_TinyAmount_MinimumFeeableSize() public {
        // 400 * 25 / 10000 = 1 exactly
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(usdc), address(stock), 400, 1);
        assertEq(p.expectedFeeAmount, 1);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(usdc.balanceOf(feeWallet), 1);
        assertEq(slip.lastAmountIn(), 399);
    }

    function test_TinyAmount_FeeRoundsToZeroReverts() public {
        // 399 * 25 / 10000 = 0 -> never silently skip the fee
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(usdc), address(stock), 399, 1);
        assertEq(p.expectedFeeAmount, 0);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeRoundsToZero.selector, uint256(399)));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_ZeroAmountReverts() public {
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(usdc), address(stock), 0, 1);
        vm.prank(taker);
        vm.expectRevert(MPGRExecutor.ZeroAmount.selector);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function testFuzz_FeeIsExactFloor(uint256 gross) public {
        gross = bound(gross, 400, 500_000e6);
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(usdc), address(stock), gross, 1);
        uint256 expectedFee = (gross * 25) / 10_000;
        uint256 takerBefore = usdc.balanceOf(taker);
        uint256 routerBefore = usdc.balanceOf(address(slip));
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(usdc.balanceOf(feeWallet), expectedFee);
        assertEq(usdc.balanceOf(address(slip)) - routerBefore, gross - expectedFee);
        assertEq(takerBefore - usdc.balanceOf(taker), gross);
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertLt(expectedFee, gross);
    }

    function testFuzz_ConfigurableFeeWithinCap(uint16 bps, uint256 gross) public {
        bps = uint16(bound(bps, 1, 100));
        gross = bound(gross, 10_000, 500_000e6);
        vm.prank(owner);
        ex.setFeeBps(bps);
        curBps = bps;
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(usdc), address(stock), gross, 1);
        assertEq(p.expectedFeeAmount, (gross * bps) / 10_000);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(usdc.balanceOf(feeWallet), (gross * bps) / 10_000);
    }

    // ------------------------------------------------------------------
    // Fee configuration
    // ------------------------------------------------------------------

    function test_SetFeeBps_WithinCapAndEvents() public {
        vm.startPrank(owner);
        vm.expectEmit(address(ex));
        emit MPGRExecutor.FeeBpsUpdated(25, 100);
        ex.setFeeBps(100);
        assertEq(ex.feeBps(), 100);
        ex.setFeeBps(10);
        assertEq(ex.feeBps(), 10);
        ex.setFeeBps(0);
        assertEq(ex.feeBps(), 0);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeBpsAboveCap.selector, uint16(101), uint16(100)));
        ex.setFeeBps(101);
        vm.stopPrank();
    }

    function test_FeeChangeAfterQuote_RevertsInsteadOfOvercharging() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G); // committed at 25 bps
        vm.prank(owner);
        ex.setFeeBps(100);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeMismatch.selector, uint256(2_500_000), uint256(10_000_000)));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_ZeroFeeConfig_NoFeeTransfer() public {
        vm.prank(owner);
        ex.setFeeBps(0);
        curBps = 0;
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        assertEq(p.expectedFeeAmount, 0);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(usdc.balanceOf(feeWallet), 0);
        assertEq(slip.lastAmountIn(), G);
    }

    function test_FeeRecipientValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InvalidFeeRecipient.selector, address(0)));
        ex.setFeeRecipient(address(0));
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InvalidFeeRecipient.selector, address(ex)));
        ex.setFeeRecipient(address(ex));
        address newWallet = makeAddr("newFeeWallet");
        vm.expectEmit(address(ex));
        emit MPGRExecutor.FeeRecipientUpdated(feeWallet, newWallet);
        ex.setFeeRecipient(newWallet);
        vm.stopPrank();
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        assertEq(usdc.balanceOf(newWallet), 2_500_000);
        assertEq(usdc.balanceOf(feeWallet), 0);
    }

    function test_FeeRecipientCannotBeTaker() public {
        usdc.mint(feeWallet, G);
        vm.startPrank(feeWallet);
        usdc.approve(address(ex), G);
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.recipient = feeWallet;
        vm.expectRevert(MPGRExecutor.TakerIsFeeRecipient.selector);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Fee bypass / double fee
    // ------------------------------------------------------------------

    function test_FeeBypass_ZeroExpectedFeeReverts() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.expectedFeeAmount = 0;
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeMismatch.selector, uint256(0), uint256(2_500_000)));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_FeeBypass_UnderstatedFeeReverts() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.expectedFeeAmount = 2_499_999;
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeMismatch.selector, uint256(2_499_999), uint256(2_500_000)));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_DoubleFee_OverstatedFeeReverts() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.expectedFeeAmount = 5_000_000;
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.FeeMismatch.selector, uint256(5_000_000), uint256(2_500_000)));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_DoubleFee_ChargedExactlyOncePerTrade() public {
        vm.recordLogs();
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        // Exactly one Transfer(executor -> feeWallet) of the fee.
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        uint256 feeTransfers;
        uint256 swapExecuted;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(usdc) && logs[i].topics[0] == transferSig
                    && address(uint160(uint256(logs[i].topics[2]))) == feeWallet
            ) {
                feeTransfers += 1;
                assertEq(abi.decode(logs[i].data, (uint256)), 2_500_000);
            }
            if (logs[i].emitter == address(ex)) swapExecuted += 1;
        }
        assertEq(feeTransfers, 1, "exactly one fee transfer");
        assertEq(swapExecuted, 1, "exactly one SwapExecuted");
        assertEq(usdc.balanceOf(feeWallet), 2_500_000);
    }

    // ------------------------------------------------------------------
    // Balance / allowance failures
    // ------------------------------------------------------------------

    function test_InsufficientBalanceReverts() public {
        address poor = makeAddr("poor");
        usdc.mint(poor, G - 1);
        vm.startPrank(poor);
        usdc.approve(address(ex), type(uint256).max);
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.recipient = poor;
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, poor, G - 1, G)
        );
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        vm.stopPrank();
    }

    function test_InsufficientAllowanceReverts() public {
        vm.prank(taker);
        usdc.approve(address(ex), G - 1);
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(ex), G - 1, G)
        );
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_FeeOnTransferSellTokenRejected() public {
        MockFeeOnTransferToken fot = new MockFeeOnTransferToken();
        vm.prank(owner);
        ex.setTokenAllowed(address(fot), true);
        fot.mint(taker, G);
        vm.prank(taker);
        fot.approve(address(ex), G);
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(fot), address(stock), G, 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.UnsupportedTransferAmount.selector, G, G - G / 100));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    // ------------------------------------------------------------------
    // Router allowlist / malicious targets
    // ------------------------------------------------------------------

    function test_RouterAllowlist_UnknownRouterReverts() public {
        MockSlipstreamRouter rogue = new MockSlipstreamRouter();
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.router = address(rogue);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                MPGRExecutor.RouterNotAllowed.selector, address(rogue), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM
            )
        );
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_RouterAllowlist_WrongKindReverts() public {
        // A Uniswap router may not be used through the Slipstream adapter.
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.router = address(uni);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                MPGRExecutor.RouterNotAllowed.selector, address(uni), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM
            )
        );
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_RouterAllowlist_RemovedRouterReverts() public {
        vm.prank(owner);
        ex.setRouter(address(slip), MPGRExecutor.RouterKind.NONE);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                MPGRExecutor.RouterNotAllowed.selector, address(slip), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM
            )
        );
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
    }

    function test_MaliciousTarget_TokenAsRouterReverts() public {
        // Using the sell token itself as "router" (classic approval-drain setup).
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.router = address(usdc);
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                MPGRExecutor.RouterNotAllowed.selector, address(usdc), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM
            )
        );
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_AdminCannotAllowlistTokenAsRouterOrEOA() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.ConflictingAllowlist.selector, address(usdc)));
        ex.setRouter(address(usdc), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.ConflictingAllowlist.selector, address(slip)));
        ex.setTokenAllowed(address(slip), true);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.NotAContract.selector, attacker));
        ex.setRouter(attacker, MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.ConflictingAllowlist.selector, address(ex)));
        ex.setRouter(address(ex), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.NotAContract.selector, attacker));
        ex.setTokenAllowed(attacker, true);
        vm.stopPrank();
    }

    function test_AdminEventsForAllowlists() public {
        MockUniswapV3Router02 r = new MockUniswapV3Router02();
        vm.startPrank(owner);
        vm.expectEmit(address(ex));
        emit MPGRExecutor.RouterUpdated(address(r), MPGRExecutor.RouterKind.NONE, MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02);
        ex.setRouter(address(r), MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02);
        vm.expectEmit(address(ex));
        emit MPGRExecutor.TokenAllowlistUpdated(address(usdc), false);
        ex.setTokenAllowed(address(usdc), false);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Token validation
    // ------------------------------------------------------------------

    function test_TokenValidation_UnlistedTokenIn() public {
        MockPermitToken rogue = new MockPermitToken("Rogue", "RGE", 18);
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(rogue), address(stock), G, 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.TokenNotAllowed.selector, address(rogue)));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_TokenValidation_UnlistedTokenOut() public {
        MockPermitToken rogue = new MockPermitToken("Rogue", "RGE", 18);
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(usdc), address(rogue), G, 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.TokenNotAllowed.selector, address(rogue)));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_TokenValidation_SameToken() public {
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(usdc), address(usdc), G, 1);
        vm.prank(taker);
        vm.expectRevert(MPGRExecutor.SameToken.selector);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    // ------------------------------------------------------------------
    // Recipient validation / output redirection
    // ------------------------------------------------------------------

    function test_MaliciousRecipientReverts() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.recipient = attacker;
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InvalidRecipient.selector, attacker, taker));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_OutputRedirectionByRouterReverts() public {
        slip.setMode(MockRouterBase.Mode.REDIRECT_OUTPUT);
        slip.setAttack(attacker, address(0));
        Snap memory before = _snap(address(usdc), address(stock), address(slip));
        vm.prank(taker);
        vm.expectRevert(); // InsufficientOutput(0, minOut)
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        _assertUnchanged(before, _snap(address(usdc), address(stock), address(slip)));
        assertEq(stock.balanceOf(attacker), 0);
    }

    function test_RouterLyingAboutOutputReverts() public {
        slip.setMode(MockRouterBase.Mode.LIE_ABOUT_OUTPUT);
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        uint256 delivered = (997_500_000 * 1e12) / 2;
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InsufficientOutput.selector, delivered, p.amountOutMinimum));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    // ------------------------------------------------------------------
    // Calldata validation (executor encodes every router call itself)
    // ------------------------------------------------------------------

    function test_CalldataEncodedByExecutor_Slipstream() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(slip.lastTokenIn(), address(usdc));
        assertEq(slip.lastTokenOut(), address(stock));
        assertEq(slip.lastTickSpacing(), TICK);
        assertEq(slip.lastRecipient(), taker, "router pays the taker directly");
        assertEq(slip.lastDeadline(), p.deadline);
        assertEq(slip.lastAmountIn(), G - 2_500_000, "amountIn = G - fee");
        assertEq(slip.lastAmountOutMinimum(), p.amountOutMinimum);
        assertEq(uint256(slip.lastSqrtPriceLimitX96()), 0);
        assertEq(slip.lastCaller(), address(ex));
        assertEq(slip.callCount(), 1);
    }

    function test_CalldataEncodedByExecutor_UniswapV3() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.router = address(uni);
        vm.prank(taker);
        ex.swapUniswapV3ExactInputSingle(p, POOL_FEE, _approvalAuth());
        assertEq(uni.lastFee(), POOL_FEE);
        assertEq(uni.lastRecipient(), taker);
        assertEq(uni.lastAmountIn(), G - 2_500_000);
        assertEq(uint256(uni.lastSqrtPriceLimitX96()), 0);
        assertEq(usdc.balanceOf(feeWallet), 2_500_000);
    }

    function test_InvalidTickSpacingReverts() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        vm.startPrank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InvalidTickSpacing.selector, int24(0)));
        ex.swapSlipstreamExactInputSingle(p, 0, _approvalAuth());
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InvalidTickSpacing.selector, int24(-10)));
        ex.swapSlipstreamExactInputSingle(p, -10, _approvalAuth());
        vm.stopPrank();
    }

    function test_InvalidPoolFeeReverts() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.router = address(uni);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InvalidPoolFee.selector, uint24(2500)));
        ex.swapUniswapV3ExactInputSingle(p, 2500, _approvalAuth());
    }

    // ------------------------------------------------------------------
    // minOut / slippage / deadline
    // ------------------------------------------------------------------

    function test_ZeroMinOutReverts() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.amountOutMinimum = 0;
        vm.prank(taker);
        vm.expectRevert(MPGRExecutor.ZeroMinimumOutput.selector);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_SlippageFailure_AtomicRevert() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        slip.setRate(1e12 * 98, 100); // price moved 2% against the taker (> 1% slippage)
        Snap memory before = _snap(address(usdc), address(stock), address(slip));
        vm.prank(taker);
        vm.expectRevert(bytes("Too little received"));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        _assertUnchanged(before, _snap(address(usdc), address(stock), address(slip)));
    }

    function test_MinOutExactlyMetSucceeds() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.amountOutMinimum = 997_500_000 * 1e12;
        vm.prank(taker);
        uint256 out = ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(out, p.amountOutMinimum);
    }

    function test_DeadlineExpiredReverts() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        vm.warp(p.deadline + 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.DeadlineExpired.selector, p.deadline, p.deadline + 1));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    // ------------------------------------------------------------------
    // Router failure / complete atomic revert
    // ------------------------------------------------------------------

    function test_RouterFailure_AtomicRevertIncludingFee() public {
        slip.setMode(MockRouterBase.Mode.REVERT);
        Snap memory before = _snap(address(usdc), address(stock), address(slip));
        vm.prank(taker);
        vm.expectRevert(bytes("router failure"));
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        _assertUnchanged(before, _snap(address(usdc), address(stock), address(slip)));
        assertEq(usdc.balanceOf(feeWallet), 0, "fee must revert with the swap");
    }

    function test_RouterPullingLessThanSwapAmount_Reverts() public {
        slip.setMode(MockRouterBase.Mode.PULL_LESS);
        Snap memory before = _snap(address(usdc), address(stock), address(slip));
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InputNotFullyConsumed.selector, uint256(0), uint256(1)));
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        _assertUnchanged(before, _snap(address(usdc), address(stock), address(slip)));
    }

    function test_RouterReturningInput_Reverts() public {
        slip.setMode(MockRouterBase.Mode.RETURN_INPUT);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InputNotFullyConsumed.selector, uint256(0), uint256(1)));
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
    }

    // ------------------------------------------------------------------
    // Reentrancy
    // ------------------------------------------------------------------

    function test_Reentrancy_FromRouterBlocked() public {
        MPGRExecutor.SwapParams memory inner = _usdcToStock(G);
        slip.setMode(MockRouterBase.Mode.REENTER);
        slip.setReenter(
            address(ex), abi.encodeCall(MPGRExecutor.swapSlipstreamExactInputSingle, (inner, TICK, _approvalAuth()))
        );
        Snap memory before = _snap(address(usdc), address(stock), address(slip));
        vm.prank(taker);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        _assertUnchanged(before, _snap(address(usdc), address(stock), address(slip)));
    }

    function test_Reentrancy_FromFeeRecipientOnNativeFeeBlocked() public {
        ReenteringReceiver evil = new ReenteringReceiver();
        vm.prank(owner);
        ex.setFeeRecipient(address(evil));
        uni.setRate(3000, 1e12);
        MPGRExecutor.SwapParams memory p = _params(address(uni), address(weth), address(usdc), 1 ether, 1);
        MPGRExecutor.SwapParams memory inner = _usdcToStock(G);
        inner.recipient = address(evil);
        evil.arm(
            address(ex),
            abi.encodeCall(MPGRExecutor.swapSlipstreamExactInputSingle, (inner, TICK, _approvalAuth())),
            false
        );
        vm.prank(taker);
        ex.swapUniswapV3ExactInputSingle{value: 1 ether}(p, POOL_FEE, _approvalAuth());
        assertTrue(evil.attempted(), "re-entry was attempted");
        assertEq(evil.lastRevertSelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(address(evil).balance, 0.0025 ether, "outer trade still paid the exact fee once");
    }

    function test_Reentrancy_FromFeeRecipientBubbling_AtomicRevert() public {
        ReenteringReceiver evil = new ReenteringReceiver();
        vm.prank(owner);
        ex.setFeeRecipient(address(evil));
        MPGRExecutor.SwapParams memory p = _params(address(uni), address(weth), address(usdc), 1 ether, 1);
        MPGRExecutor.SwapParams memory inner = _usdcToStock(G);
        evil.arm(
            address(ex),
            abi.encodeCall(MPGRExecutor.swapSlipstreamExactInputSingle, (inner, TICK, _approvalAuth())),
            true
        );
        uint256 before = taker.balance;
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(MPGRExecutor.NativeTransferFailed.selector, address(evil), 0.0025 ether)
        );
        ex.swapUniswapV3ExactInputSingle{value: 1 ether}(p, POOL_FEE, _approvalAuth());
        assertEq(taker.balance, before);
    }

    // ------------------------------------------------------------------
    // Token draining / approval abuse
    // ------------------------------------------------------------------

    function test_ApprovalAbuse_AttackerCannotSpendVictimAllowance() public {
        // Victim has a standing max approval to the executor.
        usdc.mint(victim, 10_000e6);
        vm.prank(victim);
        usdc.approve(address(ex), type(uint256).max);

        // Attacker crafts a trade: tokens are pulled from msg.sender (attacker),
        // never from the victim, and output can only go to msg.sender.
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.recipient = attacker;
        vm.prank(attacker);
        vm.expectRevert(); // attacker has no balance/allowance
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());

        // Recipient pointing at the attacker while the victim calls is also blocked.
        vm.prank(victim);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.InvalidRecipient.selector, attacker, victim));
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(usdc.balanceOf(victim), 10_000e6, "victim untouched");
    }

    function test_ApprovalAbuse_MaliciousRouterCannotPullVictimFunds() public {
        usdc.mint(victim, 10_000e6);
        vm.prank(victim);
        usdc.approve(address(ex), type(uint256).max);
        slip.setMode(MockRouterBase.Mode.PULL_FROM_VICTIM);
        slip.setAttack(attacker, victim);
        vm.prank(taker);
        vm.expectRevert(); // router has no allowance from the victim
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        assertEq(usdc.balanceOf(victim), 10_000e6);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_NoResidualRouterAllowanceOrBalances() public {
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        vm.prank(taker);
        ex.swapUniswapV3ExactInputSingle(
            _params(address(uni), address(usdc), address(stock), G, 1), POOL_FEE, _approvalAuth()
        );
        assertEq(usdc.allowance(address(ex), address(slip)), 0);
        assertEq(usdc.allowance(address(ex), address(uni)), 0);
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(stock.balanceOf(address(ex)), 0);
        assertEq(address(ex).balance, 0);
    }

    // ------------------------------------------------------------------
    // ERC-20 / WETH / native ETH
    // ------------------------------------------------------------------

    function test_ERC20_SellStockForUSDC() public {
        stock.mint(taker, 10e18);
        vm.prank(taker);
        stock.approve(address(ex), 10e18);
        slip.setRate(1, 1e12);
        MPGRExecutor.SwapParams memory p = _params(address(slip), address(stock), address(usdc), 10e18, 1);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
        assertEq(stock.balanceOf(feeWallet), 25e15, "fee in SELL token (stock)");
        assertEq(usdc.balanceOf(feeWallet), 0, "never in buy token");
    }

    function test_WETH_AsERC20Sell() public {
        vm.startPrank(taker);
        weth.deposit{value: 2 ether}();
        weth.approve(address(ex), 2 ether);
        vm.stopPrank();
        uni.setRate(3000, 1e12); // 1 ETH -> 3000 USDC
        MPGRExecutor.SwapParams memory p = _params(address(uni), address(weth), address(usdc), 2 ether, 1);
        vm.prank(taker);
        ex.swapUniswapV3ExactInputSingle(p, 500, _approvalAuth());
        assertEq(weth.balanceOf(feeWallet), 0.005 ether);
        assertEq(uni.lastAmountIn(), 1.995 ether);
    }

    function test_NativeETH_In_FeeInNativeETH() public {
        uni.setRate(3000, 1e12);
        MPGRExecutor.SwapParams memory p = _params(address(uni), address(weth), address(usdc), 1 ether, 1);
        uint256 takerEthBefore = taker.balance;
        vm.recordLogs();
        vm.prank(taker);
        uint256 out = ex.swapUniswapV3ExactInputSingle{value: 1 ether}(p, 500, _approvalAuth());
        assertEq(feeWallet.balance, 0.0025 ether, "fee is native ETH (the sell asset)");
        assertEq(takerEthBefore - taker.balance, 1 ether);
        assertEq(uni.lastAmountIn(), 0.9975 ether);
        assertEq(out, (0.9975 ether * 3000) / 1e12);
        assertEq(weth.balanceOf(address(ex)), 0);
        assertEq(address(ex).balance, 0);
    }

    function test_NativeETH_In_ValueMismatchReverts() public {
        MPGRExecutor.SwapParams memory p = _params(address(uni), address(weth), address(usdc), 1 ether, 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutor.NativeValueMismatch.selector, 0.5 ether, 1 ether));
        ex.swapUniswapV3ExactInputSingle{value: 0.5 ether}(p, 500, _approvalAuth());
    }

    function test_NativeETH_In_RequiresWethTokenIn() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        vm.prank(taker);
        vm.expectRevert(MPGRExecutor.NativeInputRequiresWeth.selector);
        ex.swapSlipstreamExactInputSingle{value: 1}(p, TICK, _approvalAuth());
    }

    function test_NativeETH_In_RequiresApprovalAuth() public {
        MPGRExecutor.SwapParams memory p = _params(address(uni), address(weth), address(usdc), 1 ether, 1);
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.EIP2612;
        vm.prank(taker);
        vm.expectRevert(MPGRExecutor.NativeInputRequiresApprovalAuth.selector);
        ex.swapUniswapV3ExactInputSingle{value: 1 ether}(p, 500, a);
    }

    function test_NativeETH_In_FeeRecipientRejectingETH_AtomicRevert() public {
        NativeRejecter rejecter = new NativeRejecter();
        vm.prank(owner);
        ex.setFeeRecipient(address(rejecter));
        MPGRExecutor.SwapParams memory p = _params(address(uni), address(weth), address(usdc), 1 ether, 1);
        uint256 before = taker.balance;
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(MPGRExecutor.NativeTransferFailed.selector, address(rejecter), 0.0025 ether)
        );
        ex.swapUniswapV3ExactInputSingle{value: 1 ether}(p, 500, _approvalAuth());
        assertEq(taker.balance, before);
    }

    function test_NativeETH_Out_Unwrap() public {
        uni.setRate(1e12, 3000); // 3000 USDC -> 1 ETH
        MPGRExecutor.SwapParams memory p = _params(address(uni), address(usdc), address(weth), 3000e6, 1);
        p.unwrapNativeOut = true;
        uint256 ethBefore = taker.balance;
        vm.prank(taker);
        uint256 out = ex.swapUniswapV3ExactInputSingle(p, 500, _approvalAuth());
        assertEq(uni.lastRecipient(), address(ex), "WETH routed via executor for unwrap");
        assertEq(taker.balance - ethBefore, out);
        assertEq(out, ((3000e6 - 7_500_000) * 1e12) / 3000);
        assertEq(usdc.balanceOf(feeWallet), 7_500_000);
        assertEq(weth.balanceOf(address(ex)), 0);
        assertEq(address(ex).balance, 0);
    }

    function test_NativeETH_Out_RequiresWethOut() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.unwrapNativeOut = true;
        vm.prank(taker);
        vm.expectRevert(MPGRExecutor.UnwrapRequiresWethOut.selector);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }

    function test_DirectETHTransferRejected() public {
        vm.prank(taker);
        (bool ok,) = address(ex).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------------
    // EIP-2612 permit / Permit2
    // ------------------------------------------------------------------

    function _signPermit(uint256 key, MockPermitToken token, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address holder = vm.addr(key);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                holder,
                spender,
                value,
                token.nonces(holder),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(key, digest);
    }

    function test_EIP2612_OneTransactionWithoutPriorApproval() public {
        vm.prank(taker);
        usdc.approve(address(ex), 0);
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.EIP2612;
        a.deadline = block.timestamp + 600;
        (a.v, a.r, a.s) = _signPermit(takerKey, usdc, address(ex), G, a.deadline);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, a);
        assertEq(usdc.balanceOf(feeWallet), 2_500_000);
        assertEq(usdc.allowance(taker, address(ex)), 0, "permit allowance fully consumed");
    }

    function test_EIP2612_FrontRunPermitStillSucceeds() public {
        vm.prank(taker);
        usdc.approve(address(ex), 0);
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.EIP2612;
        a.deadline = block.timestamp + 600;
        (a.v, a.r, a.s) = _signPermit(takerKey, usdc, address(ex), G, a.deadline);
        // Griefer submits the permit first.
        usdc.permit(taker, address(ex), G, a.deadline, a.v, a.r, a.s);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, a);
        assertEq(usdc.balanceOf(feeWallet), 2_500_000);
    }

    function test_EIP2612_InvalidSignatureReverts() public {
        vm.prank(taker);
        usdc.approve(address(ex), 0);
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.EIP2612;
        a.deadline = block.timestamp + 600;
        (a.v, a.r, a.s) = _signPermit(victimKey, usdc, address(ex), G, a.deadline); // wrong signer
        vm.prank(taker);
        vm.expectRevert(MPGRExecutor.PermitFailed.selector);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, a);
    }

    function _signPermit2(uint256 key, address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = permit2.digest(token, amount, nonce, deadline, address(ex));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, d);
        return abi.encodePacked(r, s, v);
    }

    function test_Permit2_OneTransaction() public {
        vm.startPrank(taker);
        usdc.approve(address(ex), 0);
        usdc.approve(address(permit2), type(uint256).max); // typical existing Permit2 approval
        vm.stopPrank();
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.PERMIT2;
        a.nonce = 7;
        a.deadline = block.timestamp + 600;
        a.signature = _signPermit2(takerKey, address(usdc), G, 7, a.deadline);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, a);
        assertEq(usdc.balanceOf(feeWallet), 2_500_000);
        assertTrue(permit2.nonceUsed(taker, 7));
    }

    function test_Permit2_SignatureOfAnotherOwnerCannotBeUsed() public {
        // Victim signed a Permit2 transfer to the executor; attacker replays it.
        usdc.mint(victim, G);
        vm.prank(victim);
        usdc.approve(address(permit2), type(uint256).max);
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.PERMIT2;
        a.nonce = 1;
        a.deadline = block.timestamp + 600;
        a.signature = _signPermit2(victimKey, address(usdc), G, 1, a.deadline);
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        p.recipient = attacker;
        vm.prank(attacker);
        vm.expectRevert(bytes("InvalidSigner")); // owner is forced to msg.sender
        ex.swapSlipstreamExactInputSingle(p, TICK, a);
        assertEq(usdc.balanceOf(victim), G);
    }

    // ------------------------------------------------------------------
    // Pause / rescue / events
    // ------------------------------------------------------------------

    function test_PauseBlocksTradesAndUnpauseRestores() public {
        vm.prank(owner);
        ex.pause();
        vm.prank(taker);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        vm.prank(owner);
        ex.unpause();
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
    }

    function test_RescueStrayTokens_OwnerOnly() public {
        usdc.mint(address(ex), 123);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        ex.rescueERC20(address(usdc), attacker, 123);
        vm.prank(owner);
        vm.expectEmit(address(ex));
        emit MPGRExecutor.TokensRescued(address(usdc), owner, 123);
        ex.rescueERC20(address(usdc), owner, 123);
        assertEq(usdc.balanceOf(owner), 123);
    }

    function test_StrayBalanceDoesNotBreakInvariants() public {
        // Someone donates tokens to the executor; trades still settle and the
        // donation is neither taken from nor added to any trade.
        usdc.mint(address(ex), 555);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_usdcToStock(G), TICK, _approvalAuth());
        assertEq(usdc.balanceOf(address(ex)), 555);
        assertEq(usdc.balanceOf(feeWallet), 2_500_000);
    }

    function test_SwapExecutedEventComplete() public {
        MPGRExecutor.SwapParams memory p = _usdcToStock(G);
        vm.expectEmit(address(ex));
        emit MPGRExecutor.SwapExecuted(
            taker,
            address(slip),
            p.intentId,
            address(usdc),
            address(stock),
            G,
            2_500_000,
            997_500_000,
            997_500_000 * 1e12,
            feeWallet,
            25,
            MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM,
            0
        );
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, TICK, _approvalAuth());
    }
}

import {Vm} from "forge-std/Vm.sol";

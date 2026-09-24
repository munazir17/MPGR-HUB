// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";
import {
    MockPermitToken,
    MockWETH9,
    MockRouterBase,
    MockSlipstreamRouter,
    MockUniswapV3Router02,
    MockPermit2
} from "./mocks/ExecutorMocks.sol";

/// @notice Drives random trades (good and bad) through the executor.
contract ExecutorHandler is Test {
    MPGRExecutor internal ex;
    MockPermitToken internal usdc;
    MockPermitToken internal stock;
    MockWETH9 internal weth;
    MockSlipstreamRouter internal slip;
    MockUniswapV3Router02 internal uni;
    address internal owner;
    address internal feeWallet;
    address[3] internal takers;

    uint256 public expectedFees; // ghost: sum of fees that must have reached feeWallet in USDC
    uint256 public successfulTrades;

    constructor(
        MPGRExecutor ex_,
        MockPermitToken usdc_,
        MockPermitToken stock_,
        MockWETH9 weth_,
        MockSlipstreamRouter slip_,
        MockUniswapV3Router02 uni_,
        address owner_,
        address feeWallet_
    ) {
        ex = ex_;
        usdc = usdc_;
        stock = stock_;
        weth = weth_;
        slip = slip_;
        uni = uni_;
        owner = owner_;
        feeWallet = feeWallet_;
        takers = [makeAddr("t0"), makeAddr("t1"), makeAddr("t2")];
        for (uint256 i = 0; i < 3; ++i) {
            usdc.mint(takers[i], 1e15);
            vm.prank(takers[i]);
            usdc.approve(address(ex), type(uint256).max);
        }
    }

    /// @dev ~75% honest trades, ~25% hostile (lying fee or a malicious router mode).
    function trade(uint256 takerSeed, uint256 gross, uint256 scenario, bool useUni) external {
        address taker = takers[takerSeed % 3];
        scenario = scenario % 16;
        gross = scenario == 15 ? bound(gross, 1, 399) : bound(gross, 400, 1e12); // 15: fee rounds to zero
        bool honestFee = scenario != 12;
        MockRouterBase router = useUni ? MockRouterBase(address(uni)) : MockRouterBase(address(slip));
        // 13/14 -> hostile router modes (PULL_LESS..PULL_FROM_VICTIM, skipping REENTER which needs arming)
        if (scenario == 13 || scenario == 14) {
            uint256 m = 1 + (uint256(keccak256(abi.encode(gross, takerSeed))) % 7);
            if (m == uint256(MockRouterBase.Mode.REENTER)) m = uint256(MockRouterBase.Mode.REDIRECT_OUTPUT);
            router.setMode(MockRouterBase.Mode(m));
        }
        router.setAttack(makeAddr("attacker"), takers[(takerSeed + 1) % 3]);
        uint256 fee = (gross * ex.feeBps()) / 10_000;
        MPGRExecutor.SwapParams memory p = MPGRExecutor.SwapParams({
            router: address(router),
            tokenIn: address(usdc),
            tokenOut: address(stock),
            grossAmountIn: gross,
            expectedFeeAmount: honestFee ? fee : fee + 1,
            amountOutMinimum: 1,
            recipient: taker,
            deadline: block.timestamp + 60,
            intentId: bytes32(gross),
            unwrapNativeOut: false
        });
        MPGRExecutor.Authorization memory a;
        vm.prank(taker);
        bool ok;
        if (useUni) {
            try ex.swapUniswapV3ExactInputSingle(p, 500, a) {
                ok = true;
            } catch {}
        } else {
            try ex.swapSlipstreamExactInputSingle(p, 10, a) {
                ok = true;
            } catch {}
        }
        if (ok) {
            expectedFees += fee;
            successfulTrades += 1;
        }
        router.setMode(MockRouterBase.Mode.NORMAL);
    }

    function setFee(uint16 bps) external {
        bps = uint16(bound(bps, 0, 100));
        vm.prank(owner);
        ex.setFeeBps(bps);
    }
}

contract MPGRExecutorInvariantTest is Test {
    MPGRExecutor internal ex;
    MockPermitToken internal usdc;
    MockPermitToken internal stock;
    MockWETH9 internal weth;
    MockSlipstreamRouter internal slip;
    MockUniswapV3Router02 internal uni;
    ExecutorHandler internal handler;
    address internal owner = makeAddr("owner");
    address internal feeWallet = makeAddr("feeWallet");

    function setUp() public {
        usdc = new MockPermitToken("USD Coin", "USDC", 6);
        stock = new MockPermitToken("Stock", "STK", 18);
        weth = new MockWETH9();
        slip = new MockSlipstreamRouter();
        uni = new MockUniswapV3Router02();
        MockPermit2 permit2 = new MockPermit2();
        MPGRExecutor.RouterConfig[] memory routers = new MPGRExecutor.RouterConfig[](2);
        routers[0] = MPGRExecutor.RouterConfig(address(slip), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
        routers[1] = MPGRExecutor.RouterConfig(address(uni), MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(stock);
        ex = new MPGRExecutor(owner, feeWallet, 25, address(weth), address(permit2), routers, tokens);
        stock.mint(address(slip), 1e40);
        stock.mint(address(uni), 1e40);
        slip.setRate(1e12, 1);
        uni.setRate(1e12, 1);
        handler = new ExecutorHandler(ex, usdc, stock, weth, slip, uni, owner, feeWallet);
        targetContract(address(handler));
    }

    /// Executor never retains user funds between transactions.
    function invariant_NoCustody() public view {
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(stock.balanceOf(address(ex)), 0);
        assertEq(weth.balanceOf(address(ex)), 0);
        assertEq(address(ex).balance, 0);
    }

    /// Executor never leaves a standing allowance to any router.
    function invariant_NoDanglingRouterAllowance() public view {
        assertEq(usdc.allowance(address(ex), address(slip)), 0);
        assertEq(usdc.allowance(address(ex), address(uni)), 0);
    }

    /// The fee wallet received exactly the sum of exact fees of settled trades — no more, no less.
    function invariant_FeeWalletReceivesExactlyTheFees() public view {
        assertEq(usdc.balanceOf(feeWallet), handler.expectedFees());
    }

    /// Guard against a vacuous run: real trades must have settled.
    function afterInvariant() public view {
        assertGt(handler.successfulTrades(), 0, "no trade ever settled");
    }

    /// Fee can never exceed the hard cap.
    function invariant_FeeWithinCap() public view {
        assertLe(ex.feeBps(), ex.MAX_FEE_BPS());
    }
}

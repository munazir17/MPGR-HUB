// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {MPGRSwapExecutorV2 as E} from "../../contracts/swap/MPGRSwapExecutorV2.sol";
import {IMPGRV4PoolManager as V4} from "../../contracts/swap/interfaces/IMPGRV4PoolManager.sol";
import {MockPermitToken, MockWETH9, MockPermit2, MockFeeOnTransferToken} from "../executor/mocks/ExecutorMocks.sol";
import {MockSwapV2Router, MockClassicRouter, MockFactoryHub, MockPool} from "./MPGRSwapExecutor.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev ABI/lifecycle fixture ONLY. This is not evidence of a real v4 pool.
contract MockV4Manager {
    uint256 amount;

    function unlock(bytes calldata data) public virtual returns (bytes memory) {
        (bool ok, bytes memory ret) = msg.sender.call(abi.encodeWithSignature("unlockCallback(bytes)", data));
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        return ret;
    }

    function swap(V4.PoolKey calldata, V4.SwapParams calldata p, bytes calldata) public virtual returns (int256) {
        amount = uint256(-p.amountSpecified);
        int128 sell = -int128(int256(amount));
        int128 buy = int128(int256(amount));
        return p.zeroForOne
            ? (int256(sell) << 128) | int256(uint256(uint128(buy)))
            : (int256(buy) << 128) | int256(uint256(uint128(sell)));
    }
    function sync(address) external {}

    function settle() external payable returns (uint256) {
        return amount;
    }

    function take(address currency, address to, uint256 value) external {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: value}("");
            require(ok);
        } else {
            IERC20(currency).transfer(to, value);
        }
    }
    receive() external payable {}
}

/// @dev The real manager calls a pool's hooks during swap. This fixture also
/// exposes a deliberately adversarial manager-identity callback replay, which
/// is stronger than a hook's direct call (where msg.sender is never manager).
contract HookedV4Manager is MockV4Manager {
    bytes private callbackData;

    function unlock(bytes calldata data) public override returns (bytes memory) {
        callbackData = data;
        return super.unlock(data);
    }

    function swap(V4.PoolKey calldata key, V4.SwapParams calldata p, bytes calldata hookData)
        public
        override
        returns (int256)
    {
        ReentrantV4Hook(key.hooks).attack(msg.sender);
        return super.swap(key, p, hookData);
    }

    function replay(address executor) external {
        E(payable(executor)).unlockCallback(callbackData);
    }
}

contract ReentrantV4Hook {
    uint8 private immutable mode;
    bytes private payload;

    constructor(uint8 attackMode, bytes memory callData) {
        mode = attackMode;
        payload = callData;
    }

    function attack(address executor) external {
        if (mode == 3) {
            HookedV4Manager(payable(msg.sender)).replay(executor);
        } else {
            // Bubble the failed attempt so the entire outer swap must roll
            // back, including the already-transferred protocol fee.
            (bool ok, bytes memory result) = executor.call(payload);
            if (!ok) assembly { revert(add(result, 32), mload(result)) }
            revert("reentry unexpectedly succeeded");
        }
    }
}

contract MPGRSwapExecutorV2Test is Test {
    E ex;
    MockPermitToken a;
    MockPermitToken b;
    MockWETH9 w;
    MockSwapV2Router router;
    MockClassicRouter classic;
    MockFactoryHub factory;
    MockPool pool;
    address constant SAFE = 0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B;
    address constant FEE = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;
    address constant MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant USER = address(0x1234);
    uint256 constant G = 10001;

    function setUp() public {
        vm.etch(SAFE, hex"00");
        a = new MockPermitToken("Long tail A", "A", 18);
        b = new MockPermitToken("Long tail B", "B", 18);
        w = new MockWETH9();
        router = new MockSwapV2Router();
        classic = new MockClassicRouter();
        factory = new MockFactoryHub();
        pool = new MockPool();
        vm.etch(MANAGER, address(new MockV4Manager()).code);
        E.RouterConfig[] memory configs = new E.RouterConfig[](3);
        configs[0] = E.RouterConfig(address(router), E.RouterKind.UNISWAP_V2_ROUTER02, address(factory));
        configs[1] = E.RouterConfig(address(classic), E.RouterKind.AERODROME_CLASSIC, address(factory));
        configs[2] = E.RouterConfig(MANAGER, E.RouterKind.UNISWAP_V4, MANAGER);
        ex = new E(SAFE, address(w), address(new MockPermit2()), configs, 25, FEE);
        factory.set(address(a), address(b), bytes32("v2"), address(pool));
        factory.set(address(a), address(b), bytes32("volatile"), address(pool));
        a.mint(USER, 1e24);
        b.mint(USER, 1e24);
        b.mint(address(router), 1e24);
        b.mint(address(classic), 1e24);
        a.mint(MANAGER, 1e24);
        b.mint(MANAGER, 1e24);
        vm.deal(MANAGER, 100 ether);
        vm.startPrank(USER);
        a.approve(address(ex), type(uint256).max);
        b.approve(address(ex), type(uint256).max);
        vm.stopPrank();
    }

    function params() internal view returns (E.SwapParams memory p) {
        p = E.SwapParams(
            address(router), address(a), address(b), G, 25, G - 25, USER, block.timestamp + 100, bytes32("test"), false
        );
    }

    function auth() internal pure returns (E.Authorization memory v) {
        v.kind = E.AuthKind.APPROVAL;
    }

    function path(address r, E.RouterKind kind) internal view returns (E.Hop[] memory h) {
        h = new E.Hop[](1);
        h[0].router = r;
        h[0].kind = kind;
        h[0].pool = address(pool);
        h[0].tokenOut = address(b);
    }

    function testDirectArbitraryTokensFeeEventAndNoDust() public {
        vm.recordLogs();
        vm.prank(USER);
        assertEq(ex.swapExactInput(params(), path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02), auth()), G - 25);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        bytes32 sig = keccak256(
            "SwapExecuted(address,address,bytes32,address,address,uint256,uint256,uint256,uint256,address,uint16,uint8,uint8)"
        );
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ex) && logs[i].topics[0] == sig) {
                ++count;
                (
                    address tin,
                    address tout,
                    uint256 gross,
                    uint256 fee,
                    uint256 net,
                    uint256 out,
                    address recipient,
                    uint16 bps,,
                ) = abi.decode(
                    logs[i].data,
                    (address, address, uint256, uint256, uint256, uint256, address, uint16, E.RouterKind, uint8)
                );
                assertEq(tin, address(a));
                assertEq(tout, address(b));
                assertEq(gross, G);
                assertEq(fee, 25);
                assertEq(net, G - 25);
                assertEq(out, G - 25);
                assertEq(recipient, FEE);
                assertEq(bps, 25);
            }
        }
        assertEq(count, 1);
        assertEq(a.balanceOf(FEE), 25);
        assertEq(a.balanceOf(address(ex)), 0);
        assertEq(a.allowance(address(ex), address(router)), 0);
    }

    function testSplitFeeOnceOnGrossNotPerLeg() public {
        E.Hop[][] memory paths = new E.Hop[][](2);
        paths[0] = path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02);
        paths[1] = path(address(classic), E.RouterKind.AERODROME_CLASSIC);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 4999;
        amounts[1] = G - 25 - 4999;
        vm.prank(USER);
        assertEq(ex.swapExactInputSplit(params(), paths, amounts, auth()), G - 25);
        assertEq(a.balanceOf(FEE), 25);
        assertEq(a.balanceOf(address(ex)), 0);
        assertEq(a.allowance(address(ex), address(classic)), 0);
    }

    function testFeeTermsCannotBeForged() public {
        E.SwapParams memory p = params();
        p.expectedFeeAmount = 0;
        vm.expectRevert();
        vm.prank(USER);
        ex.swapExactInput(p, path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02), auth());
        vm.expectRevert();
        vm.prank(SAFE);
        ex.proposeFeeChange(25, USER);
        vm.expectRevert();
        vm.prank(SAFE);
        ex.proposeFeeChange(0, FEE);
        assertEq(a.balanceOf(FEE), 0);
    }

    function testTimelockOwnerAndCap() public {
        vm.prank(SAFE);
        ex.proposeFeeChange(100, FEE);
        assertEq(ex.feeBps(), 25);
        vm.expectRevert();
        vm.prank(SAFE);
        ex.applyFeeChange();
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        ex.applyFeeChange();
        vm.prank(SAFE);
        ex.applyFeeChange();
        assertEq(ex.feeBps(), 100);
        vm.expectRevert();
        vm.prank(SAFE);
        ex.proposeFeeChange(101, FEE);
    }

    function testUnprovenAdaptersAndSettlerDisabled() public {
        vm.expectRevert();
        vm.prank(SAFE);
        ex.setRouter(address(router), E.RouterKind.PANCAKE_V3, address(factory));
        vm.expectRevert();
        vm.prank(SAFE);
        ex.setRouter(address(router), E.RouterKind.ZEROX_SETTLER, address(factory));
        vm.prank(USER);
        (bool ok,) = address(ex).call(abi.encodeWithSignature("swapViaAggregator()"));
        assertFalse(ok);
    }

    function testOwnershipCannotReturnToDeployerOrRenounce() public {
        vm.expectRevert();
        vm.prank(SAFE);
        ex.transferOwnership(address(this));
        vm.expectRevert();
        vm.prank(SAFE);
        ex.renounceOwnership();
    }

    function testPause() public {
        vm.prank(SAFE);
        ex.pause();
        vm.expectRevert();
        vm.prank(USER);
        ex.swapExactInput(params(), path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02), auth());
        vm.prank(SAFE);
        ex.unpause();
        vm.prank(USER);
        ex.swapExactInput(params(), path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02), auth());
    }

    function v4Path(address input, address output, bool nativePool) internal view returns (E.Hop[] memory h) {
        h = new E.Hop[](1);
        h[0].router = MANAGER;
        h[0].kind = E.RouterKind.UNISWAP_V4;
        h[0].pool = MANAGER;
        h[0].tokenOut = output;
        address c0 = nativePool ? address(0) : (input < output ? input : output);
        address c1 = nativePool ? (input == address(w) ? output : input) : (input < output ? output : input);
        h[0].v4Key = V4.PoolKey(c0, c1, 3000, 60, address(0));
    }

    function testV4TokenTokenCallbackLifecycleFixture() public {
        E.SwapParams memory p = params();
        p.router = MANAGER;
        vm.prank(USER);
        assertEq(ex.swapExactInput(p, v4Path(address(a), address(b), false), auth()), G - 25);
        assertEq(a.balanceOf(FEE), 25);
        assertEq(a.balanceOf(address(ex)), 0);
    }

    function testV4NativeOutputWrappedFixture() public {
        E.SwapParams memory p = params();
        p.router = MANAGER;
        p.tokenOut = address(w);
        vm.prank(USER);
        assertEq(ex.swapExactInput(p, v4Path(address(a), address(w), true), auth()), G - 25);
        assertEq(w.balanceOf(USER), G - 25);
        assertEq(address(ex).balance, 0);
    }

    function testV4NativeInputFixture() public {
        E.SwapParams memory p = params();
        p.router = MANAGER;
        p.tokenIn = address(w);
        vm.deal(USER, G);
        vm.prank(USER);
        assertEq(ex.swapExactInput{value: G}(p, v4Path(address(w), address(b), true), auth()), G - 25);
        assertEq(FEE.balance, 25);
        assertEq(address(ex).balance, 0);
        assertEq(w.balanceOf(address(ex)), 0);
    }

    function testForeignUnlockReverts() public {
        vm.expectRevert();
        ex.unlockCallback("");
        vm.expectRevert();
        vm.prank(MANAGER);
        ex.unlockCallback("");
    }

    function testNoPoolRollsBackFeeAndPull() public {
        factory.set(address(a), address(b), bytes32("v2"), address(0));
        uint256 before = a.balanceOf(USER);
        vm.expectRevert();
        vm.prank(USER);
        ex.swapExactInput(params(), path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02), auth());
        assertEq(a.balanceOf(USER), before);
        assertEq(a.balanceOf(FEE), 0);
    }

    function testMultihopOneFeeAndNoIntermediateDust() public {
        MockPermitToken mid = new MockPermitToken("Intermediate", "MID", 18);
        mid.mint(address(router), 1e24);
        factory.set(address(a), address(mid), bytes32("v2"), address(pool));
        factory.set(address(mid), address(b), bytes32("v2"), address(pool));
        E.Hop[] memory h = new E.Hop[](2);
        h[0] = path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02)[0];
        h[0].tokenOut = address(mid);
        h[1] = path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02)[0];
        vm.prank(USER);
        assertEq(ex.swapExactInput(params(), h, auth()), G - 25);
        assertEq(a.balanceOf(FEE), 25);
        assertEq(mid.balanceOf(address(ex)), 0);
        assertEq(mid.allowance(address(ex), address(router)), 0);
    }

    function testMinimumFailureRollsBackEverything() public {
        E.SwapParams memory p = params();
        p.amountOutMinimum = G;
        uint256 before = a.balanceOf(USER);
        vm.expectRevert();
        vm.prank(USER);
        ex.swapExactInput(p, path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02), auth());
        assertEq(a.balanceOf(USER), before);
        assertEq(a.balanceOf(FEE), 0);
        assertEq(b.balanceOf(USER), 1e24);
    }

    function testSellFeeOnTransferRejectedAtomically() public {
        MockFeeOnTransferToken taxed = new MockFeeOnTransferToken();
        taxed.mint(USER, G);
        factory.set(address(taxed), address(b), bytes32("v2"), address(pool));
        E.SwapParams memory p = params();
        p.tokenIn = address(taxed);
        vm.prank(USER);
        taxed.approve(address(ex), G);
        vm.expectRevert();
        vm.prank(USER);
        ex.swapExactInput(p, path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02), auth());
        assertEq(taxed.balanceOf(USER), G);
        assertEq(taxed.balanceOf(FEE), 0);
    }

    function testFuzzSplitFeeNeverRoundsPerLeg(uint96 raw, uint16 fraction) public {
        uint256 gross = bound(uint256(raw), 400, 1e20);
        E.SwapParams memory p = params();
        p.grossAmountIn = gross;
        p.expectedFeeAmount = gross * 25 / 10000;
        p.amountOutMinimum = gross - p.expectedFeeAmount;
        uint256 first = bound(uint256(fraction), 1, p.amountOutMinimum - 1);
        E.Hop[][] memory paths = new E.Hop[][](2);
        paths[0] = path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02);
        paths[1] = path(address(classic), E.RouterKind.AERODROME_CLASSIC);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = first;
        amounts[1] = p.amountOutMinimum - first;
        vm.prank(USER);
        ex.swapExactInputSplit(p, paths, amounts, auth());
        assertEq(a.balanceOf(FEE), gross * 25 / 10000);
        assertEq(a.balanceOf(address(ex)), 0);
    }

    function testSplitAllocationMismatchRollsBack() public {
        E.Hop[][] memory paths = new E.Hop[][](2);
        paths[0] = path(address(router), E.RouterKind.UNISWAP_V2_ROUTER02);
        paths[1] = paths[0];
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1;
        amounts[1] = 1;
        vm.expectRevert();
        vm.prank(USER);
        ex.swapExactInputSplit(params(), paths, amounts, auth());
        assertEq(a.balanceOf(FEE), 0);
        assertEq(a.balanceOf(USER), 1e24);
    }

    function testConstructorRejectsUnpinnedTerms() public {
        E.RouterConfig[] memory configs = new E.RouterConfig[](0);
        address permit = address(new MockPermit2());
        vm.expectRevert();
        new E(SAFE, address(w), permit, configs, 26, FEE);
        vm.expectRevert();
        new E(SAFE, address(w), permit, configs, 25, USER);
        vm.expectRevert();
        new E(address(this), address(w), permit, configs, 25, FEE);
        vm.etch(SAFE, hex"");
        vm.expectRevert();
        new E(SAFE, address(w), permit, configs, 25, FEE);
    }

    function testV4ReverseTokenDirectionFixture() public {
        E.SwapParams memory p = params();
        p.router = MANAGER;
        p.tokenIn = address(b);
        p.tokenOut = address(a);
        vm.prank(USER);
        assertEq(ex.swapExactInput(p, v4Path(address(b), address(a), false), auth()), G - 25);
        assertEq(b.balanceOf(FEE), 25);
    }

    function testV4NativeOutputUnwrapFixture() public {
        E.SwapParams memory p = params();
        p.router = MANAGER;
        p.tokenOut = address(w);
        p.unwrapNativeOut = true;
        vm.prank(USER);
        assertEq(ex.swapExactInput(p, v4Path(address(a), address(w), true), auth()), G - 25);
        assertEq(USER.balance, G - 25);
        assertEq(address(ex).balance, 0);
        assertEq(w.balanceOf(address(ex)), 0);
    }

    function testMaliciousV4HookReentryRevertsEntireSingleSwap() public {
        maliciousHookReentry(0, false);
    }

    function testMaliciousV4HookReentryRevertsEntireSplitSwap() public {
        maliciousHookReentry(1, false);
    }

    function testMaliciousV4HookDirectCallbackReentryReverts() public {
        maliciousHookReentry(2, false);
    }

    function testCanonicalManagerCallbackReplayReverts() public {
        maliciousHookReentry(3, false);
    }

    function testMaliciousV4HookReentryDuringOuterSplitReverts() public {
        maliciousHookReentry(0, true);
    }

    function maliciousHookReentry(uint8 mode, bool outerSplit) internal {
        vm.etch(MANAGER, address(new HookedV4Manager()).code);
        E.SwapParams memory p = params();
        p.router = MANAGER;
        E.Hop[] memory h = v4Path(address(a), address(b), false);
        E.Hop[][] memory paths = new E.Hop[][](2);
        paths[0] = h;
        paths[1] = h;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 4999;
        amounts[1] = G - 25 - 4999;
        bytes memory attack;
        if (mode == 0) attack = abi.encodeCall(E.swapExactInput, (p, h, auth()));
        else if (mode == 1) attack = abi.encodeCall(E.swapExactInputSplit, (p, paths, amounts, auth()));
        else attack = abi.encodeCall(E.unlockCallback, (bytes("forged callback")));
        ReentrantV4Hook hook = new ReentrantV4Hook(mode, attack);
        h[0].v4Key.hooks = address(hook);
        uint256 userBefore = a.balanceOf(USER);
        uint256 treasuryBefore = a.balanceOf(FEE);
        uint256 outputBefore = b.balanceOf(USER);
        uint256 managerBefore = a.balanceOf(MANAGER);
        if (mode < 2) vm.expectRevert(bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        else vm.expectRevert(E.InvalidUnlock.selector);
        vm.prank(USER);
        if (outerSplit) ex.swapExactInputSplit(p, paths, amounts, auth());
        else ex.swapExactInput(p, h, auth());
        assertEq(a.balanceOf(USER), userBefore, "gross pull rolled back");
        assertEq(a.balanceOf(FEE), treasuryBefore, "fee rolled back with failed trade");
        assertEq(b.balanceOf(USER), outputBefore, "no double output");
        assertEq(a.balanceOf(MANAGER), managerBefore, "no manager settlement");
        assertEq(a.balanceOf(address(ex)), 0, "no trapped input");
        assertEq(a.allowance(address(ex), MANAGER), 0, "no lingering allowance");
        // The revert must also roll back the one-shot callback capability and
        // outer reentrancy lock: a subsequent normal trade still charges once.
        vm.etch(MANAGER, address(new MockV4Manager()).code);
        h[0].v4Key.hooks = address(0);
        vm.prank(USER);
        ex.swapExactInput(p, h, auth());
        assertEq(a.balanceOf(FEE) - treasuryBefore, 25, "next successful swap paid fee");
    }
}

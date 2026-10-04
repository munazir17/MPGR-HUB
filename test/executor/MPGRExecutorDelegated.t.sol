// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";
import {MPGRExecutorDelegated} from "../../contracts/executor/MPGRExecutorDelegated.sol";
import {IPermit2SignatureTransfer} from "../../contracts/executor/interfaces/IMPGRExecutorRouters.sol";
import {
    MockPermitToken,
    MockFeeOnTransferToken,
    MockWETH9,
    MockRouterBase,
    MockSlipstreamRouter,
    MockUniswapV3Router02,
    MockTypedSwapModule
} from "./mocks/ExecutorMocks.sol";
import {Permit2WitnessMock} from "./mocks/Permit2WitnessMock.sol";

/// @title MPGRExecutorDelegatedTest — Phase 1 suite for the delegated
///         autonomous executor (spec §18 step 2). Pure-unit: runs anywhere.
contract MPGRExecutorDelegatedTest is Test {
    MPGRExecutor internal v1;
    MPGRExecutorDelegated internal dex;

    MockPermitToken internal usdc; // 6 decimals (sell side)
    MockPermitToken internal stock; // 18 decimals (buy side)
    MockFeeOnTransferToken internal fot; // fee-on-transfer rejection target
    MockWETH9 internal weth;

    MockSlipstreamRouter internal slipDex;
    MockUniswapV3Router02 internal uniDex;
    MockSlipstreamRouter internal slipV1;
    MockUniswapV3Router02 internal uniV1;

    Permit2WitnessMock internal permit2;

    address internal admin = makeAddr("admin");
    address internal feeWallet = makeAddr("feeWallet");

    uint256 internal ownerKey = 0xA11CE; // the USER (signs permits, receives output)
    address internal ownerAddr;
    uint256 internal otherKey = 0xB0B; // a different user
    address internal otherAddr;
    uint256 internal broadcasterKey = 0xCA57; // operator gas-only broadcaster
    address internal broadcaster;
    address internal attacker = makeAddr("attacker");

    int24 internal constant TICK = 10;
    uint24 internal constant POOL_FEE = 3000;
    uint256 internal constant G = 1_000e6; // 1000 USDC gross
    uint16 internal constant BPS = 25;
    uint256 internal constant START = 1_800_000_000;
    uint256 internal constant DL = 1_800_100_000; // deadline
    uint256 internal constant RATE_NUM = 1e12; // 1 usdc(6) -> 1e12 * 1 stock-wei (1:1 whole units)
    uint256 internal constant RATE_DEN = 1;

    bytes32 internal constant POLICY_HASH = keccak256("mpgr-autonomy-policy-v1");
    bytes32 internal constant ACTION_ID = keccak256("action-slot-1");
    bytes32 internal constant SWAP_EXECUTED_TOPIC =
        keccak256("SwapExecuted(address,address,bytes32,address,address,uint256,uint256,uint256,uint256,address,uint16,uint8,uint8)");

    uint256 internal nonceCounter = 0;

    function setUp() public {
        vm.warp(START);

        ownerAddr = vm.addr(ownerKey);
        otherAddr = vm.addr(otherKey);
        broadcaster = vm.addr(broadcasterKey);

        usdc = new MockPermitToken("USD Coin", "USDC", 6);
        stock = new MockPermitToken("Apple B20", "AAPLc", 18);
        fot = new MockFeeOnTransferToken();
        weth = new MockWETH9();
        slipDex = new MockSlipstreamRouter();
        uniDex = new MockUniswapV3Router02();
        slipV1 = new MockSlipstreamRouter();
        uniV1 = new MockUniswapV3Router02();
        permit2 = new Permit2WitnessMock();

        MPGRExecutorDelegated.RouterConfig[] memory dr = new MPGRExecutorDelegated.RouterConfig[](2);
        dr[0] = MPGRExecutorDelegated.RouterConfig(address(slipDex), MPGRExecutorDelegated.RouterKind.AERODROME_SLIPSTREAM);
        dr[1] = MPGRExecutorDelegated.RouterConfig(address(uniDex), MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02);
        address[] memory dt = new address[](4);
        dt[0] = address(usdc);
        dt[1] = address(stock);
        dt[2] = address(weth);
        dt[3] = address(fot);
        dex = new MPGRExecutorDelegated(admin, feeWallet, BPS, address(weth), address(permit2), dr, dt);

        MPGRExecutor.RouterConfig[] memory vr = new MPGRExecutor.RouterConfig[](2);
        vr[0] = MPGRExecutor.RouterConfig(address(slipV1), MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
        vr[1] = MPGRExecutor.RouterConfig(address(uniV1), MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02);
        address[] memory vt = new address[](3);
        vt[0] = address(usdc);
        vt[1] = address(stock);
        vt[2] = address(weth);
        v1 = new MPGRExecutor(admin, feeWallet, BPS, address(weth), address(permit2), vr, vt);

        // Router liquidity (output side), mirrored per router pair. WETH is
        // deep because the 6->18 rate pays ~1000 WETH per 1000 USDC swap.
        vm.deal(address(this), 4_050_000 ether); // funds the 4 WETH deposits below
        for (uint256 i = 0; i < 2; i++) {
            address r = i == 0 ? address(slipDex) : address(uniDex);
            stock.mint(r, 1e33);
            usdc.mint(r, 1e30);
            weth.deposit{value: 1_010_000 ether}();
            weth.transfer(r, 1_000_000 ether);
        }
        stock.mint(address(slipV1), 1e33);
        stock.mint(address(uniV1), 1e33);
        usdc.mint(address(slipV1), 1e30);
        usdc.mint(address(uniV1), 1e30);
        weth.deposit{value: 1_010_000 ether}();
        weth.deposit{value: 1_010_000 ether}();
        weth.transfer(address(slipV1), 1_000_000 ether);
        weth.transfer(address(uniV1), 1_000_000 ether);

        _setRates(RATE_NUM, RATE_DEN);

        // The owner holds the asset they delegate: the equivalence fuzz pulls
        // gross TWICE (v1 flow + delegated flow) at up to 2e9 usdc each.
        usdc.mint(ownerAddr, 4_200_000_000e6);

        // The user's standing Permit2 approval (real-world one-time approve).
        vm.startPrank(ownerAddr);
        usdc.approve(address(permit2), type(uint256).max);
        stock.approve(address(permit2), type(uint256).max);
        weth.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _setRates(uint256 num, uint256 den) internal {
        slipDex.setRate(num, den);
        uniDex.setRate(num, den);
        slipV1.setRate(num, den);
        uniV1.setRate(num, den);
    }

    function _witnessHash(MPGRExecutorDelegated.ActionWitness memory w) internal view returns (bytes32) {
        return dex.witnessHashOf(w);
    }

    function _witness(address buy, uint256 minOut, uint256 deadline, bytes32 actionId, bytes32 policyHash)
        internal
        view
        returns (MPGRExecutorDelegated.ActionWitness memory)
    {
        return MPGRExecutorDelegated.ActionWitness({
            owner: ownerAddr,
            buyToken: buy,
            minAmountOut: minOut,
            deadline: deadline,
            actionId: actionId,
            policyHash: policyHash
        });
    }

    function _permit(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (IPermit2SignatureTransfer.PermitTransferFrom memory)
    {
        return IPermit2SignatureTransfer.PermitTransferFrom({
            permitted: IPermit2SignatureTransfer.TokenPermissions({token: token, amount: amount}),
            nonce: nonce,
            deadline: deadline
        });
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _nextNonce() internal returns (uint256) {
        nonceCounter += 1;
        return (uint256(5) << 8) | nonceCounter; // word 5, distinct bits
    }

    function _authUniswap(
        uint256 key,
        address sell,
        uint256 gross,
        address buy,
        uint256 minOut,
        uint256 deadline,
        bytes32 actionId,
        bytes32 policyHash
    ) internal returns (MPGRExecutorDelegated.Permit2Authorization memory) {
        uint256 nonce = _nextNonce();
        MPGRExecutorDelegated.ActionWitness memory w = _witness(buy, minOut, deadline, actionId, policyHash);
        IPermit2SignatureTransfer.PermitTransferFrom memory p = _permit(sell, gross, nonce, deadline);
        bytes32 digest = permit2.witnessDigest(p, address(dex), _witnessHash(w), dex.WITNESS_TYPE_STRING());
        return MPGRExecutorDelegated.Permit2Authorization({permit: p, witness: w, signature: _sign(key, digest)});
    }

    function _uniParams(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 gross,
        uint256 minOut,
        uint256 deadline,
        bytes32 intentId,
        bool unwrap
    ) internal view returns (MPGRExecutorDelegated.SwapParams memory) {
        uint256 fee = (gross * BPS) / 10_000;
        return MPGRExecutorDelegated.SwapParams({
            router: router,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            grossAmountIn: gross,
            expectedFeeAmount: fee,
            amountOutMinimum: minOut,
            recipient: ownerAddr,
            deadline: deadline,
            intentId: intentId,
            unwrapNativeOut: unwrap
        });
    }

    /// @dev v1 and the delegated executor declare structurally IDENTICAL
    ///      SwapParams; Solidity structs are nominal, so convert field-by-field.
    function _toV1(MPGRExecutorDelegated.SwapParams memory p)
        internal
        pure
        returns (MPGRExecutor.SwapParams memory v)
    {
        v = MPGRExecutor.SwapParams({
            router: p.router,
            tokenIn: p.tokenIn,
            tokenOut: p.tokenOut,
            grossAmountIn: p.grossAmountIn,
            expectedFeeAmount: p.expectedFeeAmount,
            amountOutMinimum: p.amountOutMinimum,
            recipient: p.recipient,
            deadline: p.deadline,
            intentId: p.intentId,
            unwrapNativeOut: p.unwrapNativeOut
        });
    }

    function _expectedOut(uint256 gross, uint256 num, uint256 den) internal pure returns (uint256) {
        uint256 net = gross - (gross * BPS) / 10_000;
        return (net * num) / den;
    }

    /// @dev Happy-path uni swap: broadcaster submits; returns the router's exact out.
    function _happyUni() internal returns (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        p = _uniParams(address(uniDex), address(usdc), address(stock), G, minOut, DL, ACTION_ID, false);
        a = _authUniswap(ownerKey, address(usdc), G, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
    }

    function _registerTestModule() internal returns (MockTypedSwapModule module) {
        module = new MockTypedSwapModule(address(dex), address(uniDex), RATE_NUM, RATE_DEN);
        vm.prank(admin);
        dex.setRouterModule(address(uniDex), address(module));
    }

    function _happyModule()
        internal
        returns (
            MockTypedSwapModule module,
            MPGRExecutorDelegated.SwapParams memory p,
            MPGRExecutorDelegated.Permit2Authorization memory a
        )
    {
        module = _registerTestModule();
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        p = _uniParams(address(uniDex), address(usdc), address(stock), G, minOut, DL, ACTION_ID, false);
        a = _authUniswap(ownerKey, address(usdc), G, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
    }

    function _runAsBroadcaster(MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a)
        internal
        returns (uint256 out)
    {
        vm.prank(broadcaster);
        out = dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    // ------------------------------------------------------------------
    // Happy paths + owner-as-recipient + event + nonce consumption
    // ------------------------------------------------------------------

    function test_SwapOnBehalfOfUniswapV3_OwnerReceivesOutput_BroadcasterGetsNothing() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        uint256 out = _expectedOut(G, RATE_NUM, RATE_DEN);
        uint256 fee = (G * BPS) / 10_000;

        uint256 ownerUsdc0 = usdc.balanceOf(ownerAddr);
        uint256 ownerStock0 = stock.balanceOf(ownerAddr);
        uint256 fee0 = usdc.balanceOf(feeWallet);
        uint256 bcUsdc0 = usdc.balanceOf(broadcaster);
        uint256 bcStock0 = stock.balanceOf(broadcaster);

        uint256 got = _runAsBroadcaster(p, a);

        assertEq(got, out, "returned amountOut");
        assertEq(usdc.balanceOf(ownerAddr), ownerUsdc0 - G, "owner sold exactly G");
        assertEq(stock.balanceOf(ownerAddr), ownerStock0 + out, "owner received the output");
        assertEq(usdc.balanceOf(feeWallet), fee0 + fee, "exact 25 bps fee");
        assertEq(usdc.balanceOf(broadcaster), bcUsdc0, "broadcaster got no sell token");
        assertEq(stock.balanceOf(broadcaster), bcStock0, "broadcaster got no buy token");
        assertEq(usdc.balanceOf(address(dex)), 0, "no custody left in executor");
        assertEq(stock.balanceOf(address(dex)), 0, "no custody left in executor");
        assertTrue(permit2.nonceBitmap(ownerAddr, 5) == (uint256(1) << 1), "nonce bit 1 burned");
    }

    function test_SwapOnBehalfOfSlipstream_OwnerReceivesOutput() public {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(slipDex), address(usdc), address(stock), G, minOut, DL, ACTION_ID, false);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(usdc), G, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);

        uint256 ownerStock0 = stock.balanceOf(ownerAddr);
        vm.prank(broadcaster);
        uint256 got = dex.swapOnBehalfOfSlipstream(p, TICK, a);

        assertEq(got, minOut, "returned amountOut");
        assertEq(stock.balanceOf(ownerAddr), ownerStock0 + minOut, "owner received output (slipstream)");
    }

    function test_TypedModule_ExactInputAndMeasuredOwnerOutput() public {
        (MockTypedSwapModule module, MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) =
            _happyModule();
        uint256 fee = (G * BPS) / 10_000;
        uint256 out = _expectedOut(G, RATE_NUM, RATE_DEN);
        uint256 ownerSellBefore = usdc.balanceOf(ownerAddr);
        uint256 ownerBuyBefore = stock.balanceOf(ownerAddr);
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        uint256 broadcasterBuyBefore = stock.balanceOf(broadcaster);

        vm.prank(broadcaster);
        uint256 received = dex.swapOnBehalfOfTypedModule(p, a);

        assertEq(received, out, "measured owner output");
        assertEq(usdc.balanceOf(ownerAddr), ownerSellBefore - G, "owner funded exact gross");
        assertEq(stock.balanceOf(ownerAddr), ownerBuyBefore + out, "owner is the output recipient");
        assertEq(usdc.balanceOf(feeWallet), feeBefore + fee, "exact fee");
        assertEq(stock.balanceOf(broadcaster), broadcasterBuyBefore, "broadcaster receives nothing");
        assertEq(usdc.balanceOf(address(module)), 0, "module retains no user input");
        assertEq(usdc.balanceOf(address(dex)), 0, "core retains no input");
        assertEq(stock.balanceOf(address(dex)), 0, "core retains no output");
        assertEq(usdc.allowance(address(dex), address(module)), 0, "no module allowance");
        assertEq(usdc.allowance(address(dex), address(uniDex)), 0, "no router allowance");
        assertEq(uint8(dex.routerKind(address(uniDex))), uint8(MPGRExecutorDelegated.RouterKind.TYPED_SWAP_MODULE));
        assertEq(dex.swapModuleForRouter(address(uniDex)), address(module));
        assertEq(dex.swapModuleCodeHash(address(uniDex)), address(module).codehash);
    }

    function testFuzz_TypedModule_ExactGrossFeeAndNoCustody(uint128 rawGross) public {
        uint256 gross = bound(uint256(rawGross), 400, 1e12);
        MockTypedSwapModule module = _registerTestModule();
        uint256 fee = (gross * BPS) / 10_000;
        uint256 minOut = ((gross - fee) * RATE_NUM) / RATE_DEN;
        bytes32 actionId = bytes32(gross);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(usdc), address(stock), gross, minOut, DL, actionId, false);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(usdc), gross, address(stock), minOut, DL, actionId, POLICY_HASH);
        uint256 ownerSellBefore = usdc.balanceOf(ownerAddr);
        uint256 ownerBuyBefore = stock.balanceOf(ownerAddr);
        uint256 feeBefore = usdc.balanceOf(feeWallet);

        vm.prank(broadcaster);
        uint256 received = dex.swapOnBehalfOfTypedModule(p, a);

        assertEq(received, minOut);
        assertEq(ownerSellBefore - usdc.balanceOf(ownerAddr), gross);
        assertEq(stock.balanceOf(ownerAddr) - ownerBuyBefore, minOut);
        assertEq(usdc.balanceOf(feeWallet) - feeBefore, fee);
        assertEq(usdc.balanceOf(address(module)), 0);
        assertEq(usdc.balanceOf(address(dex)), 0);
        assertEq(stock.balanceOf(address(dex)), 0);
        assertEq(usdc.allowance(address(dex), address(module)), 0);
    }

    function test_TypedModule_MinOutUsesWhatOwnerActuallyReceives() public {
        MockTypedSwapModule module = _registerTestModule();
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(usdc), address(fot), G, minOut, DL, ACTION_ID, false);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(usdc), G, address(fot), minOut, DL, ACTION_ID, POLICY_HASH);
        uint256 actualOwnerOutput = minOut - minOut / 100;

        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InsufficientOutput.selector, actualOwnerOutput, minOut));
        vm.prank(broadcaster);
        dex.swapOnBehalfOfTypedModule(p, a);
        assertEq(fot.balanceOf(ownerAddr), 0, "failed minOut does not deliver taxed output");
        assertEq(fot.balanceOf(address(dex)), 0, "failed minOut rolls back module output");
        assertEq(usdc.balanceOf(address(module)), 0);
    }

    function test_TypedModule_BaseRejectsNonExecutorAndRecipientOverride() public {
        MockTypedSwapModule module = _registerTestModule();
        vm.expectRevert();
        vm.prank(attacker);
        module.swapExactInput(address(usdc), address(stock), 1, 1, DL, address(dex));

        vm.expectRevert();
        vm.prank(address(dex));
        module.swapExactInput(address(usdc), address(stock), 1, 1, DL, ownerAddr);
    }

    function test_TypedModule_OnlyOwnerCanRegister() public {
        MockTypedSwapModule module = new MockTypedSwapModule(address(dex), address(uniDex), RATE_NUM, RATE_DEN);
        vm.expectRevert();
        vm.prank(attacker);
        dex.setRouterModule(address(uniDex), address(module));
        assertEq(uint8(dex.routerKind(address(uniDex))), uint8(MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02));
    }

    function test_TypedModule_RegistrationRequiresExecutorAndRouterBindings() public {
        MockTypedSwapModule wrongExecutor = new MockTypedSwapModule(address(v1), address(uniDex), RATE_NUM, RATE_DEN);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidSwapModule.selector, address(wrongExecutor)));
        vm.prank(admin);
        dex.setRouterModule(address(uniDex), address(wrongExecutor));

        MockTypedSwapModule wrongRouter = new MockTypedSwapModule(address(dex), address(slipDex), RATE_NUM, RATE_DEN);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidSwapModule.selector, address(wrongRouter)));
        vm.prank(admin);
        dex.setRouterModule(address(uniDex), address(wrongRouter));
    }

    function test_TypedModule_RouterKindCannotBeSetWithoutModuleRegistration() public {
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.SwapModuleNotAllowed.selector, address(uniDex)));
        vm.prank(admin);
        dex.setRouter(address(uniDex), MPGRExecutorDelegated.RouterKind.TYPED_SWAP_MODULE);
    }

    function test_TypedModule_RuntimeCodeHashIsPinned() public {
        (MockTypedSwapModule module, MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) =
            _happyModule();
        uint256 ownerSellBefore = usdc.balanceOf(ownerAddr);
        vm.etch(address(module), hex"00");

        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.SwapModuleNotAllowed.selector, address(uniDex)));
        vm.prank(broadcaster);
        dex.swapOnBehalfOfTypedModule(p, a);
        assertEq(usdc.balanceOf(ownerAddr), ownerSellBefore, "no Permit2 pull after codehash mismatch");
        assertEq(permit2.nonceBitmap(ownerAddr, 5), 0, "failed module check does not consume nonce");
    }

    function test_TypedModule_MustConsumeItsExactInputAtomically() public {
        (MockTypedSwapModule module, MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) =
            _happyModule();
        module.setMode(MockTypedSwapModule.Mode.LEAVE_INPUT, address(0));
        uint256 ownerSellBefore = usdc.balanceOf(ownerAddr);

        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.ModuleInputNotConsumed.selector, address(module), 0, 1));
        vm.prank(broadcaster);
        dex.swapOnBehalfOfTypedModule(p, a);
        assertEq(usdc.balanceOf(ownerAddr), ownerSellBefore, "reverted trade restores user input");
        assertEq(usdc.balanceOf(address(module)), 0, "revert leaves module with no input");
        assertEq(permit2.nonceBitmap(ownerAddr, 5), 0, "reverted trade restores Permit2 nonce");
    }

    function test_TypedModule_OutputMustReturnToCoreForOwnerDelivery() public {
        (MockTypedSwapModule module, MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) =
            _happyModule();
        module.setMode(MockTypedSwapModule.Mode.REDIRECT_OUTPUT, attacker);
        uint256 ownerSellBefore = usdc.balanceOf(ownerAddr);

        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InsufficientOutput.selector, 0, p.amountOutMinimum));
        vm.prank(broadcaster);
        dex.swapOnBehalfOfTypedModule(p, a);
        assertEq(usdc.balanceOf(ownerAddr), ownerSellBefore, "redirect attempt reverts atomically");
        assertEq(stock.balanceOf(attacker), 0, "redirected output is rolled back");
    }

    function test_TypedModule_PauseAndNativeInputChecksRemainActive() public {
        (MockTypedSwapModule module, MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) =
            _happyModule();
        vm.prank(admin);
        dex.pause();
        vm.expectRevert();
        vm.prank(broadcaster);
        dex.swapOnBehalfOfTypedModule(p, a);
        vm.prank(admin);
        dex.unpause();

        vm.deal(broadcaster, 1);
        vm.expectRevert(MPGRExecutorDelegated.NativeInputUnsupported.selector);
        vm.prank(broadcaster);
        dex.swapOnBehalfOfTypedModule{value: 1}(p, a);
        assertEq(usdc.balanceOf(address(module)), 0);
    }

    function test_TypedModule_CanBeRemovedWithoutChangingExecutor() public {
        (MockTypedSwapModule module,,) = _happyModule();
        address executorBeforeRemoval = address(dex);
        vm.prank(admin);
        dex.setRouter(address(uniDex), MPGRExecutorDelegated.RouterKind.NONE);
        assertEq(address(dex), executorBeforeRemoval, "module removal does not change executor address");
        assertEq(uint8(dex.routerKind(address(uniDex))), uint8(MPGRExecutorDelegated.RouterKind.NONE));
        assertEq(dex.swapModuleForRouter(address(uniDex)), address(0));
        assertEq(dex.swapModuleCodeHash(address(uniDex)), bytes32(0));
        assertEq(dex.routerForSwapModule(address(module)), address(0));
    }

    function test_SwapOnBehalfOf_EmitsIdenticalSwapExecuted_TakerIsOwner() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        uint256 out = _expectedOut(G, RATE_NUM, RATE_DEN);
        uint256 fee = (G * BPS) / 10_000;

        vm.expectEmit(true, true, true, true, address(dex));
        emit MPGRExecutorDelegated.SwapExecuted(
            ownerAddr,
            p.router,
            ACTION_ID,
            address(usdc),
            address(stock),
            G,
            fee,
            G - fee,
            out,
            feeWallet,
            BPS,
            MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02,
            0
        );
        _runAsBroadcaster(p, a);
    }

    function test_SellDirection_StockToUsdc() public {
        _setRates(1, RATE_NUM); // 1 stock-wei -> 1/1e12 usdc-wei (mirror of the buy side)
        stock.mint(ownerAddr, 2_000e18); // the owner must hold the sell token
        uint256 gross = 1_000e18;
        uint256 minOut = _expectedOut(gross, 1, RATE_NUM);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(stock), address(usdc), gross, minOut, DL, ACTION_ID, false);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(stock), gross, address(usdc), minOut, DL, ACTION_ID, POLICY_HASH);

        uint256 ownerUsdc0 = usdc.balanceOf(ownerAddr);
        vm.prank(broadcaster);
        uint256 got = dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);

        assertEq(got, minOut, "sell-direction out");
        assertEq(usdc.balanceOf(ownerAddr), ownerUsdc0 + minOut, "owner received usdc from stock sale");
    }

    function test_UnwrapNativeOut_DeliveredToOwner() public {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(usdc), address(weth), G, minOut, DL, ACTION_ID, true);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(usdc), G, address(weth), minOut, DL, ACTION_ID, POLICY_HASH);

        uint256 ownerEth0 = ownerAddr.balance;
        vm.prank(broadcaster);
        uint256 got = dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);

        assertEq(got, minOut, "unwrapped out");
        assertEq(ownerAddr.balance, ownerEth0 + minOut, "owner received native ETH");
        assertEq(weth.balanceOf(ownerAddr), 0, "no WETH residue");
        assertEq(address(dex).balance, 0, "no ETH retained");
    }

    // ------------------------------------------------------------------
    // Permit2 witness signature tests
    // ------------------------------------------------------------------

    function test_Signature_ByNonOwner_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        a.signature = _sign(otherKey, permit2.witnessDigest(a.permit, address(dex), _witnessHash(a.witness), dex.WITNESS_TYPE_STRING()));
        vm.prank(broadcaster);
        vm.expectRevert(bytes("InvalidSigner"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_Signature_WrongSpenderDigest_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        // Signed for a DIFFERENT "executor" (spender) — cannot be redeemed here.
        a.signature = _sign(ownerKey, permit2.witnessDigest(a.permit, attacker, _witnessHash(a.witness), dex.WITNESS_TYPE_STRING()));
        vm.prank(broadcaster);
        vm.expectRevert(bytes("InvalidSigner"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_Signature_WrongChainDigest_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        // Domain with a different chainId (the permit cannot be replayed cross-chain).
        bytes32 wrongDomain = keccak256(
            abi.encode(
                permit2._DOMAIN_TYPEHASH(),
                permit2._NAME_HASH(),
                uint256(999999),
                address(permit2)
            )
        );
        bytes32 typeHash = keccak256(abi.encodePacked(permit2._PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB(), dex.WITNESS_TYPE_STRING()));
        bytes32 tpHash = keccak256(abi.encode(permit2._TOKEN_PERMISSIONS_TYPEHASH(), a.permit.permitted));
        bytes32 structHash =
            keccak256(abi.encode(typeHash, tpHash, address(dex), a.permit.nonce, a.permit.deadline, _witnessHash(a.witness)));
        a.signature = _sign(ownerKey, keccak256(abi.encodePacked("\x19\x01", wrongDomain, structHash)));
        vm.prank(broadcaster);
        vm.expectRevert(bytes("InvalidSigner"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    /// @notice STANDARD-WALLET COMPATIBILITY PROOF (witness repack regression
    ///         guard). Permit2 builds its typeHash as
    ///         keccak256(packed(_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB,
    ///         WITNESS_TYPE_STRING)). For ordinary wallets (eth_signTypedData_v4)
    ///         to sign the SAME commitment, that packed string must equal the
    ///         full canonical EIP-712 encodeType: primary struct with the
    ///         witness field NAME, referenced structs in alphabetical order,
    ///         and the TokenPermissions appendix (UniswapX convention).
    function test_WitnessTypeString_IsStandardEIP712EncodeType() public view {
        string memory expected =
            "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,ActionWitness witness)"
            "ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)"
            "TokenPermissions(address token,uint256 amount)";
        bytes32 fromContract = keccak256(
            abi.encodePacked(permit2Stub(), dex.WITNESS_TYPE_STRING())
        );
        assertEq(fromContract, keccak256(bytes(expected)));
        // The witness struct hash is seeded by the struct's OWN type string
        // (unchanged bindings), which must be a strict substring of the
        // handoff string.
        assertEq(
            dex.ACTION_WITNESS_TYPEHASH(),
            keccak256(bytes(dex.ACTION_WITNESS_STRUCT_TYPE_STRING()))
        );
    }

    /// @dev The stub constant mirrored from the deployed PermitHash library
    ///      (Permit2WitnessMock exposes the same value).
    function permit2Stub() internal view returns (string memory) {
        return permit2._PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB();
    }

    function test_Signature_TamperedTypeString_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        // Signed over a DIFFERENT witness type string.
        a.signature =
            _sign(ownerKey, permit2.witnessDigest(a.permit, address(dex), _witnessHash(a.witness), "ActionWitness(address owner)"));
        vm.prank(broadcaster);
        vm.expectRevert(bytes("InvalidSigner"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    // ------------------------------------------------------------------
    // Replay / nonce protection
    // ------------------------------------------------------------------

    function test_Replay_SamePermit_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        _runAsBroadcaster(p, a);
        vm.prank(broadcaster);
        vm.expectRevert(bytes("InvalidNonce"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_Nonce_BurnedOnlyOnSuccess() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        uniDex.setMode(MockRouterBase.Mode.REVERT);
        vm.prank(broadcaster);
        vm.expectRevert(bytes("router failure"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
        assertEq(permit2.nonceBitmap(ownerAddr, 5), 0, "failed trade must NOT burn the nonce");

        uniDex.setMode(MockRouterBase.Mode.NORMAL);
        uint256 out = _expectedOut(G, RATE_NUM, RATE_DEN);
        assertEq(_runAsBroadcaster(p, a), out, "same permit retries after a reverted trade");
    }

    function test_Nonce_DifferentBitsIndependent() public {
        (MPGRExecutorDelegated.SwapParams memory p1, MPGRExecutorDelegated.Permit2Authorization memory a1) = _happyUni();
        _runAsBroadcaster(p1, a1);
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p2 =
            _uniParams(address(uniDex), address(usdc), address(stock), G, minOut, DL, keccak256("action-slot-2"), false);
        MPGRExecutorDelegated.Permit2Authorization memory a2 =
            _authUniswap(ownerKey, address(usdc), G, address(stock), minOut, DL, keccak256("action-slot-2"), POLICY_HASH);
        uint256 out2 = _runAsBroadcaster(p2, a2);
        assertEq(out2, minOut, "second slot on the same bitmap word works");
    }

    function test_Revoke_InvalidateUnorderedNonces() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        // User revokes every nonce at bit position 1 in word 5 (the permit's bit).
        vm.prank(ownerAddr);
        permit2.invalidateUnorderedNonces(5, uint256(1) << 1);
        vm.prank(broadcaster);
        vm.expectRevert(bytes("InvalidNonce"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);

        // A different bit in the same word remains usable.
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p2 =
            _uniParams(address(uniDex), address(usdc), address(stock), G, minOut, DL, keccak256("action-slot-2"), false);
        MPGRExecutorDelegated.Permit2Authorization memory a2 =
            _authUniswap(ownerKey, address(usdc), G, address(stock), minOut, DL, keccak256("action-slot-2"), POLICY_HASH);
        assertTrue(_runAsBroadcaster(p2, a2) == minOut, "other nonce bits unaffected by revocation");
    }

    // ------------------------------------------------------------------
    // Wrong-token / wrong-amount / wrong-owner / wrong-policy bindings
    // ------------------------------------------------------------------

    function test_WrongToken_InPermit_Reverts() public {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(usdc), address(stock), G, minOut, DL, ACTION_ID, false);
        // Permit signed for STOCK but swap params say USDC.
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(stock), G, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidWitness.selector));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_WrongAmount_InPermit_Reverts() public {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(usdc), address(stock), G, minOut, DL, ACTION_ID, false);
        // Permit signed for G + 1 but swap params say G.
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(usdc), G + 1, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidWitness.selector));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_WrongPolicyHash_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        // Signed over POLICY_HASH, presented with a different policy hash.
        a.witness.policyHash = keccak256("rogue-policy");
        vm.prank(broadcaster);
        vm.expectRevert(bytes("InvalidSigner"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_WrongOwner_ZeroAddress_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        a.witness.owner = address(0);
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidWitness.selector));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_Recipient_MustBeOwner_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        p.recipient = attacker; // broadcaster tries to redirect the output
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidRecipient.selector, attacker, ownerAddr));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_ActionId_MustMatch_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        p.intentId = keccak256("another-slot");
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidWitness.selector));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_TokenNotAllowlisted_Reverts() public {
        MockPermitToken rogue = new MockPermitToken("Rogue", "ROGUE", 18);
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(rogue), address(stock), G, minOut, DL, ACTION_ID, false);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(rogue), G, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.TokenNotAllowed.selector, address(rogue)));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_RouterNotAllowlisted_Reverts() public {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(slipV1), address(usdc), address(stock), G, minOut, DL, ACTION_ID, false); // v1's router on dex
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(usdc), G, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
        vm.prank(broadcaster);
        vm.expectRevert(
            abi.encodeWithSelector(MPGRExecutorDelegated.RouterNotAllowed.selector, address(slipV1), MPGRExecutorDelegated.RouterKind.UNISWAP_V3_ROUTER02)
        );
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    // ------------------------------------------------------------------
    // Expiry / deadline
    // ------------------------------------------------------------------

    function test_PermitExpired_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        vm.warp(DL + 1);
        vm.prank(broadcaster);
        // The executor's own deadline gate fires BEFORE the permit is redeemed.
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.DeadlineExpired.selector, DL, DL + 1));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_Deadline_TripleMismatch_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        p.deadline = DL + 1; // permit and witness still say DL
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidWitness.selector));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_Deadline_AtBoundary_Succeeds() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        vm.warp(DL); // timestamp == deadline is still valid
        assertTrue(_runAsBroadcaster(p, a) == _expectedOut(G, RATE_NUM, RATE_DEN), "deadline boundary");
    }

    // ------------------------------------------------------------------
    // minOut / slippage
    // ------------------------------------------------------------------

    function test_MinAmountOut_WitnessMismatch_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        p.amountOutMinimum = p.amountOutMinimum + 1;
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.InvalidWitness.selector));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_Slippage_RateDrop_RevertsAtomically() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        _setRates(RATE_NUM / 2, RATE_DEN); // price crashes before broadcast
        uint256 ownerUsdc0 = usdc.balanceOf(ownerAddr);
        uint256 ownerStock0 = stock.balanceOf(ownerAddr);
        vm.prank(broadcaster);
        // A real router enforces amountOutMinimum itself (executor's own
        // InsufficientOutput catches only dishonest deliveries).
        vm.expectRevert(bytes("Too little received"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
        assertEq(usdc.balanceOf(ownerAddr), ownerUsdc0, "atomic: owner's sell token untouched");
        assertEq(stock.balanceOf(ownerAddr), ownerStock0, "atomic: owner's buy token untouched");
        assertEq(permit2.nonceBitmap(ownerAddr, 5), 0, "atomic: nonce not burned");
    }

    function test_MinOut_Zero_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        p.amountOutMinimum = 0;
        a.witness.minAmountOut = 0;
        a.signature = _sign(ownerKey, permit2.witnessDigest(a.permit, address(dex), _witnessHash(a.witness), dex.WITNESS_TYPE_STRING()));
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.ZeroMinimumOutput.selector));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_RouterLiesAboutOutput_BalanceDeltaRules() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        uniDex.setMode(MockRouterBase.Mode.LIE_ABOUT_OUTPUT); // returns full out, transfers half
        vm.prank(broadcaster);
        vm.expectRevert(
            abi.encodeWithSelector(
                MPGRExecutorDelegated.InsufficientOutput.selector,
                _expectedOut(G, RATE_NUM, RATE_DEN) / 2,
                p.amountOutMinimum
            )
        );
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    // ------------------------------------------------------------------
    // Fee semantics (25 bps preserved; commitment; change-after-sign)
    // ------------------------------------------------------------------

    function test_FeeSplit_Exact() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        _runAsBroadcaster(p, a);
        uint256 fee = (G * BPS) / 10_000;
        assertEq(p.expectedFeeAmount, fee, "committed fee = 25 bps of gross");
        assertEq(uniDex.lastAmountIn(), G - fee, "router received exactly (G - fee)");
        assertEq(usdc.balanceOf(feeWallet), fee, "fee wallet received exactly the fee");
    }

    function test_FeeMismatch_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        p.expectedFeeAmount = p.expectedFeeAmount + 1;
        vm.prank(broadcaster);
        vm.expectRevert(
            abi.encodeWithSelector(MPGRExecutorDelegated.FeeMismatch.selector, p.expectedFeeAmount, (G * BPS) / 10_000)
        );
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_FeeChangeAfterSigning_Reverts_NeverOvercharges() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        vm.prank(admin);
        dex.setFeeBps(50); // owner raised the fee AFTER the user signed
        vm.prank(broadcaster);
        vm.expectRevert(
            abi.encodeWithSelector(MPGRExecutorDelegated.FeeMismatch.selector, p.expectedFeeAmount, (G * 50) / 10_000)
        );
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
        vm.prank(admin);
        dex.setFeeBps(BPS);
    }

    function test_FeeRoundsToZero_Reverts() public {
        uint256 tiny = 100; // 25 bps of 100 = 0
        uint256 minOut = _expectedOut(tiny, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(usdc), address(stock), tiny, minOut, DL, ACTION_ID, false);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(usdc), tiny, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.FeeRoundsToZero.selector, tiny));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_QuoteFee_Parity_WithV1() public view {
        (uint256 feeDex, uint256 netDex) = dex.quoteFee(G);
        (uint256 feeV1, uint256 netV1) = v1.quoteFee(G);
        assertEq(feeDex, feeV1, "quoteFee fee parity");
        assertEq(netDex, netV1, "quoteFee net parity");
        assertEq(feeDex, (G * BPS) / 10_000, "quoteFee = floor(G*25/10000)");
    }

    // ------------------------------------------------------------------
    // Event parity + equivalence fuzz (v1 vs delegated)
    // ------------------------------------------------------------------

    function test_EventParity_V1_vs_Delegated() public {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);

        // v1: classic PERMIT2 pull by the taker in the taker's own tx.
        vm.recordLogs(); // capture the v1 flow's events
        vm.startPrank(ownerAddr);
        usdc.approve(address(v1), type(uint256).max);
        MPGRExecutor.SwapParams memory pv1 = _toV1(
            _uniParams(address(uniV1), address(usdc), address(stock), G, minOut, DL, ACTION_ID, false)
        );
        IPermit2SignatureTransfer.PermitTransferFrom memory perm =
            _permit(address(usdc), G, _nextNonce(), DL);
        bytes32 d = permit2.transferFromDigest(perm, address(v1));
        MPGRExecutor.Authorization memory av1 = MPGRExecutor.Authorization({
            kind: MPGRExecutor.AuthKind.PERMIT2,
            deadline: perm.deadline,
            nonce: perm.nonce,
            v: 0,
            r: bytes32(0),
            s: bytes32(0),
            signature: _sign(ownerKey, d)
        });
        v1.swapUniswapV3ExactInputSingle(pv1, POOL_FEE, av1);
        vm.stopPrank();
        Vm.Log[] memory logs1 = vm.getRecordedLogs();

        // Delegated: broadcaster submits the witness permit.
        vm.recordLogs();
        (MPGRExecutorDelegated.SwapParams memory pd, MPGRExecutorDelegated.Permit2Authorization memory ad) = _happyUni();
        _runAsBroadcaster(pd, ad);
        Vm.Log[] memory logs2 = vm.getRecordedLogs();

        Vm.Log memory e1 = _findSwapExecuted(logs1, address(v1));
        Vm.Log memory e2 = _findSwapExecuted(logs2, address(dex));

        // topics[0] identical; intentId identical; taker = respective trader.
        assertEq(e1.topics[0], SWAP_EXECUTED_TOPIC, "v1 event topic");
        assertEq(e2.topics[0], e1.topics[0], "event topic parity");
        assertEq(e1.topics[3], e2.topics[3], "intentId parity");
        assertEq(e1.topics[1], bytes32(uint256(uint160(ownerAddr))), "v1 taker is the taker");
        assertEq(e2.topics[1], bytes32(uint256(uint160(ownerAddr))), "delegated taker is the signing OWNER");
        // Full data parity (tokenIn,tokenOut,gross,fee,swapIn,out,feeRecipient,bps,kind,flags).
        assertEq(e1.data, e2.data, "data parity");
    }

    function _findSwapExecuted(Vm.Log[] memory logs, address emitter) internal pure returns (Vm.Log memory) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics.length == 4 && logs[i].topics[0] == SWAP_EXECUTED_TOPIC) {
                return logs[i];
            }
        }
        revert("SwapExecuted not found");
    }

    function testFuzz_Equivalence_V1Permit2_vs_Delegated(uint128 rawGross, uint64 num, uint64 den) public {
        uint256 gross = bound(uint256(rawGross), 400, 2_000_000e6); // fee >= 1 at 25 bps
        _setRates(bound(uint256(num), 1, 1e6), bound(uint256(den), 1, 1e6));
        uint256 expectedOut =
            _expectedOut(gross, bound(uint256(num), 1, 1e6), bound(uint256(den), 1, 1e6));
        if (expectedOut == 0) return; // skip degenerate draws (out rounds to zero)
        usdc.mint(ownerAddr, gross);
        _equivalenceCheck(gross, expectedOut);
    }

    /// @dev The two flows + equivalence assertions (own frame to stay shallow).
    function _equivalenceCheck(uint256 gross, uint256 expectedOut) internal {
        uint256 fee0 = usdc.balanceOf(feeWallet);
        // v1 flow: taker broadcasts its own PERMIT2-authorized swap (isolated locals).
        _runV1Permit2Swap(gross, expectedOut);
        uint256 feeMid = usdc.balanceOf(feeWallet);
        uint256 stockMid = stock.balanceOf(ownerAddr);
        uint256 usdcMid = usdc.balanceOf(ownerAddr);
        // Delegated flow: broadcaster submits the witness permit for the SAME trade.
        uint256 outDex = _runDelegatedUniSwap(gross, expectedOut);

        // Equivalence: fee, swap amount, and output are IDENTICAL.
        assertEq(feeMid - fee0, (gross * BPS) / 10_000, "v1 fee");
        assertEq(usdc.balanceOf(feeWallet) - feeMid, (gross * BPS) / 10_000, "delegated fee parity");
        assertEq(uniV1.lastAmountIn(), gross - (gross * BPS) / 10_000, "v1 router input");
        assertEq(uniDex.lastAmountIn(), uniV1.lastAmountIn(), "swap amount parity");
        assertEq(outDex, expectedOut, "delegated out");
        assertEq(stock.balanceOf(ownerAddr) - stockMid, expectedOut, "v1 out vs delegated out");
        assertEq(usdcMid - usdc.balanceOf(ownerAddr), gross, "gross spent parity");
        assertTrue(stock.balanceOf(ownerAddr) > stockMid, "owner stock grew in both flows");
    }


    /// @dev One v1 PERMIT2-authorized swap as the owner/taker (isolated locals).
    function _runV1Permit2Swap(uint256 gross, uint256 minOut) internal {
        MPGRExecutor.SwapParams memory pv1 = _toV1(
            _uniParams(address(uniV1), address(usdc), address(stock), gross, minOut, DL, ACTION_ID, false)
        );
        IPermit2SignatureTransfer.PermitTransferFrom memory perm = _permit(address(usdc), gross, _nextNonce(), DL);
        MPGRExecutor.Authorization memory av1 = MPGRExecutor.Authorization({
            kind: MPGRExecutor.AuthKind.PERMIT2,
            deadline: perm.deadline,
            nonce: perm.nonce,
            v: 0,
            r: bytes32(0),
            s: bytes32(0),
            signature: _sign(ownerKey, permit2.transferFromDigest(perm, address(v1)))
        });
        vm.startPrank(ownerAddr);
        v1.swapUniswapV3ExactInputSingle(pv1, POOL_FEE, av1);
        vm.stopPrank();
    }

    /// @dev One delegated swap (isolated locals) — broadcaster submits.
    function _runDelegatedUniSwap(uint256 gross, uint256 minOut) internal returns (uint256) {
        MPGRExecutorDelegated.SwapParams memory pd =
            _uniParams(address(uniDex), address(usdc), address(stock), gross, minOut, DL, ACTION_ID, false);
        MPGRExecutorDelegated.Permit2Authorization memory ad =
            _authUniswap(ownerKey, address(usdc), gross, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
        return _runAsBroadcaster(pd, ad);
    }

    function testFuzz_Equivalence_FeeMath(uint128 rawGross) public view {
        uint256 gross = bound(uint256(rawGross), 0, type(uint128).max);
        (uint256 feeDex, uint256 netDex) = dex.quoteFee(gross);
        (uint256 feeV1, uint256 netV1) = v1.quoteFee(gross);
        assertEq(feeDex, feeV1, "fuzz fee parity");
        assertEq(netDex, netV1, "fuzz net parity");
        assertEq(feeDex, (gross * BPS) / 10_000, "fuzz floor semantics");
        assertEq(feeDex + netDex, gross, "conservation");
    }

    // ------------------------------------------------------------------
    // Failure / revert mechanics (atomicity)
    // ------------------------------------------------------------------

    function test_RouterRevert_NothingMoves() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        uniDex.setMode(MockRouterBase.Mode.REVERT);
        uint256 ownerUsdc0 = usdc.balanceOf(ownerAddr);
        uint256 fee0 = usdc.balanceOf(feeWallet);
        vm.prank(broadcaster);
        vm.expectRevert(bytes("router failure"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
        assertEq(usdc.balanceOf(ownerAddr), ownerUsdc0, "owner untouched");
        assertEq(usdc.balanceOf(feeWallet), fee0, "fee wallet untouched");
        assertEq(usdc.balanceOf(address(dex)), 0, "executor holds nothing");
    }

    function test_RouterPullLess_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        uniDex.setMode(MockRouterBase.Mode.PULL_LESS);
        vm.prank(broadcaster);
        // The router pulls one wei less, so its own delivered amount fails its
        // amountOutMinimum check before the executor's full-consumption check.
        vm.expectRevert(bytes("Too little received"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_RouterReturnsInput_Reverts() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        uniDex.setMode(MockRouterBase.Mode.RETURN_INPUT);
        vm.prank(broadcaster);
        vm.expectRevert(
            abi.encodeWithSelector(
                MPGRExecutorDelegated.InputNotFullyConsumed.selector,
                uint256(0),
                uint256(1)
            )
        );
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_FeeOnTransferToken_Rejected() public {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(fot), address(stock), G, minOut, DL, ACTION_ID, false);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(fot), G, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
        vm.startPrank(ownerAddr);
        fot.approve(address(permit2), type(uint256).max);
        fot.mint(ownerAddr, G * 2);
        vm.stopPrank();
        vm.prank(broadcaster);
        vm.expectRevert(
            abi.encodeWithSelector(MPGRExecutorDelegated.UnsupportedTransferAmount.selector, G, G - (G / 100))
        );
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_UnwrapRequiresWethOut_Reverts() public {
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p =
            _uniParams(address(uniDex), address(usdc), address(stock), G, minOut, DL, ACTION_ID, true);
        MPGRExecutorDelegated.Permit2Authorization memory a =
            _authUniswap(ownerKey, address(usdc), G, address(stock), minOut, DL, ACTION_ID, POLICY_HASH);
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.UnwrapRequiresWethOut.selector));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
    }

    function test_Pause_BlocksNewSwaps_ThenUnpauses() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        vm.prank(admin);
        dex.pause();
        vm.prank(broadcaster);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
        vm.prank(admin);
        dex.unpause();
        assertTrue(_runAsBroadcaster(p, a) == _expectedOut(G, RATE_NUM, RATE_DEN), "works after unpause");
    }

    function test_Admin_Guards() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.FeeBpsAboveCap.selector, 101, 100));
        dex.setFeeBps(101);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, broadcaster));
        vm.prank(broadcaster);
        dex.setFeeBps(26);
    }

    // ------------------------------------------------------------------
    // Compromised broadcaster simulation
    // ------------------------------------------------------------------

    function test_CompromisedBroadcaster_CannotSteal_CanOnlyRedeem() public {
        // Attacker steals the broadcaster key. It can execute a live permit
        // EARLY — but output still lands on the owner, fee is exact.
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        vm.prank(attacker); // the "compromised" key holder
        uint256 got = dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
        assertEq(got, _expectedOut(G, RATE_NUM, RATE_DEN), "executes within signed bounds");
        assertEq(stock.balanceOf(attacker), 0, "no output to the key holder");
        assertEq(usdc.balanceOf(attacker), 0, "no sell token to the key holder");
        assertEq(stock.balanceOf(ownerAddr), _expectedOut(G, RATE_NUM, RATE_DEN), "owner still paid");

        // It cannot replay the permit for a second trade.
        vm.prank(attacker);
        vm.expectRevert(bytes("InvalidNonce"));
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);

        // And it cannot execute anything without a user-signed permit.
        uint256 minOut = _expectedOut(G, RATE_NUM, RATE_DEN);
        MPGRExecutorDelegated.SwapParams memory p2 =
            _uniParams(address(uniDex), address(usdc), address(stock), G, minOut, DL, keccak256("slot-x"), false);
        MPGRExecutorDelegated.Permit2Authorization memory a2 =
            _authUniswap(ownerKey, address(usdc), G, address(stock), minOut, DL, keccak256("slot-x"), POLICY_HASH);
        a2.signature = _sign(otherKey, permit2.witnessDigest(a2.permit, address(dex), _witnessHash(a2.witness), dex.WITNESS_TYPE_STRING()));
        vm.prank(attacker);
        vm.expectRevert(bytes("InvalidSigner"));
        dex.swapOnBehalfOfUniswapV3(p2, POOL_FEE, a2);
    }

    function test_CompromisedBroadcaster_BoundedBySignedMinOut() public {
        // Price crashes; the compromised key tries to dump the trade on the
        // owner anyway — the signed minimum output still reverts it.
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        _setRates(1, RATE_NUM); // collapse the price
        vm.prank(attacker);
        vm.expectRevert(bytes("Too little received")); // router enforces the signed min
        dex.swapOnBehalfOfUniswapV3(p, POOL_FEE, a);
        assertEq(usdc.balanceOf(attacker), 0, "attacker got nothing");
    }

    // ------------------------------------------------------------------
    // Native-ETH sell rejection (structural, explicit)
    // ------------------------------------------------------------------

    function test_NativeInput_Rejected() public {
        (MPGRExecutorDelegated.SwapParams memory p, MPGRExecutorDelegated.Permit2Authorization memory a) = _happyUni();
        vm.deal(broadcaster, 1 ether);
        vm.prank(broadcaster);
        vm.expectRevert(abi.encodeWithSelector(MPGRExecutorDelegated.NativeInputUnsupported.selector));
        dex.swapOnBehalfOfUniswapV3{value: 1}(p, POOL_FEE, a);
    }

    function test_Receive_OnlyWethMaySendEth() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(dex).call{value: 1}("");
        assertFalse(ok, "non-WETH ETH must be rejected");

        vm.deal(address(weth), 1 ether);
        vm.prank(address(weth));
        (ok,) = address(dex).call{value: 1}("");
        assertTrue(ok, "WETH unwrap top-ups are accepted");
    }
}

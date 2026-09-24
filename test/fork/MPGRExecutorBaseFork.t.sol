// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MPGRExecutor} from "../../contracts/executor/MPGRExecutor.sol";

interface ISlipstreamFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

interface ISlipstreamQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        int24 tickSpacing;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

interface IUniQuoterV2 {
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

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IERC20PermitLike {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
}

/// @notice Base MAINNET FORK tests — local EVM fork only, NOTHING is deployed or
///         broadcast to Base mainnet. Exercises the executor against the REAL
///         Aerodrome Slipstream router/pools, Uniswap V3 SwapRouter02, native
///         USDC (EIP-2612) and canonical Permit2.
///
///         Skipped unless BASE_MAINNET_RPC_URL is set (CI job `contracts-fork`).
///         Optional BASE_FORK_BLOCK pins the fork block for reproducibility.
contract MPGRExecutorBaseForkTest is Test {
    // Addresses copied from lib/trade/trade-config.ts (single source of truth in the app).
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant SLIP_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant SLIP_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant SLIP_QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;
    int24 internal constant B20_TICK = 10;
    // Uniswap V3 on Base (official deployments page).
    address internal constant UNI_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant UNI_QUOTER = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    // Coinbase B20 tokenized stocks (lib/trade/tokenized-stocks.ts) — Slipstream tickSpacing 10 vs USDC.
    address[15] internal B20 = [
        0xb200000000000000000000C2e324d24d7eEcd1fb, // AAPLc
        0xb200000000000000000000d9192b6B456483C2E8, // AMZNc
        0xb200000000000000000000c85a31389D71F3ecfb, // COINc
        0xB20000000000000000000019f6E7C675b73C2e4D, // CRCLc
        0xb2000000000000000000002D0BA3164cc74f58B7, // GOOGLc
        0xB2000000000000000000004AFF16039bA04bdFBc, // INTCc
        0xb2000000000000000000008bC8786B856E61707C, // METAc
        0xB200000000000000000000Ab99cFa739E253872B, // MSFTc
        0xb2000000000000000000004884b426556b92883d, // MSTRc
        0xb20000000000000000000078ee7ce2fE4908108C, // NVDAc
        0xb200000000000000000000397293Cb8cda9a10c5, // SNDKc
        0xb2000000000000000000007b9fcbd005511aCBd5, // SPCXc
        0xb2000000000000000000001e800a7f5189430cD0, // TSLAc
        address(0),
        address(0)
    ];
    // Fallback proof of the Slipstream adapter on this router/factory: WETH/USDC.
    int24[5] internal WETH_TICKS = [int24(100), 50, 10, 200, 1];

    MPGRExecutor internal ex;
    address internal owner = makeAddr("fork-owner");
    address internal feeWallet = makeAddr("fork-fee-wallet");
    uint256 internal takerKey = uint256(keccak256("mpgr-executor-fork-taker-v1"));
    address internal taker;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 pin = vm.envOr("BASE_FORK_BLOCK", uint256(0));
        if (pin == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pin);
        require(block.chainid == 8453, "fork must be Base mainnet");
        forked = true;
        taker = vm.addr(takerKey);

        MPGRExecutor.RouterConfig[] memory routers = new MPGRExecutor.RouterConfig[](2);
        routers[0] = MPGRExecutor.RouterConfig(SLIP_ROUTER, MPGRExecutor.RouterKind.AERODROME_SLIPSTREAM);
        routers[1] = MPGRExecutor.RouterConfig(UNI_ROUTER02, MPGRExecutor.RouterKind.UNISWAP_V3_ROUTER02);
        address[] memory tokens = new address[](2 + B20.length);
        tokens[0] = USDC;
        tokens[1] = WETH;
        uint256 n = 2;
        for (uint256 i = 0; i < B20.length; ++i) {
            if (B20[i] != address(0)) tokens[n++] = B20[i];
        }
        assembly {
            mstore(tokens, n)
        }
        // A fork inherits live account state: make sure the taker is a plain EOA
        // (public test keys are often EIP-7702-delegated to ETH sweepers on mainnets).
        vm.etch(taker, "");
        ex = new MPGRExecutor(owner, feeWallet, 25, WETH, PERMIT2, routers, tokens);
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    struct Pick {
        address token;
        int24 tick;
        uint256 quoteOut;
    }

    function _tryPool(address token, int24 tick, uint256 netIn) internal returns (uint256) {
        if (token == address(0)) return 0;
        if (ISlipstreamFactory(SLIP_FACTORY).getPool(USDC, token, tick) == address(0)) return 0;
        try ISlipstreamQuoterV2(SLIP_QUOTER).quoteExactInputSingle(
            ISlipstreamQuoterV2.QuoteExactInputSingleParams(USDC, token, netIn, tick, 0)
        ) returns (uint256 out, uint160, uint32, uint256) {
            return out;
        } catch {
            return 0;
        }
    }

    /// First live USDC/<token> Slipstream pool on the app's router/factory.
    function _findSlipstream(uint256 netIn, bool b20Only) internal returns (Pick memory p) {
        for (uint256 i = 0; i < B20.length; ++i) {
            uint256 out = _tryPool(B20[i], B20_TICK, netIn);
            if (out > 0) {
                console2.log("slipstream pool: B20", B20[i], "tickSpacing 10");
                return Pick(B20[i], B20_TICK, out);
            }
        }
        if (b20Only) return p;
        for (uint256 i = 0; i < WETH_TICKS.length; ++i) {
            uint256 out = _tryPool(WETH, WETH_TICKS[i], netIn);
            if (out > 0) {
                console2.log("slipstream pool: WETH tickSpacing", uint256(uint24(WETH_TICKS[i])));
                return Pick(WETH, WETH_TICKS[i], out);
            }
        }
    }

    function _requirePick(uint256 netIn) internal returns (Pick memory p) {
        p = _findSlipstream(netIn, false);
        require(p.token != address(0), "no live USDC pool on the app's Slipstream router/factory");
    }

    function _params(address router, address tokenIn, address tokenOut, uint256 gross, uint256 minOut)
        internal
        view
        returns (MPGRExecutor.SwapParams memory)
    {
        return MPGRExecutor.SwapParams({
            router: router,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            grossAmountIn: gross,
            expectedFeeAmount: (gross * 25) / 10_000,
            amountOutMinimum: minOut,
            recipient: taker,
            deadline: block.timestamp + 180,
            intentId: keccak256(abi.encode("fork", tokenIn, tokenOut, gross)),
            unwrapNativeOut: false
        });
    }

    function _approval() internal pure returns (MPGRExecutor.Authorization memory a) {
        a.kind = MPGRExecutor.AuthKind.APPROVAL;
    }

    function _assertNoCustody(address tokenIn, address tokenOut, address router) internal view {
        assertEq(IERC20(tokenIn).balanceOf(address(ex)), 0, "executor kept sell token");
        assertEq(IERC20(tokenOut).balanceOf(address(ex)), 0, "executor kept buy token");
        assertEq(IERC20(tokenIn).allowance(address(ex), router), 0, "dangling router allowance");
        assertEq(address(ex).balance, 0, "executor kept ETH");
    }

    // ------------------------------------------------------------------
    // Aerodrome Slipstream — the key requirement
    // ------------------------------------------------------------------

    function _buyViaSlipstream(Pick memory k, uint256 gross) internal returns (uint256 out) {
        uint256 fee = (gross * 25) / 10_000;
        deal(USDC, taker, gross);
        vm.prank(taker);
        IERC20(USDC).approve(address(ex), gross);
        MPGRExecutor.SwapParams memory p = _params(SLIP_ROUTER, USDC, k.token, gross, (k.quoteOut * 99) / 100);
        uint256 outBefore = IERC20(k.token).balanceOf(taker);
        uint256 feeBefore = IERC20(USDC).balanceOf(feeWallet);
        vm.prank(taker);
        out = ex.swapSlipstreamExactInputSingle(p, k.tick, _approval());
        assertEq(IERC20(USDC).balanceOf(feeWallet) - feeBefore, fee, "fee wallet received exactly floor(G*25/10000) USDC");
        assertEq(IERC20(USDC).balanceOf(taker), 0, "taker paid exactly G");
        assertEq(IERC20(k.token).balanceOf(taker) - outBefore, out, "output delivered to taker");
        assertGe(out, p.amountOutMinimum, "minOut honored");
        _assertNoCustody(USDC, k.token, SLIP_ROUTER);
        console2.log("slipstream out (atomic fee+swap):", out);
    }

    /// Key requirement: tokenized stock (B20) via Aerodrome Slipstream with an exact USDC fee.
    function test_Fork_Slipstream_USDC_to_B20_ExactSellTokenFee() public onlyFork {
        uint256 gross = 10e6;
        Pick memory k = _findSlipstream(gross - (gross * 25) / 10_000, true);
        if (k.token == address(0)) {
            console2.log("no live USDC/B20 tickSpacing-10 pool at this block - skipping (covered by the generic test)");
            vm.skip(true);
            return;
        }
        _buyViaSlipstream(k, gross);
    }

    /// The Slipstream adapter against the app's real router/factory (B20 or WETH/USDC pool).
    function test_Fork_Slipstream_USDC_ExactSellTokenFee() public onlyFork {
        uint256 gross = 10e6;
        Pick memory k = _requirePick(gross - (gross * 25) / 10_000);
        uint256 out = _buyViaSlipstream(k, gross);
        assertGt(out, 0);
        assertEq((gross * 25) / 10_000, 25_000, "exact 25 bps of 10 USDC");
    }

    function test_Fork_Slipstream_SellBack_FeeInSellToken() public onlyFork {
        Pick memory k = _requirePick(9_975_000);
        _buyViaSlipstream(k, 10e6);
        uint256 gross = IERC20(k.token).balanceOf(taker);
        vm.prank(taker);
        IERC20(k.token).approve(address(ex), gross);
        uint256 fee = (gross * 25) / 10_000;
        (uint256 quoteOut,,,) = ISlipstreamQuoterV2(SLIP_QUOTER).quoteExactInputSingle(
            ISlipstreamQuoterV2.QuoteExactInputSingleParams(k.token, USDC, gross - fee, k.tick, 0)
        );
        MPGRExecutor.SwapParams memory p = _params(SLIP_ROUTER, k.token, USDC, gross, (quoteOut * 99) / 100);
        uint256 feeWalletUsdc = IERC20(USDC).balanceOf(feeWallet);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(p, k.tick, _approval());
        assertEq(IERC20(k.token).balanceOf(feeWallet), fee, "fee in the SELL token");
        assertEq(IERC20(USDC).balanceOf(feeWallet), feeWalletUsdc, "no fee in the buy token");
        _assertNoCustody(k.token, USDC, SLIP_ROUTER);
    }

    function test_Fork_Slipstream_Permit2_OneTransaction() public onlyFork {
        uint256 gross = 5e6;
        Pick memory k = _requirePick(gross - (gross * 25) / 10_000);
        deal(USDC, taker, gross);
        vm.prank(taker);
        IERC20(USDC).approve(PERMIT2, type(uint256).max); // pre-existing Permit2 approval (CDP users have this)

        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.PERMIT2;
        a.nonce = uint256(keccak256("mpgr-fork-nonce"));
        a.deadline = block.timestamp + 600;
        bytes32 tokenPermissions = keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), USDC, gross));
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                ),
                tokenPermissions,
                address(ex),
                a.nonce,
                a.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(takerKey, digest);
        a.signature = abi.encodePacked(r, s, v);

        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_params(SLIP_ROUTER, USDC, k.token, gross, (k.quoteOut * 99) / 100), k.tick, a);
        assertEq(IERC20(USDC).balanceOf(feeWallet), (gross * 25) / 10_000);
        assertEq(IERC20(USDC).allowance(taker, address(ex)), 0, "no approval to the executor was needed");
        _assertNoCustody(USDC, k.token, SLIP_ROUTER);
    }

    function test_Fork_Slipstream_USDC_EIP2612_OneTransaction() public onlyFork {
        uint256 gross = 5e6;
        Pick memory k = _requirePick(gross - (gross * 25) / 10_000);
        deal(USDC, taker, gross);
        MPGRExecutor.Authorization memory a;
        a.kind = MPGRExecutor.AuthKind.EIP2612;
        a.deadline = block.timestamp + 600;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                taker,
                address(ex),
                gross,
                IERC20PermitLike(USDC).nonces(taker),
                a.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20PermitLike(USDC).DOMAIN_SEPARATOR(), structHash));
        (a.v, a.r, a.s) = vm.sign(takerKey, digest);
        vm.prank(taker);
        ex.swapSlipstreamExactInputSingle(_params(SLIP_ROUTER, USDC, k.token, gross, (k.quoteOut * 99) / 100), k.tick, a);
        assertEq(IERC20(USDC).balanceOf(feeWallet), (gross * 25) / 10_000);
        _assertNoCustody(USDC, k.token, SLIP_ROUTER);
    }

    function test_Fork_Slipstream_SlippageFailure_AtomicRevert() public onlyFork {
        uint256 gross = 10e6;
        Pick memory k = _requirePick(gross - (gross * 25) / 10_000);
        deal(USDC, taker, gross);
        vm.prank(taker);
        IERC20(USDC).approve(address(ex), gross);
        MPGRExecutor.SwapParams memory p = _params(SLIP_ROUTER, USDC, k.token, gross, k.quoteOut * 2); // impossible minOut
        vm.prank(taker);
        vm.expectRevert();
        ex.swapSlipstreamExactInputSingle(p, k.tick, _approval());
        assertEq(IERC20(USDC).balanceOf(taker), gross, "taker fully refunded by revert");
        assertEq(IERC20(USDC).balanceOf(feeWallet), 0, "no fee without a swap");
    }

    // ------------------------------------------------------------------
    // Uniswap V3 SwapRouter02 — native ETH in/out
    // ------------------------------------------------------------------

    function test_Fork_UniswapV3_NativeETH_to_USDC() public onlyFork {
        uint256 gross = 0.01 ether;
        uint256 fee = (gross * 25) / 10_000;
        (uint256 quoteOut,,,) = IUniQuoterV2(UNI_QUOTER).quoteExactInputSingle(
            IUniQuoterV2.QuoteExactInputSingleParams(WETH, USDC, gross - fee, 500, 0)
        );
        vm.deal(taker, 1 ether);
        MPGRExecutor.SwapParams memory p = _params(UNI_ROUTER02, WETH, USDC, gross, (quoteOut * 99) / 100);
        vm.prank(taker);
        uint256 out = ex.swapUniswapV3ExactInputSingle{value: gross}(p, 500, _approval());
        assertEq(feeWallet.balance, fee, "fee paid in native ETH (the sell asset)");
        assertEq(IERC20(USDC).balanceOf(taker), out);
        assertGe(out, p.amountOutMinimum);
        _assertNoCustody(WETH, USDC, UNI_ROUTER02);
    }

    function test_Fork_UniswapV3_USDC_to_NativeETH_Unwrap() public onlyFork {
        uint256 gross = 20e6;
        uint256 fee = (gross * 25) / 10_000;
        (uint256 quoteOut,,,) = IUniQuoterV2(UNI_QUOTER).quoteExactInputSingle(
            IUniQuoterV2.QuoteExactInputSingleParams(USDC, WETH, gross - fee, 500, 0)
        );
        deal(USDC, taker, gross);
        vm.prank(taker);
        IERC20(USDC).approve(address(ex), gross);
        MPGRExecutor.SwapParams memory p = _params(UNI_ROUTER02, USDC, WETH, gross, (quoteOut * 99) / 100);
        p.unwrapNativeOut = true;
        assertEq(taker.code.length, 0, "taker is a plain EOA on the fork");
        uint256 ethBefore = taker.balance;
        vm.prank(taker);
        uint256 out = ex.swapUniswapV3ExactInputSingle(p, 500, _approval());
        assertEq(taker.balance - ethBefore, out, "native ETH delivered");
        assertEq(IERC20(USDC).balanceOf(feeWallet), fee);
        _assertNoCustody(USDC, WETH, UNI_ROUTER02);
    }
}

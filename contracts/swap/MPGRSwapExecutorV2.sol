// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMPGRV4PoolManager} from "./interfaces/IMPGRV4PoolManager.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    IWETH9,
    ISlipstreamSwapRouter,
    IUniswapV3SwapRouter02,
    IPermit2SignatureTransfer
} from "../executor/interfaces/IMPGRExecutorRouters.sol";

import {IMPGRSwapV2RouterDraft} from "../executor/drafts/IMPGRSwapV2RouterDraft.sol";

/// @title MPGRSwapExecutorV2 — permissionless-token, governance-bounded-fee typed Base Swap executor
/// @notice UNDEPLOYED candidate. Not approved for production; fork qualification is required.
/// @dev Design pillars:
///      - PERMISSIONLESS TOKENS: any Base contract that behaves like a standard
///        ERC-20 may be traded. Safety comes from typed adapters, canonical
///        factory-verified pools, measured balance deltas, exact-input
///        (fee-on-transfer/rebase rejection), min-out, deadline and atomic fee —
///        never from a token allowlist. Routers/factories stay allowlisted.
///      - BOUNDED FEE GOVERNANCE: recipient is pinned; nonzero fee changes
///        ONLY through propose -> 48h timelock -> apply, hard-capped at
///        MAX_FEE_BPS on-chain. No immediate setter, no fee-less entry point.
///      - No arbitrary calldata, no proxy, no Agent dependencies. One atomic path.
contract MPGRSwapExecutorV2 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant V4_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    bytes32 private activeUnlock;
    address private immutable deploymentOrigin;
    error InvalidUnlock();

    address public constant GOVERNANCE_SAFE = 0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B;
    address public constant PINNED_FEE_RECIPIENT = 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice On-chain hard cap for the protocol fee: 1.00%. Governance can
    ///         never propose or apply a fee above this, in one step or many.
    uint16 public constant MAX_FEE_BPS = 100;

    /// @notice Mandatory delay between proposing and applying a fee
    ///         change. The recipient is permanently pinned.
    uint48 public constant FEE_TIMELOCK_SECONDS = 48 hours;

    /// @notice SwapExecuted.flags bit: the taker sold native ETH (msg.value).
    uint8 public constant FLAG_NATIVE_IN = 1;
    /// @notice SwapExecuted.flags bit: the taker received native ETH (unwrapped WETH).
    uint8 public constant FLAG_NATIVE_OUT = 2;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Which typed adapter an allowlisted router may be used with.
    enum RouterKind {
        NONE,
        AERODROME_SLIPSTREAM,
        UNISWAP_V3_ROUTER02,
        // Draft-local value only; NOT shared/deployed Agent enum kind 3.
        UNISWAP_V2_ROUTER02,
        AERODROME_CLASSIC,
        // Reserved disabled kind pending deployed-ABI fork qualification.
        PANCAKE_V3,
        // Reserved disabled kind; no Settler entry point exists in V2.
        ZEROX_SETTLER,
        UNISWAP_V4
    }

    /// @notice How the executor obtains the taker's sell tokens.
    ///         APPROVAL: standing ERC-20 allowance to this executor.
    ///         EIP2612:  ERC-20 `permit` signature (value == grossAmountIn) + pull.
    ///         PERMIT2:  Uniswap Permit2 SignatureTransfer (amount == grossAmountIn).
    enum AuthKind {
        APPROVAL,
        EIP2612,
        PERMIT2
    }

    struct Hop {
        address router;
        address tokenOut;
        RouterKind kind;
        uint24 poolFee;
        int24 tickSpacing;
        bool stable;
        address pool;
        IMPGRV4PoolManager.PoolKey v4Key;
        bytes hookData;
    }
    event SwapPathExecuted(bytes32 indexed intentId, bytes32 indexed pathHash, uint8 hops);

    /// @notice Router configuration used at construction.
    struct RouterConfig {
        address router;
        RouterKind kind;
        address factory;
    }

    /// @notice Common trade parameters (all enforced on-chain).
    /// @param router            Allowlisted router of the adapter's kind.
    /// @param tokenIn           Permissionless sell token (WETH when selling native ETH).
    /// @param tokenOut          Permissionless buy token.
    /// @param grossAmountIn     G: total sell amount taken from the taker (fee included).
    /// @param expectedFeeAmount Must equal floor(G * feeBps / 10_000) at execution.
    /// @param amountOutMinimum  Minimum output the taker must receive (> 0).
    /// @param recipient         Must equal msg.sender (no output redirection).
    /// @param deadline          Unix timestamp; reverts after it.
    /// @param intentId          Opaque off-chain correlation id (MPGR quoteId). Not trusted.
    /// @param unwrapNativeOut   If true, tokenOut must be WETH and native ETH is delivered.
    struct SwapParams {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 grossAmountIn;
        uint256 expectedFeeAmount;
        uint256 amountOutMinimum;
        address recipient;
        uint256 deadline;
        bytes32 intentId;
        bool unwrapNativeOut;
    }

    /// @notice Optional signature-based authorization (ignored for APPROVAL).
    struct Authorization {
        AuthKind kind;
        uint256 deadline;
        uint256 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
        bytes signature;
    }

    /// @dev Per-trade scratch values (keeps the stack shallow).
    struct Trade {
        RouterKind kind;
        address spender;
        uint256 fee;
        uint256 swapAmount;
        uint256 inBalanceBefore;
        address outReceiver;
        uint256 outBalanceBefore;
        uint256 amountOut;
        bool nativeIn;
    }

    // ---------------------------------------------------------------------
    // Immutable / storage
    // ---------------------------------------------------------------------

    /// @notice Wrapped native token used for native ETH input/output.
    IWETH9 public immutable WETH;

    /// @notice Canonical Permit2 (SignatureTransfer) used by AuthKind.PERMIT2.
    IPermit2SignatureTransfer public immutable PERMIT2;

    /// @notice Current protocol fee in bps. Mutable ONLY via the timelocked
    ///         governance flow below, always <= MAX_FEE_BPS.
    uint16 public feeBps;

    /// @notice Pinned fee recipient; governance cannot redirect fees.
    address public feeRecipient;

    /// @notice Pending governance change (zero `pendingEffectiveAt` = none).
    uint16 public pendingFeeBps;
    address public pendingFeeRecipient;
    uint48 public pendingEffectiveAt;

    /// @notice Router allowlist: router => adapter kind (NONE = not allowed).
    ///         Tokens are permissionless; routers/factories never are.
    mapping(address router => RouterKind kind) public routerKind;
    mapping(address router => address factory) public routerFactory;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted once per successful trade. Everything needed to verify
    ///         the trade off-chain (MCP verify_trade) is in this single event.
    event SwapExecuted(
        address indexed taker,
        address indexed router,
        bytes32 indexed intentId,
        address tokenIn,
        address tokenOut,
        uint256 grossAmountIn,
        uint256 feeAmount,
        uint256 swapAmountIn,
        uint256 amountOut,
        address feeRecipient,
        uint16 feeBps,
        RouterKind routerKind,
        uint8 flags
    );

    /// @notice Governance proposed a fee/recipient change; applicable at `effectiveAt`.
    event FeeChangeProposed(uint16 newFeeBps, address newFeeRecipient, uint48 effectiveAt);
    /// @notice A proposed change became active after the timelock elapsed.
    event FeeChangeApplied(uint16 previousFeeBps, uint16 newFeeBps, address previousRecipient, address newRecipient);
    /// @notice Governance cancelled a pending change before it became active.
    event FeeChangeCancelled(uint16 cancelledFeeBps, address cancelledRecipient, uint48 wasEffectiveAt);
    event RouterUpdated(address indexed router, RouterKind previousKind, RouterKind newKind);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidPath();
    error FeeDeliveryMismatch();
    error ZeroAddress();
    error NotAContract(address account);
    error FeeBpsAboveCap(uint16 requested, uint16 cap);
    error InvalidFeeRecipient(address recipient);
    error FeeChangeNotPending();
    error TimelockNotElapsed(uint48 effectiveAt, uint256 nowTs);
    error RouterNotAllowed(address router, RouterKind expected);
    error TokenIsInfrastructure(address token);
    error TokenNotAContract(address token);
    error SameToken();
    error ZeroAmount();
    error ZeroMinimumOutput();
    error DeadlineExpired(uint256 deadline, uint256 nowTs);
    error InvalidRecipient(address recipient, address taker);
    error TakerIsFeeRecipient();
    error FeeMismatch(uint256 expected, uint256 actual);
    error FeeRoundsToZero(uint256 grossAmountIn);
    error InvalidTickSpacing(int24 tickSpacing);
    error InvalidPoolFee(uint24 poolFee);
    error NativeValueMismatch(uint256 msgValue, uint256 grossAmountIn);
    error NativeInputRequiresWeth();
    error NativeInputRequiresApprovalAuth();
    error UnwrapRequiresWethOut();
    error UnsupportedTransferAmount(uint256 expected, uint256 received);
    error PermitFailed();
    error InputNotFullyConsumed(uint256 balanceBefore, uint256 balanceAfter);
    error InsufficientOutput(uint256 amountOut, uint256 amountOutMinimum);
    error NativeTransferFailed(address to, uint256 amount);
    error UnexpectedNativeSender(address sender);
    error AggregatorTargetNotAuthenticated(address target);
    error AggregatorDeadlineExpired(uint256 deadline, uint256 nowTs);
    error BatchMismatch();
    error NativeInBatchUnsupported();
    error RenounceDisabled();
    error ConflictingAllowlist(address account);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param initialOwner        Admin — MUST be the governance multisig. The
    ///                            deployer gets NO privileges unless it is this address.
    /// @param weth                Wrapped native token.
    /// @param permit2             Canonical Permit2 address.
    /// @param routers             Initial router allowlist (typed adapters + factories).
    /// @param initialFeeBps       Initial protocol fee (policy: 25). 1..MAX_FEE_BPS.
    /// @param initialFeeRecipient Initial fee recipient; pinned and verified off-chain
    ///                            before deployment, re-checked by the deploy script.
    constructor(
        address initialOwner,
        address weth,
        address permit2,
        RouterConfig[] memory routers,
        uint16 initialFeeBps,
        address initialFeeRecipient
    ) Ownable(initialOwner) {
        deploymentOrigin = msg.sender;
        if (initialOwner != GOVERNANCE_SAFE || initialOwner == msg.sender || initialOwner.code.length == 0) {
            revert InvalidRecipient(initialOwner, GOVERNANCE_SAFE);
        }
        if (initialFeeBps != 25) revert FeeMismatch(initialFeeBps, 25);
        if (initialFeeRecipient != PINNED_FEE_RECIPIENT) revert InvalidFeeRecipient(initialFeeRecipient);
        if (weth == address(0) || permit2 == address(0)) revert ZeroAddress();
        if (weth.code.length == 0) revert NotAContract(weth);
        if (initialFeeBps == 0 || initialFeeBps > MAX_FEE_BPS) revert FeeBpsAboveCap(initialFeeBps, MAX_FEE_BPS);
        if (initialFeeRecipient == address(0)) revert InvalidFeeRecipient(initialFeeRecipient);
        WETH = IWETH9(weth);
        PERMIT2 = IPermit2SignatureTransfer(permit2);
        feeBps = initialFeeBps;
        feeRecipient = initialFeeRecipient;
        for (uint256 i; i < routers.length; ++i) {
            _setRouter(routers[i].router, routers[i].kind, routers[i].factory);
        }
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    // slither-disable-start reentrancy-balance
    // These balance snapshots enforce exact consumption and preserve pre-existing dust.
    // All execution and permission/rescue methods are nonReentrant.
    /// @notice One to three typed hops, one fee on gross input, one final minimum.
    ///         Tokens are permissionless: safety is enforced by typed adapters,
    ///         factory-verified pools, measured deltas and the atomic fee.
    function swapExactInput(SwapParams calldata p, Hop[] calldata path, Authorization calldata auth)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        _validatePath(p, path, true);
        Trade memory t = _begin(p, path[0].kind, auth, p.router);
        _executePath(p, path, t.outReceiver, t.swapAmount);
        amountOut = _finish(p, t);
        emit SwapPathExecuted(p.intentId, keccak256(abi.encode(p.tokenIn, path)), uint8(path.length));
    }

    // slither-disable-end reentrancy-balance

    // slither-disable-start reentrancy-balance
    // Justification: beforeIn/beforeOut are intentional pre-call snapshots; the
    // hop output is MEASURED as a post-call balance delta, and every trading
    // entry point is nonReentrant, so no interleaved call can move it.
    /// @dev Runs one hop and measures its actual output at the receiver.
    function _runHop(
        Hop calldata h,
        address tokenIn,
        address receiver,
        uint256 amount,
        uint256 minimum,
        uint256 deadline
    ) private returns (uint256 out) {
        IERC20 sell = IERC20(tokenIn);
        uint256 beforeIn = sell.balanceOf(address(this));
        uint256 beforeOut = IERC20(h.tokenOut).balanceOf(receiver);
        if (h.kind != RouterKind.UNISWAP_V4) sell.forceApprove(h.router, amount);
        _callHop(h, tokenIn, receiver, amount, minimum, deadline);
        sell.forceApprove(h.router, 0);
        if (sell.balanceOf(address(this)) != beforeIn - amount) {
            revert InputNotFullyConsumed(beforeIn - amount, sell.balanceOf(address(this)));
        }
        out = IERC20(h.tokenOut).balanceOf(receiver) - beforeOut;
        if (out == 0) revert ZeroAmount();
    }

    // slither-disable-end reentrancy-balance

    /// @dev Typed-adapter + canonical-factory validation. The pool MUST be the
    ///      one the router's own factory reports for this pair/fee/spacing/stable
    ///      flag, so a malicious or counterfeit pool can never be routed through.
    function _validateHop(Hop calldata h, address tokenIn) private view {
        if (h.kind == RouterKind.NONE || routerKind[h.router] != h.kind) revert RouterNotAllowed(h.router, h.kind);
        _validateToken(h.tokenOut);
        address factory = routerFactory[h.router];
        address pool;
        if (h.kind == RouterKind.UNISWAP_V4) {
            IMPGRV4PoolManager.PoolKey calldata k = h.v4Key;
            if (h.router != V4_POOL_MANAGER || factory != V4_POOL_MANAGER || h.pool != V4_POOL_MANAGER) {
                revert InvalidPath();
            }
            if (k.currency0 >= k.currency1 || k.tickSpacing <= 0 || k.tickSpacing > 32767) revert InvalidPath();
            address c0 = k.currency0 == address(0) ? address(WETH) : k.currency0;
            address c1 = k.currency1;
            if (!((tokenIn == c0 && h.tokenOut == c1) || (tokenIn == c1 && h.tokenOut == c0))) revert InvalidPath();
            if (h.poolFee != 0 || h.tickSpacing != 0 || h.stable) revert InvalidPath();
            return;
        }
        if (h.kind == RouterKind.UNISWAP_V3_ROUTER02) {
            if (h.stable || h.tickSpacing != 0 || h.poolFee == 0) revert InvalidPoolFee(h.poolFee);
            pool = ISwapUniFactory(factory).getPool(tokenIn, h.tokenOut, h.poolFee);
        } else if (h.kind == RouterKind.AERODROME_SLIPSTREAM) {
            if (h.stable || h.poolFee != 0 || h.tickSpacing <= 0) revert InvalidTickSpacing(h.tickSpacing);
            pool = ISwapSlipFactory(factory).getPool(tokenIn, h.tokenOut, h.tickSpacing);
        } else if (h.kind == RouterKind.UNISWAP_V2_ROUTER02) {
            if (h.stable || h.poolFee != 0 || h.tickSpacing != 0) revert InvalidPath();
            pool = ISwapV2Factory(factory).getPair(tokenIn, h.tokenOut);
        } else if (h.kind == RouterKind.AERODROME_CLASSIC) {
            if (h.poolFee != 0 || h.tickSpacing != 0) revert InvalidPath();
            pool = ISwapClassicFactory(factory).getPool(tokenIn, h.tokenOut, h.stable);
        } else {
            revert InvalidPath();
        }
        if (pool == address(0) || pool != h.pool || pool.code.length == 0) revert InvalidPath();
    }

    /// @dev Permissionless-token safety: real code, and never this contract, a
    ///      allowlisted router or its factory (infrastructure can't pose as a token).
    function _validateToken(address token) private view {
        if (token.code.length == 0) revert TokenNotAContract(token);
        if (token == address(this) || routerKind[token] != RouterKind.NONE || routerFactory[token] != address(0)) {
            revert TokenIsInfrastructure(token);
        }
    }

    function _callHop(
        Hop calldata h,
        address tokenIn,
        address receiver,
        uint256 amount,
        uint256 minimum,
        uint256 deadline
    ) private {
        // slither-disable-start unused-return
        // Deliberately ignore router-reported output; caller measures actual recipient balances.
        if (h.kind == RouterKind.UNISWAP_V4) {
            _callV4(h, tokenIn, receiver, amount);
        } else if (h.kind == RouterKind.UNISWAP_V3_ROUTER02) {
            IUniswapV3SwapRouter02(h.router)
                .exactInputSingle(
                    IUniswapV3SwapRouter02.ExactInputSingleParams(
                        tokenIn, h.tokenOut, h.poolFee, receiver, amount, minimum, 0
                    )
                );
        } else if (h.kind == RouterKind.AERODROME_SLIPSTREAM) {
            ISlipstreamSwapRouter(h.router)
                .exactInputSingle(
                    ISlipstreamSwapRouter.ExactInputSingleParams(
                        tokenIn, h.tokenOut, h.tickSpacing, receiver, deadline, amount, minimum, 0
                    )
                );
        } else if (h.kind == RouterKind.UNISWAP_V2_ROUTER02) {
            address[] memory tokens = new address[](2);
            tokens[0] = tokenIn;
            tokens[1] = h.tokenOut;
            IMPGRSwapV2RouterDraft(h.router).swapExactTokensForTokens(amount, minimum, tokens, receiver, deadline);
        } else if (h.kind == RouterKind.AERODROME_CLASSIC) {
            ISwapClassicRouter.Route[] memory routes = new ISwapClassicRouter.Route[](1);
            routes[0] = ISwapClassicRouter.Route(tokenIn, h.tokenOut, h.stable, routerFactory[h.router]);
            ISwapClassicRouter(h.router).swapExactTokensForTokens(amount, minimum, routes, receiver, deadline);
        } else {
            revert InvalidPath();
        }
        // slither-disable-end unused-return
    }

    /// @dev v4 uses unlock/settle/take, never a v3 getPool lookup or arbitrary router calldata.
    function _callV4(Hop calldata h, address input, address receiver, uint256 amount) private {
        if (amount > uint256(uint128(type(int128).max))) revert ZeroAmount();
        bool zeroForOne = input == (h.v4Key.currency0 == address(0) ? address(WETH) : h.v4Key.currency0);
        address sellCurrency = zeroForOne ? h.v4Key.currency0 : h.v4Key.currency1;
        if (sellCurrency == address(0)) WETH.withdraw(amount);
        bytes memory data = abi.encode(h.v4Key, h.hookData, zeroForOne, amount, receiver);
        if (activeUnlock != bytes32(0)) revert InvalidUnlock();
        activeUnlock = keccak256(data);
        IMPGRV4PoolManager(V4_POOL_MANAGER).unlock(data);
        // Callback consumes the commitment before returning to the manager.
        if (activeUnlock != bytes32(0)) revert InvalidUnlock();
    }

    /// @notice Authenticated callback, usable only during this executor's own swap.
    /// @dev Deliberately not nonReentrant: the outer swap holds the lock. No external
    /// caller can choose settlement data or invoke a second trade from the callback.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (
            msg.sender != V4_POOL_MANAGER || !_reentrancyGuardEntered() || activeUnlock == bytes32(0)
                || keccak256(data) != activeUnlock
        ) {
            revert InvalidUnlock();
        }
        // Consume the one-use capability BEFORE any external interaction,
        // including hook execution in swap(). No callback state is written
        // after swap/settle/take, and a canonical-manager replay sees zero.
        activeUnlock = bytes32(0);
        (
            IMPGRV4PoolManager.PoolKey memory key,
            bytes memory hookData,
            bool zeroForOne,
            uint256 amount,
            address receiver
        ) = abi.decode(data, (IMPGRV4PoolManager.PoolKey, bytes, bool, uint256, address));
        IMPGRV4PoolManager manager = IMPGRV4PoolManager(V4_POOL_MANAGER);
        int256 delta = manager.swap(
            key,
            IMPGRV4PoolManager.SwapParams(
                zeroForOne,
                -int256(amount),
                zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341)
            ),
            hookData
        );
        int128 delta0 = int128(delta >> 128);
        int128 delta1 = int128(delta);
        int128 sellDelta = zeroForOne ? delta0 : delta1;
        int128 buyDelta = zeroForOne ? delta1 : delta0;
        if (sellDelta >= 0 || uint256(-int256(sellDelta)) != amount || buyDelta <= 0) revert InvalidUnlock();
        address sellCurrency = zeroForOne ? key.currency0 : key.currency1;
        address buyCurrency = zeroForOne ? key.currency1 : key.currency0;
        if (sellCurrency == address(0)) {
            manager.settle{value: amount}();
        } else {
            manager.sync(sellCurrency);
            IERC20(sellCurrency).safeTransfer(V4_POOL_MANAGER, amount);
            if (manager.settle() != amount) revert InvalidUnlock();
        }
        uint256 output = uint256(uint128(buyDelta));
        if (buyCurrency == address(0)) {
            manager.take(address(0), address(this), output);
            WETH.deposit{value: output}();
            if (receiver != address(this)) IERC20(address(WETH)).safeTransfer(receiver, output);
        } else {
            manager.take(buyCurrency, receiver, output);
        }
        return abi.encode(output);
    }

    /// @notice Split the net input across up to four typed paths. Pull and fee occur ONCE.
    /// @dev Allocations must sum exactly to gross minus fee; each leg is measured.
    function swapExactInputSplit(
        SwapParams calldata p,
        Hop[][] calldata paths,
        uint256[] calldata amounts,
        Authorization calldata auth
    ) external payable nonReentrant whenNotPaused returns (uint256 totalOut) {
        uint256 n = paths.length;
        if (n < 2 || n > 4 || amounts.length != n) revert BatchMismatch();
        uint256 allocated;
        for (uint256 i; i < n; ++i) {
            _validatePath(p, paths[i], false);
            if (amounts[i] == 0) revert ZeroAmount();
            allocated += amounts[i];
        }
        if (p.router != paths[0][0].router) revert InvalidPath();
        Trade memory t = _begin(p, paths[0][0].kind, auth, p.router);
        if (allocated != t.swapAmount) revert BatchMismatch();
        for (uint256 i; i < n; ++i) {
            _executePath(p, paths[i], t.outReceiver, amounts[i]);
        }
        totalOut = _finish(p, t);
        emit SwapPathExecuted(p.intentId, keccak256(abi.encode(paths, amounts)), uint8(n));
    }

    function _validatePath(SwapParams calldata p, Hop[] calldata path, bool checkRouter) private view {
        uint256 n = path.length;
        if (n == 0 || n > 3 || (checkRouter && p.router != path[0].router) || path[n - 1].tokenOut != p.tokenOut) {
            revert InvalidPath();
        }
        address input = p.tokenIn;
        for (uint256 i; i < n; ++i) {
            if (path[i].tokenOut == p.tokenIn || (i + 1 < n && path[i].tokenOut == p.tokenOut)) revert InvalidPath();
            for (uint256 j; j < i; ++j) {
                if (path[j].tokenOut == path[i].tokenOut) revert InvalidPath();
            }
            _validateHop(path[i], input);
            input = path[i].tokenOut;
        }
    }

    function _executePath(SwapParams calldata p, Hop[] calldata path, address receiver, uint256 amount) private {
        address input = p.tokenIn;
        for (uint256 i; i < path.length; ++i) {
            amount = _runHop(path[i], input, i + 1 == path.length ? receiver : address(this), amount, 1, p.deadline);
            input = path[i].tokenOut;
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Exact fee split for a gross sell amount at the CURRENT fee.
    /// @return fee        floor(grossAmountIn * feeBps / 10_000)
    /// @return swapAmount grossAmountIn - fee
    function quoteFee(uint256 grossAmountIn) external view returns (uint256 fee, uint256 swapAmount) {
        fee = Math.mulDiv(grossAmountIn, feeBps, BPS_DENOMINATOR);
        swapAmount = grossAmountIn - fee;
    }

    /// @notice Full governance state for UIs: current + pending fee terms.
    function feeGovernance()
        external
        view
        returns (
            uint16 currentFeeBps,
            uint16 maxFeeBps,
            address currentRecipient,
            uint16 nextFeeBps,
            address nextRecipient,
            uint48 effectiveAt,
            uint48 timelockSeconds
        )
    {
        return (
            feeBps,
            MAX_FEE_BPS,
            feeRecipient,
            pendingFeeBps,
            pendingFeeRecipient,
            pendingEffectiveAt,
            FEE_TIMELOCK_SECONDS
        );
    }

    // ---------------------------------------------------------------------
    // Fee governance (multisig owner + mandatory timelock)
    // ---------------------------------------------------------------------

    /// @notice Propose a new nonzero fee; the recipient must remain pinned. Cannot take effect before
    ///         `block.timestamp + FEE_TIMELOCK_SECONDS`, and the new fee can
    ///         never exceed MAX_FEE_BPS. Replaces any earlier pending change.
    function proposeFeeChange(uint16 newFeeBps, address newFeeRecipient) external onlyOwner nonReentrant {
        if (newFeeBps == 0 || newFeeBps > MAX_FEE_BPS) revert FeeBpsAboveCap(newFeeBps, MAX_FEE_BPS);
        if (newFeeRecipient != PINNED_FEE_RECIPIENT) revert InvalidFeeRecipient(newFeeRecipient);
        pendingFeeBps = newFeeBps;
        pendingFeeRecipient = newFeeRecipient;
        pendingEffectiveAt = uint48(block.timestamp) + FEE_TIMELOCK_SECONDS;
        emit FeeChangeProposed(newFeeBps, newFeeRecipient, pendingEffectiveAt);
    }

    /// @notice Only governance may apply exactly its pending change after 48 hours.
    function applyFeeChange() external onlyOwner nonReentrant {
        uint48 effectiveAt = pendingEffectiveAt;
        if (effectiveAt == 0) revert FeeChangeNotPending();
        if (block.timestamp < effectiveAt) revert TimelockNotElapsed(effectiveAt, block.timestamp);
        uint16 previousBps = feeBps;
        address previousRecipient = feeRecipient;
        feeBps = pendingFeeBps;
        feeRecipient = pendingFeeRecipient;
        delete pendingFeeBps;
        delete pendingFeeRecipient;
        delete pendingEffectiveAt;
        emit FeeChangeApplied(previousBps, feeBps, previousRecipient, feeRecipient);
    }

    /// @notice Cancel a pending change before it becomes active.
    function cancelFeeChange() external onlyOwner nonReentrant {
        if (pendingEffectiveAt == 0) revert FeeChangeNotPending();
        emit FeeChangeCancelled(pendingFeeBps, pendingFeeRecipient, pendingEffectiveAt);
        delete pendingFeeBps;
        delete pendingFeeRecipient;
        delete pendingEffectiveAt;
    }

    // ---------------------------------------------------------------------
    // Admin (owner only — Ownable2Step)
    // ---------------------------------------------------------------------

    // There are deliberately NO immediate fee/recipient setters (owner or
    // otherwise) and no alternate zero-fee entry point: the timelocked flow
    // above is the only mutation path, bounded by MAX_FEE_BPS.

    /// @notice Allowlist a router for exactly one adapter kind, or remove it (NONE).
    function setRouter(address router, RouterKind kind, address factory) external onlyOwner nonReentrant {
        _setRouter(router, kind, factory);
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == deploymentOrigin || newOwner.code.length == 0) {
            revert InvalidRecipient(newOwner, GOVERNANCE_SAFE);
        }
        super.transferOwnership(newOwner);
    }

    /// @notice Block new trades (cannot trap funds: nothing is held between txs).
    function pause() external onlyOwner nonReentrant {
        _pause();
    }

    /// @notice Resume trading.
    function unpause() external onlyOwner nonReentrant {
        _unpause();
    }

    /// @notice Recover ERC-20 tokens sent to this contract BY MISTAKE. The
    ///         executor never holds user funds between transactions (enforced
    ///         per trade), and it cannot touch user allowances from here.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    /// @notice Recover native ETH force-sent to this contract (e.g. selfdestruct).
    function rescueNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _sendNative(to, amount);
        emit NativeRescued(to, amount);
    }

    /// @notice Disabled: an ownerless executor could never be paused or re-pointed.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @dev Native v4 take is accepted only from the canonical manager while
    /// an outer nonReentrant swap is active. Callback authorization is already
    /// consumed at this point; accepting ETH does not authorize any callback.
    receive() external payable {
        if (msg.sender != address(WETH) && !(msg.sender == V4_POOL_MANAGER && _reentrancyGuardEntered())) {
            revert UnexpectedNativeSender(msg.sender);
        }
    }

    // ---------------------------------------------------------------------
    // Internal — trade lifecycle
    // ---------------------------------------------------------------------

    // slither-disable-start msg-value-loop
    // Justification: msg.value is read here only to route the native-input
    // branch. all paths share one _begin call, so native input and fee are consumed once.
    // slither-disable-start reentrancy-balance
    // Justification: `inBalanceBefore` is read before the pull ON PURPOSE — the
    // before/after delta is how fee-on-transfer/rebasing sell tokens are
    // rejected (Permit2 performs the transfer inside its own call, so the read
    // cannot move later). Every entry point is `nonReentrant`, and Permit2 is immutable; sell tokens remain permissionless.
    function _begin(SwapParams calldata p, RouterKind kind, Authorization calldata auth, address spender)
        private
        returns (Trade memory t)
    {
        _validate(p, kind);
        t.kind = kind;
        t.spender = spender;

        // Exact fee — floor(G * feeBps / 10_000) at the CURRENT governed fee.
        // The caller commits the same value; any drift reverts the trade.
        t.fee = Math.mulDiv(p.grossAmountIn, feeBps, BPS_DENOMINATOR);
        if (t.fee != p.expectedFeeAmount) revert FeeMismatch(p.expectedFeeAmount, t.fee);
        if (feeBps != 0 && t.fee == 0) revert FeeRoundsToZero(p.grossAmountIn);
        t.swapAmount = p.grossAmountIn - t.fee;

        IERC20 tokenIn = IERC20(p.tokenIn);
        t.inBalanceBefore = tokenIn.balanceOf(address(this));

        if (msg.value != 0) {
            // Native ETH sell: tokenIn is WETH; msg.value is exactly G.
            if (p.tokenIn != address(WETH)) revert NativeInputRequiresWeth();
            if (msg.value != p.grossAmountIn) revert NativeValueMismatch(msg.value, p.grossAmountIn);
            if (auth.kind != AuthKind.APPROVAL) revert NativeInputRequiresApprovalAuth();
            t.nativeIn = true;
            WETH.deposit{value: t.swapAmount}();
            if (t.fee != 0) _sendNative(feeRecipient, t.fee);
        } else {
            address recipient = feeRecipient;
            uint256 recipientBefore = tokenIn.balanceOf(recipient);
            _pullFromTaker(p, auth);
            uint256 received = tokenIn.balanceOf(address(this)) - t.inBalanceBefore;
            // Rejects fee-on-transfer / rebasing sell tokens: exact economics only.
            if (received != p.grossAmountIn) revert UnsupportedTransferAmount(p.grossAmountIn, received);
            if (t.fee != 0) tokenIn.safeTransfer(recipient, t.fee);
            // The treasury must actually receive the fee, or the whole swap reverts.
            if (tokenIn.balanceOf(recipient) - recipientBefore != t.fee) revert FeeDeliveryMismatch();
        }

        // Exact, single-use allowance for (G - fee) to the validated spender.
        // Each typed hop grants and clears only its exact allocation.

        t.outReceiver = p.unwrapNativeOut ? address(this) : msg.sender;
        t.outBalanceBefore = IERC20(p.tokenOut).balanceOf(t.outReceiver);
    }
    // slither-disable-end reentrancy-balance
    // slither-disable-end msg-value-loop

    function _finish(SwapParams calldata p, Trade memory t) private returns (uint256) {
        IERC20 tokenIn = IERC20(p.tokenIn);

        // No dangling spender allowance.
        if (tokenIn.allowance(address(this), t.spender) != 0) {
            tokenIn.forceApprove(t.spender, 0);
        }

        // The router must have consumed exactly (G - fee): nothing trapped here.
        uint256 inBalanceAfter = tokenIn.balanceOf(address(this));
        if (inBalanceAfter != t.inBalanceBefore) revert InputNotFullyConsumed(t.inBalanceBefore, inBalanceAfter);

        // Output measured by balance delta, never trusted from the router.
        t.amountOut = IERC20(p.tokenOut).balanceOf(t.outReceiver) - t.outBalanceBefore;
        if (t.amountOut < p.amountOutMinimum) revert InsufficientOutput(t.amountOut, p.amountOutMinimum);

        if (p.unwrapNativeOut) {
            WETH.withdraw(t.amountOut);
            _sendNative(msg.sender, t.amountOut);
        }

        _emitSwapExecuted(p, t);
        return t.amountOut;
    }

    function _emitSwapExecuted(SwapParams calldata p, Trade memory t) private {
        uint8 flags = (t.nativeIn ? FLAG_NATIVE_IN : 0) | (p.unwrapNativeOut ? FLAG_NATIVE_OUT : 0);
        emit SwapExecuted(
            msg.sender,
            p.router,
            p.intentId,
            p.tokenIn,
            p.tokenOut,
            p.grossAmountIn,
            t.fee,
            t.swapAmount,
            t.amountOut,
            feeRecipient,
            feeBps,
            t.kind,
            flags
        );
    }

    function _validate(SwapParams calldata p, RouterKind kind) private view {
        if (kind == RouterKind.NONE || routerKind[p.router] != kind) revert RouterNotAllowed(p.router, kind);
        _validateToken(p.tokenIn);
        _validateToken(p.tokenOut);
        if (p.tokenIn == p.tokenOut) revert SameToken();
        if (p.grossAmountIn == 0) revert ZeroAmount();
        if (p.amountOutMinimum == 0) revert ZeroMinimumOutput();
        if (p.deadline < block.timestamp) revert DeadlineExpired(p.deadline, block.timestamp);
        if (p.recipient != msg.sender) revert InvalidRecipient(p.recipient, msg.sender);
        if (msg.sender == feeRecipient) revert TakerIsFeeRecipient();
        if (p.unwrapNativeOut && p.tokenOut != address(WETH)) revert UnwrapRequiresWethOut();
    }

    /// @dev Pulls exactly `grossAmountIn` from msg.sender — and ONLY msg.sender.
    function _pullFromTaker(SwapParams calldata p, Authorization calldata auth) private {
        if (auth.kind == AuthKind.PERMIT2) {
            PERMIT2.permitTransferFrom(
                IPermit2SignatureTransfer.PermitTransferFrom({
                    permitted: IPermit2SignatureTransfer.TokenPermissions({token: p.tokenIn, amount: p.grossAmountIn}),
                    nonce: auth.nonce,
                    deadline: auth.deadline
                }),
                IPermit2SignatureTransfer.SignatureTransferDetails({
                    to: address(this), requestedAmount: p.grossAmountIn
                }),
                msg.sender,
                auth.signature
            );
            return;
        }
        if (auth.kind == AuthKind.EIP2612) {
            // Front-run tolerant: a griefer can submit the same permit first;
            // then the allowance already exists and we simply continue.
            try IERC20Permit(p.tokenIn)
                .permit(msg.sender, address(this), p.grossAmountIn, auth.deadline, auth.v, auth.r, auth.s) {}
            catch {
                if (IERC20(p.tokenIn).allowance(msg.sender, address(this)) < p.grossAmountIn) {
                    revert PermitFailed();
                }
            }
        }
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.grossAmountIn);
    }

    // slither-disable-start arbitrary-send-eth
    // Justification: `to` is never caller-chosen for trade flows. Call sites pass
    // only (a) `feeRecipient` (governed storage, timelocked), (b) `msg.sender`
    // (the output recipient is enforced == taker in _validate), or (c) an
    // owner-only rescue target. Reentrancy is blocked by nonReentrant everywhere.
    function _sendNative(address to, uint256 amount) private {
        // Reentrancy is blocked by nonReentrant on every caller.
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }
    // slither-disable-end arbitrary-send-eth

    // ---------------------------------------------------------------------
    // Internal — admin
    // ---------------------------------------------------------------------

    function _setRouter(address router, RouterKind kind, address factory) private {
        if (kind == RouterKind.PANCAKE_V3 || kind == RouterKind.ZEROX_SETTLER) revert RouterNotAllowed(router, kind);
        if (router == address(0)) revert ZeroAddress();
        if (router == address(this)) revert ConflictingAllowlist(router);
        if (kind == RouterKind.UNISWAP_V4 && (router != V4_POOL_MANAGER || factory != V4_POOL_MANAGER)) {
            revert InvalidPath();
        }
        if (kind != RouterKind.NONE) {
            if (factory.code.length == 0) revert NotAContract(factory);
            if (router.code.length == 0) revert NotAContract(router);
        }
        emit RouterUpdated(router, routerKind[router], kind);
        routerKind[router] = kind;
        routerFactory[router] = kind == RouterKind.NONE ? address(0) : factory;
    }
}

interface ISwapUniFactory {
    function getPool(address, address, uint24) external view returns (address);
}

interface ISwapSlipFactory {
    function getPool(address, address, int24) external view returns (address);
}

interface ISwapV2Factory {
    function getPair(address, address) external view returns (address);
}

interface ISwapClassicFactory {
    function getPool(address, address, bool) external view returns (address);
}

interface ISwapClassicRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }
    function swapExactTokensForTokens(uint256, uint256, Route[] calldata, address, uint256)
        external
        returns (uint256[] memory);
}

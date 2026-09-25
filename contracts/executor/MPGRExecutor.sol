// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
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
} from "./interfaces/IMPGRExecutorRouters.sol";

/// @title MPGRExecutor
/// @author MPGR HUB
/// @notice Atomic "fee + swap" executor for MPGR Agent trades.
///
///         One top-level transaction:
///           taker ──grossAmountIn──▶ executor
///           executor ──fee = floor(gross * feeBps / 10_000)──▶ feeRecipient
///           executor ──(gross - fee)──▶ allowlisted router (typed swap call)
///           router ──amountOut──▶ taker   (verified by balance delta ≥ minOut)
///         Any failed validation, fee transfer, swap, slippage check or
///         invariant reverts the WHOLE transaction.
///
/// @dev    Security model (see docs/MPGR_EXECUTOR.md for the full threat model):
///         - NO generic `execute(target, data)`: every router call is a typed,
///           executor-encoded `exactInputSingle` for a router whose KIND was
///           allowlisted by the owner. Callers never supply calldata.
///         - Tokens are only ever pulled FROM `msg.sender` (never from an
///           arbitrary address), so a standing allowance to this contract can
///           only be spent by its owner's own transaction.
///         - Output always goes to `msg.sender` (`recipient` must equal it).
///         - Output is measured by balance delta, so a malicious/buggy router
///           cannot satisfy `amountOutMinimum` by lying in its return value.
///         - Exact fee: the caller commits to `expectedFeeAmount`; if the owner
///           changed `feeBps` after the quote, the trade reverts (no surprise
///           fee). Fee is capped on-chain at MAX_FEE_BPS.
///         - No custody between transactions: the router must consume exactly
///           `gross - fee`, the router allowance is reset to zero, and the
///           executor's balances of the traded tokens must return to their
///           pre-trade values.
///         - ReentrancyGuard on every state-touching external function;
///           Ownable2Step admin; renounceOwnership disabled; Pausable (pausing
///           can only block NEW trades — there are no user funds to trap).
contract MPGRExecutor is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard on-chain fee cap: 100 bps = 1.00%. `setFeeBps` can move the
    ///         fee anywhere in [0, MAX_FEE_BPS] without a redeploy, never above.
    uint16 public constant MAX_FEE_BPS = 100;

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
        UNISWAP_V3_ROUTER02
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

    /// @notice Router configuration used at construction.
    struct RouterConfig {
        address router;
        RouterKind kind;
    }

    /// @notice Common trade parameters (all enforced on-chain).
    /// @param router            Allowlisted router of the adapter's kind.
    /// @param tokenIn           Allowlisted sell token (WETH when selling native ETH).
    /// @param tokenOut          Allowlisted buy token.
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

    /// @notice Current MPGR Agent fee in basis points (starts at 25 = 0.25%).
    uint16 public feeBps;

    /// @notice Receives every fee, in the SELL token.
    address public feeRecipient;

    /// @notice Router allowlist: router => adapter kind (NONE = not allowed).
    mapping(address router => RouterKind kind) public routerKind;

    /// @notice Token allowlist (both sell and buy side).
    mapping(address token => bool allowed) public isTokenAllowed;

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

    event FeeBpsUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event RouterUpdated(address indexed router, RouterKind previousKind, RouterKind newKind);
    event TokenAllowlistUpdated(address indexed token, bool allowed);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error NotAContract(address account);
    error FeeBpsAboveCap(uint16 requested, uint16 cap);
    error InvalidFeeRecipient(address recipient);
    error RouterNotAllowed(address router, RouterKind expected);
    error TokenNotAllowed(address token);
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
    error RenounceDisabled();
    error ConflictingAllowlist(address account);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param initialOwner   Admin (the operator's own wallet/multisig). The
    ///                       deployer gets NO privileges unless it is this address.
    /// @param initialFeeRecipient Fee wallet (non-zero, not this contract).
    /// @param initialFeeBps  Starting fee (25 = 0.25%), must be <= MAX_FEE_BPS.
    /// @param weth           Wrapped native token.
    /// @param permit2        Canonical Permit2 address.
    /// @param routers        Initial router allowlist.
    /// @param tokens         Initial token allowlist.
    constructor(
        address initialOwner,
        address initialFeeRecipient,
        uint16 initialFeeBps,
        address weth,
        address permit2,
        RouterConfig[] memory routers,
        address[] memory tokens
    ) Ownable(initialOwner) {
        if (weth == address(0) || permit2 == address(0)) revert ZeroAddress();
        if (weth.code.length == 0) revert NotAContract(weth);
        WETH = IWETH9(weth);
        PERMIT2 = IPermit2SignatureTransfer(permit2);
        _setFeeRecipient(initialFeeRecipient);
        _setFeeBps(initialFeeBps);
        for (uint256 i = 0; i < tokens.length; ++i) {
            _setToken(tokens[i], true);
        }
        for (uint256 i = 0; i < routers.length; ++i) {
            _setRouter(routers[i].router, routers[i].kind);
        }
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /// @notice Fee + Aerodrome Slipstream single-hop exact-input swap, atomically.
    /// @param p           Trade parameters (validated on-chain).
    /// @param tickSpacing Slipstream pool tick spacing (> 0).
    /// @param auth        Authorization mode for pulling `grossAmountIn`.
    /// @return amountOut  Output actually received by the taker (balance delta).
    function swapSlipstreamExactInputSingle(
        SwapParams calldata p,
        int24 tickSpacing,
        Authorization calldata auth
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (tickSpacing <= 0) revert InvalidTickSpacing(tickSpacing);
        Trade memory t = _begin(p, RouterKind.AERODROME_SLIPSTREAM, auth);
        // Router's returned amountOut is deliberately IGNORED: the executor only
        // trusts the measured balance delta in _finish (a router may lie).
        // slither-disable-next-line unused-return
        ISlipstreamSwapRouter(p.router).exactInputSingle(
            ISlipstreamSwapRouter.ExactInputSingleParams({
                tokenIn: p.tokenIn,
                tokenOut: p.tokenOut,
                tickSpacing: tickSpacing,
                recipient: t.outReceiver,
                deadline: p.deadline,
                amountIn: t.swapAmount,
                amountOutMinimum: p.amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
        amountOut = _finish(p, t);
    }

    /// @notice Fee + Uniswap V3 SwapRouter02 single-hop exact-input swap, atomically.
    /// @param p       Trade parameters (validated on-chain).
    /// @param poolFee Uniswap V3 fee tier: 100, 500, 3000 or 10000.
    /// @param auth    Authorization mode for pulling `grossAmountIn`.
    /// @return amountOut Output actually received by the taker (balance delta).
    function swapUniswapV3ExactInputSingle(
        SwapParams calldata p,
        uint24 poolFee,
        Authorization calldata auth
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (poolFee != 100 && poolFee != 500 && poolFee != 3000 && poolFee != 10000) {
            revert InvalidPoolFee(poolFee);
        }
        Trade memory t = _begin(p, RouterKind.UNISWAP_V3_ROUTER02, auth);
        // Router's returned amountOut is deliberately IGNORED: the executor only
        // trusts the measured balance delta in _finish (a router may lie).
        // slither-disable-next-line unused-return
        IUniswapV3SwapRouter02(p.router).exactInputSingle(
            IUniswapV3SwapRouter02.ExactInputSingleParams({
                tokenIn: p.tokenIn,
                tokenOut: p.tokenOut,
                fee: poolFee,
                recipient: t.outReceiver,
                amountIn: t.swapAmount,
                amountOutMinimum: p.amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
        amountOut = _finish(p, t);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Exact fee split for a gross sell amount at the CURRENT fee.
    /// @return fee        floor(grossAmountIn * feeBps / 10_000)
    /// @return swapAmount grossAmountIn - fee
    function quoteFee(uint256 grossAmountIn) external view returns (uint256 fee, uint256 swapAmount) {
        fee = (grossAmountIn * feeBps) / BPS_DENOMINATOR;
        swapAmount = grossAmountIn - fee;
    }

    // ---------------------------------------------------------------------
    // Admin (owner only — Ownable2Step)
    // ---------------------------------------------------------------------

    /// @notice Change the fee within [0, MAX_FEE_BPS]. In-flight trades that
    ///         committed to the old fee revert with FeeMismatch (never overcharge).
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        _setFeeBps(newFeeBps);
    }

    /// @notice Change the fee wallet.
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        _setFeeRecipient(newFeeRecipient);
    }

    /// @notice Allowlist a router for exactly one adapter kind, or remove it (NONE).
    function setRouter(address router, RouterKind kind) external onlyOwner {
        _setRouter(router, kind);
    }

    /// @notice Allow or disallow a token.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        _setToken(token, allowed);
    }

    /// @notice Block new trades (cannot trap funds: nothing is held between txs).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume trading.
    function unpause() external onlyOwner {
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

    /// @dev Only WETH may send ETH (during unwrap). Anything else reverts.
    receive() external payable {
        if (msg.sender != address(WETH)) revert UnexpectedNativeSender(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Internal — trade lifecycle
    // ---------------------------------------------------------------------

    // slither-disable-start reentrancy-balance
    // Justification: `inBalanceBefore` is read before the pull ON PURPOSE — the
    // before/after delta is how fee-on-transfer/rebasing sell tokens are
    // rejected (Permit2 performs the transfer inside its own call, so the read
    // cannot move later). Every entry point is `nonReentrant`, and both the
    // sell token and Permit2/the token's permit() are allowlisted/immutable.
    function _begin(SwapParams calldata p, RouterKind kind, Authorization calldata auth)
        private
        returns (Trade memory t)
    {
        _validate(p, kind);
        t.kind = kind;

        // Exact fee — floor(G * feeBps / 10_000). Committed by the caller.
        t.fee = (p.grossAmountIn * feeBps) / BPS_DENOMINATOR;
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
            _pullFromTaker(p, auth);
            uint256 received = tokenIn.balanceOf(address(this)) - t.inBalanceBefore;
            // Rejects fee-on-transfer / rebasing sell tokens: exact economics only.
            if (received != p.grossAmountIn) revert UnsupportedTransferAmount(p.grossAmountIn, received);
            if (t.fee != 0) tokenIn.safeTransfer(feeRecipient, t.fee);
        }

        // Exact, single-use router allowance for (G - fee).
        tokenIn.forceApprove(p.router, t.swapAmount);

        t.outReceiver = p.unwrapNativeOut ? address(this) : msg.sender;
        t.outBalanceBefore = IERC20(p.tokenOut).balanceOf(t.outReceiver);
    }
    // slither-disable-end reentrancy-balance

    function _finish(SwapParams calldata p, Trade memory t) private returns (uint256) {
        IERC20 tokenIn = IERC20(p.tokenIn);

        // No dangling router allowance.
        if (tokenIn.allowance(address(this), p.router) != 0) {
            tokenIn.forceApprove(p.router, 0);
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
        if (routerKind[p.router] != kind) revert RouterNotAllowed(p.router, kind);
        if (!isTokenAllowed[p.tokenIn]) revert TokenNotAllowed(p.tokenIn);
        if (!isTokenAllowed[p.tokenOut]) revert TokenNotAllowed(p.tokenOut);
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
                    to: address(this),
                    requestedAmount: p.grossAmountIn
                }),
                msg.sender,
                auth.signature
            );
            return;
        }
        if (auth.kind == AuthKind.EIP2612) {
            // Front-run tolerant: a griefer can submit the same permit first;
            // then the allowance already exists and we simply continue.
            try IERC20Permit(p.tokenIn).permit(
                msg.sender, address(this), p.grossAmountIn, auth.deadline, auth.v, auth.r, auth.s
            ) {} catch {
                if (IERC20(p.tokenIn).allowance(msg.sender, address(this)) < p.grossAmountIn) {
                    revert PermitFailed();
                }
            }
        }
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.grossAmountIn);
    }

    // slither-disable-start arbitrary-send-eth
    // Justification: `to` is never caller-chosen. Call sites pass only
    // (a) `feeRecipient` (owner-set, validated), (b) `msg.sender` (the output
    // recipient is enforced == taker in _validate), or (c) an owner-only
    // rescue target. Reentrancy is blocked by nonReentrant on every caller.
    function _sendNative(address to, uint256 amount) private {
        // Reentrancy is blocked by nonReentrant on every caller.
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }
    // slither-disable-end arbitrary-send-eth

    // ---------------------------------------------------------------------
    // Internal — admin
    // ---------------------------------------------------------------------

    function _setFeeBps(uint16 newFeeBps) private {
        if (newFeeBps > MAX_FEE_BPS) revert FeeBpsAboveCap(newFeeBps, MAX_FEE_BPS);
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function _setFeeRecipient(address newFeeRecipient) private {
        if (newFeeRecipient == address(0) || newFeeRecipient == address(this)) {
            revert InvalidFeeRecipient(newFeeRecipient);
        }
        emit FeeRecipientUpdated(feeRecipient, newFeeRecipient);
        feeRecipient = newFeeRecipient;
    }

    function _setRouter(address router, RouterKind kind) private {
        if (router == address(0)) revert ZeroAddress();
        if (router == address(this)) revert ConflictingAllowlist(router);
        if (kind != RouterKind.NONE) {
            if (router.code.length == 0) revert NotAContract(router);
            // A token can never double as a router (and vice versa).
            if (isTokenAllowed[router]) revert ConflictingAllowlist(router);
        }
        emit RouterUpdated(router, routerKind[router], kind);
        routerKind[router] = kind;
    }

    function _setToken(address token, bool allowed) private {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(this)) revert ConflictingAllowlist(token);
        if (allowed) {
            if (token.code.length == 0) revert NotAContract(token);
            if (routerKind[token] != RouterKind.NONE) revert ConflictingAllowlist(token);
        }
        isTokenAllowed[token] = allowed;
        emit TokenAllowlistUpdated(token, allowed);
    }
}

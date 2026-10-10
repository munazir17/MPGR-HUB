// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
import {IPermit2SignatureTransferWitness} from "./interfaces/IPermit2SignatureTransferWitness.sol";
import {IMPGRExecutorSwapModule} from "./interfaces/IMPGRExecutorSwapModule.sol";

/// @title MPGRExecutorDelegated
/// @author MPGR HUB
/// @notice Permissionless "fee + swap" executor for USER-AUTHORIZED AUTONOMOUS
///         trades (spec: autonomy-executor-contract-spec.md, Phase 1).
///
///         One top-level transaction, initiated by ANYONE (typically the
///         operator's gas-only broadcaster — "swap on behalf of"):
///           owner (user wallet, signs the permit offline)
///             ──exact grossAmountIn via Permit2 witness permit──▶ this contract
///           this contract ──fee = floor(gross * feeBps / 10_000)──▶ feeRecipient
///           this contract ──(gross - fee)──▶ allowlisted typed venue
///           venue ──amountOut──▶ owner   (modules return to core; measured ≥ minOut)
///
///         The user's EIP-712 Permit2 witness permit authorizes EXACTLY ONE
///         trade: exact sell token, exact gross amount, exact buy token, exact
///         minimum output, exact deadline, single-use nonce, and a policy hash
///         + action id. Anyone may broadcast it; NOBODY can redirect output
///         (it always goes to the signing owner), overspend (amounts are
///         signed exactly), or use this contract without a live permit.
///         The operator's broadcaster key therefore carries NO custody: its
///         only power is redeeming user-signed permits within their bounds.
///
///         Relationship to MPGRExecutor v1 (the assisted-flow executor):
///           - v1 is NOT modified and stays deploy-independent of this file.
///           - The trade lifecycle here replicates v1's as literal spec-of-record
///             (same structs, validation order, fee math, events, error
///             semantics); equivalence suites fuzz v1 vs this contract.
///           - Differences, ALL deliberate and user-safety-positive:
///               * taker is the recovered permit signer (`witness.owner`),
///                 not msg.sender — msg.sender is only the broadcaster;
///               * the pull is a Permit2 WITNESS permit binding
///                 {owner, buyToken, minAmountOut, deadline, actionId, policyHash};
///               * recipient must equal the owner; output never redirected;
///               * native-ETH input is structurally impossible (no msg.value
///                 path — a broadcaster must never fund a user's trade).
///
/// @dev    Security model (docs/MPGR_EXECUTOR.md threat model + spec):
///         - NO proxy, upgrade, delegatecall, generic `execute(target,data)`, or
///           caller-selected target/calldata path. Built-in venues use fixed
///           router ABIs; future venues use one fixed typed module selector.
///         - Typed modules are owner-allowlisted per router, bound to this
///           executor/router, code-hash pinned, and receive only the exact
///           post-fee input transfer (never a standing core allowance). The
///           core measures their output and forwards it only to the signer.
///         - Tokens pulled ONLY via canonical Permit2 witness permits with
///           spender == this contract (Permit2 binds msg.sender in the digest).
///         - Output always to `witness.owner` (`recipient` must equal it).
///         - Output measured by balance delta; router return values ignored.
///         - Exact fee committed by the caller (`FeeMismatch` on drift), capped
///           at MAX_FEE_BPS; owner(taker) == feeRecipient is rejected.
///         - No custody between transactions; every failure reverts atomically.
///         - No proxy, no upgrade path; renounceOwnership disabled (as v1).
contract MPGRExecutorDelegated is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants (identical to v1 where meaningful)
    // ---------------------------------------------------------------------

    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard on-chain fee cap: 100 bps = 1.00%.
    uint16 public constant MAX_FEE_BPS = 100;

    /// @notice SwapExecuted.flags bit: the owner received native ETH (unwrapped WETH).
    ///         Same bit value as v1's FLAG_NATIVE_OUT. There is no FLAG_NATIVE_IN:
    ///         native-ETH input is structurally impossible in delegated swaps.
    uint8 public constant FLAG_NATIVE_OUT = 2;

    /// @notice The ActionWitness struct's own canonical EIP-712 type string
    ///         (the encodeType of the witness struct ALONE — used for the
    ///         witness struct hash). Field order MUST match the ActionWitness
    ///         struct declaration below, field-for-field.
    string public constant ACTION_WITNESS_STRUCT_TYPE_STRING =
        "ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)";

    /// @notice The witness type string handed to Permit2's
    ///         permitWitnessTransferFrom, in STANDARD EIP-712 form so that
    ///         ordinary wallets can sign it directly. Permit2 computes its
    ///         typeHash as
    ///         keccak256(abi.encodePacked(_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB, witnessTypeString)),
    ///         so this string must complete the stub into the full encodeType:
    ///         "<witness field name + ')'>" + referenced structs in
    ///         alphabetical order + the TokenPermissions appendix (the
    ///         UniswapX Permit2-witness convention). The security bindings
    ///         (fields, order, meaning) are unchanged — only the packing
    ///         representation became wallet-compatible.
    string public constant WITNESS_TYPE_STRING =
        "ActionWitness witness)ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)TokenPermissions(address token,uint256 amount)";

    /// @notice keccak256(ACTION_WITNESS_STRUCT_TYPE_STRING) — the struct hash
    ///         seed used to build the 32-byte witness passed to Permit2.
    bytes32 public constant ACTION_WITNESS_TYPEHASH = keccak256(bytes(ACTION_WITNESS_STRUCT_TYPE_STRING));

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Which typed adapter an allowlisted router may be used with.
    enum RouterKind {
        NONE,
        AERODROME_SLIPSTREAM,
        UNISWAP_V3_ROUTER02,
        TYPED_SWAP_MODULE
    }

    /// @notice Router configuration used at construction (identical to v1).
    struct RouterConfig {
        address router;
        RouterKind kind;
    }

    /// @notice The delegation the user signs over, bound into the Permit2
    ///         signature as a witness. EVERY field is equality-enforced
    ///         against the executed trade on-chain.
    /// @param owner        The signing user wallet: fund source AND the ONLY
    ///                     output recipient (never the broadcaster).
    /// @param buyToken     Must equal SwapParams.tokenOut.
    /// @param minAmountOut Must equal SwapParams.amountOutMinimum (slippage floor).
    /// @param deadline     Must equal permit.deadline AND SwapParams.deadline.
    /// @param actionId     Unique per trade slot; must equal SwapParams.intentId.
    /// @param policyHash   keccak256 of the canonical autonomy policy tuple
    ///                     (wallet, policyId, pair, caps, slippage, expiry) —
    ///                     binds the signature to the authorized policy.
    struct ActionWitness {
        address owner;
        address buyToken;
        uint256 minAmountOut;
        uint256 deadline;
        bytes32 actionId;
        bytes32 policyHash;
    }

    /// @notice Canonical Permit2 SignatureTransfer authorization + witness.
    /// @param permit    {permitted:{token,amount}, nonce, deadline} — token and
    ///                  amount must equal SwapParams.tokenIn/grossAmountIn.
    /// @param witness   ActionWitness (hashed with ACTION_WITNESS_TYPEHASH).
    /// @param signature User's EIP-712 signature (recovery must equal witness.owner).
    struct Permit2Authorization {
        IPermit2SignatureTransfer.PermitTransferFrom permit;
        ActionWitness witness;
        bytes signature;
    }

    /// @notice Common trade parameters — IDENTICAL struct to MPGRExecutor v1.
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

    /// @dev Per-trade scratch values (keeps the stack shallow).
    struct Trade {
        RouterKind kind;
        uint256 fee;
        uint256 swapAmount;
        uint256 inBalanceBefore;
        address outReceiver;
        uint256 outBalanceBefore;
        uint256 recipientOutBalanceBefore;
        uint256 amountOut;
    }

    // ---------------------------------------------------------------------
    // Immutable / storage (identical to v1)
    // ---------------------------------------------------------------------

    /// @notice Wrapped native token used for native ETH output (unwrap path).
    IWETH9 public immutable WETH;

    /// @notice Canonical Permit2 (SignatureTransfer witness variant).
    IPermit2SignatureTransferWitness public immutable PERMIT2;

    /// @notice Current MPGR Agent fee in basis points (starts at 25 = 0.25%).
    uint16 public feeBps;

    /// @notice Receives every fee, in the SELL token.
    address public feeRecipient;

    /// @notice Router allowlist: router => adapter kind (NONE = not allowed).
    mapping(address router => RouterKind kind) public routerKind;

    /// @notice Typed immutable module selected for routers configured as
    ///         TYPED_SWAP_MODULE. Each module is bound to exactly one executor
    ///         and router; it receives only the exact post-fee input amount.
    mapping(address router => address module) public swapModuleForRouter;

    /// @notice Runtime bytecode hash pinned when a module is registered.
    mapping(address router => bytes32 codeHash) public swapModuleCodeHash;

    /// @notice Reverse lookup prevents a module address from also being used
    ///         as a token or another router.
    mapping(address module => address router) public routerForSwapModule;

    /// @notice Token allowlist (both sell and buy side).
    mapping(address token => bool allowed) public isTokenAllowed;

    // ---------------------------------------------------------------------
    // Events — SwapExecuted is ABI-IDENTICAL to v1 (taker = the signing owner),
    // so the existing MCP verification path reads delegated receipts unchanged.
    // ---------------------------------------------------------------------

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
    event SwapModuleUpdated(
        address indexed router, address indexed previousModule, address indexed newModule, bytes32 codeHash
    );
    event TokenAllowlistUpdated(address indexed token, bool allowed);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors — v1-identical meanings, plus the delegated-specific set
    // (Native-in errors from v1 are intentionally absent: no native input.)
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
    error InvalidRecipient(address recipient, address owner);
    error OwnerIsFeeRecipient(address owner);
    error FeeMismatch(uint256 expected, uint256 actual);
    error FeeRoundsToZero(uint256 grossAmountIn);
    error InvalidTickSpacing(int24 tickSpacing);
    error InvalidPoolFee(uint24 poolFee);
    error UnsupportedTransferAmount(uint256 expected, uint256 received);
    error InputNotFullyConsumed(uint256 balanceBefore, uint256 balanceAfter);
    error InsufficientOutput(uint256 amountOut, uint256 amountOutMinimum);
    error UnwrapRequiresWethOut();
    error NativeTransferFailed(address to, uint256 amount);
    error UnexpectedNativeSender(address sender);
    error RenounceDisabled();
    error ConflictingAllowlist(address account);
    /// @notice Any witness/permit equality binding failed (see _validate).
    error InvalidWitness();
    /// @notice msg.value was sent — delegated swaps pull from the OWNER's
    ///         Permit2 allowance; a broadcaster must never fund a user's trade.
    error NativeInputUnsupported();
    error SwapModuleNotAllowed(address router);
    error InvalidSwapModule(address module);
    error ModuleInputNotConsumed(address module, uint256 balanceBefore, uint256 balanceAfter);

    // ---------------------------------------------------------------------
    // Construction (identical signature to v1 — deploy tooling reuses it)
    // ---------------------------------------------------------------------

    /// @param initialOwner   Admin (operator wallet/multisig; Ownable2Step).
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
        if (permit2.code.length == 0) revert NotAContract(permit2);
        WETH = IWETH9(weth);
        PERMIT2 = IPermit2SignatureTransferWitness(permit2);
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
    // Trading — permissionless broadcast of USER-SIGNED witness permits
    // ---------------------------------------------------------------------

    /// @notice Fee + Uniswap V3 SwapRouter02 single-hop exact-input swap on
    ///         behalf of the permit's signing owner. Anyone may broadcast.
    /// @param p       Trade parameters (validated on-chain, witness-bound).
    /// @param poolFee Uniswap V3 fee tier: 100, 500, 3000 or 10000.
    /// @param auth    Permit2 witness authorization signed by `witness.owner`.
    /// @return amountOut Output actually received by the owner (balance delta).
    function swapOnBehalfOfUniswapV3(SwapParams calldata p, uint24 poolFee, Permit2Authorization calldata auth)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        if (msg.value != 0) revert NativeInputUnsupported();
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
        amountOut = _finish(p, t, auth.witness.owner);
    }

    /// @notice Fee + Aerodrome Slipstream single-hop exact-input swap on
    ///         behalf of the permit's signing owner. Anyone may broadcast.
    /// @param p           Trade parameters (validated on-chain, witness-bound).
    /// @param tickSpacing Slipstream pool tick spacing (> 0).
    /// @param auth        Permit2 witness authorization signed by `witness.owner`.
    /// @return amountOut  Output actually received by the owner (balance delta).
    function swapOnBehalfOfSlipstream(SwapParams calldata p, int24 tickSpacing, Permit2Authorization calldata auth)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        if (msg.value != 0) revert NativeInputUnsupported();
        if (tickSpacing <= 0) revert InvalidTickSpacing(tickSpacing);
        Trade memory t = _begin(p, RouterKind.AERODROME_SLIPSTREAM, auth);
        // Router's returned amountOut is deliberately IGNORED (see above).
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
        amountOut = _finish(p, t, auth.witness.owner);
    }

    /// @notice Fee + exact-input swap through one governance-allowlisted,
    ///         immutable typed venue module. The module is bound to `p.router`
    ///         and this executor; it receives only the post-fee input amount,
    ///         and output must return here so this core can measure it and send
    ///         it to the signed owner. No target or arbitrary calldata is
    ///         supplied by the caller.
    // slither-disable-next-line reentrancy-balance
    function swapOnBehalfOfTypedModule(SwapParams calldata p, Permit2Authorization calldata auth)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        if (msg.value != 0) revert NativeInputUnsupported();
        Trade memory t = _begin(p, RouterKind.TYPED_SWAP_MODULE, auth);
        address module = swapModuleForRouter[p.router];
        IERC20 tokenIn = IERC20(p.tokenIn);

        // No allowance is granted to the module. It receives exactly the
        // authorized post-fee amount for this one atomic call only.
        uint256 moduleInputBefore = tokenIn.balanceOf(module);
        tokenIn.safeTransfer(module, t.swapAmount);
        uint256 moduleInputReceived = tokenIn.balanceOf(module) - moduleInputBefore;
        if (moduleInputReceived != t.swapAmount) {
            revert UnsupportedTransferAmount(t.swapAmount, moduleInputReceived);
        }

        // The module's return value is untrusted. _finish measures output at
        // this executor and then measures the exact amount delivered to owner.
        // slither-disable-next-line unused-return
        IMPGRExecutorSwapModule(module).swapExactInput(
            p.tokenIn, p.tokenOut, t.swapAmount, p.amountOutMinimum, p.deadline, address(this)
        );

        uint256 moduleInputAfter = tokenIn.balanceOf(module);
        if (moduleInputAfter != moduleInputBefore) {
            revert ModuleInputNotConsumed(module, moduleInputBefore, moduleInputAfter);
        }
        if (module.codehash != swapModuleCodeHash[p.router]) revert SwapModuleNotAllowed(p.router);

        amountOut = _finish(p, t, auth.witness.owner);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Exact fee split for a gross sell amount at the CURRENT fee
    ///         (identical to v1).
    /// @return fee        floor(grossAmountIn * feeBps / 10_000)
    /// @return swapAmount grossAmountIn - fee
    function quoteFee(uint256 grossAmountIn) external view returns (uint256 fee, uint256 swapAmount) {
        fee = (grossAmountIn * feeBps) / BPS_DENOMINATOR;
        swapAmount = grossAmountIn - fee;
    }

    /// @notice The 32-byte witness value the USER signs over and that this
    ///         contract derives from calldata before redeeming the permit.
    function witnessHashOf(ActionWitness memory w) public pure returns (bytes32) {
        return keccak256(abi.encode(ACTION_WITNESS_TYPEHASH, w));
    }

    // ---------------------------------------------------------------------
    // Admin (owner only — Ownable2Step; identical to v1)
    // ---------------------------------------------------------------------

    /// @notice Change the fee within [0, MAX_FEE_BPS]. In-flight signed trades
    ///         that committed to the old fee revert with FeeMismatch (never
    ///         overcharge) — the user's committed expectedFeeAmount holds.
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        _setFeeBps(newFeeBps);
    }

    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        _setFeeRecipient(newFeeRecipient);
    }

    function setRouter(address router, RouterKind kind) external onlyOwner {
        _setRouter(router, kind);
    }

    /// @notice Register or replace an immutable typed module for one router.
    ///         The module must declare this executor and the same router, and
    ///         its deployed runtime code hash is pinned for every execution.
    ///         Module additions/replacements therefore do not change this
    ///         executor address, but are privileged governance actions.
    function setRouterModule(address router, address module) external onlyOwner {
        _setRouterModule(router, module);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        _setToken(token, allowed);
    }

    /// @notice Pausing blocks NEW delegated swaps. There are no user funds
    ///         held here between trades, so pausing traps nothing.
    function pause() external onlyOwner {
        _pause();
    }

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

    /// @notice Disabled — an immutable executor is part of the security model.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @dev Only WETH may send ETH (during unwrap). Anything else reverts.
    receive() external payable {
        if (msg.sender != address(WETH)) revert UnexpectedNativeSender(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Internal — trade lifecycle (v1 spec-of-record; owner replaces msg.sender)
    // ---------------------------------------------------------------------

    // slither-disable-start reentrancy-balance
    // Justification (mirrors v1): `inBalanceBefore` is read before the pull ON
    // PURPOSE — the before/after delta is how fee-on-transfer/rebasing sell
    // tokens are rejected. Permit2 performs the transfer inside its own call,
    // so the read cannot move later. Every entry point is `nonReentrant`, and
    // both the sell token and Permit2 are allowlisted/immutable.
    function _begin(SwapParams calldata p, RouterKind kind, Permit2Authorization calldata auth)
        private
        returns (Trade memory t)
    {
        address taker = auth.witness.owner;
        _validate(p, kind, auth);
        t.kind = kind;

        // Exact fee — floor(G * feeBps / 10_000). Committed by the caller and
        // bound by the user's signature (gross is signed exactly).
        t.fee = (p.grossAmountIn * feeBps) / BPS_DENOMINATOR;
        if (t.fee != p.expectedFeeAmount) revert FeeMismatch(p.expectedFeeAmount, t.fee);
        if (feeBps != 0 && t.fee == 0) revert FeeRoundsToZero(p.grossAmountIn);
        t.swapAmount = p.grossAmountIn - t.fee;

        IERC20 tokenIn = IERC20(p.tokenIn);
        t.inBalanceBefore = tokenIn.balanceOf(address(this));

        _pullFromOwner(p, auth);
        uint256 received = tokenIn.balanceOf(address(this)) - t.inBalanceBefore;
        // Rejects fee-on-transfer / rebasing sell tokens: exact economics only.
        if (received != p.grossAmountIn) revert UnsupportedTransferAmount(p.grossAmountIn, received);
        if (t.fee != 0) tokenIn.safeTransfer(feeRecipient, t.fee);

        // Built-in routers receive an exact, single-use allowance. Modules
        // instead receive an exact token transfer below and never get a core
        // allowance.
        if (kind != RouterKind.TYPED_SWAP_MODULE) tokenIn.forceApprove(p.router, t.swapAmount);

        // Module output (like WETH awaiting unwrap) first lands in the core so
        // it can measure and forward exactly what the signing owner receives.
        t.outReceiver = (p.unwrapNativeOut || kind == RouterKind.TYPED_SWAP_MODULE) ? address(this) : taker;
        t.outBalanceBefore = IERC20(p.tokenOut).balanceOf(t.outReceiver);
        if (kind == RouterKind.TYPED_SWAP_MODULE) {
            t.recipientOutBalanceBefore = IERC20(p.tokenOut).balanceOf(taker);
        }
    }
    // slither-disable-end reentrancy-balance

    /// @dev Redeems the user's witness permit. Permit2 enforces, in this order:
    ///      deadline not passed -> requestedAmount <= permitted.amount ->
    ///      unordered nonce unused -> EIP-712 signature (domain: Permit2,
    ///      chainId, canonical address; digest binds spender == THIS contract,
    ///      the tokenPermissions, the witness hash, nonce and deadline)
    ///      recovers to `witness.owner` -> then transfers from the owner.
    ///      Every failure reverts the whole transaction atomically (the nonce
    ///      bit flip is rolled back with it).
    function _pullFromOwner(SwapParams calldata p, Permit2Authorization calldata auth) private {
        PERMIT2.permitWitnessTransferFrom(
            auth.permit,
            IPermit2SignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: p.grossAmountIn}),
            auth.witness.owner,
            witnessHashOf(auth.witness),
            WITNESS_TYPE_STRING,
            auth.signature
        );
    }

    function _finish(SwapParams calldata p, Trade memory t, address taker) private returns (uint256) {
        IERC20 tokenIn = IERC20(p.tokenIn);

        // No dangling router allowance.
        if (tokenIn.allowance(address(this), p.router) != 0) {
            tokenIn.forceApprove(p.router, 0);
        }

        // The router must have consumed exactly (G - fee): nothing trapped here.
        uint256 inBalanceAfter = tokenIn.balanceOf(address(this));
        if (inBalanceAfter != t.inBalanceBefore) revert InputNotFullyConsumed(t.inBalanceBefore, inBalanceAfter);

        // Output measured by balance delta, never trusted from a router or
        // module. For modules, measure the second transfer too: minOut means
        // the actual amount received by the signed owner, including any
        // output-token transfer tax.
        if (t.kind == RouterKind.TYPED_SWAP_MODULE) {
            uint256 outputAtExecutor = IERC20(p.tokenOut).balanceOf(address(this)) - t.outBalanceBefore;
            if (p.unwrapNativeOut) {
                t.amountOut = outputAtExecutor;
            } else {
                if (outputAtExecutor != 0) IERC20(p.tokenOut).safeTransfer(taker, outputAtExecutor);
                t.amountOut = IERC20(p.tokenOut).balanceOf(taker) - t.recipientOutBalanceBefore;
            }
        } else {
            t.amountOut = IERC20(p.tokenOut).balanceOf(t.outReceiver) - t.outBalanceBefore;
        }
        if (t.amountOut < p.amountOutMinimum) revert InsufficientOutput(t.amountOut, p.amountOutMinimum);

        if (p.unwrapNativeOut) {
            WETH.withdraw(t.amountOut);
            _sendNative(taker, t.amountOut);
        }

        _emitSwapExecuted(p, t, taker);
        return t.amountOut;
    }

    function _emitSwapExecuted(SwapParams calldata p, Trade memory t, address taker) private {
        uint8 flags = p.unwrapNativeOut ? FLAG_NATIVE_OUT : 0;
        emit SwapExecuted(
            taker,
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

    function _validate(SwapParams calldata p, RouterKind kind, Permit2Authorization calldata auth) private view {
        address taker = auth.witness.owner;
        if (taker == address(0)) revert InvalidWitness();
        if (routerKind[p.router] != kind) revert RouterNotAllowed(p.router, kind);
        if (kind == RouterKind.TYPED_SWAP_MODULE) {
            address module = swapModuleForRouter[p.router];
            bytes32 pinnedCodeHash = swapModuleCodeHash[p.router];
            if (
                module == address(0) || module.code.length == 0 || pinnedCodeHash == bytes32(0)
                    || module.codehash != pinnedCodeHash || routerForSwapModule[module] != p.router
            ) revert SwapModuleNotAllowed(p.router);
            if (
                IMPGRExecutorSwapModule(module).executor() != address(this)
                    || IMPGRExecutorSwapModule(module).router() != p.router
            ) revert SwapModuleNotAllowed(p.router);
        }
        if (!isTokenAllowed[p.tokenIn]) revert TokenNotAllowed(p.tokenIn);
        if (!isTokenAllowed[p.tokenOut]) revert TokenNotAllowed(p.tokenOut);
        if (p.tokenIn == p.tokenOut) revert SameToken();
        if (p.grossAmountIn == 0) revert ZeroAmount();
        if (p.amountOutMinimum == 0) revert ZeroMinimumOutput();
        if (p.deadline < block.timestamp) revert DeadlineExpired(p.deadline, block.timestamp);
        // Triple deadline equality: permit == swap params == witness.
        if (auth.permit.deadline != p.deadline || auth.witness.deadline != p.deadline) revert InvalidWitness();
        // The output recipient is the signing owner — no redirection, ever.
        if (p.recipient != taker) revert InvalidRecipient(p.recipient, taker);
        if (taker == feeRecipient) revert OwnerIsFeeRecipient(taker);
        // Exact witness bindings: what the user signed is what executes.
        if (p.tokenIn != auth.permit.permitted.token) revert InvalidWitness();
        if (p.grossAmountIn != auth.permit.permitted.amount) revert InvalidWitness();
        if (p.tokenOut != auth.witness.buyToken) revert InvalidWitness();
        if (p.amountOutMinimum != auth.witness.minAmountOut) revert InvalidWitness();
        if (p.intentId != auth.witness.actionId) revert InvalidWitness();
        if (p.unwrapNativeOut && p.tokenOut != address(WETH)) revert UnwrapRequiresWethOut();
    }

    // slither-disable-start arbitrary-send-eth
    // Justification (mirrors v1): `to` is never caller-chosen. Call sites pass
    // only (a) `feeRecipient` (owner-set, validated), (b) the signing owner
    // (the output recipient is enforced == witness.owner in _validate), or
    // (c) an owner-only rescue target. Reentrancy is blocked by nonReentrant.
    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }
    // slither-disable-end arbitrary-send-eth

    // ---------------------------------------------------------------------
    // Internal — admin (identical to v1)
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
        if (router == address(this) || routerForSwapModule[router] != address(0)) {
            revert ConflictingAllowlist(router);
        }
        if (kind == RouterKind.TYPED_SWAP_MODULE) revert SwapModuleNotAllowed(router);
        if (kind != RouterKind.NONE) {
            if (router.code.length == 0) revert NotAContract(router);
            // A token can never double as a router (and vice versa).
            if (isTokenAllowed[router]) revert ConflictingAllowlist(router);
        }

        RouterKind previousKind = routerKind[router];
        address previousModule = swapModuleForRouter[router];
        if (previousModule != address(0)) {
            delete swapModuleForRouter[router];
            delete swapModuleCodeHash[router];
            delete routerForSwapModule[previousModule];
            emit SwapModuleUpdated(router, previousModule, address(0), bytes32(0));
        }
        emit RouterUpdated(router, previousKind, kind);
        routerKind[router] = kind;
    }

    function _setRouterModule(address router, address module) private {
        if (router == address(0) || module == address(0)) revert ZeroAddress();
        if (router == address(this) || module == address(this) || router == module) {
            revert ConflictingAllowlist(module);
        }
        if (router.code.length == 0) revert NotAContract(router);
        if (module.code.length == 0) revert NotAContract(module);
        if (
            isTokenAllowed[router] || isTokenAllowed[module] || routerKind[module] != RouterKind.NONE
                || routerForSwapModule[router] != address(0)
        ) revert ConflictingAllowlist(module);

        address boundRouter = routerForSwapModule[module];
        if (boundRouter != address(0) && boundRouter != router) revert ConflictingAllowlist(module);
        if (
            IMPGRExecutorSwapModule(module).executor() != address(this)
                || IMPGRExecutorSwapModule(module).router() != router
        ) revert InvalidSwapModule(module);

        RouterKind previousKind = routerKind[router];
        address previousModule = swapModuleForRouter[router];
        if (previousModule != address(0) && previousModule != module) {
            delete routerForSwapModule[previousModule];
        }
        bytes32 codeHash = module.codehash;
        routerKind[router] = RouterKind.TYPED_SWAP_MODULE;
        swapModuleForRouter[router] = module;
        swapModuleCodeHash[router] = codeHash;
        routerForSwapModule[module] = router;

        emit RouterUpdated(router, previousKind, RouterKind.TYPED_SWAP_MODULE);
        emit SwapModuleUpdated(router, previousModule, module, codeHash);
    }

    function _setToken(address token, bool allowed) private {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(this)) revert ConflictingAllowlist(token);
        if (allowed) {
            if (token.code.length == 0) revert NotAContract(token);
            if (routerKind[token] != RouterKind.NONE || routerForSwapModule[token] != address(0)) {
                revert ConflictingAllowlist(token);
            }
        }
        isTokenAllowed[token] = allowed;
        emit TokenAllowlistUpdated(token, allowed);
    }
}

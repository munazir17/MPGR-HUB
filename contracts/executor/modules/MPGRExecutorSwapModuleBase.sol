// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMPGRExecutorSwapModule} from "../interfaces/IMPGRExecutorSwapModule.sol";

/// @title MPGRExecutorSwapModuleBase
/// @notice Immutable, executor-bound base for typed venue adapters.
/// @dev Concrete modules must implement `_swapExactInput` using only typed
///      calls to their immutable `router`. No proxy, upgrade hook, delegatecall,
///      caller-selected target, or arbitrary calldata surface is provided here.
///      The module is a separate trust boundary and must be reviewed together
///      with its router before the executor owner registers its code hash.
abstract contract MPGRExecutorSwapModuleBase is IMPGRExecutorSwapModule {
    address public immutable override executor;
    address public immutable override router;

    error InvalidEndpoint(address endpoint);
    error UnauthorizedExecutor(address caller);
    error InvalidSwapRequest();
    error InvalidOutputRecipient(address recipient);

    constructor(address executor_, address router_) {
        if (executor_ == address(0) || executor_.code.length == 0) revert InvalidEndpoint(executor_);
        if (router_ == address(0) || router_.code.length == 0) revert InvalidEndpoint(router_);
        if (executor_ == router_) revert InvalidEndpoint(router_);
        executor = executor_;
        router = router_;
    }

    function quoteExactInput(address tokenIn, address tokenOut, uint256 amountIn)
        external
        override
        returns (uint256 amountOut)
    {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut || amountIn == 0) {
            revert InvalidSwapRequest();
        }
        return _quoteExactInput(tokenIn, tokenOut, amountIn);
    }

    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline,
        address recipient
    ) external override returns (uint256 amountOut) {
        if (msg.sender != executor) revert UnauthorizedExecutor(msg.sender);
        if (recipient != executor) revert InvalidOutputRecipient(recipient);
        if (
            tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut || amountIn == 0
                || amountOutMinimum == 0 || deadline < block.timestamp
        ) revert InvalidSwapRequest();

        return _swapExactInput(tokenIn, tokenOut, amountIn, amountOutMinimum, deadline);
    }

    /// @dev Venue-specific simulation. It must quote only the module's
    ///      immutable router's route; the output is advisory, while the user-
    ///      signed minOut is enforced by the executor after settlement.
    function _quoteExactInput(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        virtual
        returns (uint256 amountOut);

    /// @dev Venue-specific implementation; it must use the immutable `router`
    ///      and send `tokenOut` to `executor`. The core verifies delivery by
    ///      balance delta and sends the measured output to the signed owner.
    function _swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) internal virtual returns (uint256 amountOut);
}

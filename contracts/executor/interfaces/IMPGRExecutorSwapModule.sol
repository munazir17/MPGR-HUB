// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Fixed ABI for an executor-approved venue adapter. Implementations
///         are deployed per executor/router pair and must be immutable,
///         reviewed code. This is intentionally NOT a generic call interface:
///         callers cannot choose a target or provide arbitrary router calldata.
interface IMPGRExecutorSwapModule {
    /// @notice The one delegated executor this module is allowed to serve.
    function executor() external view returns (address);

    /// @notice The one router this module is configured for.
    function router() external view returns (address);

    /// @notice Simulate a venue quote for an exact input. Modules may call a
    ///         venue-specific quoter through this fixed interface; callers
    ///         invoke it with eth_call and never grant it token authority.
    function quoteExactInput(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut);

    /// @notice Execute the module's typed exact-input route. The executor
    ///         transfers exactly `amountIn` to the module before calling this
    ///         method, and requires output to be sent back to itself.
    /// @dev The executor does not trust this function's return value; it
    ///      measures output balances and enforces the signed minimum itself.
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline,
        address recipient
    ) external returns (uint256 amountOut);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice REVIEW ONLY. Standard V2 Router02 token-to-token interface, not a
/// V3 shim or generic calldata adapter. No production ABI imports this file.
/// @dev Uniswap/v2-periphery ed24991304291297c3b4a52818d02f46a17aa9a2,
/// contracts/interfaces/IUniswapV2Router01.sol. Native assets are wrapped or
/// unwrapped by the outer draft lifecycle, never by a second user transaction.
interface IMPGRSwapV2RouterDraft {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

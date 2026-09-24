// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal WETH9 surface used by the MPGR Executor (wrap native ETH
///         input / unwrap native ETH output). Base + Base Sepolia WETH is the
///         OP-stack predeploy at 0x4200000000000000000000000000000000000006.
interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice Aerodrome Slipstream (Velodrome CL) SwapRouter — the exact 8-field
///         `exactInputSingle` struct (selector 0xa026383e) the app already
///         builds in lib/trade/aerodrome-slipstream.ts. Pools are keyed by
///         `tickSpacing`, not by a fee tier.
interface ISlipstreamSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Uniswap V3 SwapRouter02 (IV3SwapRouter) — the 7-field
///         `exactInputSingle` struct (selector 0x04e45aaf). No deadline field:
///         the MPGR Executor enforces the deadline itself.
interface IUniswapV3SwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Canonical Uniswap Permit2 SignatureTransfer subset
///         (0x000000000022D473030F116dDEE9F6B43aC78BA3 on Base and Base Sepolia).
interface IPermit2SignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

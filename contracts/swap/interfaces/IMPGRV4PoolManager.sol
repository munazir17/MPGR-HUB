// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev ABI-compatible subset of Uniswap v4-core IPoolManager. Currency is an address,
/// hooks an address, and BalanceDelta an int256 in the external ABI.
interface IMPGRV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

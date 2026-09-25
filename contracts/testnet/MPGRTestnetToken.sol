// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MPGRTestnetToken
/// @notice TESTNET-ONLY fixed-supply ERC-20 with EIP-2612 permit, used to seed
///         real Uniswap V3 pools on Base Sepolia so the MPGR Executor can be
///         exercised end-to-end (approval, EIP-2612, Permit2, native ETH).
///         Refuses to deploy on Base mainnet (chainId 8453). No mint function:
///         the whole supply is minted once, to `holder`, at construction.
contract MPGRTestnetToken is ERC20Permit {
    error TestnetOnly();

    uint8 private immutable _tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address holder, uint256 supply)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        if (block.chainid == 8453) revert TestnetOnly();
        _tokenDecimals = decimals_;
        _mint(holder, supply);
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }
}

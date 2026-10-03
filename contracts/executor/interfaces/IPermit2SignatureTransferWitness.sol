// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPermit2SignatureTransfer} from "./IMPGRExecutorRouters.sol";

/// @title IPermit2SignatureTransferWitness
/// @notice The WITNESS variant of Permit2's SignatureTransfer, matching the
///         DEPLOYED canonical Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3,
///         immutable, source-tagged in Uniswap/permit2 at the deployment commit)
///         exactly. Additive to IPermit2SignatureTransfer — nothing there changes.
///
///         Hashing convention of the deployed contract (PermitHash.hashWithWitness):
///           typeHash  = keccak256(abi.encodePacked(
///                         "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
///                         witnessTypeString))
///           tpHash    = keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), permitted))
///           structHash= keccak256(abi.encode(typeHash, tpHash, msg.sender, permit.nonce, permit.deadline, witness))
///           digest    = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash))
///         where `witness` is the 32-byte struct hash of the caller's witness type
///         and `witnessTypeString` is that struct's type string WITHOUT a name
///         reference in the parent type. DOMAIN_SEPARATOR =
///         keccak256(abi.encode(keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
///                              keccak256("Permit2"), block.chainid, address(this))).
interface IPermit2SignatureTransferWitness {
    /// @dev Permit2 enforces: spender == msg.sender (bound in the digest),
    ///      deadline not passed, requestedAmount <= permitted.amount, nonce
    ///      unused (unordered bitmap), signature recovers to `owner`.
    function permitWitnessTransferFrom(
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        IPermit2SignatureTransfer.SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;

    /// @notice Revocation: sets `mask` bits in the caller's nonce bitmap at
    ///         `wordPos` — every permit whose nonce maps to a set bit can no
    ///         longer be redeemed (InvalidNonce).
    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external;

    /// @notice The unordered-nonce bitmap: (word, bit) = (nonce >> 8, nonce & 0xff).
    function nonceBitmap(address owner, uint256 wordPos) external view returns (uint256);
}

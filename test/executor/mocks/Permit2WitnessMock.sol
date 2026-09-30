// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IPermit2SignatureTransfer} from "../../../contracts/executor/interfaces/IMPGRExecutorRouters.sol";

/// @title Permit2WitnessMock — TEST ONLY, NEVER DEPLOYED.
/// @notice A faithful local replica of the DEPLOYED canonical Permit2
///         (0x000000000022D473030F116dDEE9F6B43aC78BA3) SignatureTransfer
///         witness semantics, copied from the deployment-commit source
///         (Uniswap/permit2 tag `0x000000000022D473030F116dDEE9F6B43aC78BA3`,
///         commit cc306b6): EIP-712 domain ("Permit2", chainId, this address),
///         the witness-typehash-stub convention, the unordered nonce bitmap
///         (word = nonce >> 8, bit = nonce & 0xff, flipped BEFORE signature
///         verification — a later revert rolls the flip back atomically),
///         deadline/amount checks, and the plain `permitTransferFrom` variant
///         used by MPGRExecutor v1 (so equivalence tests run both executors
///         against Permit2-style pulls). The only differences from the real
///         Permit2: `require` messages instead of custom errors, and it does
///         not implement AllowanceTransfer. Solana-grade fidelity is not
///         required; digest/recovery/nonce semantics are exact.
contract Permit2WitnessMock {
    using ECDSA for bytes32;

    // ---- Canonical constants (deployed Permit2 / PermitHash library) ----

    bytes32 public constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 public constant _NAME_HASH = keccak256("Permit2");
    bytes32 public constant _TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 public constant _PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    string public constant _PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    /// @notice Cached at construction, exactly like the deployed EIP712 base.
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address owner => mapping(uint256 word => uint256 bits)) public nonceBitmap;

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, block.chainid, address(this)));
    }

    // ---- Witness digest helpers (mirror PermitHash.hashWithWitness exactly) ----

    function hashWithWitness(
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        bytes32 witness,
        string calldata witnessTypeString
    ) public view returns (bytes32) {
        bytes32 typeHash = keccak256(abi.encodePacked(_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB, witnessTypeString));
        bytes32 tokenPermissionsHash = keccak256(abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        return keccak256(abi.encode(typeHash, tokenPermissionsHash, msg.sender, permit.nonce, permit.deadline, witness));
    }

    /// @notice The EIP-712 digest a USER wallet signs (spender = recipient executor).
    function witnessDigest(
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        address spender,
        bytes32 witness,
        string calldata witnessTypeString
    ) external view returns (bytes32) {
        // Temporarily impersonate nothing: the digest must be computed from the
        // SPENDER's perspective, so this helper re-derives it without msg.sender.
        bytes32 typeHash = keccak256(abi.encodePacked(_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB, witnessTypeString));
        bytes32 tokenPermissionsHash = keccak256(abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        bytes32 structHash = keccak256(abi.encode(typeHash, tokenPermissionsHash, spender, permit.nonce, permit.deadline, witness));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice The EIP-712 digest for v1's plain permitTransferFrom
    ///         (PermitHash.hash → spender = msg.sender; explicit spender param
    ///         here for the same reason as witnessDigest).
    function transferFromDigest(
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        address spender
    ) external view returns (bytes32) {
        bytes32 tokenPermissionsHash = keccak256(abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        bytes32 structHash =
            keccak256(abi.encode(_PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissionsHash, spender, permit.nonce, permit.deadline));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // ---- Redeemable entry points (deployed execution order, verbatim) ----

    function permitWitnessTransferFrom(
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        IPermit2SignatureTransfer.SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external {
        require(block.timestamp <= permit.deadline, "SignatureExpired");
        require(transferDetails.requestedAmount <= permit.permitted.amount, "InvalidAmount");

        _useUnorderedNonce(owner, permit.nonce);

        bytes32 structHash = hashWithWitness(permit, witness, witnessTypeString);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(ECDSA.recover(digest, signature) == owner, "InvalidSigner");

        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }

    function permitTransferFrom(
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        IPermit2SignatureTransfer.SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external {
        require(block.timestamp <= permit.deadline, "SignatureExpired");
        require(transferDetails.requestedAmount <= permit.permitted.amount, "InvalidAmount");

        _useUnorderedNonce(owner, permit.nonce);

        bytes32 tokenPermissionsHash = keccak256(abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        bytes32 structHash =
            keccak256(abi.encode(_PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissionsHash, msg.sender, permit.nonce, permit.deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(ECDSA.recover(digest, signature) == owner, "InvalidSigner");

        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }

    /// @notice User-side revocation, identical to the deployed contract.
    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external {
        nonceBitmap[msg.sender][wordPos] |= mask;
    }

    /// @dev word = nonce >> 8, bit = nonce & 0xff; flips the bit and rejects an
    ///      already-set bit — identical to the deployed _useUnorderedNonce.
    function _useUnorderedNonce(address from, uint256 nonce) private {
        uint256 wordPos = uint248(nonce >> 8);
        uint256 bitPos = uint8(nonce);
        uint256 bit = 1 << bitPos;
        uint256 flipped = nonceBitmap[from][wordPos] ^= bit;
        require(flipped & bit != 0, "InvalidNonce");
    }
}

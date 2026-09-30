// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// TEMPORARY diagnostic (remove after deployment debugging): decomposes the
// Permit2 witness digest into its parts and compares the script-formula
// domain against the deployed Permit2's cached DOMAIN_SEPARATOR.
import {Script, console2} from "forge-std/Script.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

contract DeployDiagDelegated is Script {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    string constant WITNESS_TYPE_STRING =
        "ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)";
    bytes32 constant WITNESS_TYPEHASH =
        keccak256(bytes("ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)"));
    bytes32 constant PERMIT2_WITNESS_STUB =
        keccak256(bytes("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,"));
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    function run() external {
        console2.log("chainid:", block.chainid);

        bytes32 domainOnChain = IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR();
        bytes32 domainScript = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                PERMIT2
            )
        );
        console2.log("DOMAIN_ONCHAIN:", domainOnChain);
        console2.log("DOMAIN_SCRIPT: ", domainScript);
        console2.log("DOMAIN_MATCH:", domainOnChain == domainScript);

        // Synthetics so every sub-hash can be recomputed and compared locally.
        address executor = address(uint160(0x8C6311));
        address token = address(uint160(0x602CE7));
        uint256 amount = 1e10;
        uint256 nonce = 1;
        uint256 deadline = 1790775644;
        address owner = address(uint160(0xb67FCd));
        address buyToken = address(uint160(0xB0B));
        uint256 minOut = 777;
        bytes32 actionId = keccak256("diag-action");
        bytes32 policyHash = keccak256("diag-policy");

        bytes32 witnessHash = keccak256(
            abi.encode(
                WITNESS_TYPEHASH,
                owner, buyToken, minOut, deadline, actionId, policyHash
            )
        );
        console2.log("WITNESS_HASH:", witnessHash);

        bytes32 typeHash = keccak256(abi.encodePacked(PERMIT2_WITNESS_STUB, WITNESS_TYPE_STRING));
        console2.log("TYPEHASH_STUB_PLUS_WITNESS:", typeHash);

        bytes32 tpHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount));
        console2.log("TP_HASH:", tpHash);

        bytes32 structHash = keccak256(abi.encode(typeHash, tpHash, executor, nonce, deadline, witnessHash));
        console2.log("STRUCT_HASH:", structHash);

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainScript, structHash));
        console2.log("DIGEST_SCRIPT:", digest);
    }
}

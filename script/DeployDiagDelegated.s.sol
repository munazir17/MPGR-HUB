// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// TEMPORARY diagnostic (remove after deployment debugging): mirrors the
// deploy script's _signPermit digest computation step by step and compares
// against the deployed Permit2's cached DOMAIN_SEPARATOR. Sim only.
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
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    function run() external {
        // Mirror of the deploy script's synthetic-values decomposition.
        address executor = address(uint160(0x8C6311));
        address token = address(uint160(0x602CE7));
        address buyToken = address(uint160(0xB0B));
        address owner_ = address(uint160(0xb67FCd));
        uint256 amount = 1e10;
        uint256 nonce = 1;
        uint256 deadline = 1790775644;
        uint256 minOut = 777;
        bytes32 actionId = keccak256("diag-action");
        bytes32 policyHash = keccak256("diag-policy");

        // --- exactly as _signPermit does ---
        bytes32 witnessHash = keccak256(abi.encode(WITNESS_TYPEHASH, owner_, buyToken, minOut, deadline, actionId, policyHash));
        bytes32 typeHash = keccak256(abi.encodePacked(PERMIT2_WITNESS_STUB, WITNESS_TYPE_STRING));
        bytes32 tpHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount));
        bytes32 structHash = keccak256(abi.encode(typeHash, tpHash, executor, nonce, deadline, witnessHash));
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, PERMIT2));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));

        console2.log("WITNESS_HASH:", witnessHash);
        console2.log("TYPEHASH:", typeHash);
        console2.log("TP_HASH:", tpHash);
        console2.log("STRUCT_HASH:", structHash);
        console2.log("DOMAIN_SCRIPT:", domain);
        console2.log("DIGEST_SCRIPT:", digest);
        console2.log("chainid:", block.chainid);

        bytes32 domainOnChain = IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR();
        console2.log("DOMAIN_ONCHAIN:", domainOnChain);
        console2.log("DOMAIN_MATCH:", domainOnChain == domain);
        console2.log("STUB_KECCAK:", PERMIT2_WITNESS_STUB);
        console2.log("WITNESS_TYPEHASH_KECCAK:", WITNESS_TYPEHASH);
    }
}

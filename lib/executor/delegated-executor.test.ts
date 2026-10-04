// delegated-executor digest regression tests.
// Guards against the toHex() UTF-8 packing bug: viem's toHex() encodes a
// string's CHARACTERS — a hex string passed through it is hashed as text.
// The digest here must be byte-for-byte what an independent viem encoding
// path (encodeAbiParameters + concatHex) produces for the deployed
// contract's witness scheme.
import { describe, expect, it } from "vitest";
import { concatHex, encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";

import {
  CANONICAL_PERMIT2,
  DELEGATED_ACTION_WITNESS_STRUCT_TYPE_STRING,
  DELEGATED_EXECUTOR_ADDRESS,
  DELEGATED_WITNESS_TYPEHASH,
  DELEGATED_WITNESS_TYPE_STRING,
  PERMIT2_WITNESS_TYPEHASH,
  TOKEN_PERMISSIONS_TYPEHASH,
  delegatedPermit2Domain,
  delegatedPermitDigest,
  delegatedWitnessHash,
} from "./delegated-executor";

const SELL = "0xcccccccccccccccccccccccccccccccccccccc03" as Address;
const BUY = "0xdddddddddddddddddddddddddddddddddddddd04" as Address;
const SPENDER = DELEGATED_EXECUTOR_ADDRESS;
const deadline = 4_100_000_000;
const permit = { token: SELL, amount: "1000000000", nonce: "12345", deadline };
const witness = {
  owner: ("0xe57e649e59fbed533f165ea135261236c39c2797") as Address,
  buyToken: BUY,
  minAmountOut: "900000000",
  deadline,
  actionId: ("0x" + "11".repeat(32)) as Hex,
  policyHash: ("0x" + "22".repeat(32)) as Hex,
};

/** Fully independent EIP-712 packing (encodeAbiParameters + concatHex only). */
function independentDigest(): Hex {
  const domainTypeHash = keccak256(toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [domainTypeHash, keccak256(toHex("Permit2")), 84532n, CANONICAL_PERMIT2],
    ),
  );
  const typeHash = keccak256(
    toHex(
      "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline," +
        DELEGATED_WITNESS_TYPE_STRING,
    ),
  );
  const tokenPermissionsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [TOKEN_PERMISSIONS_TYPEHASH, permit.token, BigInt(permit.amount)],
    ),
  );
  const witnessHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
      [keccak256(toHex(DELEGATED_ACTION_WITNESS_STRUCT_TYPE_STRING)), witness.owner, witness.buyToken, BigInt(witness.minAmountOut), BigInt(witness.deadline), witness.actionId, witness.policyHash],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [typeHash, tokenPermissionsHash, SPENDER, BigInt(permit.nonce), BigInt(permit.deadline), witnessHash],
    ),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

describe("delegated-executor digest packing", () => {
  it("delegatedPermitDigest equals the independent concatHex packing (no toHex-UTF-8 regression)", () => {
    const viaLibrary = delegatedPermitDigest({ permit, witness }, 84532, SPENDER);
    const viaIndependent = independentDigest();
    expect(viaLibrary).toBe(viaIndependent);
  });

  it("domain separator equals the independent packing", () => {
    const domainTypeHash = keccak256(toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [domainTypeHash, keccak256(toHex("Permit2")), 84532n, CANONICAL_PERMIT2],
      ),
    );
    expect(delegatedPermit2Domain(84532)).toBe(expected);
  });

  it("witness hash uses the deployed witness type string", () => {
    expect(delegatedWitnessHash(witness)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
          [keccak256(toHex(DELEGATED_ACTION_WITNESS_STRUCT_TYPE_STRING)), witness.owner, witness.buyToken, BigInt(witness.minAmountOut), BigInt(witness.deadline), witness.actionId, witness.policyHash],
        ),
      ),
    );
    expect(PERMIT2_WITNESS_TYPEHASH).toBe(
      keccak256(toHex("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline," + DELEGATED_WITNESS_TYPE_STRING)),
    );
  });
});

// STANDARD-WALLET COMPATIBILITY PROOF for the redeployed delegated executor's
// witness type string (lib/executor/delegated-executor.ts mirrors the on-chain
// constant). Lives in the autonomy test domain because the lib/executor
// non-custodial boundary scanner forbids wallet-signing imports there — these
// are TEST-ONLY keys and TEST-ONLY signatures proving digest equivalence.
import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  DELEGATED_EXECUTOR_ADDRESS,
  DELEGATED_WITNESS_TYPEHASH,
  delegatedPermitDigest,
  delegatedPermitTypedData,
} from "@/lib/executor/delegated-executor";

// Proves, with an INDEPENDENT encoding path (viem's hashTypedData — the same
// algorithm eth_signTypedData_v4 wallets run), that the corrected witness
// type string makes the deployed commitment exactly what a wallet signs:
//   * wallet-style typed-data digest == deployed-contract digest recipe
//   * a wallet typed-data signature == raw-digest signature (same bytes)
import { DELEGATED_ACTION_WITNESS_STRUCT_TYPE_STRING } from "@/lib/executor/delegated-executor";

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
const TEST_KEY = ("0x" + "cd".repeat(32)) as `0x${string}`;

describe("wallet-compatible witness type string (standard EIP-712)", () => {
  const typed = delegatedPermitTypedData({ permit, witness }, 84532, SPENDER);
  // The standard-wallet view: the same typed data, generically typed (exactly
  // what wallets receive over eth_signTypedData_v4).
  const walletTyped = typed as unknown as {
    domain: { name: string; chainId: number; verifyingContract: `0x${string}` };
    primaryType: string;
    types: Record<string, Array<{ name: string; type: string }>>;
    message: Record<string, unknown>;
  };

  it("viem hashTypedData (wallet algorithm) equals the deployed digest recipe", () => {
    const viaWallet = hashTypedData({
      domain: walletTyped.domain,
      types: walletTyped.types,
      primaryType: walletTyped.primaryType,
      message: walletTyped.message,
    });
    const viaRecipe = delegatedPermitDigest({ permit, witness }, 84532, SPENDER);
    expect(viaWallet).toBe(viaRecipe);
  });

  it("a wallet typed-data signature is byte-identical to the raw-digest signature the flow stores", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    const viaWallet = await account.signTypedData({
      domain: walletTyped.domain,
      types: walletTyped.types,
      primaryType: walletTyped.primaryType,
      message: walletTyped.message,
    });
    const viaDigest = await account.sign({ hash: delegatedPermitDigest({ permit, witness }, 84532, SPENDER) });
    expect(viaWallet).toBe(viaDigest);
  });

  it("witness struct hash keeps the ORIGINAL value (bindings unchanged by the repack)", () => {
    // The ActionWitness struct hash is seeded by the struct's OWN type string,
    // which is byte-identical to the pre-redeployment one — only the Permit2
    // handoff representation changed.
    expect(DELEGATED_WITNESS_TYPEHASH).toBe(keccak256(toHex("ActionWitness(address owner,address buyToken,uint256 minAmountOut,uint256 deadline,bytes32 actionId,bytes32 policyHash)")));
  });
});

import { describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, type Address, type Hex } from "viem";
import { isEoaWalletSignature, normalizeWalletSignature, walletOwnsSignature } from "../wallet-signature";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const DIGEST = `0x${"ab".repeat(32)}` as Hex;

describe("wallet signatures", () => {
  it("accepts a 65-byte signature and a longer smart-wallet signature", () => {
    const eoa = `0x${"11".repeat(65)}` as Hex;
    expect(normalizeWalletSignature(eoa)).toBe(eoa);
    expect(isEoaWalletSignature(eoa)).toBe(true);
    const smart = `0x${"22".repeat(80)}` as Hex;
    expect(normalizeWalletSignature(smart)).toBe(smart);
    expect(isEoaWalletSignature(smart)).toBe(false);
    expect(normalizeWalletSignature("0x1234")).toBeNull();
    expect(normalizeWalletSignature(1)).toBeNull();
  });

  it("verifies a contract wallet with the ERC-1271 magic value", async () => {
    const signature = `0x${"33".repeat(80)}` as Hex;
    const data = encodeFunctionResult({
      abi: [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "magic", type: "bytes4" }] }],
      functionName: "isValidSignature",
      result: "0x1626ba7e",
    });
    const client = { call: vi.fn().mockResolvedValue({ data }) };
    await expect(walletOwnsSignature(DIGEST, signature, WALLET, client)).resolves.toBe(true);
    expect(client.call).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from "vitest";

import { appendPermit2Signature, stripEip712Domain } from "../trade-permit2";

describe("stripEip712Domain", () => {
  it("removes EIP712Domain so viem will accept the remaining types", () => {
    const types = {
      EIP712Domain: [{ name: "name", type: "string" }],
      PermitTransferFrom: [{ name: "spender", type: "address" }],
    };
    expect(stripEip712Domain(types)).toEqual({
      PermitTransferFrom: [{ name: "spender", type: "address" }],
    });
  });
});

describe("appendPermit2Signature", () => {
  it("concatenates 32-byte length prefix + signature onto calldata", () => {
    const data = "0xabcd" as const;
    const signature = ("0x" + "11".repeat(65)) as `0x${string}`;
    const combined = appendPermit2Signature(data, signature);
    expect(combined.startsWith("0xabcd")).toBe(true);
    expect(combined.length).toBeGreaterThan(data.length + 64);
  });
});

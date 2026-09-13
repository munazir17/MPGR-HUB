import { describe, expect, it, vi } from "vitest";

const getEnsAddress = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ getEnsAddress }),
  };
});

const { isLikelyBasename, resolveRecipient } = await import("../transfer-basename");

const VALID_ADDRESS = "0x2222222222222222222222222222222222222222";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("isLikelyBasename", () => {
  it("recognizes a .base.eth suffix", () => {
    expect(isLikelyBasename("jesse.base.eth")).toBe(true);
    expect(isLikelyBasename("JESSE.BASE.ETH")).toBe(true);
  });

  it("rejects everything else, including a bare .base.eth with no label", () => {
    expect(isLikelyBasename(".base.eth")).toBe(false);
    expect(isLikelyBasename("jesse.eth")).toBe(false);
    expect(isLikelyBasename(VALID_ADDRESS)).toBe(false);
  });
});

describe("resolveRecipient", () => {
  it("accepts a raw 0x address without any network call", async () => {
    const result = await resolveRecipient(VALID_ADDRESS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputKind).toBe("address");
      expect(result.address.toLowerCase()).toBe(VALID_ADDRESS.toLowerCase());
      expect(result.basename).toBeNull();
    }
    expect(getEnsAddress).not.toHaveBeenCalled();
  });

  it("refuses the zero address", async () => {
    const result = await resolveRecipient(ZERO_ADDRESS);
    expect(result.ok).toBe(false);
  });

  it("rejects a string that is neither an address nor a Basename, without guessing", async () => {
    const result = await resolveRecipient("alice");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not a valid Base address/i);
  });

  it("rejects empty/non-string input", async () => {
    expect((await resolveRecipient("")).ok).toBe(false);
    expect((await resolveRecipient(undefined)).ok).toBe(false);
    expect((await resolveRecipient(42)).ok).toBe(false);
  });

  it("resolves a Basename via the mainnet ENS client (CCIP-Read)", async () => {
    getEnsAddress.mockResolvedValueOnce(VALID_ADDRESS);
    const result = await resolveRecipient("jesse.base.eth");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputKind).toBe("basename");
      expect(result.address.toLowerCase()).toBe(VALID_ADDRESS.toLowerCase());
      expect(result.basename).toBe("jesse.base.eth");
    }
  });

  it("fails closed when a Basename does not resolve", async () => {
    getEnsAddress.mockResolvedValueOnce(null);
    const result = await resolveRecipient("doesnotexist.base.eth");
    expect(result.ok).toBe(false);
  });

  it("fails closed when a Basename resolves to the zero address", async () => {
    getEnsAddress.mockResolvedValueOnce(ZERO_ADDRESS);
    const result = await resolveRecipient("weird.base.eth");
    expect(result.ok).toBe(false);
  });

  it("fails closed when ENS resolution throws", async () => {
    getEnsAddress.mockRejectedValueOnce(new Error("network down"));
    const result = await resolveRecipient("jesse.base.eth");
    expect(result.ok).toBe(false);
  });
});

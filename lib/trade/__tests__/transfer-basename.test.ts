import { describe, expect, it, vi } from "vitest";

const getEnsAddress = vi.fn();
const readContract = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ getEnsAddress }),
  };
});

vi.mock("../trade-public-client", () => ({
  getTradePublicClient: () => ({ readContract }),
}));

const { isLikelyBasename, resolveRecipient } = await import("../transfer-basename");

const VALID_ADDRESS = "0x2222222222222222222222222222222222222222";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const JESSE_ADDRESS = "0x2211d1D0020DAEA8039E46Cf1367962070d77DA9";

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
    expect(readContract).not.toHaveBeenCalled();
  });

  it("accepts a bare 40-char hex address missing the 0x prefix", async () => {
    const result = await resolveRecipient(VALID_ADDRESS.slice(2));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.toLowerCase()).toBe(VALID_ADDRESS.toLowerCase());
      expect(result.inputKind).toBe("address");
    }
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

  it("resolves a Basename via the Base L2 resolver first", async () => {
    readContract.mockResolvedValueOnce(JESSE_ADDRESS);
    const result = await resolveRecipient("jesse.base.eth");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inputKind).toBe("basename");
      expect(result.address.toLowerCase()).toBe(JESSE_ADDRESS.toLowerCase());
      expect(result.basename).toBe("jesse.base.eth");
    }
    expect(getEnsAddress).not.toHaveBeenCalled();
  });

  it("falls back to mainnet ENS when the Base L2 resolver misses", async () => {
    readContract.mockResolvedValueOnce(ZERO_ADDRESS);
    getEnsAddress.mockResolvedValueOnce(VALID_ADDRESS);
    const result = await resolveRecipient("jesse.base.eth");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.toLowerCase()).toBe(VALID_ADDRESS.toLowerCase());
    }
  });

  it("fails closed when a Basename does not resolve on either path", async () => {
    readContract.mockResolvedValueOnce(null);
    getEnsAddress.mockResolvedValueOnce(null);
    const result = await resolveRecipient("doesnotexist.base.eth");
    expect(result.ok).toBe(false);
  });

  it("fails closed when a Basename resolves to the zero address everywhere", async () => {
    readContract.mockResolvedValueOnce(ZERO_ADDRESS);
    getEnsAddress.mockResolvedValueOnce(ZERO_ADDRESS);
    const result = await resolveRecipient("weird.base.eth");
    expect(result.ok).toBe(false);
  });

  it("fails closed when both resolvers throw", async () => {
    readContract.mockRejectedValueOnce(new Error("base rpc down"));
    getEnsAddress.mockRejectedValueOnce(new Error("network down"));
    const result = await resolveRecipient("jesse.base.eth");
    expect(result.ok).toBe(false);
  });
});

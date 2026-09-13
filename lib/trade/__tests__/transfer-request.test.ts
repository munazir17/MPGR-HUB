import { describe, expect, it, vi } from "vitest";

vi.mock("../transfer-basename", () => ({
  resolveRecipient: vi.fn(async (input: unknown) => {
    if (input === "jesse.base.eth") {
      return {
        ok: true,
        address: "0x2222222222222222222222222222222222222222",
        inputKind: "basename",
        basename: "jesse.base.eth",
      };
    }
    if (input === "0x2222222222222222222222222222222222222222") {
      return {
        ok: true,
        address: "0x2222222222222222222222222222222222222222",
        inputKind: "address",
        basename: null,
      };
    }
    return { ok: false, message: `Could not resolve "${String(input)}".` };
  }),
}));

const { parseTransferRequest } = await import("../transfer-request");

describe("parseTransferRequest", () => {
  it("accepts a well-formed native ETH transfer to a raw address", async () => {
    const result = await parseTransferRequest({
      token: "ETH",
      amount: "0.01",
      recipient: "0x2222222222222222222222222222222222222222",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.asset.symbol).toBe("ETH");
      expect(result.value.amount).toBe((10n ** 16n).toString());
      expect(result.value.recipient.inputKind).toBe("address");
    }
  });

  it("accepts a Basename recipient", async () => {
    const result = await parseTransferRequest({
      token: "USDC",
      amount: "10",
      recipient: "jesse.base.eth",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipient.inputKind).toBe("basename");
      expect(result.value.recipient.basename).toBe("jesse.base.eth");
      expect(result.value.amount).toBe((10n * 10n ** 6n).toString());
    }
  });

  it("never invents a token contract for an unknown symbol", async () => {
    const result = await parseTransferRequest({
      token: "FAKESHARE",
      amount: "1",
      recipient: "0x2222222222222222222222222222222222222222",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_ASSET");
  });

  it("rejects a request with no recipient rather than defaulting to one", async () => {
    const result = await parseTransferRequest({ token: "ETH", amount: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_RECIPIENT");
  });

  it("propagates a recipient-resolution failure instead of executing anyway", async () => {
    const result = await parseTransferRequest({
      token: "ETH",
      amount: "1",
      recipient: "not-a-real-recipient",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RECIPIENT_UNRESOLVED");
  });

  it("rejects amounts with more precision than the token supports", async () => {
    const result = await parseTransferRequest({
      token: "USDC",
      amount: "1.1234567",
      recipient: "0x2222222222222222222222222222222222222222",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("accepts a pre-converted atomicAmount", async () => {
    const result = await parseTransferRequest({
      token: "USDC",
      atomicAmount: "5000000",
      recipient: "0x2222222222222222222222222222222222222222",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.amount).toBe("5000000");
  });

  it("rejects a non-object body", async () => {
    expect((await parseTransferRequest("send 10 usdc")).ok).toBe(false);
    expect((await parseTransferRequest(null)).ok).toBe(false);
  });

  it("never reads a sender/from field from the body — sender is always the session wallet, supplied separately", async () => {
    const result = await parseTransferRequest({
      token: "ETH",
      amount: "1",
      recipient: "0x2222222222222222222222222222222222222222",
      sender: "0x9999999999999999999999999999999999999999",
      from: "0x9999999999999999999999999999999999999999",
    });
    expect(result.ok).toBe(true);
    // ParsedTransferRequest has no sender/from field at all — the type
    // itself makes this impossible to smuggle through.
    expect(result.ok && "sender" in result.value).toBe(false);
  });
});

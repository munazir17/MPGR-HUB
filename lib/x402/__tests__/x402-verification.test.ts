import { describe, expect, it } from "vitest";

import {
  classifyX402ResourceResponse,
  decodeSettlementResponseHeader,
} from "../x402-verification";

function encodeHeader(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

describe("decodeSettlementResponseHeader", () => {
  it("decodes a valid settlement header", () => {
    const decoded = decodeSettlementResponseHeader(
      encodeHeader({
        success: true,
        transaction: "0xabc",
        network: "eip155:8453",
        payer: "0x1111111111111111111111111111111111111111",
      }),
    );
    expect(decoded).toEqual({
      success: true,
      transaction: "0xabc",
      network: "eip155:8453",
      payer: "0x1111111111111111111111111111111111111111",
      errorReason: undefined,
    });
  });

  it("returns null for missing, malformed, or non-object payloads", () => {
    expect(decodeSettlementResponseHeader(null)).toBeNull();
    expect(decodeSettlementResponseHeader(undefined)).toBeNull();
    expect(decodeSettlementResponseHeader("")).toBeNull();
    expect(decodeSettlementResponseHeader("not-base64-json")).toBeNull();
    expect(decodeSettlementResponseHeader(encodeHeader({ transaction: "0xabc" }))).toBeNull();
    expect(decodeSettlementResponseHeader(Buffer.from("[]", "utf-8").toString("base64"))).toBeNull();
  });

  it("preserves success:false and an errorReason", () => {
    const decoded = decodeSettlementResponseHeader(
      encodeHeader({ success: false, errorReason: "insufficient_funds" }),
    );
    expect(decoded?.success).toBe(false);
    expect(decoded?.errorReason).toBe("insufficient_funds");
  });
});

describe("classifyX402ResourceResponse", () => {
  it("payment rejected → a fresh 402", () => {
    const result = classifyX402ResourceResponse(402, encodeHeader({ success: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PAYMENT_REJECTED");
  });

  it("resource request failed → any other non-2xx", () => {
    const result = classifyX402ResourceResponse(500, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SUBMISSION_FAILED");
  });

  it("verification failed → 2xx with no valid settlement header", () => {
    const result = classifyX402ResourceResponse(200, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VERIFICATION_FAILED");
  });

  it("payment failed → 200 but settlement.success === false", () => {
    const result = classifyX402ResourceResponse(
      200,
      encodeHeader({ success: false, errorReason: "facilitator_error" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PAYMENT_FAILED");
      expect(result.error.message).toBe("facilitator_error");
    }
  });

  it("resource returned successfully → 2xx with settlement.success === true", () => {
    const result = classifyX402ResourceResponse(
      200,
      encodeHeader({ success: true, transaction: "0xdead" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settlement.success).toBe(true);
      expect(result.settlement.transaction).toBe("0xdead");
    }
  });
});

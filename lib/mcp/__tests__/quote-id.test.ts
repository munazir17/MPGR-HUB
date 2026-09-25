import { describe, expect, it } from "vitest";

import { QUOTE_TTL_SECONDS, signQuoteId, verifyQuoteId, type QuotePayload } from "@/lib/mcp/quote-id";

const SECRET = "x".repeat(40);
const payload: QuotePayload = {
  v: 1,
  chainId: 84532,
  provider: "mpgr-executor",
  taker: "0x1111111111111111111111111111111111111111",
  sellToken: "0x2222222222222222222222222222222222222222",
  buyToken: "0x3333333333333333333333333333333333333333",
  sellNative: false,
  buyNative: false,
  sellAmount: "1000000",
  expectedBuyAmount: "5000",
  slippageBps: 100,
  feeBps: 25,
  feeAmount: "2500",
  feeRecipient: "0x4444444444444444444444444444444444444444",
  iat: 1000,
  exp: 1000 + QUOTE_TTL_SECONDS,
};

function sign(p = payload, secret = SECRET): string {
  const r = signQuoteId(p, secret);
  if (!r.ok) throw new Error(r.error.code);
  return r.quoteId;
}

describe("quoteId (HMAC-bound quote)", () => {
  it("round-trips", () => {
    const v = verifyQuoteId(sign(), 1010, SECRET);
    expect(v).toEqual({ ok: true, payload });
  });

  it("rejects any tampered field (e.g. a redirected fee recipient or smaller fee)", () => {
    const [ver, , mac] = sign().split(".");
    for (const change of [{ feeRecipient: "0x5555555555555555555555555555555555555555" }, { feeAmount: "0" }, { sellAmount: "1" }]) {
      const forged = Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url");
      expect(verifyQuoteId(`${ver}.${forged}.${mac}`, 1010, SECRET)).toMatchObject({ ok: false, error: { code: "QUOTE_ID_INVALID" } });
    }
  });

  it("rejects a different key, garbage and wrong versions", () => {
    expect(verifyQuoteId(sign(), 1010, "y".repeat(40))).toMatchObject({ ok: false, error: { code: "QUOTE_ID_INVALID" } });
    for (const junk of ["", "abc", "q1.a.b", "q2" + sign().slice(2), 42, null, "q1." + "a".repeat(5000)]) {
      expect(verifyQuoteId(junk, 1010, SECRET).ok).toBe(false);
    }
  });

  it("expires after the TTL", () => {
    expect(verifyQuoteId(sign(), 1000 + QUOTE_TTL_SECONDS, SECRET).ok).toBe(true);
    expect(verifyQuoteId(sign(), 1001 + QUOTE_TTL_SECONDS, SECRET)).toMatchObject({ ok: false, error: { code: "QUOTE_EXPIRED" } });
  });

  it("refuses to sign or verify without a strong secret", () => {
    const prev = process.env.AUTH_SESSION_SECRET;
    delete process.env.AUTH_SESSION_SECRET;
    try {
      expect(signQuoteId(payload, "short")).toMatchObject({ ok: false, error: { code: "QUOTE_SECRET_MISSING" } });
      expect(verifyQuoteId(sign(), 1010, undefined)).toMatchObject({ ok: false, error: { code: "QUOTE_SECRET_MISSING" } });
    } finally {
      if (prev !== undefined) process.env.AUTH_SESSION_SECRET = prev;
    }
  });
});

import { describe, expect, it } from "vitest";
import { assessSwapRisk, riskAckRequired, RISK_DISCLAIMER } from "../token-risk";

const base = { chainId: 8453, receiveAddress: "0x940181a94a35A4569E4529A3CDfB74e38FD98631", receiveVerified: true, receiveImported: false, sellSideQuoted: null };

describe("token risk assessment", () => {
  it("stays silent when no signal fires (no safety claim either way)", () => {
    expect(assessSwapRisk({ ...base, priceImpactBps: 30 })).toEqual([]);
    expect(RISK_DISCLAIMER).toMatch(/never prove a token is safe/i);
  });
  it("requires acknowledgement for high impact, thin liquidity and unsellable quotes", () => {
    const high = assessSwapRisk({ ...base, priceImpactBps: 620 });
    expect(high.map(w => w.code)).toEqual(["HIGH_PRICE_IMPACT"]);
    expect(riskAckRequired(high)).toBe(true);
    const thin = assessSwapRisk({ ...base, priceImpactBps: 1500 });
    expect(thin.map(w => w.code)).toEqual(["THIN_LIQUIDITY"]);
    const unsellable = assessSwapRisk({ ...base, priceImpactBps: null, sellSideQuoted: false });
    expect(unsellable.map(w => w.code)).toEqual(["SELL_SIDE_UNQUOTED"]);
  });
  it("marks imported unverified tokens informational only (never blocks by itself)", () => {
    const w = assessSwapRisk({ ...base, receiveVerified: false, receiveImported: true, priceImpactBps: 10 });
    expect(w.map(x => [x.code, x.ackRequired])).toEqual([["IMPORTED_UNVERIFIED", false]]);
    expect(riskAckRequired(w)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isAllowlistedPublicRouter, publicRouterPolicyError, PUBLIC_ROUTER_ALLOWLIST } from "../route-desk";

const router = PUBLIC_ROUTER_ALLOWLIST[0];
const base = {
  provider: "public-router",
  chainId: 8453,
  agentFee: { status: "skipped" },
  transaction: { to: router, data: "0xdeadbeef", value: "0" },
  permit2: null,
  from: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  fromAmount: "1000000",
  needsPermit2Approval: true,
  permit2Spender: router,
};

describe("public router policy", () => {
  it("accepts an allowlisted router and rejects a fee claim or a stranger target", () => {
    expect(isAllowlistedPublicRouter(router)).toBe(true);
    expect(isAllowlistedPublicRouter("0x1111111111111111111111111111111111111111")).toBe(false);
    expect(publicRouterPolicyError(base)).toBeNull();
    expect(publicRouterPolicyError({ ...base, agentFee: { status: "applied" } })).toMatch(/cannot claim/i);
    expect(publicRouterPolicyError({ ...base, transaction: { ...base.transaction, to: "0x1111111111111111111111111111111111111111" } })).toMatch(/unknown router/i);
    expect(publicRouterPolicyError({ ...base, permit2Spender: "0x2222222222222222222222222222222222222222" })).toMatch(/spender/i);
  });
});

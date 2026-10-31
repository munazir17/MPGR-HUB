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
  it("refuses every public-router execution because the 0.25% fee cannot be proven", () => {
    expect(isAllowlistedPublicRouter(router)).toBe(true);
    expect(isAllowlistedPublicRouter("0x1111111111111111111111111111111111111111")).toBe(false);
    expect(publicRouterPolicyError(base)).toMatch(/0\.25%/);
    expect(publicRouterPolicyError({ ...base, agentFee: { status: "applied" } })).toMatch(/0\.25%/);
    expect(publicRouterPolicyError({ ...base, transaction: { ...base.transaction, to: "0x1111111111111111111111111111111111111111" } })).toMatch(/0\.25%/);
    expect(publicRouterPolicyError({ provider: "mpgr-executor" })).toMatch(/not a public/i);
  });
});

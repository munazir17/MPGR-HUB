// Deterministic policy engine tests (spec §5/§24 — Policy).
import { describe, expect, it } from "vitest";

import { evaluateCondition, evaluatePolicyAgainstAction, normalizeCondition, normalizePolicyInput, parseBaseUnits, parseScaledDecimal } from "@/lib/autonomy/policy-engine";
import { resolveExecutorToken } from "@/lib/autonomy/api-helpers";
import { makePolicy, usdc, WALLET } from "./helpers";
import type { SpendContext } from "@/lib/autonomy/types";

const NOW = new Date("2026-09-28T00:00:00Z");
const NO_SPEND: SpendContext = { dailySpendRaw: "0", actionsToday: 0 };
const AAPLc = "0xb200000000000000000000C2e324d24d7eEcd1fb";

function normalize(over: Record<string, unknown> = {}) {
  return normalizePolicyInput({
    wallet: WALLET,
    resolveToken: resolveExecutorToken,
    sellToken: "USDC",
    buyToken: "AAPLc",
    maxPerTrade: "20",
    maxDaily: "50",
    maxSlippageBps: 100,
    maxActionsPerDay: 5,
    ttlDays: 7,
    now: NOW,
    authorizationRef: "sess:abc:digest",
    ...over,
  });
}

describe("policy normalization (server-side, never trusts input)", () => {
  it("normalizes a valid policy against the executor allowlist", () => {
    const r = normalize();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sellToken.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(r.value.buyToken.toLowerCase()).toBe(AAPLc.toLowerCase());
    expect(r.value.maxPerTradeRaw).toBe(usdc("20"));
    expect(r.value.actions).toEqual(["swap"]);
    expect(r.value.chainId).toBe(8453);
  });

  it("rejects LLM-ish garbage: floats-as-numbers, negative, huge, wrong types", () => {
    expect(normalize({ maxPerTrade: "20.123456" }).ok).toBe(true); // exactly 6 dp is fine for USDC
    expect(normalize({ maxPerTrade: "20.1234567" }).ok).toBe(false); // more than 6 decimals rejected
    expect(normalize({ maxPerTrade: -5 }).ok).toBe(false);
    expect(normalize({ maxPerTrade: "0" }).ok).toBe(false);
    expect(normalize({ maxPerTrade: "10001" }).ok).toBe(false); // runtime ceiling 10000
    expect(normalize({ maxDaily: "100001" }).ok).toBe(false);
    expect(normalize({ maxSlippageBps: 501 }).ok).toBe(false);
    expect(normalize({ maxSlippageBps: 2.5 }).ok).toBe(false);
    expect(normalize({ maxActionsPerDay: 0 }).ok).toBe(false);
    expect(normalize({ ttlDays: 31 }).ok).toBe(false);
    expect(normalize({ buyToken: "USDC" }).ok).toBe(false); // same pair
    expect(normalize({ buyToken: "SHIBCOIN" }).ok).toBe(false); // not on executor allowlist
    expect(normalize({ authorizationRef: "" }).ok).toBe(false);
  });

  it("rejects maxDaily < maxPerTrade and non-permitted tokens", () => {
    expect(normalize({ maxDaily: "10", maxPerTrade: "20" }).ok).toBe(false);
    expect(normalize({ sellToken: "0x1234567890abcdef1234567890abcdef12345678" }).ok).toBe(false);
  });

  it("expiry never exceeds the runtime TTL cap", () => {
    const r = normalize({ ttlDays: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new Date(r.value.expiresAt).getTime() - NOW.getTime()).toBeLessThanOrEqual(30 * 86_400_000);
  });
});

describe("deterministic action evaluation", () => {
  const goal = { expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString() };
  const action = {
    action: "swap" as const,
    chainId: 8453,
    sellToken: makePolicy().sellToken,
    buyToken: makePolicy().buyToken,
    sellAmountRaw: usdc("20"),
    slippageBps: 100,
  };

  it("allows a policy-compliant action", () => {
    const d = evaluatePolicyAgainstAction(makePolicy(), goal, action, NO_SPEND, NOW);
    expect(d.allowed).toBe(true);
  });

  it("rejects over-limit per-trade amounts", () => {
    const d = evaluatePolicyAgainstAction(makePolicy(), goal, { ...action, sellAmountRaw: usdc("21") }, NO_SPEND, NOW);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rejection.rule).toBe("OVER_PER_TRADE_LIMIT");
  });

  it("rejects when the daily cap would be exceeded", () => {
    const d = evaluatePolicyAgainstAction(makePolicy(), goal, action, { dailySpendRaw: usdc("40"), actionsToday: 1 }, NOW);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rejection.rule).toBe("OVER_DAILY_LIMIT");
  });

  it("rejects wrong token, wrong chain, wrong action", () => {
    const wrongToken = evaluatePolicyAgainstAction(makePolicy(), goal, { ...action, buyToken: WALLET }, NO_SPEND, NOW);
    expect(wrongToken.allowed).toBe(false);
    const wrongChain = evaluatePolicyAgainstAction(makePolicy(), goal, { ...action, chainId: 1 }, NO_SPEND, NOW);
    expect(wrongChain.allowed).toBe(false);
    const wrongAction = evaluatePolicyAgainstAction(makePolicy(), goal, { ...action, action: "stake" as never }, NO_SPEND, NOW);
    expect(wrongAction.allowed).toBe(false);
  });

  it("rejects excessive slippage and over-rate actions", () => {
    const slippage = evaluatePolicyAgainstAction(makePolicy(), goal, { ...action, slippageBps: 300 }, NO_SPEND, NOW);
    expect(slippage.allowed).toBe(false);
    const rate = evaluatePolicyAgainstAction(makePolicy(), goal, action, { dailySpendRaw: "0", actionsToday: 5 }, NOW);
    expect(rate.allowed).toBe(false);
    if (!rate.allowed) expect(rate.rejection.rule).toBe("OVER_ACTION_RATE");
  });

  it("rejects expired, revoked and disabled policies", () => {
    const expired = evaluatePolicyAgainstAction(makePolicy({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }), goal, action, NO_SPEND, NOW);
    expect(expired.allowed).toBe(false);
    const revoked = evaluatePolicyAgainstAction(makePolicy({ revokedAt: NOW.toISOString() }), goal, action, NO_SPEND, NOW);
    expect(revoked.allowed).toBe(false);
    const disabled = evaluatePolicyAgainstAction(makePolicy({ enabled: false }), goal, action, NO_SPEND, NOW);
    expect(disabled.allowed).toBe(false);
    const missing = evaluatePolicyAgainstAction(null, goal, action, NO_SPEND, NOW);
    expect(missing.allowed).toBe(false);
  });

  it("rejects an expired goal even with a live policy", () => {
    const d = evaluatePolicyAgainstAction(makePolicy(), { expiresAt: new Date(NOW.getTime() - 1).toISOString() }, action, NO_SPEND, NOW);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rejection.rule).toBe("GOAL_EXPIRED");
  });
});

describe("condition evaluation (bigint, decimals-aware)", () => {
  // 20 USDC (6 dp) buys 0.1 AAPLc (8 dp) => price 200 USDC per AAPLc.
  const sell = usdc("20");
  const buy = "10000000"; // 0.1 AAPLc

  it("price_below triggers at or under the threshold", () => {
    expect(evaluateCondition({ kind: "price_below", threshold: "200" }, sell, buy, 6, 8)).toMatchObject({ met: true });
    expect(evaluateCondition({ kind: "price_below", threshold: "199.999999" }, sell, buy, 6, 8)).toMatchObject({ met: false });
  });

  it("price_above triggers at or over the threshold", () => {
    expect(evaluateCondition({ kind: "price_above", threshold: "200" }, sell, buy, 6, 8)).toMatchObject({ met: true });
    expect(evaluateCondition({ kind: "price_above", threshold: "200.000001" }, sell, buy, 6, 8)).toMatchObject({ met: false });
  });

  it("handles mixed decimals exactly", () => {
    // 1 WETH (18dp) buys 4000 USDC (6dp) => price 0.00025 ETH per USDC.
    expect(evaluateCondition({ kind: "price_below", threshold: "0.00025" }, "1000000000000000000", "4000000000", 18, 6)).toMatchObject({ met: true });
    expect(evaluateCondition({ kind: "price_below", threshold: "0.00024999" }, "1000000000000000000", "4000000000", 18, 6)).toMatchObject({ met: false });
  });

  it("refuses malformed conditions instead of guessing", () => {
    expect(evaluateCondition({ kind: "price_below", threshold: "abc" }, sell, buy, 6, 8).met).toBe(false);
    expect(evaluateCondition({ kind: "price_below", threshold: "0" }, sell, buy, 6, 8).met).toBe(false);
    expect("error" in evaluateCondition({ kind: "price_below", threshold: "-1" }, sell, buy, 6, 8)).toBe(true);
  });
});

describe("input parsing primitives", () => {
  it("parseBaseUnits is decimal-exact", () => {
    expect(parseBaseUnits("20", 6)).toBe("20000000");
    expect(parseBaseUnits("20.5", 6)).toBe("20500000");
    expect(parseBaseUnits("20.0000005", 6)).toBeNull();
    expect(parseBaseUnits("-1", 6)).toBeNull();
    expect(parseBaseUnits("0", 6)).toBeNull();
    expect(parseBaseUnits("1e9", 6)).toBeNull();
  });

  it("parseScaledDecimal scales to 1e18", () => {
    expect(parseScaledDecimal("1.5")).toBe(1500000000000000000n);
    expect(parseScaledDecimal("0.000001")).toBe(1000000000000n);
    expect(parseScaledDecimal("nan")).toBeNull();
  });

  it("normalizeCondition rejects malformed triggers", () => {
    expect(normalizeCondition({ kind: "price_below", threshold: "200" }).ok).toBe(true);
    expect(normalizeCondition({ kind: "pump_it", threshold: "200" }).ok).toBe(false);
    expect(normalizeCondition({ kind: "price_below", threshold: "-2" }).ok).toBe(false);
    expect(normalizeCondition(null).ok).toBe(false);
  });
});

import { reviewQuoteFixture } from "./test-fixtures/chat-review-quote";
import { parseBaseUnits } from "@/lib/autonomy/policy-engine";
import { describe, expect, it } from "vitest";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
import type { AutonomyConfig } from "@/hooks/useAgentAutonomy";
import { CHAT_REVIEW_TOKENS, chatQuoteMinOutHuman, chatReviewQuoteFromProposal, chatQuoteReviewError, chatDraftToForm, chatQuoteKey, chatReviewAuthorizationError, validateChatReviewForm } from "./chat-autonomy-review";
import { autonomyFormToDraftInput } from "./autonomy-authorize-form";

const config: AutonomyConfig = {
  enabled: true, emergencyDisabled: false, productionGate: true, executionAvailable: true,
  delegated: { chainId: 8453, executor: "0x1111111111111111111111111111111111111111", walletSigningSupported: true },
  limits: { maxGoalsPerWallet: 5, minCooldownSeconds: 60, maxPolicyTtlDays: 30, maxPerTradeHuman: "100", maxDailyHuman: "500", maxSlippageBps: 100 },
};
const prompt = "Buy AAPLc whenever price falls 1% worth 1 USDC";
const draft = buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt, { referencePrice: "347" });
const form = chatDraftToForm(draft);
const ready = () => ({ form, config, tokens: CHAT_REVIEW_TOKENS, quote: { key: chatQuoteKey(form), minOutAtomic: "280000", buyDecimals: 8, proposal: reviewQuoteFixture(form) }, authenticated: true, walletChainId: 8453 });

describe("Chat-only Base review preflight", () => {
  it("initializes the exact parsed draft from registered Base token metadata", () => {
    expect(form).toEqual({ sell: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", buy: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      sellAmount: "1", threshold: "343.53", kind: "price_below", maxDaily: "10", maxTrades: 10, slippageBps: 100, ttlDays: 30, cooldownSeconds: 3600 });
    expect(autonomyFormToDraftInput(form)).toMatchObject({ sellToken: form.sell, buyToken: form.buy, sellAmount: "1", maxPerTrade: "1", maxDaily: "10",
      condition: { kind: "price_below", threshold: "343.53" }, maxActionsPerDay: 20, ttlDays: 30, maxTrades: 10, maxSlippageBps: 100 });
    expect(validateChatReviewForm(form, config.limits)).toBeNull();
  });
  it("is ready only with complete inputs, the correct network/catalog, a session, and a matching positive quote", () => {
    expect(chatReviewAuthorizationError(ready())).toBeNull();
    // A ready fixture must explicitly confirm both gates; preflight cannot enable them.
    expect(config.productionGate).toBe(true);
    expect(config.executionAvailable).toBe(true);
  });
  it.each([
    { sell: "" }, { buy: "" }, { buy: form.sell }, { sellAmount: "" }, { sellAmount: "-1" }, { sellAmount: "NaN" },
    { sellAmount: "0.0000001" }, { sellAmount: "101" }, { maxDaily: "0.5" }, { maxDaily: "501" },
    { threshold: "" }, { threshold: "0" }, { threshold: "1e3" }, { slippageBps: 101 }, { slippageBps: 0 },
    { maxTrades: 0 }, { maxTrades: 26 }, { maxTrades: 1.5 }, { ttlDays: 31 }, { ttlDays: 0 }, { cooldownSeconds: 59 },
  ])("refuses invalid/incomplete form edits %j before authorization", (patch) => {
    expect(validateChatReviewForm({ ...form, ...patch }, config.limits)).not.toBeNull();
    expect(chatReviewAuthorizationError({ ...ready(), form: { ...form, ...patch } })).not.toBeNull();
  });
  it("never invents spend for an incomplete persisted draft", () => {
    expect(chatDraftToForm({ ...draft, amountPerTrade: null }).sellAmount).toBe("");
  });
  it("refuses a registered-token pair with no registered route", () => {
    const weth = CHAT_REVIEW_TOKENS.find((t) => t.symbol === "WETH")!;
    expect(validateChatReviewForm({ ...form, sell: weth.address }, config.limits)).toMatch(/registered Base route/);
  });
  it("keeps disabled/unavailable/emergency/network/session states fail-closed", () => {
    expect(chatReviewAuthorizationError({ ...ready(), config: null })).not.toBeNull();
    expect(chatReviewAuthorizationError({ ...ready(), config: { ...config, enabled: false } })).not.toBeNull();
    expect(chatReviewAuthorizationError({ ...ready(), config: { ...config, emergencyDisabled: true } })).not.toBeNull();
    expect(chatReviewAuthorizationError({ ...ready(), config: { ...config, delegated: undefined } })).not.toBeNull();
    expect(chatReviewAuthorizationError({ ...ready(), walletChainId: 84532 })).not.toBeNull();
    expect(chatReviewAuthorizationError({ ...ready(), authenticated: false })).toMatch(/Sign in/);
  });
  it("refuses empty, wrong-network, mismapped, or wrong-precision runtime metadata", () => {
    expect(chatReviewAuthorizationError({ ...ready(), tokens: [] })).toMatch(/token details/);
    expect(chatReviewAuthorizationError({ ...ready(), tokens: [null, { address: 123 }] as never })).toMatch(/token details/);
    expect(chatReviewAuthorizationError({ ...ready(), tokens: [{ symbol: "tUSD", address: form.sell, decimals: 6 }] })).not.toBeNull();
    expect(chatReviewAuthorizationError({ ...ready(), tokens: CHAT_REVIEW_TOKENS.map((t) => ({ ...t, decimals: 18 })) })).not.toBeNull();
  });
  it("fails closed if numeric settings are malformed instead of bypassing bounds", () => {
    expect(validateChatReviewForm(form, { ...config.limits, maxSlippageBps: Number.NaN })).not.toBeNull();
    expect(validateChatReviewForm(form, { ...config.limits, maxPolicyTtlDays: 0 })).not.toBeNull();
  });
  it("refuses absent/malformed quotes, over-precision floors and quotes for old inputs", () => {
    for (const minOut of ["", "0", "-1", "NaN", "1e-3", "0.000000001"]) {
      expect(chatReviewAuthorizationError({ ...ready(), quote: { key: chatQuoteKey(form), minOutAtomic: minOut, buyDecimals: 8 } })).not.toBeNull();
    }
    expect(chatReviewAuthorizationError({ ...ready(), quote: null })).not.toBeNull();
    for (const patch of [{ sellAmount: "2" }, { slippageBps: 90 }, { buy: CHAT_REVIEW_TOKENS.find((t) => t.symbol === "WETH")!.address }]) {
      expect(chatReviewAuthorizationError({ ...ready(), form: { ...form, ...patch } })).toMatch(/live quote/);
    }
  });
});


describe("Chat authorization requires confirmed live gates independently of settings loading", () => {
  it.each([false, undefined])("refuses production gate %s despite a valid form/session/quote", (productionGate) => {
    expect(chatReviewAuthorizationError({ ...ready(), config: { ...config, productionGate } as AutonomyConfig })).toMatch(/production safety gate/);
  });
  it.each([false, undefined])("refuses execution availability %s", (executionAvailable) => {
    expect(chatReviewAuthorizationError({ ...ready(), config: { ...config, executionAvailable } as AutonomyConfig })).toMatch(/runtime\/adapter readiness/);
  });
  it("does not suggest retry/sign-in as a fix for a disabled runtime flag", () => {
    const message = chatReviewAuthorizationError({ ...ready(), config: { ...config, enabled: false }, settingsRead: { state: "loaded", httpStatus: 200, runtimeGate: "missing" } });
    expect(message).toMatch(/runtime flag: missing/);
    expect(message).toContain("Use MPGR Swap");
    expect(message).toContain("unavailable on this deployment");
    expect(message).not.toMatch(/Retry loading settings/);
  });
  it.each(["loading", "http_error", "invalid_json", "invalid_response", "network_error", "timeout"] as const)("never authorizes stale valid settings while the read is %s", (state) => {
    expect(chatReviewAuthorizationError({ ...ready(), settingsRead: { state, httpStatus: state === "http_error" ? 503 : 200 } })).not.toBeNull();
  });
});


describe("exact atomic quote / human signing seam", () => {
  it.each([
    [8, "280000", "0.0028"], // AAPLc
    [18, "2500000000000000", "0.0025"], // WETH
    [6, "1234567", "1.234567"], // USDC
    [0, "7", "7"],
    [18, "123456789012345678901234567890", "123456789012.34567890123456789"],
    [18, "1", "0.000000000000000001"],
  ])("preserves every atomic unit at %i decimals", (decimals, atomic, human) => {
    const quote = { key: "test", minOutAtomic: atomic, buyDecimals: decimals };
    expect(chatQuoteMinOutHuman(quote, decimals)).toBe(human);
    expect(parseBaseUnits(chatQuoteMinOutHuman(quote, decimals)!, decimals)).toBe(atomic);
    expect(chatQuoteMinOutHuman(quote, decimals + 1)).toBeNull();
  });
});

describe("complete, fresh executable review", () => {
  it.each([
    { to: { ...reviewQuoteFixture(form).to, decimals: 18 } },
    { fromAmount: "2000000" }, { slippageBps: 90 }, { minToAmount: "0.0028" },
    { to: { ...reviewQuoteFixture(form).to, address: form.sell } }, { fees: null },
  ])("rejects mismatched or incomplete API quote metadata %j", (patch) => {
    expect(() => chatReviewQuoteFromProposal({ ...reviewQuoteFixture(form), ...patch }, form)).toThrow();
  });
  it("requires proposal details and exact canonical atomic floor", () => {
    expect(chatQuoteReviewError({ key: chatQuoteKey(form), minOutAtomic: "280000", buyDecimals: 8 }, form)).toMatch(/live quote/);
    const quote = chatReviewQuoteFromProposal(reviewQuoteFixture(form), form);
    expect(chatQuoteReviewError(quote, form)).toBeNull();
    expect(chatQuoteReviewError({ ...quote, minOutAtomic: "290000" }, form)).toMatch(/floor/);
  });
  it.each([
    { quotedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() - 30_000).toISOString() },
    { quotedAt: new Date(Date.now() + 60_000).toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString() },
    { executionAvailable: false }, { liquidityAvailable: false },
    { risk: [{ id: "critical", severity: "critical", title: "Unsafe", detail: "Test risk" }] },
  ])("does not authorize stale, future, nonexecutable or critical-risk snapshots %j", (patch) => {
    const quote = chatReviewQuoteFromProposal({ ...reviewQuoteFixture(form), ...patch }, form);
    expect(chatQuoteReviewError(quote, form)).not.toBeNull();
  });
});

it("explains the verified Preview block and directs to Manual without suggesting enablement", () => {
  const message = chatReviewAuthorizationError({ ...ready(), config: { ...config, enabled: false, productionGate: false },
    settingsRead: { state: "loaded", httpStatus: 200, runtimeGate: "disabled", productionGate: "missing", deploymentEnvironment: "preview" } });
  expect(message).toContain("Mainnet autonomous authorization is unavailable in Preview");
  expect(message).toContain("runtime flag: disabled");
  expect(message).toContain("production flag: missing");
  expect(message).toContain("Use MPGR Swap");
  expect(message).not.toMatch(/must review Preview configuration|Retry loading settings|enable (?:Mainnet autonomy|the production gate) in Preview/i);
});
it("does not mislabel Production as Preview or let deployment diagnostics enable a missing gate", () => {
  expect(chatReviewAuthorizationError({ ...ready(), settingsRead: { state: "loaded", deploymentEnvironment: "preview" } })).toBeNull();
  for (const deploymentEnvironment of ["preview", "production", "unknown"] as const) {
    const message = chatReviewAuthorizationError({ ...ready(), config: { ...config, productionGate: false }, settingsRead: { state: "loaded", productionGate: "missing", deploymentEnvironment } });
    expect(message).toContain("Use MPGR Swap");
    expect(message).toContain(deploymentEnvironment === "preview" ? "unavailable in Preview" : "unavailable on this deployment");
    if (deploymentEnvironment !== "preview") expect(message).not.toContain("in Preview");
  }
});

it.each(["runtime-missing", "production-missing", "stale-quote", "wrong-network", "disconnected", "missing-adapter"])("mocked Preview readiness remains closed with %s missing/invalid", (block) => {
  const args: Parameters<typeof chatReviewAuthorizationError>[0] = { ...ready(), settingsRead: { state: "loaded", deploymentEnvironment: "preview" } };
  if (block === "runtime-missing") { args.config = { ...config, enabled: false }; args.settingsRead!.runtimeGate = "missing"; }
  if (block === "production-missing") { args.config = { ...config, productionGate: false }; args.settingsRead!.productionGate = "missing"; }
  if (block === "stale-quote") { args.quote!.proposal!.quotedAt = new Date(Date.now() - 60_000).toISOString(); args.quote!.proposal!.expiresAt = new Date(Date.now() - 30_000).toISOString(); }
  if (block === "wrong-network") args.walletChainId = 1;
  if (block === "disconnected") args.walletChainId = undefined;
  if (block === "missing-adapter") args.config = { ...config, delegated: undefined };
  expect(chatReviewAuthorizationError(args)).not.toBeNull();
});

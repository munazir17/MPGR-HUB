// Chat draft detection tests (spec §20/§24). The matcher must be NARROW:
// recurring/conditional phrasing only — the existing assisted flow must
// never be captured by it.
//
// PRODUCTION FIX coverage (percent triggers, anchoring, amount follow-up,
// allowlist gate): "drops 1%" phrasing anchors to the LIVE reference price
// at draft time; the trigger stored is price_below at reference×(1−pct/100);
// both numbers ride on the draft; assets outside the delegated allowlist
// with a USDC route are refused.
import { describe, expect, it } from "vitest";

import {
  applyAmountToDraft,
  applyPercentToReference,
  autonomyAllowedTargetSymbols,
  buildAutonomyReplyText,
  buildGoalDraft,
  checkAutonomyTarget,
  detectAmountOnlyFollowUp,
  detectAutonomousTradeRequest,
} from "@/lib/autonomy/chat-draft";

describe("autonomous trade request detection", () => {
  it("matches the canonical spec example", () => {
    const m = detectAutonomousTradeRequest("Buy AAPLc whenever it falls below $200, max $20 per trade");
    expect(m).not.toBeNull();
    expect(m!.triggerKind).toBe("price_below");
    expect(m!.triggerPrice).toBe("200");
    expect(m!.targetAsset).toBe("AAPLc");
    expect(m!.amountPerTrade).toBe("20");
    expect(m!.percentDrop).toBeNull();
  });

  it("matches plain trigger phrasing and above-targets", () => {
    expect(detectAutonomousTradeRequest("Buy TSLAc when it falls below 300 USDC")).toMatchObject({ triggerKind: "price_below", targetAsset: "TSLAc" });
    expect(detectAutonomousTradeRequest("Sell AAPLc whenever it rises above $250")).toMatchObject({ triggerKind: "price_above", targetAsset: "AAPLc" });
    expect(detectAutonomousTradeRequest("keep buying NVDAc every time it drops below 120 usd")).toMatchObject({ triggerKind: "price_below", targetAsset: "NVDAc" });
  });

  it("detects RELATIVE percent triggers: 'drops 1%', 'down 1 percent', 'falls 1%'", () => {
    expect(detectAutonomousTradeRequest("Buy AAPLc when it drops 1%")).toMatchObject({
      triggerKind: "price_below",
      percentDrop: 1,
      targetAsset: "AAPLc",
      triggerPrice: "", // anchored at draft time, never guessed here
    });
    expect(detectAutonomousTradeRequest("Buy AAPLc when it is down 1 percent")).toMatchObject({ triggerKind: "price_below", percentDrop: 1 });
    expect(detectAutonomousTradeRequest("Buy AAPLc when it falls 1%")).toMatchObject({ triggerKind: "price_below", percentDrop: 1 });
    expect(detectAutonomousTradeRequest("Sell TSLAc when it rises 2.5%")).toMatchObject({ triggerKind: "price_above", percentDrop: 2.5 });
  });

  it("percent + amount: the per-trade amount is NEVER mis-read as the trigger price", () => {
    // The production bug chain: "drops 1%" fell through to the one-shot swap
    // prompt, and the follow-up amount was then read as a new turn. Both must
    // land in ONE draft.
    const m = detectAutonomousTradeRequest("Buy AAPLc when it drops 1%, max 5 USDC per trade");
    expect(m).not.toBeNull();
    expect(m!.percentDrop).toBe(1);
    expect(m!.amountPerTrade).toBe("5");
    expect(m!.triggerPrice).toBe("");
  });

  it.each([
    "Buy AAPLc whenever price falls 1% worth 1 USDC",
    "Buy AAPLc when price falls 1% worth 1 USDC",
    "Buy AAPLc whenever price falls 1% worth $1",
    "Buy AAPLc whenever price falls 1% worth 0.5 USDC",
  ])("separates a worth amount from the percent trigger: %s", (prompt) => {
    const match = detectAutonomousTradeRequest(prompt);
    expect(match).toMatchObject({
      side: "buy", targetAsset: "AAPLc", spendAsset: "USDC",
      triggerKind: "price_below", triggerPrice: "", percentDrop: 1,
      amountPerTrade: prompt.includes("0.5") ? "0.5" : "1",
    });
  });

  it.each([
    "Buy AAPLc whenever price falls 1%",
    "Buy AAPLc when price falls 1%",
    "Buy AAPLc when it falls 1%",
  ])("supports recurring wording and the price prefix independently: %s", (prompt) => {
    expect(detectAutonomousTradeRequest(prompt)).toMatchObject({ percentDrop: 1, amountPerTrade: null });
  });

  it("uses worth as an amount with an absolute trigger, but never makes a spot order conditional", () => {
    expect(detectAutonomousTradeRequest("Buy AAPLc whenever price falls below 250 worth 1 USDC"))
      .toMatchObject({ triggerPrice: "250", percentDrop: null, amountPerTrade: "1" });
    expect(detectAutonomousTradeRequest("Buy AAPLc worth 1 USDC")).toBeNull();
  });

  it("absolute dollar points still win and behave byte-for-byte as before", () => {
    expect(detectAutonomousTradeRequest("Buy AAPLc whenever it falls below $200, max $20 per trade")).toMatchObject({
      triggerPrice: "200",
      amountPerTrade: "20",
      percentDrop: null,
    });
  });

  it("NEVER captures one-shot assisted swaps (spec §25 — current mode untouched)", () => {
    expect(detectAutonomousTradeRequest("Swap 1 USDC to AAPLc")).toBeNull();
    expect(detectAutonomousTradeRequest("Buy 5 USDC of MSTRc")).toBeNull();
    expect(detectAutonomousTradeRequest("Sell my 4 USDC worth of TSLAc")).toBeNull();
    expect(detectAutonomousTradeRequest("swap 10 ETH to USDC")).toBeNull();
    expect(detectAutonomousTradeRequest("What is my AAPLc balance?")).toBeNull();
    expect(detectAutonomousTradeRequest("")).toBeNull();
  });

  it("requires a parseable price point or percent", () => {
    expect(detectAutonomousTradeRequest("Buy AAPLc whenever it falls below the moon")).toBeNull();
    expect(detectAutonomousTradeRequest("Buy AAPLc when it drops 200%")).toBeNull(); // implausible percent
  });
});

describe("percent anchoring", () => {
  it("computes the trigger with exact decimal math (347 − 1% = 343.53)", () => {
    expect(applyPercentToReference("347", 1, "price_below")).toBe("343.53");
    expect(applyPercentToReference("347.36", 1, "price_below")).toBe("343.8864");
    expect(applyPercentToReference("0.10", 1, "price_below")).toBe("0.099");
    expect(applyPercentToReference("100", 1.5, "price_above")).toBe("101.5");
  });

  it("buildGoalDraft anchors the percent trigger and shows BOTH numbers", () => {
    const m = detectAutonomousTradeRequest("Buy AAPLc when it drops 1%")!;
    const draft = buildGoalDraft(m, "Buy AAPLc when it drops 1%", { referencePrice: "347" });
    expect(draft.triggerKind).toBe("price_below");
    expect(draft.referencePrice).toBe("347");
    expect(draft.percentDrop).toBe(1);
    expect(draft.triggerPrice).toBe("343.53");
    expect(draft.supported).toBe(true);

    // The reply states both numbers: "AAPLc is 347, 1% down is 343.53".
    const reply = buildAutonomyReplyText(m, { referencePrice: "347" });
    expect(reply).toContain("AAPLc is 347");
    expect(reply).toContain("343.53");
    expect(reply).toMatch(/OFF until you review and activate/i);
  });

  it("an unanchored percent trigger produces NO price (caller refuses to guess)", () => {
    const m = detectAutonomousTradeRequest("Buy AAPLc when it drops 1%")!;
    const draft = buildGoalDraft(m, "Buy AAPLc when it drops 1%");
    expect(draft.triggerPrice).toBe("");
  });
});

describe("amount-only follow-up", () => {
  it("matches bare amounts: '1 USDC', '$1', '0.5 usdc', '2 dollars'", () => {
    expect(detectAmountOnlyFollowUp("1 USDC")).toMatchObject({ amount: "1" });
    expect(detectAmountOnlyFollowUp("$1")).toMatchObject({ amount: "1" });
    expect(detectAmountOnlyFollowUp("0.5 usdc")).toMatchObject({ amount: "0.5" });
    expect(detectAmountOnlyFollowUp("2 dollars")).toMatchObject({ amount: "2" });
    expect(detectAmountOnlyFollowUp("1")).toMatchObject({ amount: "1" });
  });

  it("never captures real requests", () => {
    expect(detectAmountOnlyFollowUp("buy 1 USDC")).toBeNull();
    expect(detectAmountOnlyFollowUp("what is my balance?")).toBeNull();
    expect(detectAmountOnlyFollowUp("swap 1 USDC to AAPLc")).toBeNull();
    expect(detectAmountOnlyFollowUp("")).toBeNull();
  });

  it("attaches the amount to an OPEN draft without touching the trigger", () => {
    const m = detectAutonomousTradeRequest("Buy AAPLc when it drops 1%")!;
    const draft = buildGoalDraft(m, "Buy AAPLc when it drops 1%", { referencePrice: "347" });
    const filled = applyAmountToDraft(draft, "1");
    expect(filled.amountPerTrade).toBe("1");
    expect(filled.triggerPrice).toBe("343.53");
    expect(filled.referencePrice).toBe("347");
    expect(filled.sourcePrompt).toBe(draft.sourcePrompt);
  });
});

describe("delegated allowlist gate (no new tokens or routes)", () => {
  it("accepts live B20 stocks and WETH — the delegated allowlist with a USDC route", () => {
    const allowed = autonomyAllowedTargetSymbols();
    expect(allowed).toContain("AAPLc");
    expect(allowed).toContain("WETH");
    expect(checkAutonomyTarget("AAPLc")).toMatchObject({ ok: true, symbol: "AAPLc" });
    expect(checkAutonomyTarget("weth")).toMatchObject({ ok: true, symbol: "WETH" });
  });

  it("refuses anything not on the delegated allowlist", () => {
    const check = checkAutonomyTarget("FOOc");
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/not available for autonomous trading/);
  });

  it("an unsupported target yields a draft that only SAYS it is unavailable", () => {
    const m = detectAutonomousTradeRequest("Buy FOOc when it drops 1%")!;
    const draft = buildGoalDraft(m, "Buy FOOc when it drops 1%", { referencePrice: "5" });
    expect(draft.supported).toBe(false);
    expect(draft.unsupportedReason).toMatch(/not available for autonomous trading/);
  });
});

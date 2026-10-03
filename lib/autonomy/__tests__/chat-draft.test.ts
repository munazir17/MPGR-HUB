// Chat draft detection tests (spec §20/§24). The matcher must be NARROW:
// recurring/conditional phrasing only — the existing assisted flow must
// never be captured by it.
import { describe, expect, it } from "vitest";

import { buildAutonomyReplyText, buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";

describe("autonomous trade request detection", () => {
  it("matches the canonical spec example", () => {
    const m = detectAutonomousTradeRequest("Buy AAPLc whenever it falls below $200, max $20 per trade");
    expect(m).not.toBeNull();
    expect(m!.triggerKind).toBe("price_below");
    expect(m!.triggerPrice).toBe("200");
    expect(m!.targetAsset).toBe("AAPLc");
    expect(m!.amountPerTrade).toBe("20");
  });

  it("matches plain trigger phrasing and above-targets", () => {
    expect(detectAutonomousTradeRequest("Buy TSLAc when it falls below 300 USDC")).toMatchObject({ triggerKind: "price_below", targetAsset: "TSLAc" });
    expect(detectAutonomousTradeRequest("Sell AAPLc whenever it rises above $250")).toMatchObject({ triggerKind: "price_above", targetAsset: "AAPLc" });
    expect(detectAutonomousTradeRequest("keep buying NVDAc every time it drops below 120 usd")).toMatchObject({ triggerKind: "price_below", targetAsset: "NVDAc" });
  });

  it("NEVER captures one-shot assisted swaps (spec §25 — current mode untouched)", () => {
    expect(detectAutonomousTradeRequest("Swap 1 USDC to AAPLc")).toBeNull();
    expect(detectAutonomousTradeRequest("Buy 5 USDC of MSTRc")).toBeNull();
    expect(detectAutonomousTradeRequest("Sell my 4 USDC worth of TSLAc")).toBeNull();
    expect(detectAutonomousTradeRequest("swap 10 ETH to USDC")).toBeNull();
    expect(detectAutonomousTradeRequest("What is my AAPLc balance?")).toBeNull();
    expect(detectAutonomousTradeRequest("")).toBeNull();
  });

  it("requires a parseable price point", () => {
    expect(detectAutonomousTradeRequest("Buy AAPLc whenever it falls below the moon")).toBeNull();
  });

  it("the reply explains and never activates (spec §20)", () => {
    const m = detectAutonomousTradeRequest("Buy AAPLc whenever it falls below $200, max $20 per trade")!;
    const reply = buildAutonomyReplyText(m);
    expect(reply).toMatch(/autonomous goal/i);
    expect(reply).toMatch(/limits you explicitly authorize/i);
    expect(reply).toMatch(/never holds your keys/i);
    expect(reply.toLowerCase()).not.toMatch(/^i (have )?(activated|enabled|executed|placed|bought)/);
    const draft = buildGoalDraft(m, "Buy AAPLc whenever it falls below $200");
    expect(draft).toMatchObject({ targetAsset: "AAPLc", spendAsset: "USDC", triggerKind: "price_below", triggerPrice: "200", amountPerTrade: "20" });
    expect(draft.sourcePrompt).toBe("Buy AAPLc whenever it falls below $200");
  });
});

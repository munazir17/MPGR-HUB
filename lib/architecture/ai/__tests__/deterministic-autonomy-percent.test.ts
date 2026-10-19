import { afterEach, describe, expect, it, vi } from "vitest";

// PRODUCTION FIX — deterministic-provider coverage for the three broken
// chat flows reported from production:
//
//   1. "Buy AAPLc when it drops 1%" produces a REVIEW-ONLY draft whose
//      trigger is ANCHORED at draft time to the live reference price
//      (price_below at reference × (1 − pct/100)), with both numbers in the
//      reply — it must NOT fall through to the one-shot swap prompt.
//   2. A follow-up message that is ONLY an amount ("1 USDC", "$1") fills
//      the OPEN draft from the same conversation — it must NOT start a spot
//      swap and must NOT hit generic portfolio help.
//   3. An asset outside the delegated allowlist produces a draft that SAYS
//      it is not available for autonomous trading.
//
// Nothing here activates anything: these are reply-shape contracts only.

import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { AIProviderRequest } from "../ai-provider";
import type { AutonomyGoalDraft } from "@/lib/autonomy/chat-draft";
import { toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

vi.mock("../agent-tool-calling", () => ({
  runRegisteredTool: vi.fn(),
}));

import { runRegisteredTool } from "../agent-tool-calling";

const runTool = vi.mocked(runRegisteredTool);

function makeRequest(
  prompt: string,
  relevantHistory: unknown[] = [],
): AIProviderRequest {
  return {
    prompt,
    agentContext: { isConnected: true } as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {
      isReturningUser: false,
      interactionCount: 0,
      favoriteTopics: [],
      conversationSummaries: [],
      relevantHistory,
    } as unknown as AIProviderRequest["memoryContext"],
    address: "0x000000000000000000000000000000000000aa",
  };
}

function pairResult(usdFeed: number | null) {
  return toolSuccess("get_pair", {
    pair: { symbol: "AAPLc", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", live: true, official: true },
    stock: usdFeed == null ? null : { symbol: "AAPLc", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", usdFeed, usdDex: null, stale: false, feedStale: false, paused: false, feedUpdatedAt: Math.floor(Date.now() / 1000) },
    wrapped: null, chainId: 8453, asOf: new Date().toISOString(),
  });
}

describe("DeterministicAIProvider percent-trigger drafts", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("'drops 1%' anchors to the live price and stores reference × (1 − pct/100)", async () => {
    runTool.mockResolvedValue(pairResult(347));

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Buy AAPLc when it drops 1%"),
    );

    // The reference price was read through the read-only get_pair tool.
    expect(runTool).toHaveBeenCalledWith("get_pair", { symbol: "AAPLc" }, expect.anything());
    const draft = response.autonomyGoalDraft;
    expect(draft).toBeDefined();
    expect(draft?.triggerKind).toBe("price_below");
    expect(draft?.referencePrice).toBe("347");
    expect(draft?.percentDrop).toBe(1);
    expect(draft?.triggerPrice).toBe("343.53");
    // BOTH numbers are shown: "AAPLc is 347, 1% down is 343.53".
    expect(response.reply).toContain("AAPLc is 347");
    expect(response.reply).toContain("343.53");
    // Still a review-only reply, never an activation claim.
    expect(response.tradeProposal).toBeUndefined();
  });

  it("a percent trigger with NO live price produces no draft (never a guessed number)", async () => {
    runTool.mockResolvedValue(pairResult(null));

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Buy AAPLc when it drops 1%"),
    );

    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.reply).toMatch(/could not get a live/i);
  });

  it("absolute-dollar phrasing still works without any price read", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Buy AAPLc whenever it falls below $200"),
    );

    expect(runTool).not.toHaveBeenCalled();
    expect(response.autonomyGoalDraft).toMatchObject({ triggerPrice: "200", percentDrop: null });
  });
});

describe("DeterministicAIProvider amount-only follow-up", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("a follow-up '1 USDC' fills the OPEN draft — no swap prepare, no portfolio help", async () => {
    const openDraft: AutonomyGoalDraft = {
      targetAsset: "AAPLc",
      spendAsset: "USDC",
      side: "buy",
      triggerKind: "price_below",
      triggerPrice: "343.53",
      amountPerTrade: null,
      referencePrice: "347",
      percentDrop: 1,
      supported: true,
      unsupportedReason: null,
      sourcePrompt: "Buy AAPLc when it drops 1%",
    };
    const previousAssistantTurn = {
      id: "a1",
      role: "assistant",
      content: "I can create this as an autonomous goal…",
      timestamp: "2026-10-14T00:00:00Z",
      autonomyGoalDraft: openDraft,
    };

    const next = makeRequest("1 USDC", [previousAssistantTurn]);
    next.lastAssistantMessage = { autonomyGoalDraft: openDraft };
    const response = await new DeterministicAIProvider().generateReply(next);

    // No swap prepare ran; the amount landed on the SAME draft.
    expect(runTool).not.toHaveBeenCalled();
    expect(response.tradeProposal).toBeUndefined();
    expect(response.autonomyGoalDraft).toMatchObject({ amountPerTrade: "1", triggerPrice: "343.53", targetAsset: "AAPLc" });
    // The reply is about the draft, not generic portfolio help.
    expect(response.reply).toMatch(/Added 1 USDC per trade/i);
    expect(response.reply).not.toMatch(/portfolio/i);
  });

  it("an amount-only message with NO open draft does not fabricate one", async () => {
    const response = await new DeterministicAIProvider().generateReply(makeRequest("1 USDC"));
    expect(response.autonomyGoalDraft).toBeUndefined();
  });

  it("prefers the deterministic lastAssistantMessage over ranked history", async () => {
    const openDraft: AutonomyGoalDraft = {
      targetAsset: "TSLAc",
      spendAsset: "USDC",
      side: "buy",
      triggerKind: "price_below",
      triggerPrice: "410.58",
      amountPerTrade: null,
      referencePrice: "415",
      percentDrop: 1,
      supported: true,
      unsupportedReason: null,
      sourcePrompt: "Buy TSLAc when it drops 1%",
    };
    const request = makeRequest("$1");
    // relevantHistory is empty (ranking dropped it) — the verbatim last
    // assistant turn still carries the open draft.
    request.lastAssistantMessage = { autonomyGoalDraft: openDraft };

    const response = await new DeterministicAIProvider().generateReply(request);

    expect(response.autonomyGoalDraft).toMatchObject({
      targetAsset: "TSLAc",
      amountPerTrade: "1",
      triggerPrice: "410.58",
    });
    expect(response.tradeProposal).toBeUndefined();
  });
});

describe("DeterministicAIProvider allowlist discipline", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("a non-allowlisted asset gets a draft that says it is not available for autonomous trading", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Buy FOOCOIN when it drops 1%"),
    );

    const draft = response.autonomyGoalDraft;
    expect(draft).toBeDefined();
    expect(draft?.supported).toBe(false);
    expect(draft?.unsupportedReason).toMatch(/not available for autonomous trading/);
    expect(response.reply).toMatch(/not available for autonomous trading/i);
    // No prepare/sign/execute path was touched.
    expect(runTool).not.toHaveBeenCalled();
    expect(response.tradeProposal).toBeUndefined();
  });
});

it("native ETH conditional is a clear refusal, not WETH and not an immediate trade", async () => {
  runTool.mockReset();
  const response = await new DeterministicAIProvider().generateReply(makeRequest("Buy $5 ETH if it drops 2%"));
  expect(response.reply).toContain("ETH is not WETH");
  expect(response.autonomyGoalDraft).toMatchObject({ targetAsset: "ETH", supported: false });
  expect(response.tradeProposal).toBeUndefined(); expect(runTool).not.toHaveBeenCalled();
});
it("explicit WETH anchors from its exact canonical DEX observation", async () => {
  const address = "0x4200000000000000000000000000000000000006";
  runTool.mockReset(); runTool.mockResolvedValue(toolSuccess("get_pair", {
    pair: { symbol: "WETH", address, live: true, official: true }, stock: null,
    wrapped: { symbol: "WETH", address, usd: 2500, stale: false, updatedAt: Math.floor(Date.now() / 1000) },
    chainId: 8453, asOf: new Date().toISOString(),
  }));
  const response = await new DeterministicAIProvider().generateReply(makeRequest("Buy $5 WETH if it drops 2%"));
  expect(response.autonomyGoalDraft).toMatchObject({ targetAsset: "WETH", amountPerTrade: "5", referencePrice: "2500", triggerPrice: "2450" });
  expect(runTool).toHaveBeenCalledExactlyOnceWith("get_pair", { symbol: "WETH" }, expect.anything());
  expect(response.tradeProposal).toBeUndefined();
});

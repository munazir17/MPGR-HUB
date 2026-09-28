import { afterEach, describe, expect, it, vi } from "vitest";

// Autonomous Agent Runtime (ADDITIVE) — locks the two chat contracts of
// the deterministic-provider branch (spec §20):
//
//   1. Clearly recurring / conditional trade phrasing ("Buy AAPLc whenever
//      it falls below $200") NEVER reaches a one-shot swap prepare. It
//      returns an explanation plus a REVIEW-ONLY autonomyGoalDraft, and
//      nothing is activated (no policy POST, no execution — there is no
//      code path here that could).
//   2. Assisted trading is UNCHANGED: one-shot swap phrasing with the same
//      tokens still flows into the existing trade branches (asserted by
//      the absence of autonomyGoalDraft and, for a prompt that previously
//      matched the transfer branch, by the branches being untouched).

import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { AIProviderRequest } from "../ai-provider";
import { toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

vi.mock("../agent-tool-calling", () => ({
  runRegisteredTool: vi.fn(),
}));

import { runRegisteredTool } from "../agent-tool-calling";

const runTool = vi.mocked(runRegisteredTool);

function makeRequest(prompt: string): AIProviderRequest {
  return {
    prompt,
    agentContext: { isConnected: true } as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {
      isReturningUser: false,
      interactionCount: 0,
      favoriteTopics: [],
      conversationSummaries: [],
    } as unknown as AIProviderRequest["memoryContext"],
    address: "0x000000000000000000000000000000000000aa",
  };
}

describe("DeterministicAIProvider autonomous-goal branch", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("returns a review-only draft for conditional phrasing, never a swap prepare", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Buy AAPLc whenever it falls below $200"),
    );

    expect(response.autonomyGoalDraft).toBeDefined();
    expect(response.autonomyGoalDraft?.targetAsset).toBe("AAPLc");
    expect(response.autonomyGoalDraft?.triggerKind).toBe("price_below");
    expect(response.autonomyGoalDraft?.triggerPrice).toBe("200");
    expect(response.tradeProposal).toBeUndefined();
    // The prepare path was never invoked — nothing to sign or execute.
    expect(runTool).not.toHaveBeenCalled();
    // The reply explains the boundary; it must not claim anything is active.
    expect(response.reply).toMatch(/OFF until you review and activate/i);
  });

  it("keeps recurring 'keep buying' phrasing out of the one-shot prepare too", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Keep buying 20 USDC of NVDAc every time it drops to 100 USDC"),
    );

    expect(response.autonomyGoalDraft).toBeDefined();
    expect(response.autonomyGoalDraft?.targetAsset).toBe("NVDAc");
    expect(response.tradeProposal).toBeUndefined();
    expect(runTool).not.toHaveBeenCalled();
  });

  it("does NOT capture a one-shot swap — assisted flow is unchanged", async () => {
    // A plain swap with a trigger-free prompt must behave exactly as
    // before this branch existed: no autonomy draft, and the prompt falls
    // through to the existing trade-prepare branch (mocked here so only
    // the routing is under test).
    runTool.mockResolvedValue(
      toolSuccess("trade_prepare_swap", {
        proposal: { id: "trade_test", requiresConfirmation: true },
      }),
    );

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Swap 1 USDC to AAPLc"),
    );

    expect(response.autonomyGoalDraft).toBeUndefined();
    // The prompt reached the EXISTING assisted trade branch, unchanged.
    expect(runTool).toHaveBeenCalled();
    expect(response.tradeProposal).toBeDefined();
  });

  it("does NOT capture balance questions even when they mention prices", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("What is my AAPLc balance?"),
    );

    expect(response.autonomyGoalDraft).toBeUndefined();
  });
});

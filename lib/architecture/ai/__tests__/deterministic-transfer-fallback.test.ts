import { afterEach, describe, expect, it, vi } from "vitest";

import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { AIProviderRequest } from "../ai-provider";
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

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

const proposal = {
  id: "transfer_test",
  requiresConfirmation: true,
  network: "base",
  kind: "native-transfer",
  amount: "1000000000000",
  sender: "0x00000000000000000000000000000000000000aa",
  recipient: {
    address: "0x2211d1D0020DAEA8039E46Cf1367962070d77DA9",
    inputKind: "basename",
    basename: "jesse.base.eth",
  },
};

describe("DeterministicAIProvider transfer fallback", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("prepares a review-only Base transfer when Gemini is unavailable", async () => {
    runTool.mockResolvedValue(
      toolSuccess("transfer_prepare_send", { proposal }),
    );

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Send 0.000001 ETH to jesse.base.eth"),
    );

    expect(runTool).toHaveBeenCalledWith(
      "transfer_prepare_send",
      {
        token: "ETH",
        amount: "0.000001",
        recipient: "jesse.base.eth",
      },
      expect.any(Object),
    );
    expect(runTool.mock.calls[0]?.[0]).not.toBe("transfer_execute");
    expect(response.transferProposal).toEqual(proposal);
    expect(response.transferProposal?.requiresConfirmation).toBe(true);
    expect(response.reply).toContain("Nothing is signed or submitted");
  });

  it("surfaces a grounded transfer failure instead of swallowing it", async () => {
    runTool.mockResolvedValue(
      toolError("transfer_prepare_send", {
        code: "INVALID_INPUT",
        message: 'Could not resolve "badname.base.eth" to an address.',
      }),
    );

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Send 0.000001 ETH to badname.base.eth"),
    );

    expect(response.transferProposal).toBeUndefined();
    expect(response.reply).toContain("Could not resolve");
  });

  it("does not prepare an incomplete transfer", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Send ETH"),
    );

    expect(runTool).not.toHaveBeenCalled();
    expect(response.reply).toContain("need token, amount, and recipient");
  });
});

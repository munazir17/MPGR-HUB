import { afterEach, describe, expect, it, vi } from "vitest";

import { DeterministicAIProvider } from "../deterministic-ai-provider";
import { detectIntent, isX402PaymentPrompt } from "@/lib/agent-intelligence";
import type { AIProviderRequest } from "../ai-provider";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

vi.mock("../agent-tool-calling", () => ({
  runRegisteredTool: vi.fn(),
}));

import { runRegisteredTool } from "../agent-tool-calling";

const runTool = vi.mocked(runRegisteredTool);

const X402_PROMPT =
  "Prepare a payment proposal for this x402 resource and ask for my explicit confirmation before any payment: https://x402-demo-discovery-endpoint.vercel.app/protected";

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

function fixtureProposal(): X402PaymentProposal {
  return {
    id: "x402_test",
    requirement: {
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: "1000",
      resource: "https://x402-demo-discovery-endpoint.vercel.app/protected",
      payTo: "0x021028695EAfDDe60E139D87000a8bd6cB65645e",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    eip712Domain: {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      source: "known-asset-registry",
    },
    displayAmount: "0.001 USDC",
    description: "Pay 0.001 USDC",
    postConfirmationSteps: ["review"],
    warnings: ["real payment"],
    requiresConfirmation: true,
    phase: "idle",
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("DeterministicAIProvider x402 fallback", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("does not classify an x402 payment prompt as xp_status", () => {
    expect(isX402PaymentPrompt(X402_PROMPT)).toBe(true);
    expect(detectIntent(X402_PROMPT, null).intent).toBe("general_help");
    expect(detectIntent("How much XP do I have?", null).intent).toBe("xp_status");
  });

  it("prepares a review-only proposal when Gemini is unavailable", async () => {
    const proposal = fixtureProposal();
    runTool.mockResolvedValue(
      toolSuccess("x402_prepare_payment", { proposal }),
    );

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest(X402_PROMPT),
    );

    expect(runTool).toHaveBeenCalledWith(
      "x402_prepare_payment",
      {
        resourceUrl:
          "https://x402-demo-discovery-endpoint.vercel.app/protected",
      },
      expect.any(Object),
    );
    expect(runTool.mock.calls[0]?.[0]).not.toBe("x402_execute_payment");
    expect(response.x402Proposal).toEqual(proposal);
    expect(response.x402Proposal?.requiresConfirmation).toBe(true);
    expect(response.x402Proposal?.phase).toBe("idle");
    expect(response.reply).toContain("explicitly confirm");
  });

  it("surfaces a grounded diagnostic instead of swallowing prepare failure", async () => {
    runTool.mockResolvedValue(
      toolError("x402_prepare_payment", {
        code: "DATA_UNAVAILABLE",
        message: "This resource is not currently requesting payment — there is nothing to prepare.",
      }),
    );

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest(X402_PROMPT),
    );

    expect(response.x402Proposal).toBeUndefined();
    expect(response.reply).toContain("could not prepare a payment proposal");
    expect(response.reply).toContain("Nothing was signed or submitted");
  });
});

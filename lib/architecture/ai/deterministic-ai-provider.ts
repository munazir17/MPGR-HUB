import {
  extractX402ResourceUrl,
  generateIntelligentReply,
  isX402PaymentPrompt,
} from "@/lib/agent-intelligence";
import { getFollowUpPrompts } from "@/lib/agent-actions";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import { runRegisteredTool } from "./agent-tool-calling";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";

// Phase 3C Part 1 — wraps generateIntelligentReply as the always-available
// local provider. FallbackAIProvider uses this class when Gemini throws.
//
// x402 addendum — payment prompts still never sign or submit. When the
// Gemini tool loop fails mid-flight, this provider runs the existing
// read/prepare tools itself so a review-only proposal can still surface.
// Prepare failures are returned as grounded diagnostics, not swallowed.

export class DeterministicAIProvider implements AIProvider {
  readonly name = "deterministic";
  readonly requiresNetwork = false;

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    if (isX402PaymentPrompt(request.prompt)) {
      return prepareOrExplainX402(request);
    }

    return generateIntelligentReply(
      request.prompt,
      request.agentContext,
      request.previousIntent,
      request.memoryContext
    );
  }
}

async function prepareOrExplainX402(
  request: AIProviderRequest,
): Promise<AIProviderResponse> {
  const resourceUrl = extractX402ResourceUrl(request.prompt);
  if (!resourceUrl) {
    return helpResponse(
      "This looks like an x402 paid-resource request, but I could not find a valid https resource URL to inspect. Paste the full https:// URL — nothing will be signed or submitted.",
    );
  }

  const result = await runRegisteredTool(
    "x402_prepare_payment",
    { resourceUrl },
    request,
  );

  if (result.success) {
    const proposal = (result.data as { proposal?: X402PaymentProposal } | undefined)
      ?.proposal;
    if (proposal) {
      return {
        intent: "general_help",
        reply:
          "I prepared an x402 payment proposal for your review. Nothing is signed or submitted until you explicitly confirm.",
        actions: [],
        highlights: [],
        followUps: getFollowUpPrompts("general_help"),
        x402Proposal: proposal,
      };
    }
  }

  const detail =
    typeof result.error?.message === "string" && result.error.message.trim()
      ? result.error.message.trim()
      : "The resource could not be prepared as a supported x402 payment.";

  return helpResponse(
    `I found the resource URL but could not prepare a payment proposal. ${detail} Nothing was signed or submitted.`,
  );
}

function helpResponse(reply: string): AIProviderResponse {
  return {
    intent: "general_help",
    reply,
    actions: [],
    highlights: [],
    followUps: getFollowUpPrompts("general_help"),
  };
}

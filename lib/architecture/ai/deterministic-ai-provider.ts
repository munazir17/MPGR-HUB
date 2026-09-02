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

export class DeterministicAIProvider implements AIProvider {
  readonly name = "deterministic";
  readonly requiresNetwork = false;

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    if (isX402PaymentPrompt(request.prompt)) {
      const prepared = await tryPrepareX402Proposal(request);
      if (prepared) return prepared;
    }

    return generateIntelligentReply(
      request.prompt,
      request.agentContext,
      request.previousIntent,
      request.memoryContext
    );
  }
}

async function tryPrepareX402Proposal(
  request: AIProviderRequest,
): Promise<AIProviderResponse | null> {
  const resourceUrl = extractX402ResourceUrl(request.prompt);
  if (!resourceUrl) return null;

  const result = await runRegisteredTool(
    "x402_prepare_payment",
    { resourceUrl },
    request,
  );

  if (!result.success) return null;

  const proposal = (result.data as { proposal?: X402PaymentProposal } | undefined)
    ?.proposal;
  if (!proposal) return null;

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

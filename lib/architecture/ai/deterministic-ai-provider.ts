import { generateIntelligentReply } from "@/lib/agent-intelligence";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";

// Phase 3C Part 1 — the current (and, for this phase, only) AIProvider
// implementation. Wraps lib/agent-intelligence.ts's
// generateIntelligentReply EXACTLY as lib/agent-engine.ts already called
// it directly before this file existed — this is a pure indirection, not
// a rewrite or a behavior change. Every existing reply — text, intent
// detection, smart actions, highlight chips, follow-up prompts, and every
// Phase 3B Part 2 memory-aware recall note — is produced by the exact
// same function call as before, with the exact same arguments, in the
// exact same order.
//
// Phase 3C Part 2 — declares `requiresNetwork = false`: this provider is
// local, synchronous under the hood, and cannot fail due to connectivity,
// which is exactly why lib/architecture/ai/fallback-ai-provider.ts uses
// an instance of this class as its fallback target.
export class DeterministicAIProvider implements AIProvider {
  readonly name = "deterministic";
  readonly requiresNetwork = false;

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    return generateIntelligentReply(
      request.prompt,
      request.agentContext,
      request.previousIntent,
      request.memoryContext
    );
  }
}

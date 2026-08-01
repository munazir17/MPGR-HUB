import { AGENT_INTENTS, type AgentIntent } from "@/lib/agent-intelligence";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import type { Logger } from "@/lib/architecture/core/types";

// Phase 3C Part 4 — AI Provider guardrails.
//
// A decorator, same shape as fallback-ai-provider.ts and
// ai-provider-diagnostics.ts: wraps a single AIProvider and validates its
// AIProviderResponse before it can reach lib/agent-engine.ts. This is
// where a real future LLM provider's raw output gets checked — today's
// DeterministicAIProvider always returns a well-formed response (it's
// TypeScript-checked at compile time), so this layer is a cheap no-op
// pass-through in practice. It exists NOW, ahead of any real network
// provider, because a model call's output is untrusted at compile time
// no matter how carefully it's prompted — it's a string that has to be
// checked, not a typed return value the compiler already guaranteed.
//
// Two kinds of problems, handled differently:
//   - Recoverable (reply needs trimming/truncating, actions/highlights/
//     followUps are missing, malformed, or too long): sanitized silently,
//     logged at "warn" only for anything actually truncated.
//   - Unrecoverable (reply is empty after trimming, intent isn't one of
//     lib/agent-intelligence.ts's AGENT_INTENTS): throws
//     AIProviderValidationError, which a wrapping FallbackAIProvider
//     (Phase 3C Part 2) can catch and fall back from, and which
//     DiagnosticsAIProvider (Phase 3C Part 3) records as a failure either
//     way.
//
// No network call, no SDK, no API key — this only inspects a value
// that's already in memory.

const MAX_REPLY_LENGTH = 4000;
const MAX_FOLLOW_UPS = 4;
const MAX_ACTIONS = 6;
const MAX_HIGHLIGHTS = 6;

export class AIProviderValidationError extends Error {
  constructor(message: string, public readonly providerName: string) {
    super(message);
    this.name = "AIProviderValidationError";
  }
}

function isValidIntent(value: unknown): value is AgentIntent {
  return typeof value === "string" && (AGENT_INTENTS as readonly string[]).includes(value);
}

export class GuardrailAIProvider implements AIProvider {
  readonly name: string;
  readonly requiresNetwork: boolean;

  constructor(private readonly provider: AIProvider, private readonly logger: Logger) {
    this.name = provider.name;
    this.requiresNetwork = provider.requiresNetwork;
  }

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    const response = await this.provider.generateReply(request);
    return this.validateAndSanitize(response);
  }

  private validateAndSanitize(response: AIProviderResponse): AIProviderResponse {
    const reply = typeof response.reply === "string" ? response.reply.trim() : "";
    if (!reply) {
      throw new AIProviderValidationError("AI provider returned an empty reply", this.provider.name);
    }

    if (!isValidIntent(response.intent)) {
      throw new AIProviderValidationError(
        `AI provider returned an unrecognized intent: "${String(response.intent)}"`,
        this.provider.name
      );
    }

    let sanitizedReply = reply;
    if (sanitizedReply.length > MAX_REPLY_LENGTH) {
      this.logger.warn("AI provider reply truncated by guardrails", {
        provider: this.provider.name,
        originalLength: sanitizedReply.length,
        maxLength: MAX_REPLY_LENGTH,
      });
      sanitizedReply = `${sanitizedReply.slice(0, MAX_REPLY_LENGTH)}…`;
    }

    const actions = Array.isArray(response.actions) ? response.actions.slice(0, MAX_ACTIONS) : [];
    const highlights = Array.isArray(response.highlights) ? response.highlights.slice(0, MAX_HIGHLIGHTS) : [];
    const followUps = Array.isArray(response.followUps)
      ? response.followUps
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, MAX_FOLLOW_UPS)
      : [];

    return {
      intent: response.intent,
      reply: sanitizedReply,
      actions,
      highlights,
      followUps,
    };
  }
}

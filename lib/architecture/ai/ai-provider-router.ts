import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import type { AIProviderKind } from "./ai-provider-config";
import {
  IMPLEMENTED_NETWORK_PROVIDER_KINDS,
  resolveConfiguredProviderKind,
} from "./ai-provider-config";
import type { EventBus, Logger } from "@/lib/architecture/core/types";

export type AgentModelTask = "research" | "structured" | "general";

const STRUCTURED_HINTS = [
  "swap",
  "trade",
  "transfer",
  "send",
  "x402",
  "payment",
  "prepare",
  "quote",
  "approve",
];

const RESEARCH_HINTS = [
  "what is",
  "explain",
  "research",
  "market",
  "tokenized",
  "base markets",
  "mpgr hub",
];

export function classifyAgentTask(prompt: string): AgentModelTask {
  const text = prompt.toLowerCase();
  if (STRUCTURED_HINTS.some((hint) => text.includes(hint))) return "structured";
  if (RESEARCH_HINTS.some((hint) => text.includes(hint))) return "research";
  return "general";
}

/**
 * Preferred network order for a turn.
 * Default remains the configured provider (Gemini unless NEXT_PUBLIC_AI_PROVIDER says otherwise).
 * Chain: Gemini → NVIDIA NIM → OpenAI → deterministic.
 * Research turns still prefer Gemini when it is implemented.
 * Unimplemented kinds are never returned.
 */
export function resolveProviderKindOrder(task: AgentModelTask): AIProviderKind[] {
  const configured = resolveConfiguredProviderKind();
  const network = IMPLEMENTED_NETWORK_PROVIDER_KINDS.filter((kind) => kind !== "deterministic");

  let preferred: AIProviderKind = configured;
  if (task === "research" && network.includes("gemini")) {
    preferred = "gemini";
  }

  const rest = network.filter((kind) => kind !== preferred);
  const ordered: AIProviderKind[] = [];
  if (preferred !== "deterministic") ordered.push(preferred);
  for (const kind of rest) {
    if (!ordered.includes(kind)) ordered.push(kind);
  }
  ordered.push("deterministic");
  return ordered;
}

export function isRateLimitMessage(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("429") || text.includes("rate limit") || text.includes("resource_exhausted") || text.includes("quota");
}

export class ProviderChainAIProvider implements AIProvider {
  readonly name: string;
  readonly requiresNetwork: boolean;

  constructor(
    public readonly providers: readonly AIProvider[],
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
  ) {
    const first = providers[0];
    this.name = first?.name ?? "chain";
    this.requiresNetwork = providers.some((provider) => provider.requiresNetwork);
  }

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    if (this.providers.length === 0) {
      throw new Error("No AI providers configured");
    }

    let lastError: unknown;
    for (let i = 0; i < this.providers.length; i += 1) {
      const provider = this.providers[i];
      try {
        const response = await provider.generateReply(request);
        if (i > 0) {
          this.logger.debug("AI provider chain recovered", {
            provider: provider.name,
            attempt: i + 1,
          });
        }
        return response;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        const next = this.providers[i + 1];
        this.logger.error("AI provider chain step failed", {
          provider: provider.name,
          rateLimited: isRateLimitMessage(message),
          timeout: err instanceof Error && err.name === "AIProviderTimeoutError",
          message,
        });
        this.eventBus.emit("ai_provider_error", {
          address: request.address ?? "unknown",
          provider: provider.name,
          message,
        });
        if (next) {
          this.eventBus.emit("ai_provider_fallback", {
            address: request.address ?? "unknown",
            from: provider.name,
            to: next.name,
          });
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("All AI providers failed");
  }
}

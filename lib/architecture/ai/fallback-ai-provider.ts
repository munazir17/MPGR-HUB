import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import type { EventBus, Logger } from "@/lib/architecture/core/types";

// Phase 3C Part 2 — AI Provider resilience.
//
// A decorator, not a new provider: wraps a primary AIProvider and a
// fallback AIProvider, both supplied via constructor injection (no
// singleton pulled from inside this class — the same discipline
// lib/architecture/ai/agent-ai-service.ts already follows). If
// primary.generateReply() throws or rejects, this logs it, emits
// ai_provider_error and ai_provider_fallback events on the injected
// EventBus (the exact same AgentEventMap every other AI module already
// emits on — see lib/architecture/core/types.ts), and returns the
// fallback provider's result instead of letting the error propagate to
// lib/agent-engine.ts's callers.
//
// Nothing in this file makes a network call — it only decides what to do
// if one were to fail. It exists now, ahead of any real network
// provider, so that when a later Phase 3C part adds one (e.g. an
// OpenAIProvider), wrapping it is a one-line change at the composition
// root (lib/architecture/ai/agent-ai-service-instance.ts):
//
//   setAIProvider(new FallbackAIProvider(
//     new OpenAIProvider(...),
//     new DeterministicAIProvider(),
//     agentEventBus,
//     logger,
//   ));
//
// — with zero changes to lib/agent-engine.ts,
// lib/architecture/ai/ai-provider-registry.ts, or anything upstream of
// it. `name`/`requiresNetwork` mirror the PRIMARY provider so
// logging/diagnostics reflect what's actually being attempted first, not
// the fallback that only runs on failure.
//
// Not wired into ai-provider-registry.ts yet — there is only one
// provider (DeterministicAIProvider) today, and wrapping it as its own
// fallback would be a meaningless no-op. This class becomes active the
// moment a second provider exists.
export class FallbackAIProvider implements AIProvider {
  readonly name: string;
  readonly requiresNetwork: boolean;

  constructor(
    private readonly primary: AIProvider,
    private readonly fallback: AIProvider,
    private readonly eventBus: EventBus,
    private readonly logger: Logger
  ) {
    this.name = primary.name;
    this.requiresNetwork = primary.requiresNetwork;
  }

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    try {
      return await this.primary.generateReply(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const address = request.address ?? "unknown";

      this.logger.error("AI provider failed, falling back", {
        provider: this.primary.name,
        fallback: this.fallback.name,
        message,
      });
      this.eventBus.emit("ai_provider_error", { address, provider: this.primary.name, message });
      this.eventBus.emit("ai_provider_fallback", { address, from: this.primary.name, to: this.fallback.name });

      return this.fallback.generateReply(request);
    }
  }
}

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
// if one were to fail. `name`/`requiresNetwork` mirror the PRIMARY
// provider so logging/diagnostics reflect what's actually being
// attempted first, not the fallback that only runs on failure.
//
// Phase 3C Part 5 — now actually wired in as the outermost layer of
// lib/architecture/ai/ai-provider-registry.ts's default composition:
// primary is the full guarded/circuit-broken/diagnosed chain, fallback is
// a bare DeterministicAIProvider — the ultimate, always-available safety
// net if anything upstream throws for any reason.
//
// `primary` and `fallback` are exposed as public readonly properties
// (rather than private) so a composition root can introspect the chain —
// e.g. ai-provider-registry.ts's getAIProviderDiagnostics() walks into
// `.primary` to find a nested DiagnosticsAIProvider. This is read-only
// exposure of already-injected dependencies, not a new dependency or a
// behavior change.
export class FallbackAIProvider implements AIProvider {
  readonly name: string;
  readonly requiresNetwork: boolean;

  constructor(
    public readonly primary: AIProvider,
    public readonly fallback: AIProvider,
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
      const code =
        err instanceof Error && typeof (err as { code?: unknown }).code === "string"
          ? (err as { code: string }).code
          : undefined;
      const address = request.address ?? "unknown";

      this.logger.error("AI provider failed, falling back", {
        provider: this.primary.name,
        fallback: this.fallback.name,
        message,
        code,
      });
      this.eventBus.emit("ai_provider_error", { address, provider: this.primary.name, message, code });
      this.eventBus.emit("ai_provider_fallback", { address, from: this.primary.name, to: this.fallback.name });

      return this.fallback.generateReply(request);
    }
  }
}

import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import type { EventBus, Logger } from "@/lib/architecture/core/types";

// Phase 3C Part 5 — AI Provider circuit breaker.
//
// A decorator, same shape as every other lib/architecture/ai/*-provider.ts
// wrapper (fallback-ai-provider.ts, ai-provider-diagnostics.ts,
// ai-provider-guardrails.ts). Tracks CONSECUTIVE failures of the wrapped
// provider; once failureThreshold is hit, the circuit "opens" and every
// further call fails FAST — CircuitOpenError is thrown immediately,
// without invoking the wrapped provider at all — until resetTimeoutMs has
// elapsed. At that point exactly one "half-open" trial call is let
// through: success closes the circuit again, failure re-opens it and
// restarts the cooldown.
//
// This matters most once a real network provider exists: without it, a
// primary provider that's genuinely down (outage, rate limit, bad
// credentials) would still be called — and awaited, and timed out — on
// every single message for as long as the outage lasts, adding real
// latency to every reply. With this wrapped around the primary (see
// lib/architecture/ai/ai-provider-registry.ts), the surrounding
// FallbackAIProvider (Phase 3C Part 2) gets an immediate rejection to
// fall back from instead, once the failure pattern is established —
// instead of a slow one.
//
// Purely in-memory control flow — no network call, no timer library, no
// new dependency, no setTimeout even (cooldown is checked lazily on the
// next call via Date.now(), not scheduled). Emits
// ai_provider_circuit_opened / ai_provider_circuit_closed on the injected
// EventBus for observability, mirroring how fallback-ai-provider.ts
// already emits ai_provider_error / ai_provider_fallback.

export interface CircuitBreakerConfig {
  /** Consecutive failures required before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial call is allowed. */
  resetTimeoutMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
};

export class CircuitOpenError extends Error {
  constructor(public readonly providerName: string) {
    super(`Circuit breaker is open for AI provider "${providerName}" — skipping call.`);
    this.name = "CircuitOpenError";
  }
}

type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreakerAIProvider implements AIProvider {
  readonly name: string;
  readonly requiresNetwork: boolean;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly config: CircuitBreakerConfig;

  constructor(
    private readonly provider: AIProvider,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    this.name = provider.name;
    this.requiresNetwork = provider.requiresNetwork;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    if (this.state === "open") {
      if (!this.hasCooldownElapsed()) {
        throw new CircuitOpenError(this.provider.name);
      }
      // Cooldown elapsed — allow exactly one trial call through.
      this.state = "half-open";
    }

    try {
      const response = await this.provider.generateReply(request);
      this.onSuccess();
      return response;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private hasCooldownElapsed(): boolean {
    return this.openedAt !== null && Date.now() - this.openedAt >= this.config.resetTimeoutMs;
  }

  private onSuccess(): void {
    if (this.state !== "closed") {
      this.logger.warn("AI provider circuit closed after successful trial call", { provider: this.provider.name });
      this.eventBus.emit("ai_provider_circuit_closed", { provider: this.provider.name });
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;

    if (this.state === "half-open" || this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
      this.logger.warn("AI provider circuit opened", {
        provider: this.provider.name,
        consecutiveFailures: this.consecutiveFailures,
      });
      this.eventBus.emit("ai_provider_circuit_opened", {
        provider: this.provider.name,
        consecutiveFailures: this.consecutiveFailures,
      });
    }
  }
}

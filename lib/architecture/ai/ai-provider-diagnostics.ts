import type { AIProvider, AIProviderRequest, AIProviderResponse } from "./ai-provider";
import type { Logger, PerformanceMonitor } from "@/lib/architecture/core/types";

// Phase 3C Part 3 — AI Provider diagnostics.
//
// A decorator, not a new provider — same shape as
// lib/architecture/ai/fallback-ai-provider.ts: wraps a single AIProvider,
// forwards every request/response through untouched, and records
// observability data on the side. Constructor-injected PerformanceMonitor
// and Logger (no singleton pulled from inside this class), reusing
// lib/architecture/core/performance-monitor.ts's existing timing/metrics
// storage instead of building a second one — every call is recorded
// under the label "ai.provider.<name>" and is visible through that
// monitor's own getMetrics(), exactly like every agent.* label
// lib/architecture/ai/agent-ai-service.ts already records.
//
// getStats() exposes a plain, serializable snapshot (call count,
// success/failure counts, last error, last call time) — no network call,
// no analytics provider wired up, just in-memory counters. Intended for
// a future diagnostics/settings surface; nothing calls getStats() yet.
export interface AIProviderStats {
  name: string;
  requiresNetwork: boolean;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  lastError: string | null;
  lastCallAt: string | null;
}

export class DiagnosticsAIProvider implements AIProvider {
  readonly name: string;
  readonly requiresNetwork: boolean;

  private totalCalls = 0;
  private successCount = 0;
  private failureCount = 0;
  private lastError: string | null = null;
  private lastCallAt: string | null = null;

  constructor(
    private readonly provider: AIProvider,
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly logger: Logger
  ) {
    this.name = provider.name;
    this.requiresNetwork = provider.requiresNetwork;
  }

  async generateReply(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.totalCalls += 1;
    this.lastCallAt = new Date().toISOString();

    try {
      const response = await this.performanceMonitor.time(`ai.provider.${this.provider.name}`, () =>
        this.provider.generateReply(request)
      );
      this.successCount += 1;
      return response;
    } catch (err) {
      this.failureCount += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn("AI provider call failed", { provider: this.provider.name, message: this.lastError });
      // Re-thrown, not swallowed — a wrapping FallbackAIProvider (Phase
      // 3C Part 2) placed around this provider must still see the
      // failure to trigger its own fallback logic. This decorator only
      // observes; it never changes control flow.
      throw err;
    }
  }

  getStats(): AIProviderStats {
    return {
      name: this.name,
      requiresNetwork: this.requiresNetwork,
      totalCalls: this.totalCalls,
      successCount: this.successCount,
      failureCount: this.failureCount,
      lastError: this.lastError,
      lastCallAt: this.lastCallAt,
    };
  }
}

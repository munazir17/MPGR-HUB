import type { AIProvider } from "./ai-provider";
import { createAIProvider } from "./ai-provider-factory";
import { resolveConfiguredProviderKind } from "./ai-provider-config";
import { DiagnosticsAIProvider, type AIProviderStats } from "./ai-provider-diagnostics";
import { GuardrailAIProvider } from "./ai-provider-guardrails";
import { CircuitBreakerAIProvider } from "./circuit-breaker-ai-provider";
import { FallbackAIProvider } from "./fallback-ai-provider";
import { DeterministicAIProvider } from "./deterministic-ai-provider";
import { agentPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { logger } from "@/lib/architecture/core/logger";

// Phase 3C Part 1 — composition point for the AIProvider dependency,
// mirroring lib/architecture/memory/memory-provider-registry.ts exactly.
// lib/agent-engine.ts calls this module's getAIProvider() instead of
// importing a concrete provider directly.
//
// Phase 3C Part 5 — the default composition now uses every decorator
// built across Parts 2–5, in this order (innermost to outermost):
//
//   createAIProvider(kind)        Part 1/3 — the raw provider
//     -> GuardrailAIProvider      Part 4 — validates/sanitizes output
//     -> CircuitBreakerAIProvider Part 5 — fails fast after repeated failures
//     -> DiagnosticsAIProvider    Part 3 — records call/success/failure metrics
//   = "primary", wrapped by:
//   FallbackAIProvider            Part 2 — falls back to a bare
//                                  DeterministicAIProvider (no guardrails/
//                                  circuit-breaker/diagnostics — the
//                                  simplest possible path) if primary
//                                  throws for any reason at all.
//
// This is a pure indirection today, not a behavior change: today
// resolveConfiguredProviderKind() always resolves to "deterministic",
// whose output is always well-formed and never throws — so
// GuardrailAIProvider passes it through unchanged, the circuit breaker
// never opens, DiagnosticsAIProvider records nothing but successes, and
// FallbackAIProvider's fallback path is never actually exercised. Every
// existing reply is produced exactly as before. This composition exists
// now so that when a later Phase 3C part adds a real network provider,
// EVERY piece of resilience infrastructure it needs already exists and
// is already wired — only createAIProvider() gains a new case.
//
// This module directly imports agentPerformanceMonitor, agentEventBus,
// and logger (the same singletons lib/architecture/ai/agent-ai-service-instance.ts
// already wires in) rather than accepting them as parameters — this
// registry, like memory-provider-registry.ts before it, IS a composition
// root for its one concern, not business logic; that's the established
// exception to "no singleton pulled from inside a class" this codebase
// already follows in lib/architecture/memory/memory-provider-registry.ts.
function buildDefaultProvider(): AIProvider {
  const base = createAIProvider(resolveConfiguredProviderKind());
  const guarded = new GuardrailAIProvider(base, logger);
  const circuitBroken = new CircuitBreakerAIProvider(guarded, agentEventBus, logger);
  const diagnosed = new DiagnosticsAIProvider(circuitBroken, agentPerformanceMonitor, logger);
  const safetyNet = new DeterministicAIProvider();
  return new FallbackAIProvider(diagnosed, safetyNet, agentEventBus, logger);
}

let activeProvider: AIProvider = buildDefaultProvider();

export function getAIProvider(): AIProvider {
  return activeProvider;
}

export function setAIProvider(provider: AIProvider): void {
  activeProvider = provider;
}

/**
 * Returns call/success/failure diagnostics for the active provider, or
 * null if none can be found. Looks at the active provider directly first
 * (in case a future setAIProvider() call sets a bare DiagnosticsAIProvider
 * as the top-level provider), then falls back to checking inside a
 * FallbackAIProvider's `.primary` (today's default composition, where
 * DiagnosticsAIProvider is nested one level in). Never throws.
 */
export function getAIProviderDiagnostics(): AIProviderStats | null {
  if (activeProvider instanceof DiagnosticsAIProvider) return activeProvider.getStats();
  if (activeProvider instanceof FallbackAIProvider && activeProvider.primary instanceof DiagnosticsAIProvider) {
    return activeProvider.primary.getStats();
  }
  return null;
}

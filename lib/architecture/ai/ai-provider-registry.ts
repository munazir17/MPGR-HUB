import type { AIProvider } from "./ai-provider";
import { createAIProvider } from "./ai-provider-factory";
import { resolveConfiguredProviderKind } from "./ai-provider-config";
import { DiagnosticsAIProvider, type AIProviderStats } from "./ai-provider-diagnostics";
import { agentPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import { logger } from "@/lib/architecture/core/logger";

// Phase 3C Part 1 — composition point for the AIProvider dependency,
// mirroring lib/architecture/memory/memory-provider-registry.ts exactly.
// lib/agent-engine.ts calls this module's getAIProvider() instead of
// importing a concrete provider directly.
//
// Phase 3C Part 3 addendum — the default active provider is now actually
// built from Part 2's config resolver (resolveConfiguredProviderKind())
// via Part 3's factory (createAIProvider()), rather than a hardcoded
// `new DeterministicAIProvider()`. It's also wrapped in
// DiagnosticsAIProvider (Part 3) for call-count/latency/error visibility.
// This is a pure indirection, not a behavior change: today
// resolveConfiguredProviderKind() always resolves to "deterministic" (no
// other kind is implemented yet), so createAIProvider() always returns a
// DeterministicAIProvider, and DiagnosticsAIProvider forwards every
// request/response through it untouched — every existing reply is
// produced exactly as before.
//
// This module directly imports agentPerformanceMonitor and logger (the
// same singletons lib/architecture/ai/agent-ai-service-instance.ts
// already wires in) rather than accepting them as parameters — this
// registry, like memory-provider-registry.ts before it, IS a composition
// root for its one concern, not business logic; that's the established
// exception to "no singleton pulled from inside a class" this codebase
// already follows in lib/architecture/memory/memory-provider-registry.ts.
//
// Phase 3C Part 2+ swap point (unchanged): once an OpenAIProvider /
// AnthropicProvider / GeminiProvider / OllamaProvider exists, call
// setAIProvider(...) once with whatever composition is appropriate (e.g.
// wrapped in FallbackAIProvider and/or DiagnosticsAIProvider) — every
// existing caller of getAIProvider() picks up the new provider
// automatically.
function buildDefaultProvider(): AIProvider {
  return new DiagnosticsAIProvider(createAIProvider(resolveConfiguredProviderKind()), agentPerformanceMonitor, logger);
}

let activeProvider: AIProvider = buildDefaultProvider();

export function getAIProvider(): AIProvider {
  return activeProvider;
}

export function setAIProvider(provider: AIProvider): void {
  activeProvider = provider;
}

/**
 * Phase 3C Part 3 — returns call/success/failure diagnostics for the
 * active provider, or null if it isn't diagnostics-wrapped (e.g. after a
 * future setAIProvider() call whose composition doesn't include
 * DiagnosticsAIProvider). Never throws. Nothing calls this yet — it's
 * exposed for a future diagnostics surface.
 */
export function getAIProviderDiagnostics(): AIProviderStats | null {
  return activeProvider instanceof DiagnosticsAIProvider ? activeProvider.getStats() : null;
}

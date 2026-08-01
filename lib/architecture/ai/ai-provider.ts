import type { AgentContext } from "@/lib/agent-context";
import type { AgentIntent } from "@/lib/agent-intelligence";
import type { AgentAction, AgentHighlight } from "@/lib/agent-actions";
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";

// Phase 3C Part 1 — AIProvider abstraction. Mirrors
// lib/architecture/memory/memory-provider.ts exactly: an interface, one
// concrete implementation today (deterministic-ai-provider.ts), and a
// registry composition point (ai-provider-registry.ts).
//
// This is a REPLACEMENT SEAM, not a new reasoning system. Everything the
// deterministic engine already receives — the Context Builder's merged
// AgentContext + ConversationMemoryContext + previousIntent
// (lib/agent-prompt-context.ts, Phase 3B Part 4) — is exactly what an
// AIProviderRequest carries below. AIProviderResponse is structurally
// identical to lib/agent-intelligence.ts's existing
// AgentIntelligenceResult, but declared independently here so THIS file
// has zero dependency on the deterministic engine module — a future
// OpenAIProvider/AnthropicProvider/GeminiProvider/OllamaProvider
// implements this interface without importing anything from
// lib/agent-intelligence.ts.
//
// No network call, no SDK import, no API key exists anywhere in this
// file or its one implementation — Phase 3C Part 1 is interfaces plus one
// wrapper around the already-working deterministic engine, nothing else.
// Everything compiles with no new dependencies and no runtime behavior
// change.

export interface AIProviderRequest {
  prompt: string;
  agentContext: AgentContext;
  previousIntent: AgentIntent | null;
  memoryContext: ConversationMemoryContext;
}

export interface AIProviderResponse {
  intent: AgentIntent;
  reply: string;
  actions: AgentAction[];
  highlights: AgentHighlight[];
  followUps: string[];
}

export interface AIProvider {
  /**
   * Short, stable identifier for logging/diagnostics only — e.g.
   * "deterministic", "openai", "anthropic", "gemini", "ollama". Never
   * shown to end users; intended for lib/architecture/core/logger.ts
   * once a real provider swap happens in a later part.
   */
  readonly name: string;

  /**
   * Produces a reply for one turn. Declared async (Promise-returning)
   * even though the current implementation is synchronous under the
   * hood — the same reasoning as MemoryProvider.get/set already being
   * async ahead of a real network-backed provider: every future
   * implementation (a real model call) is a drop-in replacement with no
   * call-site changes required anywhere in the app.
   */
  generateReply(request: AIProviderRequest): Promise<AIProviderResponse>;
}

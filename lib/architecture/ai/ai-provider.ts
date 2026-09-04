import type { AgentContext } from "@/lib/agent-context";
import type { AgentIntent } from "@/lib/agent-intelligence";
import type { AgentAction, AgentHighlight } from "@/lib/agent-actions";
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { TokenizedStockReport, TradeProposal } from "@/lib/trade/trade-types";

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
// file or its implementations — Phase 3C Part 1/2 is interfaces plus
// wrappers around the already-working deterministic engine and around
// error handling, nothing else. Everything compiles with no new
// dependencies and no runtime behavior change.
//
// Phase 3C Part 2 addendum — `requiresNetwork` and `AIProviderRequest.address`
// are additive. `requiresNetwork` lets a future composition root or UI
// (e.g. a settings screen) distinguish "local, always-available" from
// "needs connectivity" providers without special-casing by name.
// `address` is optional so every existing construction of an
// AIProviderRequest (lib/agent-engine.ts, before this addition) remains
// valid without a compile error — it's populated going forward so
// lib/architecture/ai/fallback-ai-provider.ts's emitted events carry the
// same address every other AgentEventMap payload already does.

export interface AIProviderRequest {
  prompt: string;
  agentContext: AgentContext;
  previousIntent: AgentIntent | null;
  memoryContext: ConversationMemoryContext;
  /** Phase 3C Part 2 — optional so this remains backward compatible;
   *  lib/agent-engine.ts populates it on every call. */
  address?: string;
}

export interface AIProviderResponse {
  intent: AgentIntent;
  reply: string;
  actions: AgentAction[];
  highlights: AgentHighlight[];
  followUps: string[];
  /**
   * P3 — set only when this turn's tool-calling loop ran
   * x402_prepare_payment and it succeeded (see
   * lib/architecture/ai/agent-tool-calling.ts's runToolCallingLoop).
   * Always taken directly from that tool's own structured result, never
   * constructed from the model's reply text. Optional/additive so every
   * existing AIProviderResponse construction (DeterministicAIProvider,
   * every existing test) remains valid without change.
   */
  x402Proposal?: X402PaymentProposal;
  /**
   * P4 — set only when this turn's tool-calling loop ran
   * trade_prepare_swap successfully. Taken from the tool result, never
   * from model text. Optional/additive.
   */
  tradeProposal?: TradeProposal;
  /**
   * P4 — set only when tokenized_stock_research succeeded.
   */
  tokenizedStockReport?: TokenizedStockReport;
}

export interface AIProvider {
  /** Short, stable identifier for logging/diagnostics only — e.g.
   *  "deterministic", "openai", "anthropic", "gemini", "ollama". Never
   *  shown to end users. */
  readonly name: string;

  /** Phase 3C Part 2 — true for providers that require an external
   *  network call (a real model API), false for local/deterministic
   *  ones. DeterministicAIProvider declares `false`; a future
   *  OpenAIProvider would declare `true`. Used by
   *  lib/architecture/ai/fallback-ai-provider.ts and future
   *  diagnostics/UI, never by reasoning logic itself. */
  readonly requiresNetwork: boolean;

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

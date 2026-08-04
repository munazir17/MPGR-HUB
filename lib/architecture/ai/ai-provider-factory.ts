import type { AIProvider } from "./ai-provider";
import type { AIProviderKind } from "./ai-provider-config";
import { DeterministicAIProvider } from "./deterministic-ai-provider";
import { OpenAIAIProvider } from "./openai-ai-provider";
import { GeminiAIProvider } from "./gemini-ai-provider";

// Phase 3C Part 3 — AI Provider factory.
//
// Maps a resolved AIProviderKind (lib/architecture/ai/ai-provider-config.ts)
// to a concrete AIProvider instance.
//
// Phase 3C Part 6 addendum — "openai" now returns a real OpenAIAIProvider
// (lib/architecture/ai/openai-ai-provider.ts). Every other unimplemented
// kind still falls through to DeterministicAIProvider as defense in
// depth — resolveConfiguredProviderKind() already never returns a kind
// that isn't in IMPLEMENTED_PROVIDER_KINDS, so this function should never
// actually need that fallback in practice, but it's written so it can
// NEVER throw or return undefined regardless of what's passed in.
//
// Gemini addendum — "gemini" now returns a real GeminiAIProvider
// (lib/architecture/ai/gemini-ai-provider.ts), added alongside "openai",
// not replacing it. Both are real, independently selectable providers —
// which one runs is entirely decided by resolveConfiguredProviderKind()
// (NEXT_PUBLIC_AI_PROVIDER). No other file needs to change — this is the
// single place a provider kind turns into an actual object.
//
// As later Phase 3C parts add more real implementations
// (AnthropicProvider, OllamaProvider), this function gains one case per
// provider.
export function createAIProvider(kind: AIProviderKind): AIProvider {
  switch (kind) {
    case "openai":
      return new OpenAIAIProvider();
    case "gemini":
      return new GeminiAIProvider();
    case "deterministic":
    default:
      return new DeterministicAIProvider();
  }
}

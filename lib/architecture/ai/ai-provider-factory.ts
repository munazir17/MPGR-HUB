import type { AIProvider } from "./ai-provider";
import type { AIProviderKind } from "./ai-provider-config";
import { DeterministicAIProvider } from "./deterministic-ai-provider";

// Phase 3C Part 3 — AI Provider factory.
//
// Maps a resolved AIProviderKind (lib/architecture/ai/ai-provider-config.ts)
// to a concrete AIProvider instance. Only "deterministic" has a real
// implementation today (Phase 3C Part 1) — every other kind falls
// through to it as well, purely as defense in depth: in practice,
// resolveConfiguredProviderKind() already never returns a kind that
// isn't implemented, so this function should never actually need that
// fallback, but it's written so it can NEVER throw or return undefined
// regardless of what's passed in.
//
// As later Phase 3C parts add real implementations (OpenAIProvider,
// AnthropicProvider, GeminiProvider, OllamaProvider), this function
// gains one case per provider. No other file needs to change — this is
// the single place a provider kind turns into an actual object.
export function createAIProvider(kind: AIProviderKind): AIProvider {
  switch (kind) {
    case "deterministic":
    default:
      return new DeterministicAIProvider();
  }
}

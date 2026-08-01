import type { AIProvider } from "./ai-provider";
import { DeterministicAIProvider } from "./deterministic-ai-provider";

// Phase 3C Part 1 — composition point for the AIProvider dependency,
// mirroring lib/architecture/memory/memory-provider-registry.ts exactly.
// lib/agent-engine.ts calls this module's getAIProvider() instead of
// importing DeterministicAIProvider (or any future concrete provider)
// directly — same "one seam, not a new pattern" approach already
// established by the Memory Provider registry.
//
// Phase 3C Part 2+ swap point: once an OpenAIProvider / AnthropicProvider
// / GeminiProvider / OllamaProvider exists, call
// setAIProvider(new OpenAIProvider(...)) once — every existing caller of
// getAIProvider() picks up the new provider automatically. No other file
// in the codebase needs to change for that swap.
let activeProvider: AIProvider = new DeterministicAIProvider();

export function getAIProvider(): AIProvider {
  return activeProvider;
}

export function setAIProvider(provider: AIProvider): void {
  activeProvider = provider;
}

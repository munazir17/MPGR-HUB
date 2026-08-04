// Phase 3C Part 2 — AI Provider configuration & selection.
//
// A pure, side-effect-free (besides reading process.env) resolver for
// WHICH provider kind should be active — not the provider itself. No
// API key is read or referenced here; only a plain string identifying
// which provider a composition root (lib/architecture/ai/ai-provider-registry.ts)
// should construct.
//
// Phase 3C Part 6 addendum — "openai" is implemented
// (lib/architecture/ai/openai-ai-provider.ts + app/api/agent/complete/route.ts)
// and added to IMPLEMENTED_PROVIDER_KINDS.
//
// Gemini addendum — "gemini" is now also implemented
// (lib/architecture/ai/gemini-ai-provider.ts +
// app/api/agent/complete/gemini/route.ts), added to
// IMPLEMENTED_PROVIDER_KINDS alongside "openai" (not replacing it — both
// remain selectable), and is now the DEFAULT provider kind: setting
// NEXT_PUBLIC_AI_PROVIDER=openai is still fully supported and switches
// back to OpenAI; leaving it unset now resolves to "gemini" instead of
// "deterministic". "anthropic" / "ollama" remain declared-but-unimplemented;
// requesting either still falls back to "deterministic", exactly as
// before.

export type AIProviderKind = "deterministic" | "openai" | "anthropic" | "gemini" | "ollama";

const DEFAULT_PROVIDER_KIND: AIProviderKind = "gemini";

const ALL_PROVIDER_KINDS: readonly AIProviderKind[] = ["deterministic", "openai", "anthropic", "gemini", "ollama"];

// Grows as later Phase 3C parts add real implementations. Kept as its own
// explicit list (rather than inferred from a registry) so "is this kind
// actually usable right now" has a single, obvious source of truth.
const IMPLEMENTED_PROVIDER_KINDS: readonly AIProviderKind[] = ["deterministic", "openai", "gemini"];

function isKnownProviderKind(value: string): value is AIProviderKind {
  return (ALL_PROVIDER_KINDS as readonly string[]).includes(value);
}

export function isProviderKindImplemented(kind: AIProviderKind): boolean {
  return IMPLEMENTED_PROVIDER_KINDS.includes(kind);
}

/**
 * Reads the requested provider kind from NEXT_PUBLIC_AI_PROVIDER (a
 * plain identifier string — no key, no endpoint, no secret) and falls
 * back to "gemini" (the default) when unset, unrecognized, or not yet
 * implemented. Never throws and performs no I/O beyond reading env, so a
 * composition root can call it unconditionally at startup without any
 * error handling of its own.
 */
export function resolveConfiguredProviderKind(): AIProviderKind {
  const raw = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AI_PROVIDER : undefined;
  if (!raw) return DEFAULT_PROVIDER_KIND;

  const normalized = raw.trim().toLowerCase();
  if (!isKnownProviderKind(normalized)) return DEFAULT_PROVIDER_KIND;
  if (!isProviderKindImplemented(normalized)) return DEFAULT_PROVIDER_KIND;

  return normalized;
}

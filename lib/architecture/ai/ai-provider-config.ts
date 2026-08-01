// Phase 3C Part 2 — AI Provider configuration & selection.
//
// A pure, side-effect-free (besides reading process.env) resolver for
// WHICH provider kind should be active — not the provider itself. No
// network code, no SDK import, no API key is read or referenced here;
// only a plain string identifying which provider a future composition
// root (lib/architecture/ai/agent-ai-service-instance.ts, or a later
// settings surface) should construct.
//
// Only "deterministic" is implemented today (Phase 3C Part 1). The other
// kinds are declared now so later Phase 3C parts can add real
// implementations one at a time without touching this file's shape —
// only IMPLEMENTED_PROVIDER_KINDS grows.

export type AIProviderKind = "deterministic" | "openai" | "anthropic" | "gemini" | "ollama";

const DEFAULT_PROVIDER_KIND: AIProviderKind = "deterministic";

const ALL_PROVIDER_KINDS: readonly AIProviderKind[] = ["deterministic", "openai", "anthropic", "gemini", "ollama"];

// Grows as later Phase 3C parts add real implementations. Kept as its own
// explicit list (rather than inferred from a registry) so "is this kind
// actually usable right now" has a single, obvious source of truth.
const IMPLEMENTED_PROVIDER_KINDS: readonly AIProviderKind[] = ["deterministic"];

function isKnownProviderKind(value: string): value is AIProviderKind {
  return (ALL_PROVIDER_KINDS as readonly string[]).includes(value);
}

export function isProviderKindImplemented(kind: AIProviderKind): boolean {
  return IMPLEMENTED_PROVIDER_KINDS.includes(kind);
}

/**
 * Reads the requested provider kind from NEXT_PUBLIC_AI_PROVIDER (a
 * plain identifier string — no key, no endpoint, no secret) and falls
 * back to "deterministic" when unset, unrecognized, or not yet
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

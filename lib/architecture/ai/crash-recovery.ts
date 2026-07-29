import type { AgentState } from "@/lib/agent-engine";

// Phase 3A.5 — crash recovery (objective 5).
//
// A conversation's persisted state already contains everything needed to
// detect an interrupted generation: lib/agent-engine.ts always persists
// the user's message BEFORE generating a reply (appendUserMessage runs
// and saves, then appendAssistantReply is called separately — see that
// file's comments). So if a stored conversation's LAST message is from
// the user, the assistant reply for it never completed (tab closed,
// crashed, network dropped for a future remote provider, etc.).
//
// That's the only case that needs recovering, and it's derived from data
// that already exists — not a separate "pending" flag that could itself
// drift out of sync with reality and cause duplicate/corrupted state.
//
// Returns the prompt to regenerate a reply for, or null if the
// conversation is already in a consistent (assistant-terminated, or
// empty) state.
export function findInterruptedPrompt(state: AgentState): string | null {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "user") return null;
  return last.content;
}

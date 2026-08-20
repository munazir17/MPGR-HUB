// lib/architecture/tools/agent-tool-context.ts
//
// P0.1 — the per-call execution context every AgentTool.execute()
// receives.
//
// Per the task's own instruction ("if the existing codebase already has
// a suitable context type, reuse/extend it — do NOT create a duplicate
// context architecture"), this does NOT re-derive wallet/XP/portfolio/
// staking figures itself. It carries the exact same AgentContext
// (lib/agent-context.ts) already built once per turn and already handed
// to the AI provider and to slash commands — a tool that needs "is the
// user premium" or "what's their current staked balance" reads it from
// `appContext`, the same values the rest of the Agent already sees, not
// a second, possibly-inconsistent copy.
//
// Likewise `memoryContext` reuses ConversationMemoryContext
// (lib/architecture/memory/memory-context.ts) — the richer, already-
// assembled memory object (relevant history, wallet deltas,
// personalization) — instead of an untyped `memory?: unknown` field.
//
// Naming: this is deliberately NOT called "AgentContext" — that name is
// already lib/agent-context.ts's app-state snapshot, a different concept
// (no requestId, no permissions, no confirmation mode, not tied to a
// single tool call). Reusing that name here would shadow/collide with
// it across the codebase.

import type { AgentContext } from "@/lib/agent-context";
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";

// --- Confirmation mode ---------------------------------------------------
//
// P0.1 defines the model only — no full-auto mode, no autonomous
// spending. The default everywhere in P0.1 is "always_confirm".
// "auto_within_limits" exists as a forward-compatible value for a future
// phase to actually implement (spending limits, allow-lists); nothing in
// this codebase reads or acts on it yet.
export const AGENT_CONFIRMATION_MODES = ["always_confirm", "auto_within_limits"] as const;
export type AgentConfirmationMode = (typeof AGENT_CONFIRMATION_MODES)[number];

export const DEFAULT_CONFIRMATION_MODE: AgentConfirmationMode = "always_confirm";

// --- Permissions -----------------------------------------------------------
//
// Deliberately minimal for P0.1: enough to let a "prepare" tool be
// gated off (e.g. a future settings toggle disabling proposal creation
// without disabling read tools) without inventing a permission model
// nothing yet uses. `canExecute` is included for forward compatibility
// only — AgentToolRuntime (see agent-tool-runtime.ts) NEVER consults
// this flag to allow an "execute" tool to run; that refusal is
// unconditional and independent of anything in this object, by design
// (a caller cannot grant execute access by constructing a permissive
// AgentToolPermissions).
export interface AgentToolPermissions {
  canRead: boolean;
  canPrepare: boolean;
  canExecute: boolean;
}

export const DEFAULT_TOOL_PERMISSIONS: AgentToolPermissions = {
  canRead: true,
  canPrepare: true,
  canExecute: false,
};

// --- Tool context -----------------------------------------------------------

export interface AgentToolContext {
  /** The exact app/user-state snapshot already used throughout the Agent — reused, not duplicated. Optional so a call site without one yet (an isolated test, a future non-chat caller) doesn't have to fabricate one; a tool that genuinely needs it should treat a missing value the same as "not connected", not guess. */
  appContext?: AgentContext;

  /** Reused from the existing Memory layer — see the header comment above. Optional: not every call site (e.g. a direct test) has one assembled. */
  memoryContext?: ConversationMemoryContext;

  /** Plain string, matching this codebase's existing convention (AgentEventMap, AgentMessage, etc. all type wallet addresses as `string`, not a branded/viem Address type). */
  walletAddress?: string;
  chainId?: number;

  /** Always populated by AgentToolRuntime before a tool's execute() runs, even if the caller didn't supply one — see agent-tool-runtime.ts. */
  requestId: string;
  sessionId?: string;

  permissions?: AgentToolPermissions;
  confirmationMode: AgentConfirmationMode;

  /** Escape hatch for a future tool that needs something not modeled here yet — deliberately unstructured, exactly like AgentEventMap's own `metadata`-shaped fields elsewhere in this codebase. */
  metadata?: Record<string, unknown>;
}

/** Convenience builder — fills requestId/confirmationMode with defaults so most call sites (tests, a future runtime caller) don't have to. */
export function createAgentToolContext(
  partial: Omit<AgentToolContext, "requestId" | "confirmationMode"> &
    Partial<Pick<AgentToolContext, "requestId" | "confirmationMode">>
): AgentToolContext {
  return {
    ...partial,
    requestId: partial.requestId ?? generateRequestId(),
    confirmationMode: partial.confirmationMode ?? DEFAULT_CONFIRMATION_MODE,
  };
}

function generateRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

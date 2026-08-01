// Phase 3B Part 1 — Memory Engine type contracts.
//
// These types describe data owned by the Memory Engine layer, which sits
// ON TOP of MemoryProvider (lib/architecture/memory/memory-provider.ts).
// Nothing here changes MemoryProvider's interface or LocalMemoryProvider's
// implementation — every store below is just another get/set through
// getMemoryProvider(), using its own namespaced key.

import type { AgentIntent } from "@/lib/agent-intelligence";

// --- Session Memory --------------------------------------------------------
// Ephemeral, in-process only (never persisted). Represents "this browser
// session" — resets on a full page reload, which is the correct behavior
// for session-scoped context (as opposed to Conversation Memory, which is
// the persisted message history already owned by lib/agent-engine.ts).

export interface SessionMemory {
  address: string;
  startedAt: string;
  turnCount: number;
  lastIntent: AgentIntent | null;
  /** Most-recent-first, capped list of intents touched this session. */
  recentTopics: AgentIntent[];
}

// --- User Memory -------------------------------------------------------------
// Persisted, cross-session. Personalization substrate for Phase 3B Part 3.

export interface RecentPageVisit {
  path: string;
  visitedAt: string;
}

export interface RecentCommandUse {
  name: string;
  usedAt: string;
}

export interface UserMemory {
  address: string;
  firstSeenAt: string;
  lastActiveAt: string;
  interactionCount: number;
  /** intent -> times asked about, a proxy for "favorite modules". */
  topicInterest: Partial<Record<AgentIntent, number>>;
  recentPages: RecentPageVisit[];
  recentCommands: RecentCommandUse[];
  /** Reserved for multi-token support; defaults to the app's own token. */
  preferredToken: string;
}

// --- Wallet Context Memory ---------------------------------------------------
// Persisted, capped history of AgentContext snapshots. Lets later phases
// answer "how has my XP changed" without re-deriving history elsewhere.

export interface WalletContextSnapshot {
  capturedAt: string;
  xp: number | null;
  level: number | null;
  totalHoldings: number | null;
  holderTierLabel: string | null;
  stakedBalance: number | null;
  lockedBalance: number | null;
  seasonPoints: number | null;
}

export interface WalletContextMemory {
  address: string;
  snapshots: WalletContextSnapshot[];
}

// --- Conversation Memory (compression) ---------------------------------------
// A compact summary of older turns, kept separate from
// lib/agent-engine.ts's AgentState.messages so that file's shape and
// persistence rules are never touched by this layer.

export interface ConversationSummary {
  id: string;
  coversMessageCount: number;
  summary: string;
  createdAt: string;
}

export interface ConversationMemory {
  address: string;
  summaries: ConversationSummary[];
}

// --- Ranking -------------------------------------------------------------

export interface RankedMessage<T> {
  message: T;
  score: number;
}

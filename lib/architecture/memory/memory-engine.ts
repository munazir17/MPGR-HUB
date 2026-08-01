// Phase 3B Part 1 — Memory Engine orchestrator.
//
// The single entry point for everything in this directory. Consumers
// (AgentAIService, hooks/useAgentChat.ts, hooks/useRecentPageTracking.ts,
// lib/architecture/memory/memory-context.ts) call THIS file, never the
// individual stores directly — same "one composition point" pattern as
// agent-ai-service-instance.ts for the AI Service layer and
// memory-provider-registry.ts for the provider itself.
//
// Nothing here talks to localStorage or MemoryProvider directly except
// through the store modules below, and nothing here changes
// lib/agent-engine.ts's message persistence — this is a read/derive layer
// on top of it.
//
// Phase 3B Part 3 addendum — recordFeedback() (wraps
// user-memory-store.ts's recordResponseFeedback) and
// getPersonalizationSnapshot() (a lighter-weight read than
// getMemorySnapshot, used by hooks/useAgentChat.ts). recordPageView()
// already existed from Part 1 as an unused hook point — it's now called
// by hooks/useRecentPageTracking.ts.

import type { AgentContext } from "@/lib/agent-context";
import type { AgentIntent } from "@/lib/agent-intelligence";
import type { AgentMessage } from "@/lib/agent-engine";

import { getSessionMemory, recordSessionTurn, resetSessionMemory } from "./session-memory-store";
import {
  clearUserMemory,
  getUserMemory,
  mostUsedCommands,
  recordCommandUsage,
  recordPageVisit,
  recordResponseFeedback,
  recordTopicInterest,
  topFavoriteTopics,
} from "./user-memory-store";
import { captureWalletSnapshot, getWalletContextMemory, latestSnapshot, previousSnapshot } from "./wallet-context-memory";
import { compressOldestChunk } from "./memory-compression";
import { appendConversationSummary, clearConversationMemory, getConversationMemory } from "./conversation-memory-store";
import { topRelevantMessages } from "./memory-ranking";
import { cleanupMemory } from "./memory-cleanup";
import type { SessionMemory, UserMemory, WalletContextMemory, ConversationSummary } from "./memory-types";

export interface MemorySnapshot {
  session: SessionMemory;
  user: UserMemory;
  wallet: WalletContextMemory;
  conversationSummaries: ConversationSummary[];
  favoriteTopics: AgentIntent[];
}

/**
 * Called after a user message is persisted (lib/agent-engine.ts's
 * appendUserMessage already ran). Updates session memory synchronously
 * (in-process, cheap) and user memory asynchronously (persisted).
 */
export async function recordUserTurn(address: string, intent: AgentIntent | null): Promise<void> {
  if (intent) {
    recordSessionTurn(address, intent);
    await recordTopicInterest(address, intent);
  }
}

/**
 * Called after an assistant reply is generated. Captures the wallet
 * context at this moment and, if the conversation has grown large enough,
 * compresses its oldest chunk into a summary. Safe to run in the
 * background — it never blocks reply delivery to the UI.
 */
export async function recordAssistantTurn(
  address: string,
  context: AgentContext,
  currentMessages: AgentMessage[]
): Promise<void> {
  await captureWalletSnapshot(address, context);

  const compressed = compressOldestChunk(currentMessages);
  if (compressed) {
    await appendConversationSummary(address, compressed.summary);
    // Note: `compressed.remaining` is intentionally not written back into
    // lib/agent-engine.ts's AgentState here — trimming the canonical
    // message list is a separate concern from producing the summary.
  }
}

export async function recordCommandTurn(address: string, commandName: string): Promise<void> {
  await recordCommandUsage(address, commandName);
}

/** Called by hooks/useRecentPageTracking.ts on every route change. */
export async function recordPageView(address: string, path: string): Promise<void> {
  await recordPageVisit(address, path);
}

/**
 * Phase 3B Part 3 — records a thumbs up/down against an intent, called by
 * lib/architecture/ai/agent-ai-service.ts's setFeedback() only when the
 * feedback was just set (not toggled off).
 */
export async function recordFeedback(address: string, intent: AgentIntent, feedback: "up" | "down"): Promise<void> {
  await recordResponseFeedback(address, intent, feedback);
}

/**
 * Retrieval: the most relevant recent messages for the current prompt,
 * ranked rather than just "last N". Used by lib/architecture/memory/memory-context.ts
 * instead of the full raw history.
 */
export function retrieveRelevantMessages(
  messages: AgentMessage[],
  prompt: string,
  currentIntent: AgentIntent | null,
  limit = 8
): AgentMessage[] {
  return topRelevantMessages(messages, prompt, currentIntent, limit);
}

/** Full read of everything the Memory Engine knows about this address. */
export async function getMemorySnapshot(address: string): Promise<MemorySnapshot> {
  const [user, wallet, conversation] = await Promise.all([
    getUserMemory(address),
    getWalletContextMemory(address),
    getConversationMemory(address),
  ]);

  return {
    session: getSessionMemory(address),
    user,
    wallet,
    conversationSummaries: conversation.summaries,
    favoriteTopics: topFavoriteTopics(user),
  };
}

/**
 * Phase 3B Part 3 — a lighter, personalization-focused read (skips the
 * wallet/conversation reads getMemorySnapshot does), used by
 * hooks/useAgentChat.ts to populate its `personalization` return field
 * and to feed hooks/useCommandPalette.ts's usage-based ordering.
 */
export interface PersonalizationSnapshot {
  favoriteTopics: AgentIntent[];
  mostUsedCommands: string[];
  preferredToken: string;
  recentPages: string[];
  interactionCount: number;
  isReturningUser: boolean;
}

export async function getPersonalizationSnapshot(address: string): Promise<PersonalizationSnapshot> {
  const user = await getUserMemory(address);
  return {
    favoriteTopics: topFavoriteTopics(user),
    mostUsedCommands: mostUsedCommands(user, 5),
    preferredToken: user.preferredToken,
    recentPages: user.recentPages.map((p) => p.path),
    interactionCount: user.interactionCount,
    isReturningUser: user.interactionCount > 0,
  };
}

/** Convenience: XP/holdings delta since the previous captured snapshot. */
export function walletDeltaSinceLastVisit(wallet: WalletContextMemory) {
  const latest = latestSnapshot(wallet);
  const prior = previousSnapshot(wallet);
  if (!latest || !prior) return null;
  return {
    xpGained: latest.xp !== null && prior.xp !== null ? latest.xp - prior.xp : null,
    holdingsChange:
      latest.totalHoldings !== null && prior.totalHoldings !== null
        ? latest.totalHoldings - prior.totalHoldings
        : null,
  };
}

export async function runMemoryCleanup(address: string): Promise<void> {
  await cleanupMemory(address);
}

/** Mirrors lib/agent-engine.ts's clearAgentState — wipes derived memory too. */
export async function clearAllMemory(address: string): Promise<void> {
  resetSessionMemory(address);
  await Promise.all([clearUserMemory(address), clearConversationMemory(address)]);
}

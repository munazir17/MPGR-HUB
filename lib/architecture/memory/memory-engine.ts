// Phase 3B Part 1 — Memory Engine orchestrator.
//
// The single entry point for everything in this directory. Consumers
// (AgentAIService today; a future Context Builder in Part 4) call THIS
// file, never the individual stores directly — same "one composition
// point" pattern as agent-ai-service-instance.ts for the AI Service layer
// and memory-provider-registry.ts for the provider itself.
//
// Nothing here talks to localStorage or MemoryProvider directly except
// through the store modules below, and nothing here changes
// lib/agent-engine.ts's message persistence — this is a read/derive layer
// on top of it.

import type { AgentContext } from "@/lib/agent-context";
import type { AgentIntent } from "@/lib/agent-intelligence";
import type { AgentMessage } from "@/lib/agent-engine";

import { getSessionMemory, recordSessionTurn, resetSessionMemory } from "./session-memory-store";
import {
  clearUserMemory,
  getUserMemory,
  recordCommandUsage,
  recordPageVisit,
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
    // message list is a Part 2 concern (once agent-intelligence.ts reads
    // from summaries instead of raw history for old turns). Part 1 only
    // produces and persists the summary.
  }
}

export async function recordCommandTurn(address: string, commandName: string): Promise<void> {
  await recordCommandUsage(address, commandName);
}

/** Part 3 hook point — call from route-change handling once wired in. */
export async function recordPageView(address: string, path: string): Promise<void> {
  await recordPageVisit(address, path);
}

/**
 * Retrieval: the most relevant recent messages for the current prompt,
 * ranked rather than just "last N". Used by a future Context Builder
 * (Part 4) instead of the full raw history.
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

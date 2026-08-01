// Phase 3B Part 2 — Conversation Intelligence.
//
// This is the seam between the Memory Engine (memory-engine.ts and its
// stores) and lib/agent-intelligence.ts's reply generation. It resolves
// everything memory-related that a reply might want to reference — into
// one plain, synchronous-to-consume object — BEFORE generateIntelligentReply
// runs, so that function itself can stay synchronous (it's the documented
// Phase 3B model-call swap point; keeping it sync until then is
// intentional).
//
// Reuses lib/agent-commands/action-history.ts as-is for "previous
// actions" — that store already exists and is already the canonical
// record of commands the user has run. This file does not duplicate it.

import { getMemorySnapshot } from "./memory-engine";
import { retrieveRelevantMessages } from "./memory-engine";
import { latestSnapshot, previousSnapshot } from "./wallet-context-memory";
import { getActionHistory } from "@/lib/agent-commands/action-history";
import type { AgentMessage } from "@/lib/agent-engine";
import type { AgentIntent } from "@/lib/agent-intelligence";
import type { WalletContextMemory } from "./memory-types";

export interface WalletDelta {
  xpGained: number | null;
  holdingsChange: number | null;
  stakedChange: number | null;
  lockedChange: number | null;
  seasonPointsChange: number | null;
  tierChanged: boolean;
  previousTierLabel: string | null;
  currentTierLabel: string | null;
}

export interface RecalledAction {
  commandName: string;
  summary: string;
  timestamp: string;
}

export interface ConversationMemoryContext {
  relevantHistory: AgentMessage[];
  conversationSummaries: string[];
  favoriteTopics: AgentIntent[];
  walletDelta: WalletDelta | null;
  lastAction: RecalledAction | null;
  isReturningUser: boolean;
  interactionCount: number;
  /** Best-guess topic carried from ranked history, used as a detectIntent
   *  fallback when there's no direct keyword match and no immediate
   *  follow-up phrase — see lib/agent-intelligence.ts's detectIntent(). */
  dominantRecentIntent: AgentIntent | null;
}

function diff(a: number | null, b: number | null): number | null {
  return a !== null && b !== null ? a - b : null;
}

function computeWalletDelta(wallet: WalletContextMemory): WalletDelta | null {
  const latest = latestSnapshot(wallet);
  const prior = previousSnapshot(wallet);
  if (!latest || !prior) return null;

  return {
    xpGained: diff(latest.xp, prior.xp),
    holdingsChange: diff(latest.totalHoldings, prior.totalHoldings),
    stakedChange: diff(latest.stakedBalance, prior.stakedBalance),
    lockedChange: diff(latest.lockedBalance, prior.lockedBalance),
    seasonPointsChange: diff(latest.seasonPoints, prior.seasonPoints),
    tierChanged: latest.holderTierLabel !== prior.holderTierLabel,
    previousTierLabel: prior.holderTierLabel,
    currentTierLabel: latest.holderTierLabel,
  };
}

function deriveDominantIntent(relevantHistory: AgentMessage[]): AgentIntent | null {
  const counts = new Map<AgentIntent, number>();
  for (const message of relevantHistory) {
    if (message.role === "assistant" && message.intent) {
      counts.set(message.intent, (counts.get(message.intent) ?? 0) + 1);
    }
  }
  let best: AgentIntent | null = null;
  let bestCount = 0;
  for (const [intent, count] of counts) {
    if (count > bestCount) {
      best = intent;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Builds the full memory context for one reply-generation turn. Called by
 * lib/agent-engine.ts's appendAssistantReply/regenerateLastReply before
 * invoking generateIntelligentReply — this function does all the async
 * memory reads up front so the reasoning layer itself stays synchronous.
 */
export async function buildConversationMemoryContext(
  address: string,
  prompt: string,
  previousIntent: AgentIntent | null,
  messages: AgentMessage[]
): Promise<ConversationMemoryContext> {
  const [snapshot, actionHistory] = await Promise.all([getMemorySnapshot(address), getActionHistory(address)]);

  const relevantHistory = retrieveRelevantMessages(messages, prompt, previousIntent, 8);
  const walletDelta = computeWalletDelta(snapshot.wallet);
  const dominantRecentIntent = deriveDominantIntent(relevantHistory);
  const lastEntry = actionHistory[actionHistory.length - 1] ?? null;

  return {
    relevantHistory,
    conversationSummaries: snapshot.conversationSummaries.map((s) => s.summary),
    favoriteTopics: snapshot.favoriteTopics,
    walletDelta,
    lastAction: lastEntry
      ? { commandName: lastEntry.commandName, summary: lastEntry.summary, timestamp: lastEntry.timestamp }
      : null,
    isReturningUser: snapshot.user.interactionCount > 0,
    interactionCount: snapshot.user.interactionCount,
    dominantRecentIntent,
  };
}

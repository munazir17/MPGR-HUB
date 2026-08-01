// Phase 3B Part 4 — Context Builder.
//
// The single centralized composition point for everything a reply needs:
// AgentContext (wallet state, XP, rewards, staking, holder tier, season
// progress — built each render by lib/agent-context.ts from live hook
// data) merged with ConversationMemoryContext (recent activity, previous
// conversation, personalization — built by
// lib/architecture/memory/memory-context.ts from the Memory Engine).
//
// Before this file existed, lib/agent-engine.ts's appendAssistantReply and
// regenerateLastReply each independently computed "previous intent" and
// called buildConversationMemoryContext — two near-identical blocks. This
// file replaces both with one call, so it's now literally true that
// "every prompt automatically includes wallet state, XP, rewards,
// staking, holder tier, season progress, recent activity, and previous
// conversation" — all of it flows through this one function.
//
// This is also lib/agent-intelligence.ts's documented Phase 3B swap
// point's natural counterpart: when generateIntelligentReply's body
// becomes a real model call, AgentPromptContext below is exactly the
// payload that call would be built from — nothing about this file's
// shape needs to change for that swap.
//
// generateIntelligentReply's own signature (prompt, context,
// previousIntent, memoryContext) is UNCHANGED — this file only
// centralizes how those four pieces get assembled before the call, it
// doesn't change what's called or how.

import type { AgentMessage } from "@/lib/agent-engine";
import type { AgentContext } from "@/lib/agent-context";
import type { AgentIntent } from "@/lib/agent-intelligence";
import { buildConversationMemoryContext, type ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";

export interface AgentPromptContext {
  /** Wallet state, XP, rewards, staking, holder tier, season progress. */
  agent: AgentContext;
  /** Recent activity, previous conversation, personalization. */
  memory: ConversationMemoryContext;
  /** The most recent intent the assistant replied with, if any. */
  previousIntent: AgentIntent | null;
}

/**
 * Finds the intent of the most recent assistant message with one set —
 * used both as generateIntelligentReply's follow-up carry-over signal and
 * as buildConversationMemoryContext's relevance-ranking anchor. Moved
 * here from lib/agent-engine.ts (it was a private function there) so the
 * Context Builder can own the full assembly without a circular import
 * back into agent-engine.ts — agent-engine.ts now imports it from here
 * instead of defining it.
 */
export function findPreviousIntent(messages: AgentMessage[]): AgentIntent | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message.intent) return message.intent;
  }
  return null;
}

/**
 * Builds the complete prompt context for one reply-generation turn.
 * Called by lib/agent-engine.ts's appendAssistantReply and
 * regenerateLastReply — the only two call sites that invoke
 * lib/agent-intelligence.ts's generateIntelligentReply.
 */
export async function buildAgentPromptContext(
  address: string,
  prompt: string,
  agentContext: AgentContext,
  messages: AgentMessage[]
): Promise<AgentPromptContext> {
  const previousIntent = findPreviousIntent(messages);
  const memory = await buildConversationMemoryContext(address, prompt, previousIntent, messages);
  return { agent: agentContext, memory, previousIntent };
}

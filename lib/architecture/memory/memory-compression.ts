// Phase 3B Part 1 — Memory Compression.
//
// Once a conversation grows past a threshold, the oldest chunk of
// messages is folded into a single ConversationSummary and persisted
// separately (see conversation-memory-store.ts below). This file only
// contains the pure summarization logic — deterministic and local for
// now, matching lib/agent-intelligence.ts's current "no model call" phase.
// The Phase 3B model-call swap point noted in agent-intelligence.ts is
// where this would later call out to a real summarizer; the call site
// (memory-engine.ts) won't need to change shape when that happens.

import type { AgentMessage } from "@/lib/agent-engine";
import type { ConversationSummary } from "./memory-types";

export const COMPRESSION_TRIGGER_COUNT = 40;
export const COMPRESSION_CHUNK_SIZE = 20;

export function shouldCompress(messageCount: number): boolean {
  return messageCount > COMPRESSION_TRIGGER_COUNT;
}

function summarizeChunk(chunk: AgentMessage[]): string {
  const intentCounts = new Map<string, number>();
  for (const message of chunk) {
    if (message.role === "assistant" && message.intent) {
      intentCounts.set(message.intent, (intentCounts.get(message.intent) ?? 0) + 1);
    }
  }
  const topics = [...intentCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([intent]) => intent.replace(/_/g, " "))
    .slice(0, 5);

  const userTurns = chunk.filter((m) => m.role === "user").length;
  const topicsText = topics.length > 0 ? topics.join(", ") : "general questions";

  return `Earlier in this conversation (${userTurns} user message${userTurns === 1 ? "" : "s"}), the user asked mainly about: ${topicsText}.`;
}

/**
 * Compresses the oldest COMPRESSION_CHUNK_SIZE messages into one summary.
 * Returns null if there's nothing old enough to compress yet. Does not
 * mutate the input array and does not touch lib/agent-engine.ts's stored
 * AgentState — the caller decides what, if anything, to do with the
 * returned summary and which messages it covered.
 */
export function compressOldestChunk(messages: AgentMessage[]): {
  summary: ConversationSummary;
  remaining: AgentMessage[];
} | null {
  if (!shouldCompress(messages.length)) return null;

  const chunk = messages.slice(0, COMPRESSION_CHUNK_SIZE);
  const remaining = messages.slice(COMPRESSION_CHUNK_SIZE);

  const summary: ConversationSummary = {
    id: `summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    coversMessageCount: chunk.length,
    summary: summarizeChunk(chunk),
    createdAt: new Date().toISOString(),
  };

  return { summary, remaining };
}

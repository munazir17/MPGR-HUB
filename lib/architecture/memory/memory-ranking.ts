// Phase 3B Part 1 — Memory Ranking.
//
// Pure functions only — no storage access. Scores a list of past
// conversation messages against the current prompt/intent so a future
// Context Builder (Part 4) can select the most relevant handful instead
// of dumping the entire history into a prompt.

import type { AgentIntent } from "@/lib/agent-intelligence";
import type { AgentMessage } from "@/lib/agent-engine";
import type { RankedMessage } from "./memory-types";

const RECENCY_HALF_LIFE_MS = 1000 * 60 * 30; // 30 minutes

function recencyScore(timestamp: string, now: number): number {
  const ageMs = Math.max(0, now - new Date(timestamp).getTime());
  return Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
}

function intentMatchScore(message: AgentMessage, currentIntent: AgentIntent | null): number {
  if (!currentIntent || !message.intent) return 0;
  return message.intent === currentIntent ? 1 : 0;
}

function keywordOverlapScore(message: AgentMessage, prompt: string): number {
  const promptWords = new Set(
    prompt
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
  if (promptWords.size === 0) return 0;
  const contentWords = message.content.toLowerCase().split(/\s+/);
  const hits = contentWords.filter((w) => promptWords.has(w)).length;
  return Math.min(1, hits / promptWords.size);
}

/**
 * Ranks messages by a weighted blend of recency, intent match, and keyword
 * overlap with the current prompt. Higher score = more relevant to surface
 * for the current turn. Order of the input array is not assumed.
 */
export function rankMessages(
  messages: AgentMessage[],
  prompt: string,
  currentIntent: AgentIntent | null
): RankedMessage<AgentMessage>[] {
  const now = Date.now();
  return messages
    .map((message) => {
      const score =
        recencyScore(message.timestamp, now) * 0.5 +
        intentMatchScore(message, currentIntent) * 0.3 +
        keywordOverlapScore(message, prompt) * 0.2;
      return { message, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** Convenience: top-N ranked messages, restored to chronological order. */
export function topRelevantMessages(
  messages: AgentMessage[],
  prompt: string,
  currentIntent: AgentIntent | null,
  limit = 8
): AgentMessage[] {
  const ranked = rankMessages(messages, prompt, currentIntent).slice(0, limit);
  const keep = new Set(ranked.map((r) => r.message.id));
  return messages.filter((m) => keep.has(m.id));
}

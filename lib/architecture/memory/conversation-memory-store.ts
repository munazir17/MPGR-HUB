// Phase 3B Part 1 — persisted store for compressed conversation summaries.
//
// Deliberately separate from lib/agent-engine.ts's AgentState: that file
// owns raw message persistence and its exact shape/rules are untouched.
// This store only holds the *derived* summaries produced by
// memory-compression.ts, under its own namespaced key.

import { getMemoryProvider } from "./memory-provider-registry";
import type { ConversationMemory, ConversationSummary } from "./memory-types";

const MAX_SUMMARIES = 10;

function storageKey(address: string): string {
  return `mpgr-hub:conversation-memory:${address.toLowerCase()}`;
}

function emptyMemory(address: string): ConversationMemory {
  return { address, summaries: [] };
}

export async function getConversationMemory(address: string): Promise<ConversationMemory> {
  return getMemoryProvider().get<ConversationMemory>(storageKey(address), emptyMemory(address));
}

export async function appendConversationSummary(
  address: string,
  summary: ConversationSummary
): Promise<ConversationMemory> {
  const memory = await getConversationMemory(address);
  const summaries = [...memory.summaries, summary].slice(-MAX_SUMMARIES);
  const updated: ConversationMemory = { ...memory, summaries };
  await getMemoryProvider().set(storageKey(address), updated);
  return updated;
}

export async function clearConversationMemory(address: string): Promise<ConversationMemory> {
  const cleared = emptyMemory(address);
  await getMemoryProvider().set(storageKey(address), cleared);
  return cleared;
}

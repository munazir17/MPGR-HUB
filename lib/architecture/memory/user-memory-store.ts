// Phase 3B Part 1 — persisted User Memory store.
//
// Same pattern as lib/agent-engine.ts's AgentState: a namespaced key,
// read/write exclusively through getMemoryProvider(), never localStorage
// directly. This file owns User Memory's read/write rules; callers
// (memory-engine.ts) never touch the key or the provider directly.

import { getMemoryProvider } from "./memory-provider-registry";
import type { AgentIntent } from "@/lib/agent-intelligence";
import type { RecentCommandUse, RecentPageVisit, UserMemory } from "./memory-types";

const MAX_RECENT_PAGES = 15;
const MAX_RECENT_COMMANDS = 15;
const DEFAULT_TOKEN = "MPGR";

function storageKey(address: string): string {
  return `mpgr-hub:user-memory:${address.toLowerCase()}`;
}

function emptyUserMemory(address: string): UserMemory {
  const now = new Date().toISOString();
  return {
    address,
    firstSeenAt: now,
    lastActiveAt: now,
    interactionCount: 0,
    topicInterest: {},
    recentPages: [],
    recentCommands: [],
    preferredToken: DEFAULT_TOKEN,
  };
}

export async function getUserMemory(address: string): Promise<UserMemory> {
  return getMemoryProvider().get<UserMemory>(storageKey(address), emptyUserMemory(address));
}

async function saveUserMemory(memory: UserMemory): Promise<UserMemory> {
  await getMemoryProvider().set(storageKey(memory.address), memory);
  return memory;
}

/** Records one conversational turn's intent — powers "favorite modules". */
export async function recordTopicInterest(address: string, intent: AgentIntent): Promise<UserMemory> {
  const memory = await getUserMemory(address);
  const updated: UserMemory = {
    ...memory,
    lastActiveAt: new Date().toISOString(),
    interactionCount: memory.interactionCount + 1,
    topicInterest: {
      ...memory.topicInterest,
      [intent]: (memory.topicInterest[intent] ?? 0) + 1,
    },
  };
  return saveUserMemory(updated);
}

export async function recordPageVisit(address: string, path: string): Promise<UserMemory> {
  const memory = await getUserMemory(address);
  const entry: RecentPageVisit = { path, visitedAt: new Date().toISOString() };
  const recentPages = [entry, ...memory.recentPages.filter((p) => p.path !== path)].slice(0, MAX_RECENT_PAGES);
  return saveUserMemory({ ...memory, recentPages, lastActiveAt: entry.visitedAt });
}

export async function recordCommandUsage(address: string, name: string): Promise<UserMemory> {
  const memory = await getUserMemory(address);
  const entry: RecentCommandUse = { name, usedAt: new Date().toISOString() };
  const recentCommands = [entry, ...memory.recentCommands].slice(0, MAX_RECENT_COMMANDS);
  return saveUserMemory({ ...memory, recentCommands, lastActiveAt: entry.usedAt });
}

/** Returns the intents this user engages with most, most-interested-first. */
export function topFavoriteTopics(memory: UserMemory, limit = 3): AgentIntent[] {
  return (Object.entries(memory.topicInterest) as [AgentIntent, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([intent]) => intent);
}

export async function clearUserMemory(address: string): Promise<UserMemory> {
  return saveUserMemory(emptyUserMemory(address));
}

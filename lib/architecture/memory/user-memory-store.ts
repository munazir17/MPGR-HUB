// Phase 3B Part 1 — persisted User Memory store.
//
// Same pattern as lib/agent-engine.ts's AgentState: a namespaced key,
// read/write exclusively through getMemoryProvider(), never localStorage
// directly. This file owns User Memory's read/write rules; callers
// (memory-engine.ts) never touch the key or the provider directly.
//
// Phase 3B Part 3 addendum — recordCommandUsage now also increments
// commandUsageCounts (uncapped frequency, distinct from the capped
// recentCommands recency list), and this file gains
// recordResponseFeedback + mostUsedCommands. Every existing function's
// behavior and signature is unchanged.

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
    commandUsageCounts: {},
    responsePreference: {},
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
  const commandUsageCounts = {
    ...memory.commandUsageCounts,
    [name]: (memory.commandUsageCounts[name] ?? 0) + 1,
  };
  return saveUserMemory({ ...memory, recentCommands, commandUsageCounts, lastActiveAt: entry.usedAt });
}

/**
 * Phase 3B Part 3 — records a thumbs up/down against the intent of the
 * message it was given for. Called only when feedback was just SET (not
 * toggled off) — see lib/architecture/ai/agent-ai-service.ts's
 * setFeedback for that check.
 */
export async function recordResponseFeedback(
  address: string,
  intent: AgentIntent,
  feedback: "up" | "down"
): Promise<UserMemory> {
  const memory = await getUserMemory(address);
  const current = memory.responsePreference[intent] ?? { up: 0, down: 0 };
  const updated: UserMemory = {
    ...memory,
    lastActiveAt: new Date().toISOString(),
    responsePreference: {
      ...memory.responsePreference,
      [intent]: {
        up: current.up + (feedback === "up" ? 1 : 0),
        down: current.down + (feedback === "down" ? 1 : 0),
      },
    },
  };
  return saveUserMemory(updated);
}

/** Returns the intents this user engages with most, most-interested-first. */
export function topFavoriteTopics(memory: UserMemory, limit = 3): AgentIntent[] {
  return (Object.entries(memory.topicInterest) as [AgentIntent, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([intent]) => intent);
}

/**
 * Phase 3B Part 3 — command names ranked by total usage (uncapped
 * counter, not the capped recency list), most-used-first. Powers Command
 * Palette default ordering via hooks/useCommandPalette.ts.
 */
export function mostUsedCommands(memory: UserMemory, limit = 5): string[] {
  return (Object.entries(memory.commandUsageCounts) as [string, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

export async function clearUserMemory(address: string): Promise<UserMemory> {
  return saveUserMemory(emptyUserMemory(address));
}

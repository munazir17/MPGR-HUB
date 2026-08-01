// Phase 3B Part 1 — in-process Session Memory.
//
// Deliberately NOT persisted through MemoryProvider: a "session" is this
// running app instance, and losing it on reload is correct behavior (that
// distinction is what separates Session Memory from Conversation Memory,
// which lib/agent-engine.ts already persists). Module-level Map instead of
// a class instance, matching the singleton pattern already used by
// event-bus.ts / task-queue.ts / logger.ts.

import type { AgentIntent } from "@/lib/agent-intelligence";
import type { SessionMemory } from "./memory-types";

const MAX_RECENT_TOPICS = 10;

const sessions = new Map<string, SessionMemory>();

function keyFor(address: string): string {
  return address.toLowerCase();
}

function newSession(address: string): SessionMemory {
  return {
    address,
    startedAt: new Date().toISOString(),
    turnCount: 0,
    lastIntent: null,
    recentTopics: [],
  };
}

export function getSessionMemory(address: string): SessionMemory {
  const key = keyFor(address);
  const existing = sessions.get(key);
  if (existing) return existing;
  const created = newSession(address);
  sessions.set(key, created);
  return created;
}

export function recordSessionTurn(address: string, intent: AgentIntent): SessionMemory {
  const key = keyFor(address);
  const current = getSessionMemory(address);
  const updated: SessionMemory = {
    ...current,
    turnCount: current.turnCount + 1,
    lastIntent: intent,
    recentTopics: [intent, ...current.recentTopics.filter((t) => t !== intent)].slice(0, MAX_RECENT_TOPICS),
  };
  sessions.set(key, updated);
  return updated;
}

export function resetSessionMemory(address: string): void {
  sessions.delete(keyFor(address));
}

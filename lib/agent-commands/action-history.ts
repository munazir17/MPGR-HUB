import { getMemoryProvider } from "@/lib/architecture/memory/memory-provider-registry";
import type { CommandResult } from "./types";

// Phase 3A.6 — Action History.
//
// Goes through the existing MemoryProvider abstraction (same as
// lib/agent-engine.ts's getAgentState/saveAgentState) rather than
// touching localStorage directly — the whole point of Phase 3A.5's
// MemoryProvider objective. Stored under its own key, separate from the
// conversation itself, so clearing action history never touches chat
// messages and vice versa.

export interface ActionHistoryEntry {
  id: string;
  commandName: string;
  resultKind: CommandResult["kind"];
  summary: string;
  timestamp: string;
}

interface ActionHistoryState {
  address: string;
  entries: ActionHistoryEntry[];
}

const MAX_ENTRIES = 50;

function historyKey(address: string): string {
  return `mpgr-hub:agent-action-history:${address.toLowerCase()}`;
}

function emptyState(address: string): ActionHistoryState {
  return { address, entries: [] };
}

export async function getActionHistory(address: string): Promise<ActionHistoryEntry[]> {
  const state = await getMemoryProvider().get<ActionHistoryState>(historyKey(address), emptyState(address));
  return state.entries;
}

export async function recordAction(
  address: string,
  commandName: string,
  result: CommandResult
): Promise<ActionHistoryEntry[]> {
  const state = await getMemoryProvider().get<ActionHistoryState>(historyKey(address), emptyState(address));
  const entry: ActionHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    commandName,
    resultKind: result.kind,
    summary: result.kind === "navigate" ? result.text : result.text,
    timestamp: new Date().toISOString(),
  };
  const entries = [...state.entries, entry].slice(-MAX_ENTRIES);
  await getMemoryProvider().set(historyKey(address), { address, entries });
  return entries;
}

export async function clearActionHistory(address: string): Promise<void> {
  await getMemoryProvider().set(historyKey(address), emptyState(address));
}

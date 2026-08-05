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
//
// Phase 3D — Smart Actions & AI Automation. This history stream is no
// longer slash-commands-only: lib/architecture/ai/smart-action-engine.ts
// also calls recordAction() for a conversational "open X" intent that
// auto-navigated, using the intent name (e.g. "open_rewards") as
// commandName — those names use underscores and never collide with a
// real slash command's name (see lib/agent-commands/commands.ts, all of
// which are short single/hyphenated words). Three new OPTIONAL fields —
// success, durationMs, category — extend ActionHistoryEntry without
// breaking anything: every entry already persisted to localStorage
// before this change simply omits them, which the optional `?` already
// allows, and the one pre-existing caller
// (hooks/useAgentChat.ts's executeCommand) keeps compiling and running
// unchanged by not passing a 4th argument.

export interface ActionHistoryEntry {
  id: string;
  commandName: string;
  resultKind: CommandResult["kind"];
  summary: string;
  timestamp: string;
  // Phase 3D additions — all optional, so nothing above breaks.
  success?: boolean;
  durationMs?: number;
  category?: string;
}

interface ActionHistoryState {
  address: string;
  entries: ActionHistoryEntry[];
}

// Phase 3D — recordAction's new, optional 4th parameter. `category`
// defaults from `result.kind` when omitted (see recordAction below), so
// a caller only needs to supply it when a finer bucket than
// navigate/info/error is useful (e.g. smart-action-engine.ts passing
// "navigation" explicitly, matching the default anyway, for clarity at
// the call site).
export interface RecordActionMeta {
  success?: boolean;
  durationMs?: number;
  category?: string;
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

// Phase 3D — filters the same stored history by `category` without a
// second storage read path: still goes through getActionHistory() above,
// so there is exactly one place that reads from the MemoryProvider.
// Entries persisted before Phase 3D (no `category` field) simply never
// match a specific filter, which is the correct behavior — they predate
// categorization and default filtering to "show everything" would be
// surprising.
export async function getActionHistoryByCategory(address: string, category: string): Promise<ActionHistoryEntry[]> {
  const entries = await getActionHistory(address);
  return entries.filter((entry) => entry.category === category);
}

function defaultCategory(resultKind: CommandResult["kind"]): string {
  if (resultKind === "navigate") return "navigation";
  if (resultKind === "error") return "error";
  return "info";
}

export async function recordAction(
  address: string,
  commandName: string,
  result: CommandResult,
  meta?: RecordActionMeta
): Promise<ActionHistoryEntry[]> {
  const state = await getMemoryProvider().get<ActionHistoryState>(historyKey(address), emptyState(address));
  const entry: ActionHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    commandName,
    resultKind: result.kind,
    summary: result.kind === "navigate" ? result.text : result.text,
    timestamp: new Date().toISOString(),
    success: meta?.success ?? result.kind !== "error",
    durationMs: meta?.durationMs,
    category: meta?.category ?? defaultCategory(result.kind),
  };
  const entries = [...state.entries, entry].slice(-MAX_ENTRIES);
  await getMemoryProvider().set(historyKey(address), { address, entries });
  return entries;
}

export async function clearActionHistory(address: string): Promise<void> {
  await getMemoryProvider().set(historyKey(address), emptyState(address));
}

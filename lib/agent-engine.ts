import { getMemoryProvider } from "@/lib/architecture/memory/memory-provider-registry";
import { generateIntelligentReply, type AgentIntent } from "@/lib/agent-intelligence";
// Phase 3B Part 2 — Conversation Intelligence. Builds the memory context
// consumed by generateIntelligentReply. Only appendAssistantReply and
// regenerateLastReply need it (they're the two call sites that invoke
// lib/agent-intelligence.ts); appendUserMessage, appendCommandMessage,
// setMessageFeedback, and clearAgentState are all untouched below.
import { buildConversationMemoryContext } from "@/lib/architecture/memory/memory-context";
import type { AgentContext } from "@/lib/agent-context";
import type { AgentAction, AgentHighlight } from "@/lib/agent-actions";

// Phase 3A — local/mock persistence for MPGR Agent conversations.
// Phase 3A.2 — replies come from lib/agent-intelligence.ts.
// Phase 3A.3 — messages carry actions/highlights/followUps.
// Phase 3A.4 — feedback + regenerateLastReply + setMessageFeedback.
// Phase 3A.5 — persistence goes through getMemoryProvider() instead of
// lib/storage.ts directly; every exported function here is async.
//
// Phase 3A.6 addendum — added appendAssistantMessage (below) for the
// slash-command path in lib/agent-commands/*, which resolves replies
// deterministically and must NOT go through generateIntelligentReply.
//
// Phase 3B Part 2 addendum — appendAssistantReply and regenerateLastReply
// now build a ConversationMemoryContext (lib/architecture/memory/memory-context.ts)
// before calling generateIntelligentReply, and pass it as that function's
// new optional fourth argument. Every other function below, and every
// other part of these two functions, is unchanged from 3A.5.

export type AgentRole = "user" | "assistant";
export type AgentFeedback = "up" | "down";

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  timestamp: string;
  intent?: AgentIntent;
  actions?: AgentAction[];
  highlights?: AgentHighlight[];
  followUps?: string[];
  feedback?: AgentFeedback;
}

export interface AgentState {
  address: string;
  messages: AgentMessage[];
}

function storageKey(address: string): string {
  return `mpgr-hub:agent:${address.toLowerCase()}`;
}

function emptyState(address: string): AgentState {
  return { address, messages: [] };
}

export async function getAgentState(address: string): Promise<AgentState> {
  return getMemoryProvider().get<AgentState>(storageKey(address), emptyState(address));
}

async function saveAgentState(state: AgentState): Promise<AgentState> {
  await getMemoryProvider().set(storageKey(state.address), state);
  return state;
}

interface AssistantExtras {
  intent?: AgentIntent;
  actions?: AgentAction[];
  highlights?: AgentHighlight[];
  followUps?: string[];
}

function createMessage(role: AgentRole, content: string, extra?: AssistantExtras): AgentMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    timestamp: new Date().toISOString(),
    ...(extra?.intent ? { intent: extra.intent } : {}),
    ...(extra?.actions && extra.actions.length > 0 ? { actions: extra.actions } : {}),
    ...(extra?.highlights && extra.highlights.length > 0 ? { highlights: extra.highlights } : {}),
    ...(extra?.followUps && extra.followUps.length > 0 ? { followUps: extra.followUps } : {}),
  };
}

export async function appendUserMessage(address: string, content: string): Promise<AgentState> {
  const trimmed = content.trim();
  if (!trimmed) return getAgentState(address);
  const state = await getAgentState(address);
  const updated: AgentState = {
    ...state,
    messages: [...state.messages, createMessage("user", trimmed)],
  };
  return saveAgentState(updated);
}

function findPreviousIntent(messages: AgentMessage[]): AgentIntent | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message.intent) return message.intent;
  }
  return null;
}

export async function appendAssistantReply(
  address: string,
  userPrompt: string,
  context: AgentContext
): Promise<AgentState> {
  const state = await getAgentState(address);
  const previousIntent = findPreviousIntent(state.messages);
  // Phase 3B Part 2 — resolved before generateIntelligentReply runs, so
  // that function itself stays synchronous.
  const memoryContext = await buildConversationMemoryContext(address, userPrompt, previousIntent, state.messages);
  const { intent, reply, actions, highlights, followUps } = generateIntelligentReply(
    userPrompt,
    context,
    previousIntent,
    memoryContext
  );
  const updated: AgentState = {
    ...state,
    messages: [...state.messages, createMessage("assistant", reply, { intent, actions, highlights, followUps })],
  };
  return saveAgentState(updated);
}

// Phase 3A.6 — appends an assistant message whose text was already
// computed elsewhere (e.g. lib/agent-commands/action-executor.ts's
// deterministic command results) without calling
// generateIntelligentReply. Reuses the exact same createMessage +
// saveAgentState path every other function here uses — no new
// persistence logic, no duplicated message-shape rules. `extra` is
// optional so a future command result carrying actions/highlights can
// use this same function without a signature change.
export async function appendAssistantMessage(
  address: string,
  content: string,
  extra?: AssistantExtras
): Promise<AgentState> {
  const state = await getAgentState(address);
  const updated: AgentState = {
    ...state,
    messages: [...state.messages, createMessage("assistant", content, extra)],
  };
  return saveAgentState(updated);
}

// Phase 3A.6 — appends an assistant message for a slash-command result
// (lib/agent-commands/action-executor.ts's replyText), called by
// lib/architecture/ai/agent-ai-service.ts's runCommand(). Reuses the same
// createMessage + saveAgentState path as appendAssistantMessage — no new
// persistence logic. `commandName` isn't stored on AgentMessage (no UI
// currently reads it there); it's accepted here to match runCommand()'s
// call signature and is already captured separately by the
// command_executed event and lib/agent-commands/action-history.ts.
export async function appendCommandMessage(
  address: string,
  content: string,
  commandName: string
): Promise<AgentState> {
  void commandName;
  return appendAssistantMessage(address, content);
}

export async function regenerateLastReply(address: string, context: AgentContext): Promise<AgentState> {
  const state = await getAgentState(address);
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant") return state;

  let userIndex = -1;
  for (let i = state.messages.length - 2; i >= 0; i--) {
    if (state.messages[i].role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) return state;

  const userPrompt = state.messages[userIndex].content;
  const trimmedMessages = state.messages.slice(0, -1);
  const previousIntent = findPreviousIntent(trimmedMessages);
  // Phase 3B Part 2 — same memory context resolution as appendAssistantReply,
  // computed against the trimmed history (i.e. excluding the reply being
  // regenerated), matching how previousIntent is already computed above.
  const memoryContext = await buildConversationMemoryContext(address, userPrompt, previousIntent, trimmedMessages);
  const { intent, reply, actions, highlights, followUps } = generateIntelligentReply(
    userPrompt,
    context,
    previousIntent,
    memoryContext
  );
  const updated: AgentState = {
    ...state,
    messages: [...trimmedMessages, createMessage("assistant", reply, { intent, actions, highlights, followUps })],
  };
  return saveAgentState(updated);
}

export async function setMessageFeedback(
  address: string,
  messageId: string,
  feedback: AgentFeedback
): Promise<AgentState> {
  const state = await getAgentState(address);
  const updated: AgentState = {
    ...state,
    messages: state.messages.map((message) =>
      message.id === messageId && message.role === "assistant"
        ? { ...message, feedback: message.feedback === feedback ? undefined : feedback }
        : message
    ),
  };
  return saveAgentState(updated);
}

export async function clearAgentState(address: string): Promise<AgentState> {
  return saveAgentState(emptyState(address));
}

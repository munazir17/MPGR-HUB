import { readJSON, writeJSON } from "@/lib/storage";
import { generateIntelligentReply, type AgentIntent } from "@/lib/agent-intelligence";
import type { AgentContext } from "@/lib/agent-context";
import type { AgentAction, AgentHighlight } from "@/lib/agent-actions";

// Phase 3A — local/mock persistence for MPGR Agent conversations, using the
// same localStorage-backed JSON helper the rest of the app's mock services
// use (lib/storage.ts). No network calls. Conversation history is scoped
// per connected wallet address, same as XP/staking/rewards state.
//
// Phase 3A.2: assistant replies now come from lib/agent-intelligence.ts,
// which reads a real AgentContext snapshot (built in lib/agent-context.ts
// from the app's existing hooks) instead of matching keywords in
// isolation. Each assistant message is tagged with the `intent` that
// produced it so the next turn can resolve short follow-ups
// ("What about rewards?") against the previous topic — see
// lib/agent-intelligence.ts's RELATED_TOPICS.
//
// Phase 3A.3: assistant messages now also carry `actions`, `highlights`,
// and `followUps` — all plain, JSON-serializable data (icons are string
// keys, see lib/agent-actions.ts) so they round-trip through
// writeJSON/readJSON exactly like the rest of AgentMessage.
//
// Phase 3B swap point: once a real backend exists, `appendAssistantReply`
// moves behind an async API call — the shape of AgentMessage / AgentState
// and the storage key don't need to change.

export type AgentRole = "user" | "assistant";

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  timestamp: string;
  // Only ever set on assistant messages — the detected intent that
  // produced this reply, used as conversational context for the next turn.
  intent?: AgentIntent;
  // Only ever set on assistant messages. Empty arrays are omitted rather
  // than stored, keeping user messages and "no actions for this intent"
  // replies visually and structurally identical in storage.
  actions?: AgentAction[];
  highlights?: AgentHighlight[];
  followUps?: string[];
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

export function getAgentState(address: string): AgentState {
  return readJSON<AgentState>(storageKey(address), emptyState(address));
}

function saveAgentState(state: AgentState): AgentState {
  writeJSON(storageKey(state.address), state);
  return state;
}

function createMessage(
  role: AgentRole,
  content: string,
  extra?: { intent?: AgentIntent; actions?: AgentAction[]; highlights?: AgentHighlight[]; followUps?: string[] }
): AgentMessage {
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

// Appends a user message and persists immediately, so the message is never
// lost even if the assistant reply step is interrupted.
export function appendUserMessage(address: string, content: string): AgentState {
  const trimmed = content.trim();
  if (!trimmed) return getAgentState(address);
  const state = getAgentState(address);
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

// Generates and appends the assistant reply for the most recent user
// prompt, using the intelligence layer (lib/agent-intelligence.ts) grounded
// in the real AgentContext snapshot the caller passes in. Kept as a
// separate step (rather than folded into appendUserMessage) so the calling
// hook can simulate a "thinking" delay between the two without blocking
// persistence of the user's own message.
export function appendAssistantReply(address: string, userPrompt: string, context: AgentContext): AgentState {
  const state = getAgentState(address);
  const previousIntent = findPreviousIntent(state.messages);
  const { intent, reply, actions, highlights, followUps } = generateIntelligentReply(userPrompt, context, previousIntent);
  const updated: AgentState = {
    ...state,
    messages: [...state.messages, createMessage("assistant", reply, { intent, actions, highlights, followUps })],
  };
  return saveAgentState(updated);
}

export function clearAgentState(address: string): AgentState {
  return saveAgentState(emptyState(address));
}

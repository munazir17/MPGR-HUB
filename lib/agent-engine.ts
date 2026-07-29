import { readJSON, writeJSON } from "@/lib/storage";
import { generateAgentReply } from "@/lib/agent-config";

// Phase 3A — local/mock persistence for MPGR Agent conversations, using the
// same localStorage-backed JSON helper the rest of the app's mock services
// use (lib/storage.ts). No network calls. Conversation history is scoped
// per connected wallet address, same as XP/staking/rewards state.
//
// Phase 3B swap point: once a real backend exists, `appendMessage`'s
// assistant-reply half moves behind an async API call — the shape of
// AgentMessage / AgentState and the storage key don't need to change.

export type AgentRole = "user" | "assistant";

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  timestamp: string;
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

function createMessage(role: AgentRole, content: string): AgentMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    timestamp: new Date().toISOString(),
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

// Generates and appends the mock assistant reply for the most recent user
// prompt. Kept as a separate step (rather than folded into
// appendUserMessage) so the calling hook can simulate a "thinking" delay
// between the two without blocking persistence of the user's own message.
export function appendAssistantReply(address: string, userPrompt: string): AgentState {
  const state = getAgentState(address);
  const reply = generateAgentReply(userPrompt);
  const updated: AgentState = {
    ...state,
    messages: [...state.messages, createMessage("assistant", reply)],
  };
  return saveAgentState(updated);
}

export function clearAgentState(address: string): AgentState {
  return saveAgentState(emptyState(address));
}

import { getMemoryProvider } from "@/lib/architecture/memory/memory-provider-registry";
import type { AgentIntent } from "@/lib/agent-intelligence";
import { buildAgentPromptContext } from "@/lib/agent-prompt-context";
import { getAIProvider } from "@/lib/architecture/ai/ai-provider-registry";
import type { AgentContext } from "@/lib/agent-context";
import type { AgentAction, AgentHighlight } from "@/lib/agent-actions";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import type { TokenizedStockReport, TradeProposal } from "@/lib/trade/trade-types";

// Phase 3A — local/mock persistence for MPGR Agent conversations.
// Phase 3A.2 — replies come from lib/agent-intelligence.ts.
// Phase 3A.3 — messages carry actions/highlights/followUps.
// Phase 3A.4 — feedback + regenerateLastReply + setMessageFeedback.
// Phase 3A.5 — persistence goes through getMemoryProvider() instead of
// lib/storage.ts directly; every exported function here is async.
//
// Phase 3A.6 — appendAssistantMessage / appendCommandMessage support
// deterministic slash-command results without invoking the AI provider.
//
// Phase 3B — prompt context is built through buildAgentPromptContext(),
// which combines agent context, conversation memory, and previous intent.
//
// Phase 3C — reply generation goes through getAIProvider() instead of
// calling generateIntelligentReply() directly.
//
// Phase 3C Part 2 — AIProviderRequest includes the wallet address so
// provider fallback/diagnostic layers can attribute events correctly.
//
// P3 — x402 payment proposals are carried from AIProviderResponse through
// AgentMessage to the UI. The proposal is never constructed from assistant
// text here. It is received only from the structured AI provider response
// and is rendered by the UI as a review-only proposal. Signing/submission
// remains outside this module.

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

  /**
   * P3 — present only when this assistant turn successfully prepared
   * an x402 payment proposal.
   *
   * The value comes directly from AIProviderResponse.x402Proposal,
   * which itself is captured from the structured x402 prepare-tool
   * result rather than reconstructed from model-generated text.
   *
   * This field is display/state data only. Nothing in AgentMessage,
   * persistence, or the agent engine signs or submits the payment.
   */
  x402Proposal?: X402PaymentProposal;
  /**
   * P4 — present only when this assistant turn prepared a CDP swap.
   * Display/state only; signing stays outside this module.
   */
  tradeProposal?: TradeProposal;
  /**
   * P4 — present only when tokenized_stock_research succeeded.
   */
  tokenizedStockReport?: TokenizedStockReport;
}

export interface AgentState {
  address: string;
  messages: AgentMessage[];
}

function storageKey(address: string): string {
  return `mpgr-hub:agent:${address.toLowerCase()}`;
}

function emptyState(address: string): AgentState {
  return {
    address,
    messages: [],
  };
}

export async function getAgentState(address: string): Promise<AgentState> {
  return getMemoryProvider().get<AgentState>(
    storageKey(address),
    emptyState(address),
  );
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
  x402Proposal?: X402PaymentProposal;
  tradeProposal?: TradeProposal;
  tokenizedStockReport?: TokenizedStockReport;
}

function createMessage(
  role: AgentRole,
  content: string,
  extra?: AssistantExtras,
): AgentMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    timestamp: new Date().toISOString(),
    ...(extra?.intent ? { intent: extra.intent } : {}),
    ...(extra?.actions && extra.actions.length > 0
      ? { actions: extra.actions }
      : {}),
    ...(extra?.highlights && extra.highlights.length > 0
      ? { highlights: extra.highlights }
      : {}),
    ...(extra?.followUps && extra.followUps.length > 0
      ? { followUps: extra.followUps }
      : {}),
    ...(extra?.x402Proposal
      ? { x402Proposal: extra.x402Proposal }
      : {}),
    ...(extra?.tradeProposal
      ? { tradeProposal: extra.tradeProposal }
      : {}),
    ...(extra?.tokenizedStockReport
      ? { tokenizedStockReport: extra.tokenizedStockReport }
      : {}),
  };
}

export async function appendUserMessage(
  address: string,
  content: string,
): Promise<AgentState> {
  const trimmed = content.trim();

  if (!trimmed) {
    return getAgentState(address);
  }

  const state = await getAgentState(address);

  const updated: AgentState = {
    ...state,
    messages: [
      ...state.messages,
      createMessage("user", trimmed),
    ],
  };

  return saveAgentState(updated);
}

export async function appendAssistantReply(
  address: string,
  userPrompt: string,
  context: AgentContext,
): Promise<AgentState> {
  const state = await getAgentState(address);

  const promptContext = await buildAgentPromptContext(
    address,
    userPrompt,
    context,
    state.messages,
  );

  const {
    intent,
    reply,
    actions,
    highlights,
    followUps,
    x402Proposal,
    tradeProposal,
    tokenizedStockReport,
  } = await getAIProvider().generateReply({
    prompt: userPrompt,
    agentContext: promptContext.agent,
    previousIntent: promptContext.previousIntent,
    memoryContext: promptContext.memory,
    address,
  });

  const updated: AgentState = {
    ...state,
    messages: [
      ...state.messages,
      createMessage("assistant", reply, {
        intent,
        actions,
        highlights,
        followUps,
        x402Proposal,
        tradeProposal,
        tokenizedStockReport,
      }),
    ],
  };

  return saveAgentState(updated);
}

/**
 * Appends an assistant message whose content was already computed
 * elsewhere, such as a deterministic slash-command result.
 *
 * This path deliberately does not invoke the AI provider.
 */
export async function appendAssistantMessage(
  address: string,
  content: string,
  extra?: AssistantExtras,
): Promise<AgentState> {
  const state = await getAgentState(address);

  const updated: AgentState = {
    ...state,
    messages: [
      ...state.messages,
      createMessage("assistant", content, extra),
    ],
  };

  return saveAgentState(updated);
}

/**
 * Appends an assistant message for a slash-command result.
 *
 * commandName is intentionally not persisted on AgentMessage because
 * command execution is already recorded separately by the command
 * history/event system.
 */
export async function appendCommandMessage(
  address: string,
  content: string,
  commandName: string,
): Promise<AgentState> {
  void commandName;
  return appendAssistantMessage(address, content);
}

export async function regenerateLastReply(
  address: string,
  context: AgentContext,
): Promise<AgentState> {
  const state = await getAgentState(address);

  const last = state.messages[state.messages.length - 1];

  if (!last || last.role !== "assistant") {
    return state;
  }

  let userIndex = -1;

  for (let i = state.messages.length - 2; i >= 0; i--) {
    if (state.messages[i].role === "user") {
      userIndex = i;
      break;
    }
  }

  if (userIndex === -1) {
    return state;
  }

  const userPrompt = state.messages[userIndex].content;
  const trimmedMessages = state.messages.slice(0, -1);

  const promptContext = await buildAgentPromptContext(
    address,
    userPrompt,
    context,
    trimmedMessages,
  );

  const {
    intent,
    reply,
    actions,
    highlights,
    followUps,
    x402Proposal,
    tradeProposal,
    tokenizedStockReport,
  } = await getAIProvider().generateReply({
    prompt: userPrompt,
    agentContext: promptContext.agent,
    previousIntent: promptContext.previousIntent,
    memoryContext: promptContext.memory,
    address,
  });

  const updated: AgentState = {
    ...state,
    messages: [
      ...trimmedMessages,
      createMessage("assistant", reply, {
        intent,
        actions,
        highlights,
        followUps,
        x402Proposal,
        tradeProposal,
        tokenizedStockReport,
      }),
    ],
  };

  return saveAgentState(updated);
}

export async function setMessageFeedback(
  address: string,
  messageId: string,
  feedback: AgentFeedback,
): Promise<AgentState> {
  const state = await getAgentState(address);

  const updated: AgentState = {
    ...state,
    messages: state.messages.map((message) =>
      message.id === messageId && message.role === "assistant"
        ? {
            ...message,
            feedback:
              message.feedback === feedback
                ? undefined
                : feedback,
          }
        : message,
    ),
  };

  return saveAgentState(updated);
}

export async function clearAgentState(
  address: string,
): Promise<AgentState> {
  return saveAgentState(emptyState(address));
}

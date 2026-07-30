import {
  appendAssistantMessage,
  appendAssistantReply,
  appendUserMessage,
  clearAgentState,
  getAgentState,
  regenerateLastReply,
  setMessageFeedback,
  type AgentFeedback,
  type AgentState,
} from "@/lib/agent-engine";
import type { AgentContext } from "@/lib/agent-context";
import type { EventBus, Logger, PerformanceMonitor, TaskQueue } from "../core/types";

export interface AgentAIServiceDeps {
  eventBus: EventBus;
  logger: Logger;
  performanceMonitor: PerformanceMonitor;
  taskQueue: TaskQueue;
}

export class AgentAIService {
  constructor(private readonly deps: AgentAIServiceDeps) {}

  async loadState(address: string): Promise<AgentState> {
    return this.deps.performanceMonitor.time("agent.loadState", () => getAgentState(address));
  }

  async sendMessage(address: string, content: string): Promise<AgentState> {
    const state = await this.deps.performanceMonitor.time("agent.sendMessage", () =>
      appendUserMessage(address, content)
    );
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "user") {
      this.deps.eventBus.emit("message_sent", { address, messageId: last.id, content: last.content });
      this.deps.eventBus.emit("memory_saved", { address, key: `agent:${address}` });
    }
    this.deps.logger.debug("User message persisted", { address });
    return state;
  }

  async generateReply(address: string, userPrompt: string, context: AgentContext): Promise<AgentState> {
    const state = await this.deps.performanceMonitor.time("agent.generateReply", () =>
      appendAssistantReply(address, userPrompt, context)
    );
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "assistant") {
      this.deps.eventBus.emit("message_received", {
        address,
        messageId: last.id,
        intent: last.intent ?? "general_help",
      });
      this.deps.eventBus.emit("memory_updated", { address, key: `agent:${address}` });
    }
    return state;
  }

  // Phase 3A.6 — command path (lib/agent-commands/*). Slash commands
  // resolve deterministically and skip lib/agent-intelligence.ts
  // entirely, so this persists the already-computed reply text via
  // lib/agent-engine.ts's appendAssistantMessage rather than
  // appendAssistantReply — same createMessage/saveAgentState path as
  // every other method here, just without the intent-generation call.
  // `commandName` is used as the emitted event's `intent` field so
  // downstream listeners (future analytics/indexing) can distinguish a
  // command result from a conversational one.
  async runCommand(address: string, commandName: string, replyText: string): Promise<AgentState> {
    const state = await this.deps.performanceMonitor.time("agent.runCommand", () =>
      appendAssistantMessage(address, replyText)
    );
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "assistant") {
      this.deps.eventBus.emit("message_received", { address, messageId: last.id, intent: commandName });
      this.deps.eventBus.emit("memory_updated", { address, key: `agent:${address}` });
    }
    this.deps.logger.debug("Command executed", { address, commandName });
    return state;
  }

  async regenerate(address: string, context: AgentContext): Promise<AgentState> {
    const state = await this.deps.performanceMonitor.time("agent.regenerate", () =>
      regenerateLastReply(address, context)
    );
    this.deps.eventBus.emit("memory_updated", { address, key: `agent:${address}` });
    return state;
  }

  async setFeedback(address: string, messageId: string, feedback: AgentFeedback): Promise<AgentState> {
    const state = await setMessageFeedback(address, messageId, feedback);
    this.deps.eventBus.emit("memory_updated", { address, key: `agent:${address}` });
    return state;
  }

  async clear(address: string): Promise<AgentState> {
    const state = await clearAgentState(address);
    this.deps.eventBus.emit("memory_updated", { address, key: `agent:${address}` });
    return state;
  }

  enqueueBackgroundTask<T>(label: string, work: () => Promise<T>): string {
    return this.deps.taskQueue.enqueue(label, work);
  }
}

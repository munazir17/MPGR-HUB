import {
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

// Phase 3A.5 — the "AI Service" in the UI -> Hook -> AI Service -> Memory
// Provider -> Storage chain. This class does NOT reimplement
// lib/agent-engine.ts's message rules (createMessage, intent carry-over,
// regenerate/feedback semantics) — it calls them as-is and adds the
// cross-cutting concerns those pure functions shouldn't know about: event
// emission, timing, and logging. hooks/useAgentChat.ts talks to this
// class; it never imports lib/agent-engine.ts's functions directly
// anymore.
//
// Every dependency is injected via the constructor (objective 9) rather
// than imported — a test, or a future service (AI Trading, AI Execution)
// wanting a different Logger/EventBus, supplies its own without touching
// this class's internals. See agent-ai-service-instance.ts for the one
// place these are actually wired together.
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

  // Background-safe hook for future work (memory summarization/ranking,
  // knowledge indexing, portfolio refresh) — enqueues onto the shared
  // TaskQueue instead of running inline. Nothing calls this yet; it
  // exists so Phase 3B can start enqueueing real jobs without adding a
  // new dependency chain.
  enqueueBackgroundTask<T>(label: string, work: () => Promise<T>): string {
    return this.deps.taskQueue.enqueue(label, work);
  }
}

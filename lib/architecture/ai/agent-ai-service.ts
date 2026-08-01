import {
  appendAssistantReply,
  appendCommandMessage,
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
// Phase 3B Part 1 — Memory Engine. Every call below runs through
// enqueueBackgroundTask()/taskQueue.enqueue(), so it can never block a
// reply reaching the UI, and a failure here never surfaces as a chat
// error (it's logged by the task queue instead).
import { clearAllMemory, recordAssistantTurn, recordCommandTurn, recordUserTurn } from "@/lib/architecture/memory/memory-engine";

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
//
// Phase 3A.6 — Advanced Conversational UX. Adds runCommand(), which
// mirrors generateReply()'s exact shape (time -> persist -> emit events)
// for command-originated messages instead of lib/agent-intelligence.ts
// replies. No new dependency was needed — it reuses the same injected
// deps, so agent-ai-service-instance.ts requires no change.
//
// Phase 3B Part 1 — Memory Engine. Adds background recording calls into
// lib/architecture/memory/memory-engine.ts inside generateReply(),
// clear(), and runCommand(). Every existing method's signature, return
// value, and persisted-state behavior is UNCHANGED — the new calls are
// enqueued onto the existing TaskQueue (taskQueue.enqueue(..., "low")),
// so they run after the method has already returned and can never delay
// a reply reaching the UI or change what the UI receives.
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

      // Phase 3B Part 1 — background memory recording. Runs after the
      // reply has already been returned to the caller above; never
      // delays message delivery. Any failure here is caught and logged
      // by InMemoryTaskQueue.drain(), never thrown back into the chat
      // flow.
      const intent = last.intent ?? null;
      this.deps.taskQueue.enqueue(
        "memory.recordTurn",
        async () => {
          await recordUserTurn(address, intent);
          await recordAssistantTurn(address, context, state.messages);
        },
        "low"
      );
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
    // Phase 3B Part 1 — clearing the chat also resets session/derived
    // memory, so a fresh conversation isn't silently biased by stale
    // topic-interest or summary data from before the clear.
    this.deps.taskQueue.enqueue("memory.clearAll", () => clearAllMemory(address), "low");
    return state;
  }

  // Background-safe hook for future work (memory summarization/ranking,
  // knowledge indexing, portfolio refresh) — enqueues onto the shared
  // TaskQueue instead of running inline.
  enqueueBackgroundTask<T>(label: string, work: () => Promise<T>): string {
    return this.deps.taskQueue.enqueue(label, work);
  }

  // Phase 3A.6 — mirrors generateReply's shape exactly (time -> persist ->
  // emit events), but for command-originated messages instead of
  // lib/agent-intelligence.ts replies. replyText is already computed by
  // lib/agent-commands/action-executor.ts before this is called; this
  // method's only job is persistence + telemetry, same division of
  // responsibility as every other method above.
  async runCommand(address: string, commandName: string, replyText: string): Promise<AgentState> {
    const state = await this.deps.performanceMonitor.time("agent.runCommand", () =>
      appendCommandMessage(address, replyText, commandName)
    );
    this.deps.eventBus.emit("command_executed", { address, commandName, resultKind: "message" });
    this.deps.eventBus.emit("memory_updated", { address, key: `agent:${address}` });
    // Phase 3B Part 1 — records command usage into User Memory for Part 3
    // personalization (favorite commands / modules).
    this.deps.taskQueue.enqueue("memory.recordCommand", () => recordCommandTurn(address, commandName), "low");
    return state;
  }
}

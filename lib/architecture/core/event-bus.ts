import type { AgentEventHandler, AgentEventMap, AgentEventName, EventBus, Logger } from "./types";
import { logger as defaultLogger } from "./logger";

// Phase 3A.5 — lightweight in-memory pub/sub (objective 3). AI modules
// (AgentAIService, and future Trading/Execution/Multi-Agent services)
// emit events here instead of importing and calling each other directly,
// so adding a new listener (a background indexer, an analytics hook, a
// second agent reacting to `portfolio_updated`) never means touching the
// module that emits it.
//
// Deliberately synchronous and local — no network, no persistence. If a
// future event needs to survive a page reload or cross a tab, that's a
// TaskQueue job reacting to the event, not a change to the bus itself.
export class InMemoryEventBus implements EventBus {
  private handlers = new Map<AgentEventName, Set<AgentEventHandler<any>>>();

  constructor(private readonly logger: Logger = defaultLogger) {}

  on<E extends AgentEventName>(event: E, handler: AgentEventHandler<E>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off<E extends AgentEventName>(event: E, handler: AgentEventHandler<E>): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        // One bad subscriber must never break the emitter or its other
        // subscribers — the "one component can't crash the whole Agent"
        // principle, applied at the event layer.
        this.logger.error(`Event handler for "${event}" threw`, { error: err });
      }
    }
  }
}

// Default singleton — every AI service shares this instance unless a
// different EventBus is explicitly injected (see
// lib/architecture/ai/agent-ai-service-instance.ts).
export const agentEventBus: EventBus = new InMemoryEventBus();

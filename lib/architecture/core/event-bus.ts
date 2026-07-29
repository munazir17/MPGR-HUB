import type { AgentEventHandler, AgentEventMap, AgentEventName, EventBus, EventMiddleware, Logger } from "./types";
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
//
// Phase 3A.5 (final) — middleware (objective: audit/analytics/security
// plugins without touching emitters). Every emit() now runs through the
// registered middleware chain, in registration order, before handlers are
// notified. With zero middleware registered (today's default, and every
// existing call site), emit()/on()/off() behave exactly as before —
// middleware is strictly additive.
export class InMemoryEventBus implements EventBus {
  private handlers = new Map<AgentEventName, Set<AgentEventHandler<any>>>();
  private middlewares: EventMiddleware[] = [];

  constructor(private readonly logger: Logger = defaultLogger) {}

  on<E extends AgentEventName>(event: E, handler: AgentEventHandler<E>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off<E extends AgentEventName>(event: E, handler: AgentEventHandler<E>): void {
    this.handlers.get(event)?.delete(handler);
  }

  // Registers a middleware. Returns an unsubscribe function, mirroring
  // on()'s shape, so a caller (analytics setup, an audit trail) can tear
  // its middleware down the same way it tears down an event handler.
  use(middleware: EventMiddleware): () => void {
    this.middlewares.push(middleware);
    return () => {
      this.middlewares = this.middlewares.filter((m) => m !== middleware);
    };
  }

  emit<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): void {
    this.runMiddleware(0, event, payload, () => this.dispatchToHandlers(event, payload));
  }

  // Walks the middleware chain by index rather than an array copy/slice,
  // so a middleware added or removed mid-chain (from inside another
  // middleware, an edge case but a possible one) can't corrupt an emit()
  // already in flight.
  private runMiddleware<E extends AgentEventName>(
    index: number,
    event: E,
    payload: AgentEventMap[E],
    done: () => void
  ): void {
    if (index >= this.middlewares.length) {
      done();
      return;
    }
    const middleware = this.middlewares[index];
    try {
      middleware(event, payload, () => this.runMiddleware(index + 1, event, payload, done));
    } catch (err) {
      // A broken middleware (bad analytics plugin, buggy audit hook) must
      // never block real subscribers from receiving the event — same
      // "one bad component can't break the rest" principle as handlers
      // below, applied to the middleware chain.
      this.logger.error(`Event middleware threw for "${event}"`, { error: err });
      this.runMiddleware(index + 1, event, payload, done);
    }
  }

  private dispatchToHandlers<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): void {
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

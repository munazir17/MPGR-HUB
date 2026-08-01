// Phase 3A.5 — Production Architecture Hardening.
//
// Shared contracts for every cross-cutting concern the AI stack depends
// on: logging, events, performance timing, and background task queuing.
// These interfaces have ONE goal: nothing in lib/architecture/ai/ or
// hooks/useAgentChat.ts should ever import a concrete implementation
// directly — only these types, with a concrete instance handed in via
// dependency injection (see lib/architecture/ai/agent-ai-service-instance.ts,
// the single composition root).
//
// None of this changes existing behavior today. It's the seam that lets
// Phase 3B (Hybrid Memory), AI Trading, AI Execution, and Multi-Agent work
// plug in without touching hooks/useAgentChat.ts or any UI component.

// --- Logging -------------------------------------------------------------

export type LogLevel = "debug" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

// --- Events ----------------------------------------------------------------
// The canonical set of events AI modules communicate through instead of
// calling each other directly. Payloads are plain, serializable data —
// no class instances, no live component refs — so any future subscriber
// (analytics, background indexing, a second AI agent) can consume them
// without importing UI or engine internals.

export interface AgentEventMap {
  message_sent: { address: string; messageId: string; content: string };
  message_received: { address: string; messageId: string; intent: string };
  memory_saved: { address: string; key: string };
  memory_updated: { address: string; key: string };
  wallet_changed: { address: string | null };
  portfolio_updated: { address: string };
  rewards_claimed: { address: string; amount: number };
  staking_changed: { address: string };
  // Phase 3A.6 — Advanced Conversational UX. Additive only; every event
  // above is untouched. Emitted by
  // lib/architecture/ai/agent-ai-service.ts's runCommand() and, in
  // future, lib/agent-commands/action-history.ts's clear flow.
  command_executed: { address: string; commandName: string; resultKind: "message" | "navigate" | "error" };
  action_history_cleared: { address: string };
  // Phase 3C Part 2 — AI Provider resilience. Emitted by
  // lib/architecture/ai/fallback-ai-provider.ts when a primary AIProvider
  // throws and generation falls back to a secondary provider. Additive
  // only; every event above is untouched.
  ai_provider_error: { address: string; provider: string; message: string };
  ai_provider_fallback: { address: string; from: string; to: string };
  // Phase 3C Part 5 — AI Provider circuit breaker. Emitted by
  // lib/architecture/ai/circuit-breaker-ai-provider.ts when a provider's
  // consecutive-failure count crosses its threshold (circuit opens, every
  // further call fails fast without invoking the provider) and when a
  // trial call after the cooldown succeeds (circuit closes again).
  // Additive only; every event above is untouched.
  ai_provider_circuit_opened: { provider: string; consecutiveFailures: number };
  ai_provider_circuit_closed: { provider: string };
}

export type AgentEventName = keyof AgentEventMap;

export type AgentEventHandler<E extends AgentEventName> = (payload: AgentEventMap[E]) => void;

// Phase 3A.5 (final) — middleware sits in front of every emit(), able to
// inspect/log/audit an event before subscribers ever see it, without the
// emitter (AgentAIService, future Trading/Execution services) knowing
// middleware exists at all. `next()` must be called to continue the
// chain; not calling it short-circuits delivery to handlers — useful for
// a future security/filtering middleware, though today's use() consumers
// (logging, analytics, audit) always call it.
export type EventMiddleware = <E extends AgentEventName>(
  event: E,
  payload: AgentEventMap[E],
  next: () => void
) => void;

export interface EventBus {
  on<E extends AgentEventName>(event: E, handler: AgentEventHandler<E>): () => void;
  off<E extends AgentEventName>(event: E, handler: AgentEventHandler<E>): void;
  emit<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): void;
  // Registers a middleware, run in registration order before handlers on
  // every emit(). Returns an unsubscribe function, mirroring on()'s shape.
  use(middleware: EventMiddleware): () => void;
}

// --- Performance monitoring -------------------------------------------------

export interface PerformanceMetric {
  label: string;
  durationMs: number;
  timestamp: string;
}

export interface PerformanceMonitor {
  // Wraps an async operation, records its duration under `label`, and
  // returns the operation's own result untouched.
  time<T>(label: string, fn: () => Promise<T>): Promise<T>;
  // Synchronous variant, e.g. for render-duration style measurements.
  timeSync<T>(label: string, fn: () => T): T;
  getMetrics(label?: string): PerformanceMetric[];
  clear(): void;
}

// --- Background task queue ---------------------------------------------------

export type TaskStatus = "pending" | "running" | "done" | "failed";

// Phase 3A.5 (final) — HIGH drains before NORMAL, which drains before LOW;
// FIFO order is preserved *within* each priority. Optional and defaults to
// "normal" everywhere, so every existing enqueue(label, work) call site
// keeps its current (single-FIFO-lane) behavior unchanged.
export type TaskPriority = "high" | "normal" | "low";

export interface Task<T = unknown> {
  id: string;
  label: string;
  status: TaskStatus;
  createdAt: string;
  error?: string;
  result?: T;
  priority: TaskPriority;
}

export interface TaskQueue {
  // Enqueues work and returns its task id immediately; execution happens
  // asynchronously, sequentially, in FIFO order within the chosen
  // priority lane (default "normal" — omit it and behavior is identical
  // to before). Never blocks the caller — this is for non-critical
  // background work (memory summarization, ranking, portfolio refresh,
  // trading analysis, knowledge indexing), never anything the UI is
  // synchronously waiting on.
  enqueue<T>(label: string, work: () => Promise<T>, priority?: TaskPriority): string;
  getTask(id: string): Task | undefined;
  getTasks(): Task[];
}

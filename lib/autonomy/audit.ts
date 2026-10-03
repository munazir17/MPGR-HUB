// lib/autonomy/audit.ts
//
// Auditable event trail (spec §21/§22). Every autonomous decision and
// action produces a serializable AutonomyAuditEvent that:
//   1. is emitted on the EXISTING InMemoryEventBus (agentEventBus) as an
//      additive AgentEventMap entry — observability consumers subscribe,
//      the emitter stays decoupled;
//   2. is persisted (bounded) via the AutonomyStore for the user-visible
//      history;
//   3. is timed on the EXISTING PerformanceMonitor.
//
// Events carry addresses, ids, codes, hashes and amounts — NEVER secrets
// (the type model cannot express them; see types.ts).

import type { EventBus, PerformanceMonitor } from "@/lib/architecture/core/types";
import type { AutonomyStore } from "./store";
import { AUTONOMY_LIMITS } from "./config";
import type { AutonomyAuditEvent } from "./types";

export interface AutonomyAuditSink {
  record(event: AutonomyAuditEvent): Promise<void>;
}

export class BusAuditSink implements AutonomyAuditSink {
  constructor(
    private readonly store: AutonomyStore,
    private readonly bus: EventBus,
    private readonly perf: PerformanceMonitor,
  ) {}

  async record(event: AutonomyAuditEvent): Promise<void> {
    // Persist first (bounded, best-effort must not break the runtime path —
    // but persistence failures ARE logged loudly by the task queue when used).
    await this.store.appendAudit(event, AUTONOMY_LIMITS.maxAuditEventsPerGoal);
    // Emit on the canonical bus — payload is the plain event object.
    this.bus.emit("autonomy_audit", { event });
    this.perf.timeSync(`autonomy.audit.${event.type}`, () => event.type);
  }
}

/** Convenience builder that stamps time; keeps call sites terse. */
export function auditEvent(
  wallet: string,
  type: AutonomyAuditEvent["type"],
  at: Date,
  extra?: { goalId?: string; policyId?: string; data?: AutonomyAuditEvent["data"] },
): AutonomyAuditEvent {
  return {
    at: at.toISOString(),
    type,
    wallet: wallet as AutonomyAuditEvent["wallet"],
    goalId: extra?.goalId,
    policyId: extra?.policyId,
    data: extra?.data,
  };
}

// lib/autonomy/store.ts
//
// Durable state for the Autonomous Agent Runtime (spec §7).
//
// NOT a new memory system: agent chat/memory stays in
// lib/architecture/memory/*. THIS store holds only authorization-grade
// state that must be server-side and durable — policies, goals, action
// records, audit trails, daily counters, idempotency guards — the same
// class of data as the existing x402 proposal store / session registry.
//
// It NEVER stores private keys, seed phrases, or credentials (there is no
// field for them anywhere in the type model — see types.ts).
//
// Two implementations of one interface:
//   InMemoryAutonomyStore — tests (and tests only).
//   RedisAutonomyStore    — production (redis-store.ts, fail-closed).

import { canTransitionGoal } from "./types";
import { InvalidGoalTransitionError, requireTransition } from "./goal-machine";
import { makeId, utcDayKey } from "./idempotency";
import type {
  AgentGoal,
  AutonomyAuditEvent,
  AutonomyPolicy,
  GoalActionRecord,
  GoalStatus,
} from "./types";

export interface GoalTransitionPatch {
  status?: GoalStatus;
  description?: string;
  condition?: AgentGoal["condition"];
  nextEvaluationAt?: string;
  lastEvaluationAt?: string;
  lastAction?: string | null;
  lastResult?: AgentGoal["lastResult"];
  pendingExecution?: AgentGoal["pendingExecution"];
  stats?: AgentGoal["stats"];
  maxTrades?: number | null;
  updatedAt: string;
}

export interface AutonomyStore {
  // -- policies ------------------------------------------------------------
  createPolicy(policy: AutonomyPolicy): Promise<AutonomyPolicy>;
  getPolicy(policyId: string): Promise<AutonomyPolicy | null>;
  listPolicies(wallet: string): Promise<AutonomyPolicy[]>;
  /** CAS: only succeeds when the policy exists, belongs to the wallet and is not already revoked. */
  revokePolicy(policyId: string, wallet: string, revokedAt: string): Promise<AutonomyPolicy | null>;

  // -- goals ---------------------------------------------------------------
  createGoal(goal: AgentGoal): Promise<AgentGoal>;
  getGoal(goalId: string): Promise<AgentGoal | null>;
  listGoals(wallet: string): Promise<AgentGoal[]>;
  countNonTerminalGoals(wallet: string): Promise<number>;
  /**
   * CAS transition: applies ONLY if the goal's current status is in
   * `expectedFrom` AND updatedAt matches `expectedUpdatedAt` AND the move
   * is legal per the state machine. Returns null on any mismatch.
   * NOTE: `expiresAt` is intentionally NOT patchable here — goals expire on
   * the schedule they were created with (edit = cancel + recreate).
   */
  transitionGoal(
    goalId: string,
    wallet: string,
    expectedFrom: readonly GoalStatus[],
    expectedUpdatedAt: string,
    patch: GoalTransitionPatch,
  ): Promise<AgentGoal | null>;

  // -- due scan (scheduler) --------------------------------------------------
  listKnownWallets(limit: number): Promise<string[]>;

  // -- daily counters (UTC day keys) -----------------------------------------
  // Single source of truth: one atomic ledger append per action records BOTH
  // the spend amount and the action count, so they can never drift apart.
  getDailySpendRaw(policyId: string, dayKey: string): Promise<string>;
  /**
   * Atomically appends one action to the UTC-day ledger. Returns the updated
   * ledger entries (sum with BigInt for exact spend), or null when the
   * policy's daily action cap is reached (caller must refuse the action).
   */
  tryRecordDailyAction(policyId: string, dayKey: string, amountRaw: string, maxActions: number): Promise<string[] | null>;
  getDailyActions(policyId: string, dayKey: string): Promise<number>;

  // -- idempotency -----------------------------------------------------------
  /** SET-NX claim. True => this caller owns the key for the lease duration. */
  claimExecution(idempotencyKey: string, ttlSeconds: number): Promise<boolean>;
  releaseExecution(idempotencyKey: string): Promise<void>;
  /** Per-goal evaluation lease (prevents concurrent ticks on one goal). */
  tryAcquireGoalLease(goalId: string, token: string, ttlSeconds: number): Promise<boolean>;
  releaseGoalLease(goalId: string, token: string): Promise<void>;

  // -- audit + history ---------------------------------------------------------
  appendAudit(event: AutonomyAuditEvent, maxEvents: number): Promise<void>;
  listAudit(goalId: string): Promise<AutonomyAuditEvent[]>;
  saveActionRecord(record: GoalActionRecord, maxRecords: number): Promise<void>;
  listActionRecords(goalId: string): Promise<GoalActionRecord[]>;
}

export function newGoalId(now: Date): string {
  return makeId("goal", now, randomEntropy());
}

export function newPolicyId(now: Date): string {
  return makeId("pol", now, randomEntropy());
}

function randomEntropy(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// In-memory implementation — TESTS ONLY (never wired in production).
// ---------------------------------------------------------------------------

export class InMemoryAutonomyStore implements AutonomyStore {
  readonly policies = new Map<string, AutonomyPolicy>();
  readonly goals = new Map<string, AgentGoal>();
  readonly ledgers = new Map<string, string[]>();
  readonly execKeys = new Map<string, number>(); // key -> expiresAtMs
  readonly leases = new Map<string, { token: string; expiresAtMs: number }>();
  readonly audit = new Map<string, AutonomyAuditEvent[]>();
  readonly actionRecords = new Map<string, GoalActionRecord[]>();
  clock: () => number = () => Date.now();

  async createPolicy(policy: AutonomyPolicy): Promise<AutonomyPolicy> {
    const withId: AutonomyPolicy = { ...policy, id: policy.id || newPolicyId(new Date(this.clock())) };
    this.policies.set(withId.id, { ...withId });
    return { ...withId };
  }

  async getPolicy(policyId: string): Promise<AutonomyPolicy | null> {
    const p = this.policies.get(policyId);
    return p ? { ...p } : null;
  }

  async listPolicies(wallet: string): Promise<AutonomyPolicy[]> {
    return [...this.policies.values()]
      .filter((p) => p.wallet.toLowerCase() === wallet.toLowerCase())
      .map((p) => ({ ...p }));
  }

  async revokePolicy(policyId: string, wallet: string, revokedAt: string): Promise<AutonomyPolicy | null> {
    const p = this.policies.get(policyId);
    if (!p || p.wallet.toLowerCase() !== wallet.toLowerCase() || p.revokedAt) return null;
    p.revokedAt = revokedAt;
    return { ...p };
  }

  async createGoal(goal: AgentGoal): Promise<AgentGoal> {
    const withId: AgentGoal = { ...goal, id: goal.id || newGoalId(new Date(this.clock())) };
    this.goals.set(withId.id, { ...withId });
    return { ...withId };
  }

  async getGoal(goalId: string): Promise<AgentGoal | null> {
    const g = this.goals.get(goalId);
    return g ? structuredClone(g) : null;
  }

  async listGoals(wallet: string): Promise<AgentGoal[]> {
    return [...this.goals.values()]
      .filter((g) => g.wallet.toLowerCase() === wallet.toLowerCase())
      .map((g) => structuredClone(g));
  }

  async countNonTerminalGoals(wallet: string): Promise<number> {
    const terminal = ["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"];
    return [...this.goals.values()].filter((g) => g.wallet.toLowerCase() === wallet.toLowerCase() && !terminal.includes(g.status)).length;
  }

  async transitionGoal(
    goalId: string,
    wallet: string,
    expectedFrom: readonly GoalStatus[],
    expectedUpdatedAt: string,
    patch: GoalTransitionPatch,
  ): Promise<AgentGoal | null> {
    const g = this.goals.get(goalId);
    if (!g || g.wallet.toLowerCase() !== wallet.toLowerCase()) return null;
    if (g.updatedAt !== expectedUpdatedAt) return null;
    if (!expectedFrom.includes(g.status)) return null;
    const to = patch.status ?? g.status;
    if (to !== g.status && !canTransitionGoal(g.status, to)) {
      throw new InvalidGoalTransitionError(g.status, to);
    }
    const next: AgentGoal = { ...structuredClone(g), ...goalFieldsFromPatch(patch), status: to };
    this.goals.set(goalId, next);
    return structuredClone(next);
  }

  async listKnownWallets(limit: number): Promise<string[]> {
    return [...new Set([...this.goals.values()].map((g) => g.wallet.toLowerCase()))].slice(0, limit);
  }

  private spendKey(policyId: string, dayKey: string): string {
    return `${policyId}:${dayKey}`;
  }

  private ledger(policyId: string, dayKey: string): string[] {
    return this.ledgers.get(this.spendKey(policyId, dayKey)) ?? [];
  }

  async getDailySpendRaw(policyId: string, dayKey: string): Promise<string> {
    return this.ledger(policyId, dayKey).reduce<bigint>((sum, v) => sum + BigInt(v), 0n).toString();
  }

  async tryRecordDailyAction(policyId: string, dayKey: string, amountRaw: string, maxActions: number): Promise<string[] | null> {
    const key = this.spendKey(policyId, dayKey);
    const list = this.ledgers.get(key) ?? [];
    if (list.length + 1 > maxActions) return null;
    list.push(amountRaw);
    this.ledgers.set(key, list);
    return [...list];
  }

  async getDailyActions(policyId: string, dayKey: string): Promise<number> {
    return this.ledger(policyId, dayKey).length;
  }

  async claimExecution(idempotencyKey: string, ttlSeconds: number): Promise<boolean> {
    const nowMs = this.clock();
    this.sweepExpired(nowMs);
    if (this.execKeys.has(idempotencyKey)) return false;
    this.execKeys.set(idempotencyKey, nowMs + ttlSeconds * 1000);
    return true;
  }

  async releaseExecution(idempotencyKey: string): Promise<void> {
    this.execKeys.delete(idempotencyKey);
  }

  async tryAcquireGoalLease(goalId: string, token: string, ttlSeconds: number): Promise<boolean> {
    const nowMs = this.clock();
    this.sweepExpired(nowMs);
    const existing = this.leases.get(goalId);
    if (existing && existing.expiresAtMs > nowMs) return false;
    this.leases.set(goalId, { token, expiresAtMs: nowMs + ttlSeconds * 1000 });
    return true;
  }

  async releaseGoalLease(goalId: string, token: string): Promise<void> {
    const existing = this.leases.get(goalId);
    if (existing && existing.token === token) this.leases.delete(goalId);
  }

  private sweepExpired(nowMs: number): void {
    for (const [k, exp] of this.execKeys) if (exp <= nowMs) this.execKeys.delete(k);
    for (const [k, v] of this.leases) if (v.expiresAtMs <= nowMs) this.leases.delete(k);
  }

  async appendAudit(event: AutonomyAuditEvent, maxEvents: number): Promise<void> {
    const list = this.audit.get(event.goalId ?? "_global") ?? [];
    const lastSeq = list.length > 0 ? (list[list.length - 1].seq ?? list.length) : 0;
    list.push({ ...event, seq: lastSeq + 1 });
    while (list.length > maxEvents) list.shift();
    this.audit.set(event.goalId ?? "_global", list);
  }

  async listAudit(goalId: string): Promise<AutonomyAuditEvent[]> {
    return [...(this.audit.get(goalId) ?? [])];
  }

  async saveActionRecord(record: GoalActionRecord, maxRecords: number): Promise<void> {
    const list = this.actionRecords.get(record.goalId) ?? [];
    const idx = list.findIndex((r) => r.idempotencyKey === record.idempotencyKey);
    if (idx >= 0) list[idx] = record;
    else list.push(record);
    while (list.length > maxRecords) list.shift();
    this.actionRecords.set(record.goalId, list);
  }

  async listActionRecords(goalId: string): Promise<GoalActionRecord[]> {
    return [...(this.actionRecords.get(goalId) ?? [])];
  }
}

function stripUndefined<T extends object>(value: T): Partial<AgentGoal> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<AgentGoal>;
}

/**
 * Converts a transition patch into goal fields. `maxTrades: null` (patch)
 * means "remove the cap" — represented by the key's absence on the goal.
 */
function goalFieldsFromPatch(patch: GoalTransitionPatch): Partial<AgentGoal> {
  const { maxTrades, ...rest } = patch;
  const fields = stripUndefined(rest);
  if (maxTrades != null) fields.maxTrades = maxTrades;
  return fields;
}

/** Guard for API-layer calls that must not mutate a terminal goal. */
export function assertMutable(goal: AgentGoal): void {
  requireTransition(goal.status, goal.status);
}

export { utcDayKey };

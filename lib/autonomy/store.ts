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
import { legacyLedgerPoison } from "./day-ledger-scripts";
import { InvalidGoalTransitionError, requireTransition } from "./goal-machine";
import { makeId, utcDayKey } from "./idempotency";
import {
  isPreBroadcastRefusalCode,
  type AgentGoal,
  type AutonomyAuditEvent,
  type AutonomyPolicy,
  type GoalActionRecord,
  type GoalStatus,
  type SpendReservationRelease,
  type SpendReservationState,
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

/**
 * View of one policy-day ledger. `status` is never a silent zero: when the
 * legacy CSV is malformed or the fenced ledger is missing/corrupt the totals
 * are UNKNOWN and callers must refuse to act (fail closed).
 */
export type DayLedgerSnapshot =
  | { status: "OK"; spendRaw: string; actions: number }
  | { status: "MALFORMED_LEGACY" | "LEDGER_UNAVAILABLE"; spendRaw: null; actions: null };

export type ReserveDailySpendResult =
  | {
      ok: true;
      /** Existing state when false — an idempotent retry, never double-counted. */
      created: boolean;
      state: SpendReservationState;
      snapshot: { spendRaw: string; actions: number };
    }
  | {
      ok: false;
      reason: "OVER_BUDGET" | "OVER_ACTIONS" | "MALFORMED_LEGACY" | "LEDGER_UNAVAILABLE" | "BAD_AMOUNT";
      snapshot: { spendRaw: string; actions: number } | null;
    };

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

  // -- daily spend reservations (UTC day keys) -------------------------------
  // Single source of truth: one RESERVATION per execution id records the
  // spend amount AND the action count atomically, so they can never drift
  // apart — and the daily caps (maxDailyRaw / maxActionsPerDay) are enforced
  // in the SAME atomic operation that takes the reservation. Concurrent goals
  // sharing a policy therefore cannot jointly exceed either cap.
  //
  // Lifecycle: reserve -> markSpendAttempt (BEFORE the execution adapter is
  // invoked) -> commit | release | markSpendAmbiguous. See types.ts and
  // docs/AUTONOMY-DAILY-SPEND-RESERVATIONS.md for the exact release rules.
  //
  // Reads run the legacy CSV -> hash migration fence first (idempotent,
  // fail-closed on malformed legacy data) so the totals always include
  // pre-migration entries.

  /** Fenced day totals — spend counted against the cap, and action count. */
  getDayLedger(policyId: string, dayKey: string): Promise<DayLedgerSnapshot>;

  /**
   * Atomically reserve `amountRaw` (exact decimal-string units) for one
   * execution id against the policy-day caps. Idempotent per execution id:
   * retries/duplicates never double-count. Fail-closed on malformed legacy
   * data or an unknown ledger state (never a silent zero reset).
   */
  reserveDailySpend(input: {
    policyId: string;
    dayKey: string;
    execId: string;
    amountRaw: string;
    maxDailyRaw: string;
    maxActions: number;
  }): Promise<ReserveDailySpendResult>;

  /**
   * The ATTEMPT MARKER: RESERVED -> ATTEMPTING. MUST be persisted before the
   * execution adapter is invoked. Once this returns the reservation must
   * never be released automatically — the adapter may have broadcast.
   */
  markSpendAttempt(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null>;

  /** Terminal consumed (successful or reverted execution). Idempotent. */
  commitDailySpend(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null>;

  /**
   * The ONLY way spend is freed. `PRE_BROADCAST_REFUSAL` releases only for an
   * explicit verified pre-broadcast code (validated here too — defense in
   * depth); `UNATTEMPTED` releases only a RESERVED (never-attempted) entry.
   * Returns the resulting state, or null when the release is refused/unknown.
   */
  releaseDailySpend(
    policyId: string,
    dayKey: string,
    execId: string,
    release: SpendReservationRelease,
  ): Promise<SpendReservationState | null>;

  /**
   * Operator/recovery primitive for a stuck ATTEMPTING reservation with an
   * unknown broadcast outcome: ATTEMPTING -> AMBIGUOUS. Spend STAYS counted.
   * Never releases anything.
   */
  markSpendAmbiguous(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null>;

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
  /**
   * Legacy CSV day ledgers, RAW string per policy-day (mirrors the Redis key
   * `mpgrhub:autonomy:day:{policyId}:{day}` exactly — including the fence
   * poison after migration). Tests use this to simulate frozen pre-fix
   * writers against the same key the production migration fences.
   */
  readonly legacyDayLedgers = new Map<string, string>();
  /** Authoritative day hashes (mirrors `mpgrhub:autonomy:dayv2:...`). */
  readonly dayHashes = new Map<string, InMemoryDayHash>();
  /** Fence markers (mirrors `mpgrhub:autonomy:dayfence:...`). */
  readonly dayFences = new Set<string>();
  /** Migration archives (mirrors `mpgrhub:autonomy:dayarchive:...`). */
  readonly dayArchives = new Map<string, string>();
  /**
   * Write-witness counters (mirrors `mpgrhub:autonomy:daygen:...`): "0" at
   * import, incremented by every mutation. The proof `restoreDayLedger`
   * needs — see the Lua `RESTORE_DAY_LEDGER_SCRIPT` rationale.
   */
  readonly dayGens = new Map<string, string>();
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

  private dayKey(policyId: string, dayKey: string): string {
    return `${policyId}:${dayKey}`;
  }

  /**
   * In-memory mirror of the Lua `ensure_day_ledger()` — identical semantics:
   * validate ALL legacy data first, write only after validation, fence+poison
   * atomically, and never reset an existing total to zero.
   */
  private ensureDayLedger(policyId: string, dayKey: string): DayLedgerSnapshot {
    const key = this.dayKey(policyId, dayKey);
    const poison = legacyLedgerPoison();
    const legacy = this.legacyDayLedgers.get(key);
    const poisoned = legacy !== undefined && legacy === poison;
    const fenced = this.dayFences.has(key) || poisoned;

    if (fenced) {
      const hash = this.dayHashes.get(key);
      if (hash && hash.migrated) {
        return { status: "OK", spendRaw: hash.total, actions: hash.count };
      }
      // Fenced but the hash is missing/corrupt: totals UNKNOWN — never zero.
      return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
    }

    // Not fenced. A migrated hash is authoritative — NEVER re-import over it
    // (an archive-only re-import would drop post-migration reservations and
    // undercount spend). Unpoisoned legacy CSV next to a migrated hash = foreign
    // entries that were never imported — fail closed. A migrated hash without a
    // fence is corrupt state — fail closed; keep all data.
    const existing = this.dayHashes.get(key);
    if (existing) {
      if (!existing.migrated) {
        return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
      }
      if (legacy !== undefined && legacy !== poison) {
        return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
      }
      return { status: "OK", spendRaw: existing.total, actions: existing.count };
    }

    // Hash missing but a write-witness exists: this policy-day was migrated
    // before and the hash was lost. Re-importing the legacy CSV alone would
    // silently undercount any post-migration writes — fail closed; recovery is
    // restoreDayLedger (only valid while the witness is "0").
    if (this.dayGens.has(key)) {
      return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
    }

    // True first access: import the legacy CSV (if any). Validate first —
    // writes come only after every field has been accepted.
    let sum = 0n;
    let count = 0;
    if (legacy !== undefined) {
      const parsed = parseLegacyCsvStrict(legacy);
      if (parsed === null) return { status: "MALFORMED_LEGACY", spendRaw: null, actions: null };
      sum = parsed.sum;
      count = parsed.count;
    }

    // All validation done — write (the whole method is synchronous, so this
    // is atomic w.r.t. other store calls, like the Redis script).
    const total = sum.toString();
    this.dayHashes.set(key, {
      total,
      count,
      migrated: true,
      legacy: total,
      legacyCount: count,
      reservations: new Map(),
    });
    this.dayFences.add(key);
    if (legacy !== undefined) this.dayArchives.set(key, legacy);
    this.legacyDayLedgers.set(key, poison);
    this.dayGens.set(key, "0");
    return { status: "OK", spendRaw: total, actions: count };
  }

  /** Mirror of the Lua `INCR daygen` write-witness bump. */
  private bumpDayGen(policyId: string, dayKey: string): void {
    const key = this.dayKey(policyId, dayKey);
    const cur = this.dayGens.get(key);
    this.dayGens.set(key, String((cur === undefined ? 0 : Number(cur)) + 1));
  }

  async getDayLedger(policyId: string, dayKey: string): Promise<DayLedgerSnapshot> {
    return this.ensureDayLedger(policyId, dayKey);
  }

  async reserveDailySpend(input: {
    policyId: string;
    dayKey: string;
    execId: string;
    amountRaw: string;
    maxDailyRaw: string;
    maxActions: number;
  }): Promise<ReserveDailySpendResult> {
    const { policyId, dayKey, execId, amountRaw, maxDailyRaw, maxActions } = input;
    if (!/^\d+$/.test(amountRaw) || !/^\d+$/.test(maxDailyRaw) || !Number.isInteger(maxActions)) {
      return { ok: false, reason: "BAD_AMOUNT", snapshot: null };
    }
    const led = this.ensureDayLedger(policyId, dayKey);
    if (led.status !== "OK") {
      return { ok: false, reason: led.status === "MALFORMED_LEGACY" ? "MALFORMED_LEGACY" : "LEDGER_UNAVAILABLE", snapshot: null };
    }
    const hash = this.dayHashes.get(this.dayKey(policyId, dayKey))!;
    const existing = hash.reservations.get(execId);
    if (existing) {
      // Idempotent: a duplicate execution id is never counted twice.
      return { ok: true, created: false, state: existing.state, snapshot: { spendRaw: hash.total, actions: hash.count } };
    }
    const amount = BigInt(amountRaw);
    const newTotal = BigInt(hash.total) + amount;
    if (newTotal > BigInt(maxDailyRaw)) {
      return { ok: false, reason: "OVER_BUDGET", snapshot: { spendRaw: hash.total, actions: hash.count } };
    }
    if (hash.count + 1 > maxActions) {
      return { ok: false, reason: "OVER_ACTIONS", snapshot: { spendRaw: hash.total, actions: hash.count } };
    }
    hash.reservations.set(execId, { state: "RESERVED", amount: amountRaw });
    hash.total = newTotal.toString();
    hash.count += 1;
    this.bumpDayGen(policyId, dayKey);
    return { ok: true, created: true, state: "RESERVED", snapshot: { spendRaw: hash.total, actions: hash.count } };
  }

  async markSpendAttempt(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null> {
    const res = this.dayHashes.get(this.dayKey(policyId, dayKey))?.reservations.get(execId);
    if (!res) return null;
    if (res.state === "RESERVED") {
      res.state = "ATTEMPTING";
      this.bumpDayGen(policyId, dayKey);
    }
    return res.state;
  }

  async commitDailySpend(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null> {
    const res = this.dayHashes.get(this.dayKey(policyId, dayKey))?.reservations.get(execId);
    if (!res) return null;
    if (res.state === "RESERVED" || res.state === "ATTEMPTING") {
      res.state = "COMMITTED";
      this.bumpDayGen(policyId, dayKey);
    }
    if (res.state === "COMMITTED" || res.state === "AMBIGUOUS") return res.state;
    return null; // RELEASED cannot be committed
  }

  async releaseDailySpend(
    policyId: string,
    dayKey: string,
    execId: string,
    release: SpendReservationRelease,
  ): Promise<SpendReservationState | null> {
    // Defense in depth: the store also refuses unverified codes.
    if (release.reason === "PRE_BROADCAST_REFUSAL" && !isPreBroadcastRefusalCode(release.code)) return null;
    const key = this.dayKey(policyId, dayKey);
    const hash = this.dayHashes.get(key);
    const res = hash?.reservations.get(execId);
    if (!hash || !res) return null;
    const allowed =
      (release.reason === "PRE_BROADCAST_REFUSAL" && (res.state === "RESERVED" || res.state === "ATTEMPTING")) ||
      (release.reason === "UNATTEMPTED" && res.state === "RESERVED");
    if (!allowed) return null;
    const newTotal = BigInt(hash.total) - BigInt(res.amount);
    if (newTotal < 0n || hash.count - 1 < 0) return null;
    res.state = "RELEASED";
    hash.total = newTotal.toString();
    hash.count -= 1;
    this.bumpDayGen(policyId, dayKey);
    return "RELEASED";
  }

  async markSpendAmbiguous(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null> {
    const res = this.dayHashes.get(this.dayKey(policyId, dayKey))?.reservations.get(execId);
    if (!res) return null;
    if (res.state === "ATTEMPTING") {
      res.state = "AMBIGUOUS";
      this.bumpDayGen(policyId, dayKey);
      return "AMBIGUOUS";
    }
    return null;
  }

  /**
   * Operator recovery mirror of RedisAutonomyStore.restoreDayLedger (tests +
   * parity only — the runtime never calls it): rebuild a migrated-but-lost day
   * hash from its migration archive. The archive only ever contains the legacy
   * CSV as imported — so restore is allowed ONLY when the write-witness proves
   * nothing was written after the import (gen == "0") and the archive is
   * therefore the full authoritative ledger. If post-migration reservations
   * existed (gen > 0), or completeness cannot be proven (no witness), this
   * fails closed: an incomplete total would UNDERCOUNT spend. Never invents
   * zero totals; never touches an existing hash.
   */
  async restoreDayLedger(policyId: string, dayKey: string): Promise<DayLedgerSnapshot> {
    const key = this.dayKey(policyId, dayKey);
    const poison = legacyLedgerPoison();
    const legacy = this.legacyDayLedgers.get(key);
    const poisoned = legacy !== undefined && legacy === poison;
    const fenced = this.dayFences.has(key) || poisoned;
    if (!fenced) return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
    if (this.dayHashes.has(key)) return this.ensureDayLedger(policyId, dayKey);
    const gen = this.dayGens.get(key);
    if (gen === undefined || gen !== "0") return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
    const archived = this.dayArchives.get(key);
    if (archived === undefined) return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
    const parsed = parseLegacyCsvStrict(archived);
    if (parsed === null) return { status: "MALFORMED_LEGACY", spendRaw: null, actions: null };
    this.dayHashes.set(key, {
      total: parsed.sum.toString(),
      count: parsed.count,
      migrated: true,
      legacy: parsed.sum.toString(),
      legacyCount: parsed.count,
      reservations: new Map(),
    });
    this.dayFences.add(key);
    this.dayGens.set(key, "0");
    return { status: "OK", spendRaw: parsed.sum.toString(), actions: parsed.count };
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

// ---------------------------------------------------------------------------
// Day-ledger in-memory internals (faithful mirror of the Lua in
// day-ledger-scripts.ts — same validation, same fail-closed rules).
// ---------------------------------------------------------------------------

interface InMemoryDayHash {
  total: string;
  count: number;
  migrated: true;
  legacy: string;
  legacyCount: number;
  reservations: Map<string, { state: SpendReservationState; amount: string }>;
}

/**
 * Strict legacy-CSV parse: EVERY field must be a digit string. Mirrors the
 * Lua `parse_csv_strict` exactly (empty fields and non-digit junk fail the
 * whole ledger closed — the old reader silently dropped them instead).
 */
function parseLegacyCsvStrict(csv: string): { sum: bigint; count: number } | null {
  if (csv === "") return { sum: 0n, count: 0 };
  let sum = 0n;
  let count = 0;
  for (const field of csv.split(",")) {
    if (!/^\d+$/.test(field)) return null;
    sum += BigInt(field);
    count += 1;
  }
  return { sum, count };
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

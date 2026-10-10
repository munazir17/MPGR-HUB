import "server-only";

// lib/autonomy/redis-store.ts
//
// Production AutonomyStore over the EXISTING Redis seam (lib/api/redis.ts —
// the same Upstash instance as sessions / x402 / games, collision-free
// `mpgrhub:autonomy:*` namespace).
//
// Design notes
//   * CAS via tiny Lua scripts that compare SCALARS (status / updatedAt /
//     wallet) kept in a per-record "meta" string — no JSON parsing inside
//     Lua, so the scripts are simple, auditable, and testable against the
//     repo's LuaRedis double.
//   * Daily spend ledger: a HASH of exact decimal-string totals plus one
//     reservation field per execution id (RESERVED -> ATTEMPTING ->
//     COMMITTED | AMBIGUOUS | RELEASED). The caps (maxDailyRaw and
//     maxActionsPerDay) are enforced INSIDE the atomic Lua that takes the
//     reservation, so concurrent goals sharing a policy cannot jointly
//     exceed them. Amounts are summed as decimal strings — exact for
//     18-decimals amounts where a Lua/JS number would lose precision. The
//     legacy pre-fix CSV ledger is imported and fenced atomically on first
//     access (see day-ledger-scripts.ts and
//     docs/AUTONOMY-DAILY-SPEND-RESERVATIONS.md).
//   * Audit trails and action records are read-modify-write under the
//     per-goal lease (single writer by construction).
//   * Fail-closed: Redis unavailability THROWS; callers (runtime/routes)
//     treat that as "cannot proceed" — never "proceed unguarded".
//
// No secret is ever written: every value is a types.ts record, and that
// type model has no field capable of holding key material.

import { getRedis } from "@/lib/api/redis";
import {
  COMMIT_DAY_SPEND_SCRIPT,
  DAY_LEDGER_ARCHIVE_TTL_SECONDS,
  DAY_LEDGER_KEYS,
  DAY_LEDGER_TTL_SECONDS,
  ENSURE_DAY_LEDGER_SCRIPT,
  MARK_SPEND_AMBIGUOUS_SCRIPT,
  MARK_SPEND_ATTEMPT_SCRIPT,
  RELEASE_DAY_SPEND_SCRIPT,
  RESERVE_DAY_SPEND_SCRIPT,
  RESTORE_DAY_LEDGER_SCRIPT,
  legacyLedgerPoison,
} from "./day-ledger-scripts";
import { newGoalId, newPolicyId } from "./store";
import { InMemoryAutonomyStore, type AutonomyStore, type DayLedgerSnapshot, type GoalTransitionPatch, type ReserveDailySpendResult } from "./store";
import { isPreBroadcastRefusalCode } from "./types";
import type {
  AgentGoal,
  AutonomyAuditEvent,
  AutonomyPolicy,
  GoalActionRecord,
  GoalStatus,
  SpendReservationRelease,
  SpendReservationState,
} from "./types";

const PREFIX = "mpgrhub:autonomy";

const KEY = {
  wallets: `${PREFIX}:wallets`,
  walletGoals: (wallet: string) => `${PREFIX}:${wallet}:goals`,
  walletPolicies: (wallet: string) => `${PREFIX}:${wallet}:policies`,
  goal: (id: string) => `${PREFIX}:goal:${id}`,
  goalMeta: (id: string) => `${PREFIX}:goal-meta:${id}`,
  policy: (id: string) => `${PREFIX}:policy:${id}`,
  policyMeta: (id: string) => `${PREFIX}:policy-meta:${id}`,
  dayLedger: (policyId: string, day: string) => DAY_LEDGER_KEYS.legacy(policyId, day),
  exec: (key: string) => `${PREFIX}:exec:${key}`,
  lease: (goalId: string) => `${PREFIX}:lease:${goalId}`,
  audit: (goalId: string) => `${PREFIX}:audit:${goalId}`,
  records: (goalId: string) => `${PREFIX}:records:${goalId}`,
};

// Meta strings: scalars only, "|" is guaranteed absent from every component
// (ISO timestamps, UPPERCASE statuses, lowercase hex wallets).
const goalMeta = (g: Pick<AgentGoal, "status" | "updatedAt" | "wallet">) =>
  `${g.status}|${g.updatedAt}|${g.wallet.toLowerCase()}`;
const parseGoalMeta = (meta: string) => {
  const [status = "", updatedAt = "", wallet = ""] = meta.split("|");
  return { status: status as GoalStatus, updatedAt, wallet };
};

const policyMeta = (p: Pick<AutonomyPolicy, "wallet" | "revokedAt">) =>
  `${p.wallet.toLowerCase()}|${p.revokedAt ?? "-"}`;
const parsePolicyMeta = (meta: string) => {
  const [wallet = "", revokedAt = ""] = meta.split("|");
  return { wallet, revokedAt: revokedAt === "-" ? undefined : revokedAt };
};

/**
 * CAS goal update. Compares wallet/status/updatedAt scalars, enforces the
 * legal-move list, then swaps the record + meta. Returns nil on mismatch.
 */
const CAS_GOAL_SCRIPT = `
local meta = redis.call("GET", KEYS[2])
if not meta then return nil end
local status, updatedAt, wallet = string.match(meta, "^(.-)|(.-)|(.+)$")
if wallet ~= ARGV[1] then return nil end
local allowed = false
for s in string.gmatch(ARGV[2], "[^,]+") do
  if s == status then allowed = true break end
end
if not allowed then return nil end
if updatedAt ~= ARGV[3] then return nil end
local newStatus = ARGV[4]
if newStatus ~= status then
  local legal = false
  for t in string.gmatch(ARGV[5], "[^,]+") do
    if t == newStatus then legal = true break end
  end
  if not legal then return nil end
end
redis.call("SET", KEYS[1], ARGV[6])
redis.call("SET", KEYS[2], newStatus .. "|" .. ARGV[7] .. "|" .. wallet)
redis.call("ZINCRBY", KEYS[3], 0, ARGV[8])
return ARGV[6]
`;

const CAS_REVOKE_POLICY_SCRIPT = `
local meta = redis.call("GET", KEYS[2])
if not meta then return nil end
local wallet, revokedAt = string.match(meta, "^(.-)|(.-)$")
if wallet ~= ARGV[1] then return nil end
if revokedAt ~= "-" then return nil end
redis.call("SET", KEYS[1], ARGV[2])
redis.call("SET", KEYS[2], wallet .. "|" .. ARGV[3])
redis.call("ZINCRBY", KEYS[3], 0, ARGV[4])
return ARGV[2]
`;

const RELEASE_LEASE_SCRIPT = `
local token = redis.call("GET", KEYS[1])
if token == ARGV[1] then redis.call("DEL", KEYS[1]) return 1 end
return 0
`;

const ZADD_MEMBER_SCRIPT = `redis.call("ZINCRBY", KEYS[1], 0, ARGV[1]) return 1`;
const ZRANGE_ALL = `return redis.call("ZRANGE", KEYS[1], 0, -1)`;

type Raw = string | Record<string, unknown> | null;

/** Reservation state letters (compact in Lua) -> typed state names. */
const SPEND_STATE_BY_LETTER: Record<string, SpendReservationState> = {
  R: "RESERVED",
  A: "ATTEMPTING",
  C: "COMMITTED",
  X: "AMBIGUOUS",
  F: "RELEASED",
};

function parseRecord<T>(raw: Raw): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

export class RedisAutonomyStore implements AutonomyStore {
  private redis() {
    return getRedis();
  }

  // -- policies ---------------------------------------------------------

  async createPolicy(policy: AutonomyPolicy): Promise<AutonomyPolicy> {
    const withId: AutonomyPolicy = { ...policy, id: policy.id || newPolicyId(new Date()) };
    const redis = this.redis();
    await redis.set(KEY.policy(withId.id), JSON.stringify(withId));
    await redis.set(KEY.policyMeta(withId.id), policyMeta(withId));
    await redis.eval(ZADD_MEMBER_SCRIPT, [KEY.walletPolicies(withId.wallet.toLowerCase())], [withId.id]);
    return { ...withId };
  }

  async getPolicy(policyId: string): Promise<AutonomyPolicy | null> {
    return parseRecord<AutonomyPolicy>(await this.redis().get(KEY.policy(policyId)));
  }

  async listPolicies(wallet: string): Promise<AutonomyPolicy[]> {
    const ids = await this.zmembers(KEY.walletPolicies(wallet.toLowerCase()));
    const out: AutonomyPolicy[] = [];
    for (const id of ids) {
      const policy = await this.getPolicy(id);
      if (policy) out.push(policy);
    }
    return out;
  }

  async revokePolicy(policyId: string, wallet: string, revokedAt: string): Promise<AutonomyPolicy | null> {
    const policy = await this.getPolicy(policyId);
    if (!policy) return null;
    const revoked: AutonomyPolicy = { ...policy, revokedAt };
    const result = await this.redis().eval(
      CAS_REVOKE_POLICY_SCRIPT,
      [KEY.policy(policyId), KEY.policyMeta(policyId), KEY.walletPolicies(wallet.toLowerCase())],
      [wallet.toLowerCase(), JSON.stringify(revoked), revokedAt, policyId],
    );
    if (typeof result !== "string") return null;
    return (parseRecord<AutonomyPolicy>(result)) ?? null;
  }

  // -- goals ------------------------------------------------------------

  async createGoal(goal: AgentGoal): Promise<AgentGoal> {
    const withId: AgentGoal = { ...goal, id: goal.id || newGoalId(new Date()) };
    const redis = this.redis();
    await redis.set(KEY.goal(withId.id), JSON.stringify(withId));
    await redis.set(KEY.goalMeta(withId.id), goalMeta(withId));
    await redis.eval(
      `redis.call("ZINCRBY", KEYS[1], 0, ARGV[1]) return 1`,
      [KEY.walletGoals(withId.wallet.toLowerCase())],
      [withId.id],
    );
    await redis.eval(ZADD_MEMBER_SCRIPT, [KEY.wallets], [withId.wallet.toLowerCase()]);
    return { ...withId };
  }

  async getGoal(goalId: string): Promise<AgentGoal | null> {
    return parseRecord<AgentGoal>(await this.redis().get(KEY.goal(goalId)));
  }

  async listGoals(wallet: string): Promise<AgentGoal[]> {
    const ids = await this.zmembers(KEY.walletGoals(wallet.toLowerCase()));
    const out: AgentGoal[] = [];
    for (const id of ids) {
      const goal = await this.getGoal(id);
      if (goal) out.push(goal);
    }
    return out;
  }

  async countNonTerminalGoals(wallet: string): Promise<number> {
    const terminal: readonly string[] = ["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"];
    return (await this.listGoals(wallet)).filter((g) => !terminal.includes(g.status)).length;
  }

  async transitionGoal(
    goalId: string,
    wallet: string,
    expectedFrom: readonly GoalStatus[],
    expectedUpdatedAt: string,
    patch: GoalTransitionPatch,
  ): Promise<AgentGoal | null> {
    const current = await this.getGoal(goalId);
    if (!current) return null;
    const to = patch.status ?? current.status;
    const { GOAL_TRANSITIONS } = await import("./types");
    const legalTargets = to === current.status ? [current.status] : GOAL_TRANSITIONS[current.status];
    const normalized = patch.maxTrades === null ? { ...patch, maxTrades: undefined } : patch;
    // JSON.stringify drops `undefined` fields, so removed caps stay removed.
    const updated: AgentGoal = JSON.parse(JSON.stringify({ ...current, ...normalized, status: to }));
    const result = await this.redis().eval(
      CAS_GOAL_SCRIPT,
      [KEY.goal(goalId), KEY.goalMeta(goalId), KEY.walletGoals(wallet.toLowerCase())],
      [
        wallet.toLowerCase(),
        expectedFrom.join(","),
        expectedUpdatedAt,
        to,
        legalTargets.join(","),
        JSON.stringify(updated),
        updated.updatedAt,
        goalId,
      ],
    );
    if (typeof result !== "string") return null;
    return parseRecord<AgentGoal>(result);
  }

  async listKnownWallets(limit: number): Promise<string[]> {
    return (await this.zmembers(KEY.wallets)).slice(0, limit);
  }

  // -- daily spend reservations (UTC) ---------------------------------------
  //
  // All ledger Lua lives in day-ledger-scripts.ts (the CANONICAL source — the
  // tests execute these same strings). Amounts are exact decimal strings; the
  // scripts never convert them to Lua/JS numbers.

  private ledgerKeys(policyId: string, dayKey: string): string[] {
    return [
      DAY_LEDGER_KEYS.legacy(policyId, dayKey),
      DAY_LEDGER_KEYS.hash(policyId, dayKey),
      DAY_LEDGER_KEYS.fence(policyId, dayKey),
      DAY_LEDGER_KEYS.archive(policyId, dayKey),
      DAY_LEDGER_KEYS.gen(policyId, dayKey),
    ];
  }

  /** Keys for the hash+gen lifecycle scripts (attempt/commit/ambiguous). */
  private ledgerHashKeys(policyId: string, dayKey: string): string[] {
    return [DAY_LEDGER_KEYS.hash(policyId, dayKey), DAY_LEDGER_KEYS.gen(policyId, dayKey)];
  }

  private ledgerArgs(): Array<string | number> {
    return [legacyLedgerPoison(), DAY_LEDGER_TTL_SECONDS, DAY_LEDGER_ARCHIVE_TTL_SECONDS];
  }

  async getDayLedger(policyId: string, dayKey: string): Promise<DayLedgerSnapshot> {
    const result = await this.redis().eval(
      ENSURE_DAY_LEDGER_SCRIPT,
      this.ledgerKeys(policyId, dayKey),
      this.ledgerArgs(),
    );
    const reply = Array.isArray(result) ? (result as Array<string | number>).map(String) : null;
    if (reply?.[0] === "OK") {
      return { status: "OK", spendRaw: reply[1], actions: Number(reply[2]) };
    }
    if (reply?.[0] === "MALFORMED") return { status: "MALFORMED_LEGACY", spendRaw: null, actions: null };
    return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
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
    const result = await this.redis().eval(
      RESERVE_DAY_SPEND_SCRIPT,
      this.ledgerKeys(policyId, dayKey),
      [...this.ledgerArgs(), execId, amountRaw, maxDailyRaw, maxActions],
    );
    const reply = Array.isArray(result) ? (result as Array<string | number>).map(String) : null;
    if (!reply) return { ok: false, reason: "LEDGER_UNAVAILABLE", snapshot: null };
    switch (reply[0]) {
      case "OK": {
        const snapshot = { spendRaw: reply[3], actions: Number(reply[4]) };
        const created = reply[1] === "1";
        return { ok: true, created, state: SPEND_STATE_BY_LETTER[reply[2]] ?? "RESERVED", snapshot };
      }
      case "OVER_BUDGET":
        return { ok: false, reason: "OVER_BUDGET", snapshot: { spendRaw: reply[1], actions: Number(reply[2]) } };
      case "OVER_ACTIONS":
        return { ok: false, reason: "OVER_ACTIONS", snapshot: { spendRaw: reply[1], actions: Number(reply[2]) } };
      case "MALFORMED":
        return { ok: false, reason: "MALFORMED_LEGACY", snapshot: null };
      case "BAD_AMOUNT":
        return { ok: false, reason: "BAD_AMOUNT", snapshot: null };
      default:
        return { ok: false, reason: "LEDGER_UNAVAILABLE", snapshot: null };
    }
  }

  async markSpendAttempt(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null> {
    const result = await this.redis().eval(
      MARK_SPEND_ATTEMPT_SCRIPT,
      this.ledgerHashKeys(policyId, dayKey),
      [execId, DAY_LEDGER_TTL_SECONDS],
    );
    const reply = Array.isArray(result) ? (result as Array<string | number>).map(String) : null;
    if (reply?.[0] === "OK") return SPEND_STATE_BY_LETTER[reply[1]] ?? null;
    return null;
  }

  async commitDailySpend(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null> {
    const result = await this.redis().eval(
      COMMIT_DAY_SPEND_SCRIPT,
      this.ledgerHashKeys(policyId, dayKey),
      [execId, DAY_LEDGER_TTL_SECONDS],
    );
    const reply = Array.isArray(result) ? (result as Array<string | number>).map(String) : null;
    if (reply?.[0] === "OK") return SPEND_STATE_BY_LETTER[reply[1]] ?? null;
    return null;
  }

  async releaseDailySpend(
    policyId: string,
    dayKey: string,
    execId: string,
    release: SpendReservationRelease,
  ): Promise<SpendReservationState | null> {
    // Defense in depth: the store refuses to release for unverified codes
    // even if a caller bypasses the runtime's classification.
    if (release.reason === "PRE_BROADCAST_REFUSAL" && !isPreBroadcastRefusalCode(release.code)) return null;
    const reasonFlag = release.reason === "PRE_BROADCAST_REFUSAL" ? "P" : "U";
    const result = await this.redis().eval(
      RELEASE_DAY_SPEND_SCRIPT,
      this.ledgerKeys(policyId, dayKey),
      [...this.ledgerArgs(), execId, reasonFlag],
    );
    const reply = Array.isArray(result) ? (result as Array<string | number>).map(String) : null;
    if (reply?.[0] === "OK") return "RELEASED";
    return null;
  }

  async markSpendAmbiguous(policyId: string, dayKey: string, execId: string): Promise<SpendReservationState | null> {
    const result = await this.redis().eval(
      MARK_SPEND_AMBIGUOUS_SCRIPT,
      this.ledgerHashKeys(policyId, dayKey),
      [execId, DAY_LEDGER_TTL_SECONDS],
    );
    const reply = Array.isArray(result) ? (result as Array<string | number>).map(String) : null;
    if (reply?.[0] === "OK") return "AMBIGUOUS";
    return null;
  }

  /**
   * OPERATOR recovery (see docs/AUTONOMY-DAILY-SPEND-RESERVATIONS.md):
   * rebuild a migrated-but-lost day hash from its migration archive — but ONLY
   * when the `daygen` write-witness proves nothing was written after the
   * import (gen == "0"), i.e. the archive IS the full authoritative ledger.
   * If post-migration reservations existed (gen > 0) the archive cannot
   * contain them and any restore would UNDERCOUNT spend: the script returns
   * LOST_HISTORY and this method reports LEDGER_UNAVAILABLE (fail closed;
   * manual reconciliation required). Never invents zero totals; never touches
   * an existing hash. Not called by the runtime.
   */
  async restoreDayLedger(policyId: string, dayKey: string): Promise<DayLedgerSnapshot> {
    const result = await this.redis().eval(
      RESTORE_DAY_LEDGER_SCRIPT,
      this.ledgerKeys(policyId, dayKey),
      this.ledgerArgs(),
    );
    const reply = Array.isArray(result) ? (result as Array<string | number>).map(String) : null;
    if (reply?.[0] === "OK") return { status: "OK", spendRaw: reply[1], actions: Number(reply[2]) };
    if (reply?.[0] === "ALREADY") {
      const view = await this.getDayLedger(policyId, dayKey);
      return view;
    }
    return { status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null };
  }

  // -- idempotency -----------------------------------------------------------

  async claimExecution(idempotencyKey: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis().set(KEY.exec(idempotencyKey), "1", { ex: Math.max(1, ttlSeconds), nx: true });
    return result !== null;
  }

  async releaseExecution(idempotencyKey: string): Promise<void> {
    await this.redis().del(KEY.exec(idempotencyKey));
  }

  async tryAcquireGoalLease(goalId: string, token: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis().set(KEY.lease(goalId), token, { ex: Math.max(1, ttlSeconds), nx: true });
    return result !== null;
  }

  async releaseGoalLease(goalId: string, token: string): Promise<void> {
    await this.redis().eval(RELEASE_LEASE_SCRIPT, [KEY.lease(goalId)], [token]);
  }

  // -- audit + history -----------------------------------------------------------

  async appendAudit(event: AutonomyAuditEvent, maxEvents: number): Promise<void> {
    // Single-writer: audit appends happen while the per-goal lease is held.
    const existing = await this.listAudit(event.goalId ?? "_global");
    const lastSeq = existing.length > 0 ? (existing[existing.length - 1].seq ?? existing.length) : 0;
    existing.push({ ...event, seq: lastSeq + 1 });
    while (existing.length > maxEvents) existing.shift();
    await this.redis().set(KEY.audit(event.goalId ?? "_global"), JSON.stringify(existing));
  }

  async listAudit(goalId: string): Promise<AutonomyAuditEvent[]> {
    return parseRecord<AutonomyAuditEvent[]>(await this.redis().get(KEY.audit(goalId))) ?? [];
  }

  async saveActionRecord(record: GoalActionRecord, maxRecords: number): Promise<void> {
    const existing = await this.listActionRecords(record.goalId);
    const idx = existing.findIndex((r) => r.idempotencyKey === record.idempotencyKey);
    if (idx >= 0) existing[idx] = record;
    else existing.push(record);
    while (existing.length > maxRecords) existing.shift();
    await this.redis().set(KEY.records(record.goalId), JSON.stringify(existing));
  }

  async listActionRecords(goalId: string): Promise<GoalActionRecord[]> {
    return parseRecord<GoalActionRecord[]>(await this.redis().get(KEY.records(goalId))) ?? [];
  }

  private async zmembers(key: string): Promise<string[]> {
    const members = await this.redis().eval(ZRANGE_ALL, [key], []);
    return Array.isArray(members) ? (members as string[]) : [];
  }
}

export { InMemoryAutonomyStore };

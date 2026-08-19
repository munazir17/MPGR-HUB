// lib/reward-allocation/kv-allocation-store.ts
//
// SERVER-ONLY. Vercel KV (Upstash Redis under the hood) implementation of
// the AllocationStore interface defined in allocation-store.ts.
//
// Why Vercel KV: it's the smallest production-compatible persistence
// mechanism that satisfies allocation-store.ts's concurrency contract
// (atomic insert-if-absent, CAS-style conditional upserts, atomic
// increment) on a serverless Next.js/Vercel deployment with zero
// additional infrastructure to stand up — a REST-based Redis that
// survives cold starts, redeploys, and multiple concurrent instances by
// construction (it's an external durable store, not in-process memory).
// Nothing in package.json/node_modules can be verified from inside this
// sandbox (no network access here), so `npm install` for the
// "@vercel/kv" dependency added to package.json is a required one-time
// setup step — see docs/GAME_REWARDS_SETUP.md.
//
// Atomicity notes:
//   - putRunRecordIfAbsent uses SET key value NX — a true atomic
//     test-and-set, not a read-then-write race.
//   - upsertPlayerWeekRecord / upsertWeeklySettlement use a Lua script
//     (EVAL), which Redis guarantees runs atomically end-to-end — the
//     script reads the current value, checks the expected status, and
//     writes the new value in one indivisible operation. This is real
//     compare-and-swap, not an approximation.
//   - The GAME treasury ledger is stored in fixed-point "milli-MPGR"
//     units (raw amount / 10^15) so it fits Redis's native 64-bit
//     INCRBY instead of needing bigint math inside Lua. 7,000,000 MPGR
//     lifetime cap == 7,000,000,000 milli-MPGR units, nowhere near the
//     ~9.2 * 10^18 signed 64-bit ceiling. This trades away sub-1e-15-MPGR
//     precision (irrelevant at this token's economics — the minimum
//     meaningful allocation is 0.1 MPGR, see games-reward-config.ts).

import { kv } from "@vercel/kv";
import type { Address } from "viem";
import type { AllocationStore, InsertResult } from "./allocation-store";
import type { AllocationStatus, PlayerWeekRecord, RunRecord, WeeklySettlement } from "./allocation-types";

const LEDGER_SCALE = 10n ** 15n; // raw units per stored ledger unit (milli-MPGR)

function runKey(sessionId: string) {
  return `mpgrhub:games:run:${sessionId}`;
}
function playerWeekKey(wallet: Address, weekKey: string) {
  return `mpgrhub:games:playerweek:${weekKey}:${wallet.toLowerCase()}`;
}
function playerWeekIndexKey(weekKey: string) {
  return `mpgrhub:games:playerweek-index:${weekKey}`;
}
function settlementKey(weekKey: string) {
  return `mpgrhub:games:settlement:${weekKey}`;
}
function ledgerKey(rewardType: "GAME") {
  return `mpgrhub:games:ledger:${rewardType}`;
}

// bigint-safe JSON round-trip: every bigint field is serialized as a
// "<digits>n" string and parsed back, so callers of this store never see
// a plain number where the type says bigint.
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v.toString()}n` : v));
}
function deserialize<T>(raw: string): T {
  return JSON.parse(raw, (_key, v) => {
    if (typeof v === "string" && /^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1));
    return v;
  }) as T;
}

// expectedStatus semantics (matches allocation-store.ts's documented
// contract exactly): "" (JS undefined) or "none" both mean "write only
// if the record doesn't exist yet, or exists with allocationStatus ==
// 'none'" — i.e. safe for a first-time insert. Any other value means
// "write only if the existing record's allocationStatus equals exactly
// this" — a real transition guard. Either way, a failed check no-ops
// and returns the current stored value rather than overwriting it.
const CAS_UPSERT_SCRIPT = `
local current = redis.call("GET", KEYS[1])
local expected = ARGV[2]
if expected == "" or expected == "none" then
  if current ~= false then
    local ok, decoded = pcall(cjson.decode, current)
    if ok and decoded.allocationStatus ~= nil and decoded.allocationStatus ~= "none" then
      return current
    end
  end
else
  if current == false then
    return current
  end
  local ok2, decoded2 = pcall(cjson.decode, current)
  if not ok2 or decoded2.allocationStatus ~= expected then
    return current
  end
end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`;

const CAS_UPSERT_SETTLEMENT_SCRIPT = `
local current = redis.call("GET", KEYS[1])
local expected = ARGV[2]
if expected ~= "" then
  if current == false then
    return {err = "CAS_MISMATCH_NOT_FOUND"}
  end
  local ok, decoded = pcall(cjson.decode, current)
  if not ok or decoded.status ~= expected then
    return current
  end
elseif current ~= false then
  return current
end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`;

export const kvAllocationStore: AllocationStore = {
  // --- Run-level idempotency ------------------------------------------

  async getRunRecord(sessionId) {
    const raw = await kv.get<string>(runKey(sessionId));
    if (!raw) return null;
    return deserialize<RunRecord>(raw);
  },

  async putRunRecordIfAbsent(record: RunRecord): Promise<InsertResult<RunRecord>> {
    const key = runKey(record.sessionId);
    const payload = serialize(record);
    // NX = only set if not already present. Vercel KV/Upstash returns
    // "OK" on success and null when the key already existed.
    const result = await kv.set(key, payload, { nx: true });
    if (result === null) {
      const existingRaw = await kv.get<string>(key);
      if (!existingRaw) {
        // Extremely unlikely race (deleted between NX-fail and read) —
        // treat as inserted-failed-then-vanished by retrying the insert.
        const retry = await kv.set(key, payload, { nx: true });
        if (retry === null) {
          const existing2 = await kv.get<string>(key);
          return { inserted: false, record: deserialize<RunRecord>(existing2 as string) };
        }
        return { inserted: true, record };
      }
      return { inserted: false, record: deserialize<RunRecord>(existingRaw) };
    }
    return { inserted: true, record };
  },

  // --- Per-player weekly ledger -----------------------------------------

  async getPlayerWeekRecord(wallet, weekKey) {
    const raw = await kv.get<string>(playerWeekKey(wallet, weekKey));
    if (!raw) return null;
    return deserialize<PlayerWeekRecord>(raw);
  },

  async upsertPlayerWeekRecord(
    record: PlayerWeekRecord,
    expectedStatus?: AllocationStatus
  ): Promise<PlayerWeekRecord> {
    const key = playerWeekKey(record.wallet, record.weekKey);
    const payload = serialize(record);
    const result = await kv.eval(CAS_UPSERT_SCRIPT, [key], [payload, expectedStatus ?? ""]);
    if (result === null || result === undefined) {
      // Should not happen given the script's logic (it always returns
      // either the new payload or the existing stored value), but guard
      // rather than crash on a deserialize(null) if it ever does.
      throw new Error(`upsertPlayerWeekRecord: unexpected empty result for ${key}`);
    }
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    const stored = deserialize<PlayerWeekRecord>(resultStr);
    // Maintain a per-week index of wallets so listEligiblePlayersForWeek
    // doesn't need a Redis KEYS scan (unsafe in production).
    await kv.sadd(playerWeekIndexKey(record.weekKey), record.wallet.toLowerCase());
    return stored;
  },

  async listEligiblePlayersForWeek(weekKey: string): Promise<PlayerWeekRecord[]> {
    const wallets = await kv.smembers(playerWeekIndexKey(weekKey));
    if (!wallets || wallets.length === 0) return [];
    const raws = await Promise.all(wallets.map((w) => kv.get<string>(playerWeekKey(w as Address, weekKey))));
    return raws
      .filter((r): r is string => !!r)
      .map((r) => deserialize<PlayerWeekRecord>(r))
      .filter((r) => r.eligibilityStatus === "eligible");
  },

  // --- Whole-week settlement state ----------------------------------------

  async getWeeklySettlement(weekKey) {
    const raw = await kv.get<string>(settlementKey(weekKey));
    if (!raw) return null;
    return deserialize<WeeklySettlement>(raw);
  },

  async upsertWeeklySettlement(
    settlement: WeeklySettlement,
    expectedStatus?: WeeklySettlement["status"]
  ): Promise<WeeklySettlement> {
    const key = settlementKey(settlement.weekKey);
    const payload = serialize(settlement);
    const result = await kv.eval(CAS_UPSERT_SETTLEMENT_SCRIPT, [key], [payload, expectedStatus ?? ""]);
    if (result === null || result === undefined) {
      throw new Error(`upsertWeeklySettlement: unexpected empty result for ${key}`);
    }
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    return deserialize<WeeklySettlement>(resultStr);
  },

  // --- Games treasury ledger -----------------------------------------------

  async getTreasuryLedgerTotal(rewardType: "GAME"): Promise<bigint> {
    const units = await kv.get<number>(ledgerKey(rewardType));
    return BigInt(units ?? 0) * LEDGER_SCALE;
  },

  async recordTreasuryLedgerEntry(rewardType: "GAME", amountRaw: bigint): Promise<void> {
    if (amountRaw <= 0n) return;
    // Round UP to whole ledger units so the ledger can never
    // under-report real spend (a conservative direction to round the
    // 7M-lifetime-budget accounting).
    const units = (amountRaw + LEDGER_SCALE - 1n) / LEDGER_SCALE;
    await kv.incrby(ledgerKey(rewardType), Number(units));
  },
};

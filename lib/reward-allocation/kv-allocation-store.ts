// lib/reward-allocation/kv-allocation-store.ts
//
// SERVER-ONLY.
// Upstash Redis implementation of the AllocationStore interface.
//
// This replaces the deprecated @vercel/kv client with the official
// @upstash/redis SDK. The underlying Redis database remains the same.
//
// Required Vercel environment variables:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//
// For compatibility with older migrated Vercel KV environments, this
// implementation also accepts:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//
// No game/reward logic is changed here. This file only provides the
// persistent Redis storage implementation used by the allocation system.

import { Redis } from "@upstash/redis";
import type { Address } from "viem";
import type { AllocationStore, InsertResult } from "./allocation-store";
import type {
  AllocationStatus,
  PlayerWeekRecord,
  RunRecord,
  WeeklySettlement,
} from "./allocation-types";

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
//
// Prefer the current Upstash environment variables.
//
// The fallback keeps compatibility with projects whose existing Vercel
// integration still exposes the older KV_REST_API_* variables after the
// Vercel KV -> Upstash migration.

const redisUrl =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;

const redisToken =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

if (!redisUrl || !redisToken) {
  throw new Error(
    "Upstash Redis environment variables are missing. Expected UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
  );
}

const kv = new Redis({
  url: redisUrl,
  token: redisToken,
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const LEDGER_SCALE = 10n ** 15n;

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

// ---------------------------------------------------------------------------
// BigInt-safe JSON serialization
// ---------------------------------------------------------------------------
//
// Redis stores strings for these records. BigInt values are encoded with
// an "n" suffix and restored on read.

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? `${v.toString()}n` : v
  );
}

function deserialize<T>(raw: string): T {
  return JSON.parse(raw, (_key, v) => {
    if (typeof v === "string" && /^-?\d+n$/.test(v)) {
      return BigInt(v.slice(0, -1));
    }

    return v;
  }) as T;
}

// ---------------------------------------------------------------------------
// Atomic CAS-style player-week update
// ---------------------------------------------------------------------------
//
// expectedStatus:
//
// "" / undefined:
//   Create if missing, or update an existing record whose allocationStatus
//   is "none".
//
// "none":
//   Same semantics as above.
//
// Any other status:
//   Update only when the existing record has exactly that allocationStatus.
//
// Redis executes EVAL atomically.

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

// ---------------------------------------------------------------------------
// Atomic CAS-style weekly settlement update
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Allocation store
// ---------------------------------------------------------------------------

export const kvAllocationStore: AllocationStore = {
  // -------------------------------------------------------------------------
  // Run-level idempotency
  // -------------------------------------------------------------------------

  async getRunRecord(sessionId) {
    const raw = await kv.get<string>(runKey(sessionId));

    if (!raw) {
      return null;
    }

    return deserialize<RunRecord>(raw);
  },

  async putRunRecordIfAbsent(
    record: RunRecord
  ): Promise<InsertResult<RunRecord>> {
    const key = runKey(record.sessionId);
    const payload = serialize(record);

    // NX = only create the key if it does not already exist.
    //
    // This is atomic on Redis and prevents duplicate game submissions
    // from being recorded twice.

    const result = await kv.set(key, payload, {
      nx: true,
    });

    if (result === null) {
      const existingRaw = await kv.get<string>(key);

      if (!existingRaw) {
        // Extremely unlikely race:
        // the key disappeared between the failed NX operation and GET.
        const retry = await kv.set(key, payload, {
          nx: true,
        });

        if (retry === null) {
          const existing2 = await kv.get<string>(key);

          if (!existing2) {
            throw new Error(
              `putRunRecordIfAbsent: duplicate run key disappeared unexpectedly: ${key}`
            );
          }

          return {
            inserted: false,
            record: deserialize<RunRecord>(existing2),
          };
        }

        return {
          inserted: true,
          record,
        };
      }

      return {
        inserted: false,
        record: deserialize<RunRecord>(existingRaw),
      };
    }

    return {
      inserted: true,
      record,
    };
  },

  // -------------------------------------------------------------------------
  // Per-player weekly ledger
  // -------------------------------------------------------------------------

  async getPlayerWeekRecord(wallet, weekKey) {
    const raw = await kv.get<string>(
      playerWeekKey(wallet, weekKey)
    );

    if (!raw) {
      return null;
    }

    return deserialize<PlayerWeekRecord>(raw);
  },

  async upsertPlayerWeekRecord(
    record: PlayerWeekRecord,
    expectedStatus?: AllocationStatus
  ): Promise<PlayerWeekRecord> {
    const key = playerWeekKey(record.wallet, record.weekKey);
    const payload = serialize(record);

    const result = await kv.eval(
      CAS_UPSERT_SCRIPT,
      [key],
      [payload, expectedStatus ?? ""]
    );

    if (result === null || result === undefined) {
      throw new Error(
        `upsertPlayerWeekRecord: unexpected empty result for ${key}`
      );
    }

    const resultStr =
      typeof result === "string"
        ? result
        : JSON.stringify(result);

    const stored = deserialize<PlayerWeekRecord>(resultStr);

    // Maintain a per-week wallet index so settlement does not need
    // an unsafe Redis KEYS scan.

    await kv.sadd(
      playerWeekIndexKey(record.weekKey),
      record.wallet.toLowerCase()
    );

    return stored;
  },

  async listEligiblePlayersForWeek(
    weekKey: string
  ): Promise<PlayerWeekRecord[]> {
    const wallets = await kv.smembers(
      playerWeekIndexKey(weekKey)
    );

    if (!wallets || wallets.length === 0) {
      return [];
    }

    const raws = await Promise.all(
      wallets.map((wallet) =>
        kv.get<string>(
          playerWeekKey(
            wallet as Address,
            weekKey
          )
        )
      )
    );

    return raws
      .filter((raw): raw is string => !!raw)
      .map((raw) =>
        deserialize<PlayerWeekRecord>(raw)
      )
      .filter(
        (record) =>
          record.eligibilityStatus === "eligible"
      );
  },

  // -------------------------------------------------------------------------
  // Weekly settlement state
  // -------------------------------------------------------------------------

  async getWeeklySettlement(weekKey) {
    const raw = await kv.get<string>(
      settlementKey(weekKey)
    );

    if (!raw) {
      return null;
    }

    return deserialize<WeeklySettlement>(raw);
  },

  async upsertWeeklySettlement(
    settlement: WeeklySettlement,
    expectedStatus?: WeeklySettlement["status"]
  ): Promise<WeeklySettlement> {
    const key = settlementKey(settlement.weekKey);
    const payload = serialize(settlement);

    const result = await kv.eval(
      CAS_UPSERT_SETTLEMENT_SCRIPT,
      [key],
      [payload, expectedStatus ?? ""]
    );

    if (result === null || result === undefined) {
      throw new Error(
        `upsertWeeklySettlement: unexpected empty result for ${key}`
      );
    }

    const resultStr =
      typeof result === "string"
        ? result
        : JSON.stringify(result);

    return deserialize<WeeklySettlement>(resultStr);
  },

  // -------------------------------------------------------------------------
  // GAME treasury ledger
  // -------------------------------------------------------------------------

  async getTreasuryLedgerTotal(
    rewardType: "GAME"
  ): Promise<bigint> {
    const units = await kv.get<number>(
      ledgerKey(rewardType)
    );

    return BigInt(units ?? 0) * LEDGER_SCALE;
  },

  async recordTreasuryLedgerEntry(
    rewardType: "GAME",
    amountRaw: bigint
  ): Promise<void> {
    if (amountRaw <= 0n) {
      return;
    }

    // Round UP so the ledger can never under-report real spend.

    const units =
      (amountRaw + LEDGER_SCALE - 1n) /
      LEDGER_SCALE;

    await kv.incrby(
      ledgerKey(rewardType),
      Number(units)
    );
  },
};

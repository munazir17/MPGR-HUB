// lib/reward-allocation/kv-allocation-store.ts
//
// SERVER-ONLY.
// Upstash Redis implementation of the AllocationStore interface.
//
// Important:
// @upstash/redis can automatically deserialize JSON values returned by GET.
// Therefore this file safely supports BOTH:
//   1. legacy/raw JSON strings
//   2. already-deserialized objects
//
// Required Vercel environment variables:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//
// Backward compatibility:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN

import { Redis } from "@upstash/redis";
import type { Address } from "viem";

import type {
  AllocationStore,
  InsertResult,
} from "./allocation-store";

import type {
  AllocationStatus,
  PlayerWeekRecord,
  RunRecord,
  WeeklySettlement,
} from "./allocation-types";

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------

const redisUrl =
  process.env.UPSTASH_REDIS_REST_URL ??
  process.env.KV_REST_API_URL;

const redisToken =
  process.env.UPSTASH_REDIS_REST_TOKEN ??
  process.env.KV_REST_API_TOKEN;

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

function playerWeekKey(
  wallet: Address,
  weekKey: string
) {
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

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint"
      ? `${v.toString()}n`
      : v
  );
}

function deserialize<T>(raw: string): T {
  return JSON.parse(raw, (_key, v) => {
    if (
      typeof v === "string" &&
      /^-?\d+n$/.test(v)
    ) {
      return BigInt(v.slice(0, -1));
    }

    return v;
  }) as T;
}

// ---------------------------------------------------------------------------
// IMPORTANT: Upstash GET normalization
// ---------------------------------------------------------------------------
//
// @upstash/redis may automatically JSON-decode values returned from GET.
//
// Therefore:
//   string  -> legacy/raw JSON -> deserialize()
//   object  -> already decoded -> return directly
//
// This fixes:
//   SyntaxError: "[object Object]" is not valid JSON
//

function normalizeRedisValue<T>(
  value: unknown
): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return deserialize<T>(value);
  }

  return value as T;
}

// ---------------------------------------------------------------------------
// Atomic CAS-style player-week update
// ---------------------------------------------------------------------------

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
    const raw = await kv.get<unknown>(
      runKey(sessionId)
    );

    return normalizeRedisValue<RunRecord>(raw);
  },

  async putRunRecordIfAbsent(
    record: RunRecord
  ): Promise<InsertResult<RunRecord>> {
    const key = runKey(record.sessionId);
    const payload = serialize(record);

    const result = await kv.set(
      key,
      payload,
      {
        nx: true,
      }
    );

    if (result === null) {
      const existingRaw = await kv.get<unknown>(
        key
      );

      const existing =
        normalizeRedisValue<RunRecord>(
          existingRaw
        );

      if (!existing) {
        // Extremely unlikely race:
        // the key disappeared between failed NX
        // and GET.

        const retry = await kv.set(
          key,
          payload,
          {
            nx: true,
          }
        );

        if (retry === null) {
          const existing2Raw =
            await kv.get<unknown>(key);

          const existing2 =
            normalizeRedisValue<RunRecord>(
              existing2Raw
            );

          if (!existing2) {
            throw new Error(
              `putRunRecordIfAbsent: duplicate run key disappeared unexpectedly: ${key}`
            );
          }

          return {
            inserted: false,
            record: existing2,
          };
        }

        return {
          inserted: true,
          record,
        };
      }

      return {
        inserted: false,
        record: existing,
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

  async getPlayerWeekRecord(
    wallet,
    weekKey
  ) {
    const raw = await kv.get<unknown>(
      playerWeekKey(wallet, weekKey)
    );

    return normalizeRedisValue<PlayerWeekRecord>(
      raw
    );
  },

  async upsertPlayerWeekRecord(
    record: PlayerWeekRecord,
    expectedStatus?: AllocationStatus
  ): Promise<PlayerWeekRecord> {
    const key = playerWeekKey(
      record.wallet,
      record.weekKey
    );

    const payload = serialize(record);

    const result = await kv.eval(
      CAS_UPSERT_SCRIPT,
      [key],
      [
        payload,
        expectedStatus ?? "",
      ]
    );

    if (
      result === null ||
      result === undefined
    ) {
      throw new Error(
        `upsertPlayerWeekRecord: unexpected empty result for ${key}`
      );
    }

    const stored =
      normalizeRedisValue<PlayerWeekRecord>(
        result
      );

    if (!stored) {
      throw new Error(
        `upsertPlayerWeekRecord: unable to decode result for ${key}`
      );
    }

    // Maintain per-week wallet index.
    //
    // This avoids unsafe Redis KEYS scans during settlement.

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

    if (
      !wallets ||
      wallets.length === 0
    ) {
      return [];
    }

    const records =
      await Promise.all(
        wallets.map(async (wallet) => {
          const raw =
            await kv.get<unknown>(
              playerWeekKey(
                wallet as Address,
                weekKey
              )
            );

          return normalizeRedisValue<PlayerWeekRecord>(
            raw
          );
        })
      );

    return records
      .filter(
        (
          record
        ): record is PlayerWeekRecord =>
          record !== null
      )
      .filter(
        (record) =>
          record.eligibilityStatus ===
          "eligible"
      );
  },

  // -------------------------------------------------------------------------
  // Weekly settlement state
  // -------------------------------------------------------------------------

  async getWeeklySettlement(
    weekKey
  ) {
    const raw = await kv.get<unknown>(
      settlementKey(weekKey)
    );

    return normalizeRedisValue<WeeklySettlement>(
      raw
    );
  },

  async upsertWeeklySettlement(
    settlement: WeeklySettlement,
    expectedStatus?: WeeklySettlement["status"]
  ): Promise<WeeklySettlement> {
    const key = settlementKey(
      settlement.weekKey
    );

    const payload = serialize(settlement);

    const result = await kv.eval(
      CAS_UPSERT_SETTLEMENT_SCRIPT,
      [key],
      [
        payload,
        expectedStatus ?? "",
      ]
    );

    if (
      result === null ||
      result === undefined
    ) {
      throw new Error(
        `upsertWeeklySettlement: unexpected empty result for ${key}`
      );
    }

    const stored =
      normalizeRedisValue<WeeklySettlement>(
        result
      );

    if (!stored) {
      throw new Error(
        `upsertWeeklySettlement: unable to decode result for ${key}`
      );
    }

    return stored;
  },

  // -------------------------------------------------------------------------
  // GAME treasury ledger
  // -------------------------------------------------------------------------

  async getTreasuryLedgerTotal(
    rewardType: "GAME"
  ): Promise<bigint> {
    const units =
      await kv.get<unknown>(
        ledgerKey(rewardType)
      );

    if (
      units === null ||
      units === undefined
    ) {
      return 0n;
    }

    if (typeof units === "number") {
      return BigInt(units) *
        LEDGER_SCALE;
    }

    if (typeof units === "string") {
      return BigInt(units) *
        LEDGER_SCALE;
    }

    throw new Error(
      `Invalid treasury ledger value for ${rewardType}`
    );
  },

  async recordTreasuryLedgerEntry(
    rewardType: "GAME",
    amountRaw: bigint
  ): Promise<void> {
    if (amountRaw <= 0n) {
      return;
    }

    // Round UP so the ledger can never under-report
    // real spending.

    const units =
      (
        amountRaw +
        LEDGER_SCALE -
        1n
      ) /
      LEDGER_SCALE;

    await kv.incrby(
      ledgerKey(rewardType),
      Number(units)
    );
  },
};

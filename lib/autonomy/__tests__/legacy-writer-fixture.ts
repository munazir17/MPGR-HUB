// Frozen pre-fix writer/reader FIXTURE — deliberately duplicated legacy code.
//
// This is an EXACT copy of the removed `tryRecordDailyAction` Lua append and
// the removed TypeScript day-ledger readers, kept ONLY so the migration tests
// can simulate OLD-CODE instances (rolling-deploy era) writing to and reading
// from the legacy CSV key against the new fence. Nothing in production imports
// this file. The CANONICAL ledger Lua lives in lib/autonomy/day-ledger-scripts.ts.

import type { InMemoryAutonomyStore } from "../store";

/** The pre-fix append script, byte-for-byte as it shipped in redis-store.ts. */
export const FROZEN_LEGACY_CSV_APPEND_SCRIPT = `
local cur = redis.call("GET", KEYS[1]) or ""
local n = 0
for _ in string.gmatch(cur, "[^,]+") do n = n + 1 end
if n + 1 > tonumber(ARGV[1]) then return nil end
local next = cur == "" and ARGV[2] or cur .. "," .. ARGV[2]
redis.call("SET", KEYS[1], next)
redis.call("EXPIRE", KEYS[1], ARGV[3])
return next
`;

/** The pre-fix reader parsing (silently DROPPED non-digit fields). */
export function frozenLegacyParse(csv: string | null | undefined): string[] {
  if (csv === null || csv === undefined) return [];
  return csv.split(",").filter((v) => /^\d+$/.test(v));
}

export interface EvalClient {
  eval<T = unknown>(script: string, keys: string[], args: Array<string | number>): Promise<T>;
}

/** Old-code append over any eval-capable client (LuaRedis double or ioredis). */
export async function frozenLegacyAppend(
  client: EvalClient,
  legacyKey: string,
  amountRaw: string,
  maxActions: number,
): Promise<string[] | null> {
  const result = await client.eval(FROZEN_LEGACY_CSV_APPEND_SCRIPT, [legacyKey], [maxActions, amountRaw, 2 * 86_400]);
  if (result === null || result === undefined || result === false) return null;
  const text = typeof result === "string" ? result : String(result);
  return frozenLegacyParse(text);
}

/** Old-code append against the in-memory store's legacy key. */
export function frozenLegacyAppendInMemory(
  store: InMemoryAutonomyStore,
  policyId: string,
  dayKey: string,
  amountRaw: string,
  maxActions: number,
): string[] | null {
  const key = `${policyId}:${dayKey}`;
  const cur = store.legacyDayLedgers.get(key) ?? "";
  let n = 0;
  for (const field of cur.split(",")) if (field.length > 0) n += 1;
  if (n + 1 > maxActions) return null;
  const next = cur === "" ? amountRaw : `${cur},${amountRaw}`;
  store.legacyDayLedgers.set(key, next);
  return frozenLegacyParse(next);
}

import "server-only";

// lib/autonomy/day-ledger-scripts.ts
//
// CANONICAL Lua source for the policy-day spend ledger (the ONLY place the
// ledger Lua lives — redis-store.ts and every test execute THESE strings,
// so there are no stale duplicated scripts).
//
// Why Lua at all: the daily spend/action caps must hold across CONCURRENT
// goals sharing one policy. A read-then-write check in TypeScript is a TOCTOU
// race (two goals can both pass the check and jointly exceed the cap), so the
// reservation is taken in one atomic Redis script.
//
// Exact integer arithmetic: raw token amounts are decimal STRINGS that can
// exceed both float64 precision and Lua's 53-bit/64-bit integer ranges
// (1e21 raw units of an 18-decimal token). All amount math here is schoolbook
// decimal-string addition/subtraction/comparison — NO tonumber() on amounts,
// ever. Counts are small integers and may use numbers.
//
// Lua dialect: written for Redis's embedded Lua 5.1 AND fengari 5.3 (the
// LuaRedis test double) — no goto, no integer division, no 5.3-only syntax.
//
// ---------------------------------------------------------------------------
// THE DAY LEDGER (keys for one policy + one UTC day)
// ---------------------------------------------------------------------------
//   legacy  mpgrhub:autonomy:day:{policyId}:{day}
//       The pre-fix CSV of digit-string amounts. Old (pre-fix) code appends
//       here with a count-capped append script. After migration this key holds
//       the FENCE POISON so old writers can no longer admit actions.
//
//   hash    mpgrhub:autonomy:dayv2:{policyId}:{day}
//       The authoritative ledger: HSET fields
//         total          decimal-string sum counted against the daily cap
//                        (imported legacy sum + every LIVE reservation)
//         count          live action count (imported legacy entries + live
//                        reservations), also capped by maxActionsPerDay
//         migrated       "1" (written together with the fence)
//         legacy         the imported legacy sum (kept for forensics)
//         legacyCount    the imported legacy entry count
//         res:{execId}   one field per spend reservation:
//                        "R:{amount}"  RESERVED      (pre-attempt)
//                        "A:{amount}"  ATTEMPTING    (attempt marker set)
//                        "C:{amount}"  COMMITTED     (consumed, terminal)
//                        "X:{amount}"  AMBIGUOUS     (consumed, outcome unknown)
//                        "F:{amount}"  RELEASED      (freed, terminal)
//       total/count include R, A, C and X entries — a RELEASED entry is
//       subtracted again. So an uncertain/failed-after-broadcast outcome keeps
//       its spend counted (conservative: over-counting is safe).
//
//   fence   mpgrhub:autonomy:dayfence:{policyId}:{day} = "1"
//       The migration fence marker (separate from the hash so that "fenced but
//       hash lost" is distinguishable from "never migrated" and can NEVER be
//       silently re-imported / reset to zero).
//
//   archive mpgrhub:autonomy:dayarchive:{policyId}:{day}
//       An exact copy of the legacy CSV as it looked at the moment of
//       migration (before poisoning). Operator recovery source only — it
//       does NOT contain any post-migration reservation.
//
//   gen     mpgrhub:autonomy:daygen:{policyId}:{day} = write-witness counter
//       "0" at import (migration); INCR'd by every mutation of the hash
//       (new reservation, attempt, commit, ambiguous, release). It survives
//       the loss of the hash itself and is the proof restoreDayLedger needs:
//       gen == "0" means the archive IS the full authoritative ledger;
//       gen > 0 means post-migration reservations existed that only the lost
//       hash held, so any archive-only restore would UNDERCOUNT spend and is
//       refused (fail closed).
//
// ---------------------------------------------------------------------------
// CSV -> HASH MIGRATION FENCE (the hard part)
// ---------------------------------------------------------------------------
// Redis Lua runtime errors do NOT roll back writes that already happened
// inside the script, so the migration VALIDATES ALL legacy data first and
// performs ALL writes only after validation succeeds. A malformed legacy CSV
// therefore fails closed with ZERO writes: no partial migration, no poisoned
// key, and — critically — never a reset of an existing policy-day total.
//
// The fence POISONS the legacy key with >maxActionsPerDay non-digit fields
// (`__FENCED__` repeated). The frozen old append script counts fields with
// `[^,]+` and refuses once the count cap is reached, so any old-code writer
// that touches the key AFTER the fence is refused and cannot admit actions.
// Non-digit poison fields can never be mistaken for migrated amounts (the
// strict parser rejects them) and the exact-poison marker check runs first.
//
// Old writer BEFORE the fence: its CSV entry is imported by the migration
// (atomic serialization of the two scripts guarantees import-or-refuse,
// never a lost write). Old writer AFTER the fence: refused. A new-code
// reservation and an old-code append therefore can never jointly exceed the
// cap: whichever script runs second either sees the other's write or the
// fence. (The remaining pre-fix TOCTOU between two OLD instances during a
// rolling deploy is closed by the documented drain procedure — see
// docs/AUTONOMY-DAILY-SPEND-RESERVATIONS.md.)

/** Redis key builders — shared by the store, the tests and the runbook. */
export const DAY_LEDGER_KEYS = {
  legacy: (policyId: string, day: string) => `mpgrhub:autonomy:day:${policyId}:${day}`,
  hash: (policyId: string, day: string) => `mpgrhub:autonomy:dayv2:${policyId}:${day}`,
  fence: (policyId: string, day: string) => `mpgrhub:autonomy:dayfence:${policyId}:${day}`,
  archive: (policyId: string, day: string) => `mpgrhub:autonomy:dayarchive:${policyId}:${day}`,
  gen: (policyId: string, day: string) => `mpgrhub:autonomy:daygen:${policyId}:${day}`,
} as const;

/**
 * Key order the 5-key day-ledger scripts expect in KEYS[]. The single-key
 * lifecycle scripts (attempt/commit/ambiguous) take [hash, gen]; release
 * takes all five.
 */
export const DAY_LEDGER_SCRIPT_KEYS = ["legacy", "hash", "fence", "archive", "gen"] as const;

/** TTL for the hash/fence/poison (refreshed on every write): day + 1 day grace. */
export const DAY_LEDGER_TTL_SECONDS = 2 * 86_400;

/** Archive keeps a forensic copy a little longer than the ledger itself. */
export const DAY_LEDGER_ARCHIVE_TTL_SECONDS = 3 * 86_400;

/**
 * Fence poison marker. The poisoned legacy key is this string repeated with
 * commas, MORE times than any legal maxActionsPerDay (policy normalization
 * caps it at 50; 1000 defeats any plausible frozen-old cap too).
 */
export const LEGACY_LEDGER_POISON_FIELD = "__FENCED__";
const POISON_REPEAT = 1000;

export function legacyLedgerPoison(): string {
  return new Array(POISON_REPEAT).fill(LEGACY_LEDGER_POISON_FIELD).join(",");
}

// ---------------------------------------------------------------------------
// Shared Lua: decimal-string arithmetic (amounts NEVER touch tonumber).
// ---------------------------------------------------------------------------

const LUA_DECIMAL = `
local function ltrim0(s)
  local i = string.find(s, "[^0]")
  if not i then return "0" end
  return string.sub(s, i)
end

local function dec_add(a, b)
  a = ltrim0(a); b = ltrim0(b)
  local i, j = string.len(a), string.len(b)
  local out, carry = {}, 0
  while i > 0 or j > 0 or carry > 0 do
    local da = 0
    if i > 0 then da = string.byte(a, i) - 48; i = i - 1 end
    local db = 0
    if j > 0 then db = string.byte(b, j) - 48; j = j - 1 end
    local s = da + db + carry
    if s >= 10 then s = s - 10; carry = 1 else carry = 0 end
    table.insert(out, 1, string.char(s + 48))
  end
  return table.concat(out)
end

-- Precondition: ltrim0(b) <= ltrim0(a) (guaranteed by the reservation
-- invariant: an entry's amount is only ever subtracted while it is counted).
local function dec_sub(a, b)
  a = ltrim0(a); b = ltrim0(b)
  if string.len(b) > string.len(a) then return nil end
  local i, j = string.len(a), string.len(b)
  local out, borrow = {}, 0
  while i > 0 do
    local da = string.byte(a, i) - 48 - borrow
    local db = 0
    if j > 0 then db = string.byte(b, j) - 48; j = j - 1 end
    if da < db then da = da + 10; borrow = 1 else borrow = 0 end
    table.insert(out, 1, string.char(da - db + 48))
    i = i - 1
  end
  if borrow ~= 0 then return nil end
  return ltrim0(table.concat(out))
end

local function dec_lte(a, b)
  a = ltrim0(a); b = ltrim0(b)
  if string.len(a) ~= string.len(b) then return string.len(a) < string.len(b) end
  return a <= b
end

local function is_digits(s)
  return string.match(s, "^%d+$") ~= nil
end

-- Strict CSV parser: EVERY field must be a digit string. Empty fields ("1,,2",
-- trailing commas), empty fields at the edges, and any non-digit content are
-- MALFORMED. Returns (sum, count) or nil on malformed input. The old reader
-- silently DROPPED non-digit fields; we fail closed instead of losing amounts.
local function parse_csv_strict(csv)
  if csv == "" then return "0", 0 end
  local sum, count = "0", 0
  local pos, len = 1, string.len(csv)
  while true do
    local comma = string.find(csv, ",", pos, true)
    local field
    if comma then field = string.sub(csv, pos, comma - 1) else field = string.sub(csv, pos) end
    if not is_digits(field) then return nil end
    sum = dec_add(sum, field)
    count = count + 1
    if not comma then break end
    pos = comma + 1
    if pos > len then return nil end
  end
  return sum, count
end
`;

// ---------------------------------------------------------------------------
// Shared Lua: ensure_day_ledger() — THE migration fence.
//
// Validates the legacy CSV (or its absence) BEFORE any write, imports it into
// the hash exactly once, creates the fence + archive + poison atomically, and
// never resets an existing total to zero.
//
// Returns {"OK", total, count} | {"MALFORMED"} | {"UNAVAILABLE"}
// ---------------------------------------------------------------------------

const LUA_ENSURE_DAY_LEDGER = `
local function ensure_day_ledger()
  local poison = ARGV[1]
  local ttl = ARGV[2]
  local genKey = KEYS[5]
  local legacy = redis.call("GET", KEYS[1])
  -- NOTE: redis.call returns FALSE (not nil) for missing keys/fields.
  local poisoned = (legacy and legacy == poison)
  local fenced = (redis.call("EXISTS", KEYS[3]) == 1) or poisoned

  if fenced then
    if redis.call("EXISTS", KEYS[2]) == 1 then
      local total = redis.call("HGET", KEYS[2], "total")
      local count = redis.call("HGET", KEYS[2], "count")
      if total and count and is_digits(total) and is_digits(count) then
        return {"OK", total, count}
      end
    end
    -- Fenced but the hash is missing/corrupt: the day total is UNKNOWN.
    -- Refuse (fail closed) — NEVER create a fresh zeroed ledger here.
    return {"UNAVAILABLE"}
  end

  -- Not fenced. A migrated hash already exists: it is authoritative. NEVER
  -- re-import over it (an archive-only re-import would drop post-migration
  -- reservations and UNDERCOUNT spend). An unpoisoned legacy CSV alongside a
  -- migrated hash means foreign entries that were never imported — fail
  -- closed. A migrated hash WITHOUT a fence is corrupt state (every write
  -- path creates both atomically) — fail closed; keep all data.
  if redis.call("EXISTS", KEYS[2]) == 1 then
    if not redis.call("HGET", KEYS[2], "migrated") then
      return {"UNAVAILABLE"}
    end
    if legacy and legacy ~= poison then
      return {"UNAVAILABLE"}
    end
    local total = redis.call("HGET", KEYS[2], "total")
    local count = redis.call("HGET", KEYS[2], "count")
    if total and count and is_digits(total) and is_digits(count) then
      return {"OK", total, count}
    end
    return {"UNAVAILABLE"}
  end

  -- Hash missing. If a write-witness exists, this policy-day was migrated
  -- before (import is exactly-once) and the hash was lost — re-importing the
  -- legacy CSV alone would silently undercount any post-migration writes.
  -- Fail closed; the recovery path is restoreDayLedger (gen must be "0").
  if redis.call("EXISTS", genKey) == 1 then
    return {"UNAVAILABLE"}
  end

  -- True first access: import the legacy CSV (if any). Validate first —
  -- writes come only after every field has been accepted.
  local sum, count = "0", 0
  if legacy then
    local psum, pcount = parse_csv_strict(legacy)
    if not psum then
      return {"MALFORMED"}
    end
    sum, count = psum, pcount
  end

  -- All validation done — now write. This whole script is atomic, so old
  -- writers are serialized against import+fence: their append either landed
  -- before (imported here) or is refused by the poison below. Never lost.
  local countStr = string.format("%d", count)
  redis.call("HSET", KEYS[2],
    "total", sum,
    "count", countStr,
    "migrated", "1",
    "legacy", sum,
    "legacyCount", countStr)
  redis.call("EXPIRE", KEYS[2], ttl)
  if legacy then
    redis.call("SET", KEYS[4], legacy, "EX", ARGV[3])
  end
  redis.call("SET", KEYS[3], "1", "EX", ttl)
  redis.call("SET", KEYS[1], poison, "EX", ttl)
  redis.call("SET", genKey, "0", "EX", ttl)
  return {"OK", sum, countStr}
end
`;

/** The fenced-but-hash-missing / malformed sentinel totals used fail-closed. */
// (No sentinel totals: the store reports `MALFORMED_LEGACY` / `LEDGER_UNAVAILABLE`
// and callers must refuse to act — a fake zero is exactly the reset bug.)

// ---------------------------------------------------------------------------
// Entry scripts. ARGV contract (common prefix): ARGV[1] = poison string,
// ARGV[2] = ledger TTL seconds, ARGV[3] = archive TTL seconds.
// ---------------------------------------------------------------------------

/**
 * ensureDayLedger — run the migration fence (or read the fenced totals).
 * KEYS = legacy, hash, fence, archive.
 * Returns {"OK", total, count} | {"MALFORMED"} | {"UNAVAILABLE"}
 */
export const ENSURE_DAY_LEDGER_SCRIPT = `
${LUA_DECIMAL}
${LUA_ENSURE_DAY_LEDGER}
return ensure_day_ledger()
`;

/**
 * reserveDaySpend — atomically (migrate+)reserve one spend amount for an
 * execution id. Idempotent per execution id: a duplicate reservation is
 * returned as-is and NEVER counted twice.
 *
 * KEYS = legacy, hash, fence, archive.
 * ARGV = poison, ttl, archiveTtl, execId, amountRaw, maxDailyRaw, maxActions
 *
 * Returns
 *   {"OK", created, state, total, count}  state in R/A/C/X/F
 *   {"OVER_BUDGET", total, count} | {"OVER_ACTIONS", total, count}
 *   {"MALFORMED"} | {"UNAVAILABLE"} | {"BAD_AMOUNT"}
 */
export const RESERVE_DAY_SPEND_SCRIPT = `
${LUA_DECIMAL}
${LUA_ENSURE_DAY_LEDGER}
local amount = ARGV[5]
if not is_digits(amount) then return {"BAD_AMOUNT"} end
local maxDaily = ARGV[6]
local maxActions = tonumber(ARGV[7])
if not is_digits(maxDaily) or maxActions == nil then return {"BAD_AMOUNT"} end

local led = ensure_day_ledger()
if led[1] ~= "OK" then return led end
local total, count = led[2], led[3]

local field = "res:" .. ARGV[4]
if redis.call("HEXISTS", KEYS[2], field) == 1 then
  local cur = redis.call("HGET", KEYS[2], field)
  local state, amt = string.match(cur, "^(%a):(%d+)$")
  if not state then return {"UNAVAILABLE"} end
  return {"OK", "0", state, total, count}
end

local newTotal = dec_add(total, amount)
if not dec_lte(newTotal, maxDaily) then
  return {"OVER_BUDGET", total, count}
end
if count + 1 > maxActions then
  return {"OVER_ACTIONS", total, count}
end
redis.call("HSET", KEYS[2], field, "R:" .. amount, "total", newTotal, "count", string.format("%d", count + 1))
redis.call("EXPIRE", KEYS[2], ARGV[2])
redis.call("INCR", KEYS[5])
redis.call("EXPIRE", KEYS[5], ARGV[2])
return {"OK", "1", "R", newTotal, string.format("%d", count + 1)}
`;

/**
 * markSpendAttempt — the ATTEMPT MARKER. Persisted BEFORE the execution
 * adapter is invoked: state R -> A. Idempotent. Once A is visible, a crash
 * may have broadcast — the reservation must never be released automatically.
 *
 * KEYS = hash, gen. ARGV = execId, ttl
 * Returns {"OK", state} | {"MISSING"} | {"CORRUPT"}
 */
export const MARK_SPEND_ATTEMPT_SCRIPT = `
local field = "res:" .. ARGV[1]
local cur = redis.call("HGET", KEYS[1], field)
if not cur then return {"MISSING"} end
local state, amt = string.match(cur, "^(%a):(%d+)$")
if not state then return {"CORRUPT"} end
if state == "R" then
  redis.call("HSET", KEYS[1], field, "A:" .. amt)
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  redis.call("INCR", KEYS[2])
  redis.call("EXPIRE", KEYS[2], ARGV[2])
  return {"OK", "A"}
end
return {"OK", state}
`;

/**
 * commitDaySpend — terminal consumed state (successful or reverted
 * execution; anything whose spend must stay counted). R|A -> C.
 * Idempotent; X stays X; F cannot be committed (returns REFUSED).
 *
 * KEYS = hash, gen. ARGV = execId, ttl
 * Returns {"OK", state} | {"REFUSED", state} | {"MISSING"}
 */
export const COMMIT_DAY_SPEND_SCRIPT = `
local field = "res:" .. ARGV[1]
local cur = redis.call("HGET", KEYS[1], field)
if not cur then return {"MISSING"} end
local state, amt = string.match(cur, "^(%a):(%d+)$")
if not state then return {"MISSING"} end
if state == "R" or state == "A" then
  redis.call("HSET", KEYS[1], field, "C:" .. amt)
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  redis.call("INCR", KEYS[2])
  redis.call("EXPIRE", KEYS[2], ARGV[2])
  return {"OK", "C"}
end
if state == "C" or state == "X" then return {"OK", state} end
return {"REFUSED", state}
`;

/**
 * markSpendAmbiguous — recovery primitive for an ATTEMPTING reservation
 * whose broadcast outcome is unknown (process crash after the attempt
 * marker, lost adapter response). A -> X. The spend STAYS counted. This is
 * the ONLY state an operator may move a stuck-A reservation to; it never
 * releases anything.
 *
 * KEYS = hash, gen. ARGV = execId, ttl
 * Returns {"OK", state} | {"REFUSED", state} | {"MISSING"}
 */
export const MARK_SPEND_AMBIGUOUS_SCRIPT = `
local field = "res:" .. ARGV[1]
local cur = redis.call("HGET", KEYS[1], field)
if not cur then return {"MISSING"} end
local state, amt = string.match(cur, "^(%a):(%d+)$")
if not state then return {"MISSING"} end
if state == "A" then
  redis.call("HSET", KEYS[1], field, "X:" .. amt)
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  redis.call("INCR", KEYS[2])
  redis.call("EXPIRE", KEYS[2], ARGV[2])
  return {"OK", "X"}
end
return {"REFUSED", state}
`;

/**
 * releaseDaySpend — the ONLY way spend is freed. Two verified reasons:
 *   P — verified pre-broadcast refusal (adapter/guard promised nothing was
 *       broadcast; allowed from R or A)
 *   U — unattempted (state is exactly R, proving the adapter was never
 *       invoked; crash-recovery path)
 * Anything else is refused. total/count are decremented exactly once.
 *
 * KEYS = legacy, hash, fence, archive, gen (hash is KEYS[2]).
 * ARGV = poison, ttl, archiveTtl, execId, reason ("P"|"U")
 * Returns {"OK", state} | {"REFUSED", state} | {"MISSING"}
 */
export const RELEASE_DAY_SPEND_SCRIPT = `
${LUA_DECIMAL}
local field = "res:" .. ARGV[4]
local cur = redis.call("HGET", KEYS[2], field)
if not cur then return {"MISSING"} end
local state, amt = string.match(cur, "^(%a):(%d+)$")
if not state then return {"MISSING"} end
local reason = ARGV[5]
local allowed = (reason == "P" and (state == "R" or state == "A"))
  or (reason == "U" and state == "R")
if not allowed then
  return {"REFUSED", state}
end
local total = redis.call("HGET", KEYS[2], "total")
local count = redis.call("HGET", KEYS[2], "count")
if not total or not count then return {"MISSING"} end
local newTotal = dec_sub(total, amt)
if newTotal == nil then return {"MISSING"} end
local newCount = tonumber(count) - 1
if newCount < 0 then return {"MISSING"} end
redis.call("HSET", KEYS[2], field, "F:" .. amt, "total", newTotal, "count", string.format("%d", newCount))
redis.call("EXPIRE", KEYS[2], ARGV[2])
redis.call("INCR", KEYS[5])
redis.call("EXPIRE", KEYS[5], ARGV[2])
return {"OK", "F"}
`;

/**
 * restoreDayLedger — OPERATOR recovery for "migrated but the hash is
 * missing" (see docs/AUTONOMY-DAILY-SPEND-RESERVATIONS.md).
 *
 * The archive holds ONLY the legacy CSV as it looked at migration time — it
 * can never contain post-migration reservations. Restoring it blindly would
 * UNDERCOUNT daily spend and re-open the over-budget hole this ledger closes.
 * The write-witness (`daygen`) is therefore the arbiter:
 *
 *   gen == "0"  exactly the import ever wrote the hash, so the archived CSV
 *               IS the full authoritative ledger and re-importing it
 *               reconstructs the day exactly. Restore proceeds.
 *   gen > 0     post-migration reservations existed that only the lost hash
 *               held. The full authoritative ledger CANNOT be reconstructed.
 *               Return {"LOST_HISTORY"} — fail closed, never an incomplete
 *               total. Manual reconciliation is required.
 *   gen missing the witness itself is gone: completeness cannot be proven.
 *               Fail closed ({"UNAVAILABLE"}).
 *
 * Never invents zero totals: without an archive it refuses. Never touches an
 * existing hash ({"ALREADY"}).
 *
 * KEYS = legacy, hash, fence, archive, gen. ARGV = poison, ttl, archiveTtl
 * Returns {"OK", total, count} | {"ALREADY"} | {"LOST_HISTORY"}
 *       | {"UNAVAILABLE"} | {"MALFORMED"}
 */
export const RESTORE_DAY_LEDGER_SCRIPT = `
${LUA_DECIMAL}
local poison = ARGV[1]
local ttl = ARGV[2]
local legacy = redis.call("GET", KEYS[1])
local poisoned = (legacy and legacy == poison)
local fenced = (redis.call("EXISTS", KEYS[3]) == 1) or poisoned
if not fenced then return {"UNAVAILABLE"} end
if redis.call("EXISTS", KEYS[2]) == 1 then return {"ALREADY"} end
local gen = redis.call("GET", KEYS[5])
if not gen then return {"UNAVAILABLE"} end
if gen ~= "0" then return {"LOST_HISTORY"} end
local archived = redis.call("GET", KEYS[4])
if not archived then return {"UNAVAILABLE"} end
local sum, count = parse_csv_strict(archived)
if not sum then return {"MALFORMED"} end
local countStr = string.format("%d", count)
redis.call("HSET", KEYS[2],
  "total", sum,
  "count", countStr,
  "migrated", "1",
  "legacy", sum,
  "legacyCount", countStr)
redis.call("EXPIRE", KEYS[2], ttl)
redis.call("SET", KEYS[3], "1", "EX", ttl)
redis.call("SET", KEYS[5], "0", "EX", ttl)
return {"OK", sum, countStr}
`;

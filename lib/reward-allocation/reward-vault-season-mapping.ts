// lib/reward-vault/reward-vault-season-mapping.ts
//
// SERVER-ONLY. Maps the existing XP season concept
// (lib/xp-engine.ts::getSeasonNumber()/getSeasonStart()/getSeasonEnd(),
// a pure date calculation with no on-chain counterpart) to the vault's
// on-chain seasonId (MPGRRewardVault.createSeason/getSeason/allocateReward's
// seasonId parameter — a completely separate, admin-created on-chain
// concept). Before this module existed, no relationship between the two
// was defined anywhere in the repo — this file makes that relationship
// explicit and centralizes it, rather than leaving each future caller to
// assume one.
//
// THIS FILE DOES NOT:
//   - call createSeason() — no on-chain season is created by importing
//     or calling anything here.
//   - assume a vault season currently exists for the current XP season
//     number. resolveVaultSeasonId() below can and will return null.
//   - decide the week/season granularity mismatch noted in the
//     architecture audit (an XP "season" is calendar-month-sized;
//     "weekKey" in lib/reward-allocation/allocation-types.ts is a
//     narrower settlement cadence nested inside one XP season). That
//     mismatch is intentionally left as an open CONFIG/DECISION
//     REQUIRED item, not resolved by this file.
//
// CONFIG/DECISION REQUIRED before this module can be used for anything
// beyond a lookup stub:
//   1. Confirm the intended mapping is actually 1:1 (XP season number ==
//      vault seasonId) rather than e.g. a separate on-chain season per
//      settlement week, or some other scheme.
//   2. Decide who/what actually calls createSeason() for a new XP season
//      as it begins, and how startTime/endTime are derived (candidates:
//      getSeasonStart()/getSeasonEnd() from xp-engine.ts, converted to
//      unix seconds) — not implemented here.
//   3. Decide how "does a vault season exist for this XP season number"
//      is checked in production (live seasonExists() read via the admin
//      ABI vs. a cached/persisted flag) — this file defines the shape of
//      that check, not its implementation.

import { getSeasonNumber, getSeasonStart, getSeasonEnd } from "@/lib/xp-engine";

/**
 * The vault seasonId a given XP season number would map to, under the
 * "candidate direction" named in the architecture (1:1 mapping). This is
 * a pure, deterministic function — it does NOT read chain state, so it
 * cannot tell you whether that vault season has actually been created
 * yet. See VaultSeasonLookup below for the (unimplemented) chain-aware
 * check.
 *
 * Returns bigint to match every other seasonId type in this codebase
 * (VaultSeason.seasonId, PlayerWeekRecord.seasonId, etc.).
 */
export function candidateVaultSeasonId(xpSeasonNumber: number = getSeasonNumber()): bigint {
  return BigInt(xpSeasonNumber);
}

/** The unix-seconds start/end a createSeason() call would use for a given XP season, IF decision #1/#2 above are approved as-is. Not called anywhere yet. */
export function candidateVaultSeasonWindow(referenceDate: Date = new Date()): {
  startTimeSeconds: bigint;
  endTimeSeconds: bigint;
} {
  const start = getSeasonStart();
  const end = getSeasonEnd();
  void referenceDate; // reserved for a future non-"now" lookup; xp-engine's season functions are always relative to the current date today
  return {
    startTimeSeconds: BigInt(Math.floor(start.getTime() / 1000)),
    endTimeSeconds: BigInt(Math.floor(end.getTime() / 1000)),
  };
}

/**
 * Chain-aware resolution: does a vault season actually exist for the
 * current XP season, and what is its on-chain state. Interface only —
 * no implementation. A real implementation would call the admin ABI's
 * seasonExists(seasonId)/getSeason(seasonId) (see
 * lib/reward-vault/reward-vault-admin-abi.ts) through a server-only
 * read client, and return null (rather than throwing) when no season
 * has been created yet, so callers can distinguish "not created yet"
 * from "read failed."
 */
export interface VaultSeasonLookup {
  resolveActiveVaultSeasonId(): Promise<{
    seasonId: bigint;
    exists: boolean;
    finalized: boolean;
  } | null>;
}


// lib/season-points.ts
//
// CANONICAL Season Points calculation. This is the ONLY place Season
// Points are computed anywhere in the app — lib/xp-engine.ts (client
// display) and app/api/leaderboard/route.ts (server-authoritative
// persistence) both call into this module instead of each keeping
// their own copy. lib/leaderboard-store.ts also uses this module's
// getUTCSeasonOrdinal() for its stale-write guard (see that file).
//
// ---------------------------------------------------------------------
// Business definition (unchanged): Season Points = XP earned during the
// current UTC calendar month.
// ---------------------------------------------------------------------

export interface SeasonPointsHistoryEntry {
  // Anything with an `xp` amount and a `timestamp` qualifies — this is
  // intentionally structural (not tied to lib/xp-engine.ts's
  // XPHistoryEntry type) so the server route can accept a plain JSON
  // array without importing client-only code.
  xp: number;
  timestamp: string;
}

export interface SeasonPointsResult {
  seasonPoints: number;
  // How many history rows were excluded from the season calculation for
  // having an unusable xp amount, an unparseable timestamp, or a
  // timestamp in the future. Server callers can log this; never throws
  // or corrupts the rest of the calculation.
  invalidEntries: number;
  // True when unhistoried lifetime XP was attributed to the current
  // season under the legacy-recovery rule below. Exposed for
  // diagnostics/tests, not required by callers.
  recoveredUnhistoriedXp: number;
}

// --- UTC month boundary ----------------------------------------------

// Current UTC calendar month, expressed as [start, end) — end is
// exclusive (the first instant of the FOLLOWING month), so a boundary
// timestamp of exactly midnight UTC on the 1st is never ambiguous, and
// a future-dated timestamp (>= end) is unambiguously excluded rather
// than accidentally satisfying a one-sided `>= start` check.
export function getUTCSeasonStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function getUTCSeasonEnd(now: Date = new Date()): Date {
  const start = getUTCSeasonStart(now);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

// A monotonically increasing integer identifying a UTC calendar month
// (e.g. August 2026 -> 2026*12 + 7). Used ONLY by
// lib/leaderboard-store.ts to detect an out-of-order write that spans a
// season rollover — see that file's header comment on upsertEntry() for
// why xp-comparison alone isn't sufficient. Not used by the season
// points calculation itself.
export function getUTCSeasonOrdinal(now: Date = new Date()): number {
  return now.getUTCFullYear() * 12 + now.getUTCMonth();
}

// Parses a timestamp the same way for every caller. Returns null (never
// an Invalid Date) for anything unparseable, so callers can branch on
// validity explicitly instead of relying on `Invalid Date` comparisons
// silently evaluating to false.
function parseTimestamp(raw: string): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- Canonical calculation ---------------------------------------------

// `lifetimeXp` is the wallet's total XP (authoritative count of every
// grant ever made, historied or not). `history` is every history row
// currently known for that wallet — may be incomplete for legacy
// records: some wallets have `xp` (lifetime total) higher than any sum
// of their `history` rows, because the `history` array was added to the
// local record shape (lib/xp-engine.ts) after those wallets had already
// accrued XP — those earlier grants have no corresponding history row
// at all. That's the ONLY legacy scenario this recovery rule exists
// for; it is not a general-purpose "trust the bigger number" fallback.
//
// Recovery rule, precisely:
//   For each history entry, its XP AMOUNT is trusted independently of
//   whether its TIMESTAMP is trusted. An entry with a valid, finite,
//   non-negative `xp` contributes to `accountedSum` regardless of
//   whether its timestamp is missing, unparseable, or in the future —
//   because we DO know a real XP grant of that size happened, even if
//   we can't place it in a month. Only entries whose `xp` itself is
//   unusable (NaN, negative, non-finite) are excluded from
//   `accountedSum`, since there we don't know an amount to account for
//   at all.
//
//   unhistoried = max(0, lifetimeXp - accountedSum)
//   If unhistoried > 0 AND no entry has a valid timestamp strictly
//   before the current UTC month (i.e. nothing proves any XP belongs to
//   an EARLIER season), the unhistoried amount is attributed to the
//   CURRENT season.
//
// This design deliberately closes a loophole an earlier version of this
// function had: excluding an entry's XP from `accountedSum` whenever
// its TIMESTAMP was invalid let that same XP silently reappear via the
// "unhistoried" recovery path — effectively still counting malformed
// data, just laundered through a different code path. Concretely:
//   lifetimeXp = 50, history = [ {xp:30, valid timestamp},
//                                 {xp:20, invalid timestamp} ]
// must resolve to 30 (the 20 is discarded, full stop), never to 50
// (which would happen if the 20 were left out of accountedSum, making
// the "gap" between 50 and 30 look like innocent legacy unhistoried XP
// instead of what it actually is: a data point this function has
// already decided not to trust the timing of, but can still be
// confident about the CLAIMED AMOUNT).
//
// The same principle is why a FUTURE-dated entry (timestamp >= end,
// i.e. next month or later) also gets its xp folded into
// `accountedSum` rather than dropped outright: if it were dropped
// entirely, the same laundering loophole would let a future-dated
// entry's XP get "recovered" into the current season, which is exactly
// what future timestamps must NOT be able to do.
//
// This never does `seasonPoints = xp` unconditionally — only when there
// is literally no earlier-timestamped entry to contradict that
// attribution, and even then, only for the portion of xp that isn't
// already accounted for by SOME entry (valid-timestamped or not).
export function calculateSeasonPoints(
  lifetimeXp: number,
  history: SeasonPointsHistoryEntry[],
  now: Date = new Date()
): SeasonPointsResult {
  const start = getUTCSeasonStart(now);
  const end = getUTCSeasonEnd(now);
  const safeLifetimeXp = Number.isFinite(lifetimeXp) && lifetimeXp > 0 ? lifetimeXp : 0;

  let invalidEntries = 0;
  let currentMonthSum = 0;
  let accountedSum = 0;
  let hasPriorSeasonHistory = false;

  for (const entry of history ?? []) {
    const xp = Number.isFinite(entry?.xp) && entry.xp >= 0 ? entry.xp : NaN;
    if (Number.isNaN(xp)) {
      // Unusable amount — nothing to account for at all.
      invalidEntries++;
      continue;
    }
    // The amount is trustworthy from here on, regardless of timestamp.
    accountedSum += xp;

    const ts = parseTimestamp(entry.timestamp);
    if (ts === null) {
      invalidEntries++; // unparseable timestamp — already accounted above
      continue;
    }
    if (ts.getTime() >= end.getTime()) {
      invalidEntries++; // future timestamp — already accounted above, must not count toward any season
      continue;
    }
    if (ts.getTime() >= start.getTime()) {
      currentMonthSum += xp;
    } else {
      hasPriorSeasonHistory = true; // already accounted above
    }
  }

  const unhistoried = Math.max(0, safeLifetimeXp - accountedSum);
  const shouldRecoverUnhistoried = unhistoried > 0 && !hasPriorSeasonHistory;
  const recoveredUnhistoriedXp = shouldRecoverUnhistoried ? unhistoried : 0;

  const seasonPoints = Math.max(0, currentMonthSum + recoveredUnhistoriedXp);

  return { seasonPoints, invalidEntries, recoveredUnhistoriedXp };
}

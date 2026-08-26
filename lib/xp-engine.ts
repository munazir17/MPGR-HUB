import { calculateSeasonPoints, getUTCSeasonStart, getUTCSeasonEnd } from "./season-points";

export type XPAction =
  | "WALLET_CONNECTED"
  | "DAILY_CHECK_IN"
  | "PROFILE_COMPLETED"
  | "SHARE_ON_X"
  | "QUEST_COMPLETED"
  | "REFERRAL_SUCCESS"
  // Games Platform (Games 1.0) — awarded by lib/games/mpgr-run/run-rewards.ts
  // only after a client-validated, non-duplicate completed run, and only up
  // to a per-day cap enforced in that module. Fixed amount, same discipline
  // as every other action here — no arbitrary/variable XP grants.
  | "GAME_MPGR_RUN_COMPLETE";

export const XP_ACTIONS: Record<XPAction, { label: string; xp: number }> = {
  WALLET_CONNECTED: { label: "Wallet Connected", xp: 50 },
  DAILY_CHECK_IN: { label: "Daily Check-In", xp: 20 },
  PROFILE_COMPLETED: { label: "Profile Completed", xp: 30 },
  SHARE_ON_X: { label: "Shared on X", xp: 15 },
  QUEST_COMPLETED: { label: "Quest Completed", xp: 40 },
  REFERRAL_SUCCESS: { label: "Referral Success", xp: 100 },
  GAME_MPGR_RUN_COMPLETE: { label: "MPGR Run Completed", xp: 8 },
};

export interface XPHistoryEntry {
  action: XPAction;
  xp: number;
  timestamp: string;
}

export interface UserXPRecord {
  address: string;
  xp: number;
  streak: number;
  lastCheckIn: string | null;
  referralCount: number;
  oneTimeActionsAwarded: XPAction[];
  claimedAchievements: string[];
  lastKnownLevel: number;
  history: XPHistoryEntry[];
}

const STORAGE_PREFIX = "mpgr_xp_v1_";
const ONE_TIME_ACTIONS: XPAction[] = ["WALLET_CONNECTED", "PROFILE_COMPLETED"];

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function emptyRecord(address: string): UserXPRecord {
  return {
    address: address.toLowerCase(),
    xp: 0,
    streak: 0,
    lastCheckIn: null,
    referralCount: 0,
    oneTimeActionsAwarded: [],
    claimedAchievements: [],
    lastKnownLevel: 1,
    history: [],
  };
}

// --- Storage layer -------------------------------------------------
// Phase 2B swap point: replace get/save bodies with fetch() calls to a
// real API/database. Everything else in this file stays identical.

export function getUserRecord(address: string): UserXPRecord {
  if (typeof window === "undefined") return emptyRecord(address);
  try {
    const raw = window.localStorage.getItem(storageKey(address));
    if (!raw) return emptyRecord(address);
    return { ...emptyRecord(address), ...JSON.parse(raw) };
  } catch {
    return emptyRecord(address);
  }
}

function saveUserRecord(record: UserXPRecord) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(record.address), JSON.stringify(record));
}

// --- Level curve -----------------------------------------------------

function xpFloorForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(100 * Math.pow(level - 1, 1.5) * 1.5);
}

export interface LevelProgress {
  level: number;
  nextLevel: number;
  xpIntoLevel: number;
  xpNeededForLevel: number;
  progress: number;
}

export function getLevelProgress(xp: number): LevelProgress {
  let level = 1;
  while (xpFloorForLevel(level + 1) <= xp) level++;
  const currentFloor = xpFloorForLevel(level);
  const nextFloor = xpFloorForLevel(level + 1);
  const xpIntoLevel = xp - currentFloor;
  const xpNeededForLevel = nextFloor - currentFloor;
  const progress = xpNeededForLevel === 0
    ? 100
    : Math.min(100, Math.round((xpIntoLevel / xpNeededForLevel) * 100));
  return { level, nextLevel: level + 1, xpIntoLevel, xpNeededForLevel, progress };
}

// --- Actions -----------------------------------------------------------

export interface AwardResult {
  record: UserXPRecord;
  xpGained: number;
  leveledUp: boolean;
  newLevel: number;
}

function finalizeAward(record: UserXPRecord, xpGained: number): AwardResult {
  const newLevel = getLevelProgress(record.xp).level;
  const leveledUp = newLevel > record.lastKnownLevel;
  record.lastKnownLevel = newLevel;
  saveUserRecord(record);
  return { record, xpGained, leveledUp, newLevel };
}

export function awardXP(address: string, action: XPAction): AwardResult {
  const record = getUserRecord(address);

  if (ONE_TIME_ACTIONS.includes(action) && record.oneTimeActionsAwarded.includes(action)) {
    return { record, xpGained: 0, leveledUp: false, newLevel: getLevelProgress(record.xp).level };
  }

  const xp = XP_ACTIONS[action].xp;
  record.xp += xp;
  record.history.push({ action, xp, timestamp: new Date().toISOString() });
  if (ONE_TIME_ACTIONS.includes(action)) {
    record.oneTimeActionsAwarded.push(action);
  }
  return finalizeAward(record, xp);
}

export function performDailyCheckIn(address: string): AwardResult & { alreadyCheckedIn: boolean } {
  const record = getUserRecord(address);
  const today = new Date().toISOString().slice(0, 10);

  if (record.lastCheckIn === today) {
    return { record, xpGained: 0, leveledUp: false, newLevel: getLevelProgress(record.xp).level, alreadyCheckedIn: true };
  }

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  record.streak = record.lastCheckIn === yesterday ? record.streak + 1 : 1;
  record.lastCheckIn = today;

  const xp = XP_ACTIONS.DAILY_CHECK_IN.xp;
  record.xp += xp;
  record.history.push({ action: "DAILY_CHECK_IN", xp, timestamp: new Date().toISOString() });

  const result = finalizeAward(record, xp);
  return { ...result, alreadyCheckedIn: false };
}

// Season points: real XP earned since the 1st of the current UTC
// calendar month.
//
// Root-cause fix — this used to sum `record.history` itself, filtered
// against a LOCAL-timezone midnight boundary (`setHours(0,0,0,0)`),
// with no handling for unparseable timestamps and no recovery for
// legacy records where `xp` (lifetime total) is higher than
// `sum(history)` (history was added to the record shape after some
// wallets had already accrued XP). All of that now lives in ONE place
// — lib/season-points.ts's calculateSeasonPoints() — shared with the
// server-authoritative calculation in app/api/leaderboard/route.ts, so
// this file, the leaderboard POST, and any future recompute/migration
// tooling can never drift into competing answers for the same wallet.
export function getSeasonPoints(record: UserXPRecord): number {
  return calculateSeasonPoints(record.xp, record.history).seasonPoints;
}

// UTC calendar-month boundaries (was local-timezone midnight — see
// lib/season-points.ts's header comment for why that was wrong).
// Re-exported from the canonical module so every existing call site
// across the app (season countdown displays, Season Pass, etc.) keeps
// working unchanged while getting the corrected boundary.
export function getSeasonStart(): Date {
  return getUTCSeasonStart();
}

export function getSeasonEnd(): Date {
  // Canonical end is exclusive (first instant of next month); every
  // existing caller here treats getSeasonEnd() as an inclusive "last
  // moment of this month" countdown target, so subtract 1ms to match
  // that existing contract exactly.
  return new Date(getUTCSeasonEnd().getTime() - 1);
}

// Season number is 1-indexed from a fixed UTC epoch. Kept UTC-consistent
// with getSeasonStart()/getSeasonEnd()/calculateSeasonPoints() above —
// this used to use local-timezone Date methods (getFullYear/getMonth,
// `new Date(2026, 0, 1)` constructed in local time), so a wallet near a
// month boundary could see a season NUMBER one month off from the
// season points/countdown they were actually looking at, even though
// both were nominally describing "the current season."
export function getSeasonNumber(): number {
  const epoch = new Date(Date.UTC(2026, 0, 1));
  const now = new Date();
  return (
    (now.getUTCFullYear() - epoch.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - epoch.getUTCMonth()) +
    1
  );
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
  claimed: boolean;
  progress: number;
  target: number;
  comingSoon?: boolean;
}

// Games Platform (Games 1.0) — minimal aggregate stats needed to compute
// game-related achievement progress. Sourced from lib/games/game-storage.ts
// GameStatsRecord; kept as its own narrow shape here so xp-engine.ts never
// needs to import anything from lib/games/. Optional everywhere so every
// existing call site (that doesn't pass it) behaves exactly as before —
// game achievements just render locked/0-progress until stats are supplied.
export interface GameAchievementStats {
  totalRuns: number;
  bestDistance: number;
  noCollisionRuns: number;
  totalCoinsCollected: number;
}

export function getAchievements(record: UserXPRecord, gameStats?: GameAchievementStats): Achievement[] {
  const level = getLevelProgress(record.xp).level;
  const claimed = record.claimedAchievements;
  const g = gameStats;

  const defs: Omit<Achievement, "claimed">[] = [
    {
      id: "first-checkin",
      title: "First Check-in",
      description: "Complete your first daily check-in",
      unlocked: record.streak >= 1,
      progress: Math.min(record.streak, 1),
      target: 1,
    },
    {
      id: "streak-7",
      title: "7 Day Streak",
      description: "Check in 7 days in a row",
      unlocked: record.streak >= 7,
      progress: Math.min(record.streak, 7),
      target: 7,
    },
    {
      id: "streak-30",
      title: "30 Day Streak",
      description: "Check in 30 days in a row",
      unlocked: record.streak >= 30,
      progress: Math.min(record.streak, 30),
      target: 30,
    },
    {
      id: "xp-100",
      title: "100 XP",
      description: "Earn 100 total XP",
      unlocked: record.xp >= 100,
      progress: Math.min(record.xp, 100),
      target: 100,
    },
    {
      id: "level-5",
      title: "Level 5",
      description: "Reach level 5",
      unlocked: level >= 5,
      progress: Math.min(level, 5),
      target: 5,
    },
    {
      id: "level-10",
      title: "Level 10",
      description: "Reach level 10",
      unlocked: level >= 10,
      progress: Math.min(level, 10),
      target: 10,
    },
    {
      id: "community-builder",
      title: "Community Builder",
      description: "Refer 10 friends to MPGR HUB",
      unlocked: record.referralCount >= 10,
      progress: Math.min(record.referralCount, 10),
      target: 10,
    },
    {
      id: "top-referrer",
      title: "Top Referrer",
      description: "Available once the global leaderboard launches",
      unlocked: false,
      progress: 0,
      target: 1,
      comingSoon: true,
    },
    {
      id: "first-spin",
      title: "First Spin",
      description: "Coming soon — spin feature not yet live",
      unlocked: false,
      progress: 0,
      target: 1,
      comingSoon: true,
    },
    {
      id: "og-member",
      title: "OG Member",
      description: "Manually awarded to early testers",
      unlocked: false,
      progress: 0,
      target: 1,
      comingSoon: true,
    },
    // --- Games Platform: MPGR Run --------------------------------------
    {
      id: "mpgr-run-first",
      title: "First Run",
      description: "Complete your first MPGR Run",
      unlocked: !!g && g.totalRuns >= 1,
      progress: Math.min(g?.totalRuns ?? 0, 1),
      target: 1,
    },
    {
      id: "mpgr-run-1000m",
      title: "1,000m Club",
      description: "Reach 1,000m in a single MPGR Run",
      unlocked: !!g && g.bestDistance >= 1000,
      progress: Math.min(g?.bestDistance ?? 0, 1000),
      target: 1000,
    },
    {
      id: "mpgr-run-5000m",
      title: "5,000m Club",
      description: "Reach 5,000m in a single MPGR Run",
      unlocked: !!g && g.bestDistance >= 5000,
      progress: Math.min(g?.bestDistance ?? 0, 5000),
      target: 5000,
    },
    {
      id: "mpgr-run-10000m",
      title: "10,000m Club",
      description: "Reach 10,000m in a single MPGR Run",
      unlocked: !!g && g.bestDistance >= 10000,
      progress: Math.min(g?.bestDistance ?? 0, 10000),
      target: 10000,
    },
    {
      id: "mpgr-run-no-collision",
      title: "Flawless Run",
      description: "Finish a run of at least 500m without a single collision",
      unlocked: !!g && g.noCollisionRuns >= 1,
      progress: Math.min(g?.noCollisionRuns ?? 0, 1),
      target: 1,
    },
    {
      id: "mpgr-run-coin-collector",
      title: "Coin Collector",
      description: "Collect 500 total coins across all MPGR Runs",
      unlocked: !!g && g.totalCoinsCollected >= 500,
      progress: Math.min(g?.totalCoinsCollected ?? 0, 500),
      target: 500,
    },
    {
      id: "mpgr-runner",
      title: "MPGR Runner",
      description: "Complete 25 MPGR Runs",
      unlocked: !!g && g.totalRuns >= 25,
      progress: Math.min(g?.totalRuns ?? 0, 25),
      target: 25,
    },
  ];

  return defs.map((d) => ({ ...d, claimed: claimed.includes(d.id) }));
}

export function claimAchievement(
  address: string,
  achievementId: string,
  gameStats?: GameAchievementStats
): UserXPRecord {
  const record = getUserRecord(address);
  const achievement = getAchievements(record, gameStats).find((a) => a.id === achievementId);
  if (!achievement || !achievement.unlocked || record.claimedAchievements.includes(achievementId)) {
    return record;
  }
  record.claimedAchievements.push(achievementId);
  saveUserRecord(record);
  return record;
}

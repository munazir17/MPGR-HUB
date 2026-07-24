export type XPAction =
  | "WALLET_CONNECTED"
  | "DAILY_CHECK_IN"
  | "PROFILE_COMPLETED"
  | "SHARE_ON_X"
  | "QUEST_COMPLETED"
  | "REFERRAL_SUCCESS";

export const XP_ACTIONS: Record<XPAction, { label: string; xp: number }> = {
  WALLET_CONNECTED: { label: "Wallet Connected", xp: 50 },
  DAILY_CHECK_IN: { label: "Daily Check-In", xp: 20 },
  PROFILE_COMPLETED: { label: "Profile Completed", xp: 30 },
  SHARE_ON_X: { label: "Shared on X", xp: 15 },
  QUEST_COMPLETED: { label: "Quest Completed", xp: 40 },
  REFERRAL_SUCCESS: { label: "Referral Success", xp: 100 },
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

// Season points: real XP earned since the 1st of the current calendar month.
export function getSeasonPoints(record: UserXPRecord): number {
  const start = getSeasonStart();
  return record.history
    .filter((entry) => new Date(entry.timestamp) >= start)
    .reduce((sum, entry) => sum + entry.xp, 0);
}

export function getSeasonStart(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function getSeasonEnd(): Date {
  const d = getSeasonStart();
  d.setMonth(d.getMonth() + 1);
  d.setMilliseconds(-1);
  return d;
}

export function getSeasonNumber(): number {
  const epoch = new Date(2026, 0, 1);
  const now = new Date();
  return (now.getFullYear() - epoch.getFullYear()) * 12 + (now.getMonth() - epoch.getMonth()) + 1;
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

export function getAchievements(record: UserXPRecord): Achievement[] {
  const level = getLevelProgress(record.xp).level;
  const claimed = record.claimedAchievements;

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
  ];

  return defs.map((d) => ({ ...d, claimed: claimed.includes(d.id) }));
}

export function claimAchievement(address: string, achievementId: string): UserXPRecord {
  const record = getUserRecord(address);
  const achievement = getAchievements(record).find((a) => a.id === achievementId);
  if (!achievement || !achievement.unlocked || record.claimedAchievements.includes(achievementId)) {
    return record;
  }
  record.claimedAchievements.push(achievementId);
  saveUserRecord(record);
  return record;
}

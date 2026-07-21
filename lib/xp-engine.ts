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
  timestamp: string; // ISO string
}

export interface UserXPRecord {
  address: string;
  xp: number;
  streak: number;
  lastCheckIn: string | null; // YYYY-MM-DD
  referralCount: number;
  oneTimeActionsAwarded: XPAction[];
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
    history: [],
  };
}

// --- Storage layer -------------------------------------------------
// Everything below reads/writes localStorage. To move to a real backend
// in Phase 2B, replace the body of getUserRecord/saveUserRecord with
// fetch() calls to your API — every function above this comment stays
// identical, since they only depend on this pair.

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
  xpIntoLevel: number;
  xpNeededForLevel: number;
  progress: number; // 0-100
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
  return { level, xpIntoLevel, xpNeededForLevel, progress };
}

// --- Actions -----------------------------------------------------------

export function awardXP(address: string, action: XPAction): UserXPRecord {
  const record = getUserRecord(address);

  if (ONE_TIME_ACTIONS.includes(action) && record.oneTimeActionsAwarded.includes(action)) {
    return record; // already granted once, no duplicate award
  }

  const xp = XP_ACTIONS[action].xp;
  record.xp += xp;
  record.history.push({ action, xp, timestamp: new Date().toISOString() });
  if (ONE_TIME_ACTIONS.includes(action)) {
    record.oneTimeActionsAwarded.push(action);
  }
  saveUserRecord(record);
  return record;
}

export function performDailyCheckIn(address: string): {
  record: UserXPRecord;
  xpAwarded: number;
  alreadyCheckedIn: boolean;
} {
  const record = getUserRecord(address);
  const today = new Date().toISOString().slice(0, 10);

  if (record.lastCheckIn === today) {
    return { record, xpAwarded: 0, alreadyCheckedIn: true };
  }

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  record.streak = record.lastCheckIn === yesterday ? record.streak + 1 : 1;
  record.lastCheckIn = today;

  const xp = XP_ACTIONS.DAILY_CHECK_IN.xp;
  record.xp += xp;
  record.history.push({ action: "DAILY_CHECK_IN", xp, timestamp: new Date().toISOString() });
  saveUserRecord(record);

  return { record, xpAwarded: xp, alreadyCheckedIn: false };
}

// Season points: real XP earned since the 1st of the current calendar month,
// computed from actual timestamped history — not a separate fake counter.
export function getSeasonPoints(record: UserXPRecord): number {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  return record.history
    .filter((entry) => new Date(entry.timestamp) >= startOfMonth)
    .reduce((sum, entry) => sum + entry.xp, 0);
}

export interface Achievement {
  id: string;
  label: string;
  description: string;
  unlocked: boolean;
}

export function getAchievements(record: UserXPRecord): Achievement[] {
  return [
    {
      id: "first-steps",
      label: "First Steps",
      description: "Connected your wallet",
      unlocked: record.oneTimeActionsAwarded.includes("WALLET_CONNECTED"),
    },
    {
      id: "consistent",
      label: "Consistent",
      description: "7-day check-in streak",
      unlocked: record.streak >= 7,
    },
    {
      id: "grinder",
      label: "Grinder",
      description: "Earned 500+ XP",
      unlocked: record.xp >= 500,
    },
    {
      id: "networker",
      label: "Networker",
      description: "5+ successful referrals",
      unlocked: record.referralCount >= 5,
    },
  ];
}

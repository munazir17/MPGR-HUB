import {
  getLevelProgress,
  getSeasonNumber,
  getSeasonPoints,
  getUserRecord,
  type UserXPRecord,
} from "@/lib/xp-engine";
import { readJSON, writeJSON } from "@/lib/storage";

// --- Types -------------------------------------------------------------

export type RewardSource = "DAILY_CHECK_IN" | "STREAK" | "LEVEL" | "REFERRAL" | "SEASON";

export interface RewardClaim {
  id: string;
  source: RewardSource;
  title: string;
  description: string;
  amount: number; // Mock MPGR amount. Phase 2B swap point: once the reward
  // contract exists, this becomes the real allocation read from chain
  // instead of a static number.
  unlocked: boolean;
  claimed: boolean;
  progress: number;
  target: number;
}

export interface RewardClaimHistoryEntry {
  rewardId: string;
  amount: number;
  timestamp: string;
}

export interface RewardState {
  address: string;
  claimedRewardIds: string[];
  totalClaimed: number;
  history: RewardClaimHistoryEntry[];
}

export interface ClaimResult {
  claims: RewardClaim[];
  claimedAmount: number;
  claimedIds: string[];
}

export interface WeeklyClaimPoint {
  date: string; // YYYY-MM-DD
  label: string; // short weekday, e.g. "Mon"
  amount: number;
}

// Human-readable labels for each reward source, used by the UI for badges.
// Additive only — doesn't change how RewardSource itself is produced.
export const REWARD_SOURCE_LABEL: Record<RewardSource, string> = {
  DAILY_CHECK_IN: "Daily",
  STREAK: "Streak",
  LEVEL: "Level",
  REFERRAL: "Referral",
  SEASON: "Season",
};

const STORAGE_PREFIX = "mpgr_rewards_v1_";

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function emptyState(address: string): RewardState {
  return {
    address: address.toLowerCase(),
    claimedRewardIds: [],
    totalClaimed: 0,
    history: [],
  };
}

// --- Storage layer -------------------------------------------------
// Phase 2B swap point: replace get/save bodies with fetch()/contract-claim
// calls to a real API or the rewards contract — same pattern as
// lib/xp-engine.ts's storage layer.

export function getRewardState(address: string): RewardState {
  return readJSON(storageKey(address), emptyState(address));
}

function saveRewardState(state: RewardState) {
  writeJSON(storageKey(state.address), state);
}

// --- Reward definitions ----------------------------------------------
// Every reward derives its unlock condition and progress from data the XP
// engine already tracks (streak, level, referrals, season points). Nothing
// here introduces a new game mechanic — it layers a claimable MPGR value on
// top of signals that already exist, so this module never duplicates
// lib/xp-engine.ts's state.

const todayISO = () => new Date().toISOString().slice(0, 10);

export function getRewardClaims(record: UserXPRecord | null): RewardClaim[] {
  if (!record) return [];

  const level = getLevelProgress(record.xp).level;
  const seasonPoints = getSeasonPoints(record);
  const season = getSeasonNumber();
  const checkedInToday = record.lastCheckIn === todayISO();

  const defs: Omit<RewardClaim, "claimed">[] = [
    {
      id: `checkin-${todayISO()}`,
      source: "DAILY_CHECK_IN",
      title: "Daily Check-In Bonus",
      description: "Claim a small MPGR bonus after today's check-in",
      amount: 5,
      unlocked: checkedInToday,
      progress: checkedInToday ? 1 : 0,
      target: 1,
    },
    {
      id: "streak-7",
      source: "STREAK",
      title: "7-Day Streak Reward",
      description: "Reach a 7-day check-in streak",
      amount: 50,
      unlocked: record.streak >= 7,
      progress: Math.min(record.streak, 7),
      target: 7,
    },
    {
      id: "streak-30",
      source: "STREAK",
      title: "30-Day Streak Reward",
      description: "Reach a 30-day check-in streak",
      amount: 250,
      unlocked: record.streak >= 30,
      progress: Math.min(record.streak, 30),
      target: 30,
    },
    {
      id: "level-5",
      source: "LEVEL",
      title: "Level 5 Reward",
      description: "Reach Level 5",
      amount: 100,
      unlocked: level >= 5,
      progress: Math.min(level, 5),
      target: 5,
    },
    {
      id: "level-10",
      source: "LEVEL",
      title: "Level 10 Reward",
      description: "Reach Level 10",
      amount: 300,
      unlocked: level >= 10,
      progress: Math.min(level, 10),
      target: 10,
    },
    {
      id: "referral-5",
      source: "REFERRAL",
      title: "Referral Milestone",
      description: "Refer 5 friends to MPGR HUB",
      amount: 150,
      unlocked: record.referralCount >= 5,
      progress: Math.min(record.referralCount, 5),
      target: 5,
    },
    {
      id: `season-${season}-250`,
      source: "SEASON",
      title: "Season Milestone · 250",
      description: `Earn 250 season points in Season ${season}`,
      amount: 40,
      unlocked: seasonPoints >= 250,
      progress: Math.min(seasonPoints, 250),
      target: 250,
    },
    {
      id: `season-${season}-1000`,
      source: "SEASON",
      title: "Season Milestone · 1,000",
      description: `Earn 1,000 season points in Season ${season}`,
      amount: 200,
      unlocked: seasonPoints >= 1000,
      progress: Math.min(seasonPoints, 1000),
      target: 1000,
    },
  ];

  const state = getRewardState(record.address);
  return defs.map((d) => ({ ...d, claimed: state.claimedRewardIds.includes(d.id) }));
}

// --- Claim actions -------------------------------------------------------

export function claimReward(address: string, rewardId: string): ClaimResult {
  const record = getUserRecord(address);
  const claims = getRewardClaims(record);
  const target = claims.find((c) => c.id === rewardId);

  if (!target || !target.unlocked || target.claimed) {
    return { claims, claimedAmount: 0, claimedIds: [] };
  }

  const state = getRewardState(address);
  state.claimedRewardIds.push(rewardId);
  state.totalClaimed += target.amount;
  state.history.push({ rewardId, amount: target.amount, timestamp: new Date().toISOString() });
  saveRewardState(state);

  return { claims: getRewardClaims(record), claimedAmount: target.amount, claimedIds: [rewardId] };
}

export function claimAllRewards(address: string): ClaimResult {
  const record = getUserRecord(address);
  const claims = getRewardClaims(record);
  const claimable = claims.filter((c) => c.unlocked && !c.claimed);

  if (claimable.length === 0) {
    return { claims, claimedAmount: 0, claimedIds: [] };
  }

  const state = getRewardState(address);
  let claimedAmount = 0;
  const claimedIds: string[] = [];

  for (const c of claimable) {
    state.claimedRewardIds.push(c.id);
    state.totalClaimed += c.amount;
    state.history.push({ rewardId: c.id, amount: c.amount, timestamp: new Date().toISOString() });
    claimedAmount += c.amount;
    claimedIds.push(c.id);
  }
  saveRewardState(state);

  return { claims: getRewardClaims(record), claimedAmount, claimedIds };
}

// --- Derived stats (read-only, layered on top of claim history) ---------
// Everything below reads existing RewardClaimHistoryEntry data — no new
// storage keys, no schema changes. Pure functions, safe to memoize in hooks.

// Last 7 calendar days (oldest → newest) of claimed MPGR, bucketed by day.
// Powers the "Claimed This Week" chart on the Rewards page.
export function getWeeklyClaimSeries(history: RewardClaimHistoryEntry[]): WeeklyClaimPoint[] {
  const days: WeeklyClaimPoint[] = [];
  const now = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push({
      date: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString("en-US", { weekday: "short" }),
      amount: 0,
    });
  }

  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const entry of history) {
    const point = byDate.get(new Date(entry.timestamp).toISOString().slice(0, 10));
    if (point) point.amount += entry.amount;
  }

  return days;
}

// Sum of claimed MPGR between `daysAgoStart` and `daysAgoEnd` (exclusive of
// end), counting back from now. Used to compare this week vs. last week.
export function getClaimedInWindow(
  history: RewardClaimHistoryEntry[],
  daysAgoStart: number,
  daysAgoEnd: number
): number {
  const now = Date.now();
  const start = now - daysAgoStart * 86_400_000;
  const end = now - daysAgoEnd * 86_400_000;
  return history
    .filter((h) => {
      const t = new Date(h.timestamp).getTime();
      return t >= start && t < end;
    })
    .reduce((sum, h) => sum + h.amount, 0);
}

// Resolves a title/source for a claim-history entry even after its reward
// definition has rotated out of getRewardClaims() (e.g. a previous day's
// check-in id). Falls back to the id prefix, which every reward id in this
// module is namespaced by.
export function inferRewardMeta(
  rewardId: string,
  claims: RewardClaim[]
): { title: string; source: RewardSource } {
  const match = claims.find((c) => c.id === rewardId);
  if (match) return { title: match.title, source: match.source };

  if (rewardId.startsWith("checkin-")) return { title: "Daily Check-In Bonus", source: "DAILY_CHECK_IN" };
  if (rewardId.startsWith("streak-")) return { title: "Streak Reward", source: "STREAK" };
  if (rewardId.startsWith("level-")) return { title: "Level Reward", source: "LEVEL" };
  if (rewardId.startsWith("referral-")) return { title: "Referral Milestone", source: "REFERRAL" };
  if (rewardId.startsWith("season-")) return { title: "Season Milestone", source: "SEASON" };
  return { title: "Reward Claimed", source: "DAILY_CHECK_IN" };
}

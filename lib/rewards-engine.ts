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

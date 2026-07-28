// Season Pass — Phase 2C, Module 2.
//
// Season Level is derived from real Season XP already tracked by
// lib/xp-engine.ts (getSeasonPoints) — no parallel XP system. Premium track
// eligibility is derived from lib/premium-engine.ts (getPremiumStatus),
// which itself derives from Token Lock — so Season Pass never talks to
// Token Lock directly, it goes through the Premium engine, the same
// dependency direction every other module uses.
//
// Claim state is scoped per season number and stored separately from XP/
// Premium/Rewards state, so it naturally resets when a new season starts.

import { getUserRecord, getSeasonPoints, getSeasonNumber, getSeasonEnd, awardXP, type UserXPRecord, type Achievement } from "@/lib/xp-engine";
import { getPremiumStatus, type PremiumTierId } from "@/lib/premium-engine";
import { readJSON, writeJSON } from "@/lib/storage";
import { SEASON_PASS_CONFIG, SEASON_REWARD_TRACK, getRewardNode, type SeasonRewardNode } from "@/lib/season-config";

export type { SeasonRewardNode };

// --- Season level (linear curve over Season XP) ---------------------------

export interface SeasonLevelProgress {
  level: number;
  pointsIntoLevel: number;
  pointsNeededForLevel: number;
  progress: number; // 0-100
  isMaxLevel: boolean;
}

export function getSeasonLevelProgress(seasonPoints: number): SeasonLevelProgress {
  const { maxLevel, pointsPerLevel } = SEASON_PASS_CONFIG;
  const rawLevel = Math.floor(seasonPoints / pointsPerLevel) + 1;
  const level = Math.min(rawLevel, maxLevel);
  const isMaxLevel = level >= maxLevel;
  const floorForLevel = (level - 1) * pointsPerLevel;
  const pointsIntoLevel = isMaxLevel ? pointsPerLevel : seasonPoints - floorForLevel;

  return {
    level,
    pointsIntoLevel,
    pointsNeededForLevel: pointsPerLevel,
    progress: isMaxLevel ? 100 : Math.min(100, Math.round((pointsIntoLevel / pointsPerLevel) * 100)),
    isMaxLevel,
  };
}

// --- Status (derived, never stored) ---------------------------------------

export interface SeasonPassStatus {
  seasonNumber: number;
  seasonEnd: Date;
  seasonPoints: number;
  levelProgress: SeasonLevelProgress;
  isPremium: boolean;
  premiumTier: PremiumTierId;
}

export function getSeasonPassStatus(address: string): SeasonPassStatus {
  const record = getUserRecord(address);
  const seasonPoints = getSeasonPoints(record);
  const premium = getPremiumStatus(address);

  return {
    seasonNumber: getSeasonNumber(),
    seasonEnd: getSeasonEnd(),
    seasonPoints,
    levelProgress: getSeasonLevelProgress(seasonPoints),
    isPremium: premium.isPremium,
    premiumTier: premium.tier,
  };
}

// --- Storage: claim state, scoped per season -------------------------------

const STORAGE_PREFIX = "mpgr_season_pass_v1_";

export interface SeasonPassState {
  address: string;
  seasonNumber: number;
  claimedFreeLevels: number[];
  claimedPremiumLevels: number[];
  claimedMissions: string[];
}

function storageKey(address: string, seasonNumber: number) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}_s${seasonNumber}`;
}

function emptyState(address: string, seasonNumber: number): SeasonPassState {
  return {
    address: address.toLowerCase(),
    seasonNumber,
    claimedFreeLevels: [],
    claimedPremiumLevels: [],
    claimedMissions: [],
  };
}

export function getSeasonPassState(address: string): SeasonPassState {
  const seasonNumber = getSeasonNumber();
  return readJSON(storageKey(address, seasonNumber), emptyState(address, seasonNumber));
}

function saveSeasonPassState(state: SeasonPassState) {
  writeJSON(storageKey(state.address, state.seasonNumber), state);
}

// --- Reward track, merged with claim state ---------------------------------

export interface SeasonTrackNode extends SeasonRewardNode {
  unlocked: boolean;
  freeClaimed: boolean;
  premiumClaimed: boolean;
}

export function getSeasonTrack(status: SeasonPassStatus, state: SeasonPassState): SeasonTrackNode[] {
  return SEASON_REWARD_TRACK.map((node) => ({
    ...node,
    unlocked: status.levelProgress.level >= node.level,
    freeClaimed: state.claimedFreeLevels.includes(node.level),
    premiumClaimed: state.claimedPremiumLevels.includes(node.level),
  }));
}

interface ClaimResult {
  success: boolean;
  error?: string;
  state: SeasonPassState;
}

export function claimFreeReward(address: string, level: number): ClaimResult {
  const status = getSeasonPassStatus(address);
  const state = getSeasonPassState(address);
  const node = getRewardNode(level);

  if (!node || !node.free) return { success: false, error: "No free reward at this level.", state };
  if (status.levelProgress.level < level) return { success: false, error: "Reach this level first.", state };
  if (state.claimedFreeLevels.includes(level)) return { success: false, error: "Already claimed.", state };

  state.claimedFreeLevels.push(level);
  saveSeasonPassState(state);
  // XP-kind rewards reuse the existing XP pipeline instead of inventing new math.
  if (node.free.kind === "xp") awardXP(address, "QUEST_COMPLETED");
  return { success: true, state };
}

export function claimPremiumReward(address: string, level: number): ClaimResult {
  const status = getSeasonPassStatus(address);
  const state = getSeasonPassState(address);
  const node = getRewardNode(level);

  if (!node || !node.premium) return { success: false, error: "No premium reward at this level.", state };
  if (!status.isPremium) return { success: false, error: "Premium required to claim this reward.", state };
  if (status.levelProgress.level < level) return { success: false, error: "Reach this level first.", state };
  if (state.claimedPremiumLevels.includes(level)) return { success: false, error: "Already claimed.", state };

  state.claimedPremiumLevels.push(level);
  saveSeasonPassState(state);
  return { success: true, state };
}

// --- Season Missions --------------------------------------------------------
// Season-scoped bonus tasks derived from data already tracked elsewhere
// (account XP record + season points). Claiming reuses the existing XP
// pipeline ("QUEST_COMPLETED") — no new XP math.

export function getSeasonMissions(record: UserXPRecord, seasonPoints: number, state: SeasonPassState): Achievement[] {
  const claimed = state.claimedMissions;
  const defs: Omit<Achievement, "claimed">[] = [
    {
      id: "mission-season-xp-100",
      title: "Warm Up",
      description: "Earn 100 Season XP",
      unlocked: seasonPoints >= 100,
      progress: Math.min(seasonPoints, 100),
      target: 100,
    },
    {
      id: "mission-season-xp-500",
      title: "On A Roll",
      description: "Earn 500 Season XP",
      unlocked: seasonPoints >= 500,
      progress: Math.min(seasonPoints, 500),
      target: 500,
    },
    {
      id: "mission-streak-5",
      title: "Consistent",
      description: "Reach a 5-day check-in streak",
      unlocked: record.streak >= 5,
      progress: Math.min(record.streak, 5),
      target: 5,
    },
    {
      id: "mission-referral-1",
      title: "Bring a Friend",
      description: "Refer 1 friend this season",
      unlocked: record.referralCount >= 1,
      progress: Math.min(record.referralCount, 1),
      target: 1,
    },
  ];
  return defs.map((d) => ({ ...d, claimed: claimed.includes(d.id) }));
}

export function claimSeasonMission(address: string, missionId: string): SeasonPassState {
  const record = getUserRecord(address);
  const status = getSeasonPassStatus(address);
  const state = getSeasonPassState(address);
  const mission = getSeasonMissions(record, status.seasonPoints, state).find((m) => m.id === missionId);

  if (!mission || !mission.unlocked || state.claimedMissions.includes(missionId)) {
    return state;
  }

  state.claimedMissions.push(missionId);
  saveSeasonPassState(state);
  awardXP(address, "QUEST_COMPLETED");
  return state;
}

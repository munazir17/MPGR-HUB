// lib/holder-tier-engine.ts

// Holder Tier — independent module, standalone from Premium Membership.
//
// Premium (lib/premium-engine.ts)   -> derived ONLY from active Token Lock.
// Holder Tier (this module)         -> derived ONLY from Total Holder Score.
//
// Total Holder Score = Live Wallet MPGR + Active Staked MPGR + Active
// Locked MPGR, each counted at 100% weight. Released locks, withdrawn
// stake, and burned tokens never count — enforced upstream by the
// providers in lib/holder-score-providers.ts, not recomputed here.
//
// This module owns a perk set disjoint from Premium's: no XP multiplier,
// no rewards multiplier (those remain Premium-only). Holder Tier instead
// grants cosmetics, governance voting weight, community reputation,
// leaderboard ranking, holder achievements, and a set of flagged future
// perks (launchpad allocation, airdrop priority, early-access).

import { getWalletBalance, getStakedBalance, getLockedBalance } from "@/lib/holder-score-providers";
import { readJSON, writeJSON } from "@/lib/storage";
import {
  HOLDER_TIERS,
  HOLDER_FEATURE_FLAGS,
  getHolderCosmetics,
  isHolderFeatureEnabled,
  type HolderTierId,
  type HolderTierDef,
  type HolderCosmetics,
} from "@/lib/holder-tier-config";
import type { Achievement } from "@/lib/xp-engine";

export type { HolderTierId, HolderTierDef, HolderCosmetics };
export { HOLDER_TIERS, HOLDER_FEATURE_FLAGS, getHolderCosmetics, isHolderFeatureEnabled };

// --- Holder Score ------------------------------------------------------

export interface HolderScoreBreakdown {
  walletBalance: number;
  stakedBalance: number;
  lockedBalance: number;
  totalScore: number;
}

export function getHolderScoreFromBalances(
  walletBalance: number,
  stakedBalance: number,
  lockedBalance: number
): HolderScoreBreakdown {
  const wallet = Number.isFinite(walletBalance) ? Math.max(0, walletBalance) : 0;
  const staked = Number.isFinite(stakedBalance) ? Math.max(0, stakedBalance) : 0;
  const locked = Number.isFinite(lockedBalance) ? Math.max(0, lockedBalance) : 0;
  return {
    walletBalance: wallet,
    stakedBalance: staked,
    lockedBalance: locked,
    totalScore: wallet + staked + locked,
  };
}

export function getHolderScore(address: string): HolderScoreBreakdown {
  return getHolderScoreFromBalances(
    getWalletBalance(address),
    getStakedBalance(address),
    getLockedBalance(address)
  );
}

// --- Status (derived, never stored) -------------------------------------

export interface HolderTierStatus {
  tier: HolderTierId;
  score: HolderScoreBreakdown;
  currentTierDef: HolderTierDef | null;
  nextTierDef: HolderTierDef | null;
  progressToNextTier: number; // 0-100
  amountToNextTier: number;
  votingWeight: number; // 0 if not holding any tier
  communityReputationScore: number;
  cosmetics: HolderCosmetics | null;
}

export function getHolderTierStatus(address: string, liveScore?: HolderScoreBreakdown): HolderTierStatus {
  const score = liveScore ?? getHolderScore(address);
  const totalScore = score.totalScore;

  const sortedAsc = [...HOLDER_TIERS].sort((a, b) => a.minScore - b.minScore);
  const currentTierDef = [...sortedAsc].reverse().find((t) => totalScore >= t.minScore) ?? null;
  const nextTierDef = sortedAsc.find((t) => totalScore < t.minScore) ?? null;

  const progressToNextTier = nextTierDef
    ? Math.min(100, Math.round((totalScore / nextTierDef.minScore) * 100))
    : 100;
  const amountToNextTier = nextTierDef ? Math.max(0, nextTierDef.minScore - totalScore) : 0;

  const tier: HolderTierId = currentTierDef?.id ?? "none";

  const votingWeight =
    isHolderFeatureEnabled("governanceVotingWeight") && currentTierDef
      ? Math.round(totalScore * currentTierDef.votingWeightMultiplier)
      : 0;

  const communityReputationScore = isHolderFeatureEnabled("communityReputationScore")
    ? Math.round(Math.sqrt(totalScore) * 10 + (currentTierDef?.reputationBonus ?? 0))
    : 0;

  const cosmetics =
    isHolderFeatureEnabled("holderBadge") || isHolderFeatureEnabled("holderFrame")
      ? getHolderCosmetics(tier)
      : null;

  return {
    tier,
    score,
    currentTierDef,
    nextTierDef,
    progressToNextTier,
    amountToNextTier,
    votingWeight,
    communityReputationScore,
    cosmetics,
  };
}

export interface HolderFuturePerks {
  launchpadAllocationEligible: boolean;
  airdropPriorityEligible: boolean;
  earlyAccessEligible: boolean;
}

export function getHolderFuturePerks(status: HolderTierStatus): HolderFuturePerks {
  const holdsAnyTier = status.tier !== "none";
  return {
    launchpadAllocationEligible: isHolderFeatureEnabled("launchpadAllocation") && holdsAnyTier,
    airdropPriorityEligible: isHolderFeatureEnabled("airdropPriority") && holdsAnyTier,
    earlyAccessEligible: isHolderFeatureEnabled("earlyAccessEligibility") && holdsAnyTier,
  };
}

export interface HolderEvent {
  id: string;
  title: string;
  description: string;
  minTier: Exclude<HolderTierId, "none">;
  date: string;
}

const HOLDER_EVENTS: HolderEvent[] = [
  {
    id: "event-ama-bronze",
    title: "Community AMA",
    description: "Monthly AMA with the core team, open to all Holder tiers.",
    minTier: "bronze",
    date: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  },
  {
    id: "event-strategy-gold",
    title: "Tokenomics Deep Dive",
    description: "Closed-door walkthrough of upcoming tokenomics changes.",
    minTier: "gold",
    date: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  },
  {
    id: "event-summit-diamond",
    title: "Diamond Holder Summit",
    description: "Invite-only summit for the top Holder tier.",
    minTier: "diamond",
    date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  },
];

function tierRank(id: HolderTierId): number {
  if (id === "none") return -1;
  return HOLDER_TIERS.findIndex((t) => t.id === id);
}

export function getHolderEvents(status: HolderTierStatus): (HolderEvent & { unlocked: boolean })[] {
  if (!isHolderFeatureEnabled("exclusiveHolderEvents")) return [];
  return HOLDER_EVENTS.map((event) => ({
    ...event,
    unlocked: tierRank(status.tier) >= tierRank(event.minTier),
  }));
}

const STORAGE_PREFIX = "mpgr_holder_tier_v1_";

export interface HolderTierState {
  address: string;
  claimedAchievements: string[];
}

function storageKey(address: string) {
  return `\( {STORAGE_PREFIX} \){address.toLowerCase()}`;
}

function emptyState(address: string): HolderTierState {
  return { address: address.toLowerCase(), claimedAchievements: [] };
}

export function getHolderTierState(address: string): HolderTierState {
  return readJSON(storageKey(address), emptyState(address));
}

function saveHolderTierState(state: HolderTierState) {
  writeJSON(storageKey(state.address), state);
}

export function getHolderAchievements(status: HolderTierStatus, state: HolderTierState): Achievement[] {
  if (!isHolderFeatureEnabled("holderAchievements")) return [];

  const claimed = state.claimedAchievements;
  const score = status.score.totalScore;

  const defs: Omit<Achievement, "claimed">[] = [
    {
      id: "holder-bronze-tier",
      title: "Bronze Holder",
      description: "Reach a Total Holder Score of 1,000 MPGR",
      unlocked: score >= 1_000,
      progress: Math.min(score, 1_000),
      target: 1_000,
    },
    {
      id: "holder-silver-tier",
      title: "Silver Holder",
      description: "Reach a Total Holder Score of 10,000 MPGR",
      unlocked: score >= 10_000,
      progress: Math.min(score, 10_000),
      target: 10_000,
    },
    {
      id: "holder-gold-tier",
      title: "Gold Holder",
      description: "Reach a Total Holder Score of 50,000 MPGR",
      unlocked: score >= 50_000,
      progress: Math.min(score, 50_000),
      target: 50_000,
    },
    {
      id: "holder-platinum-tier",
      title: "Platinum Holder",
      description: "Reach a Total Holder Score of 150,000 MPGR",
      unlocked: score >= 150_000,
      progress: Math.min(score, 150_000),
      target: 150_000,
    },
    {
      id: "holder-diamond-tier",
      title: "Diamond Holder",
      description: "Reach a Total Holder Score of 500,000 MPGR",
      unlocked: score >= 500_000,
      progress: Math.min(score, 500_000),
      target: 500_000,
    },
    {
      id: "holder-diversified",
      title: "Diversified Holder",
      description: "Hold a non-zero balance in wallet, staking, and locking at the same time",
      unlocked: status.score.walletBalance > 0 && status.score.stakedBalance > 0 && status.score.lockedBalance > 0,
      progress:
        [status.score.walletBalance, status.score.stakedBalance, status.score.lockedBalance].filter((v) => v > 0)
          .length,
      target: 3,
    },
  ];

  return defs.map((d) => ({ ...d, claimed: claimed.includes(d.id) }));
}

export function claimHolderAchievement(address: string, achievementId: string, liveScore?: HolderScoreBreakdown): HolderTierState {
  const state = getHolderTierState(address);
  const status = getHolderTierStatus(address, liveScore);
  const achievement = getHolderAchievements(status, state).find((a) => a.id === achievementId);

  if (!achievement || !achievement.unlocked || state.claimedAchievements.includes(achievementId)) {
    return state;
  }

  state.claimedAchievements.push(achievementId);
  saveHolderTierState(state);
  return state;
}

export interface HolderLeaderboardEntry {
  address: string;
  totalScore: number;
  tier: HolderTierId;
  votingWeight: number;
  communityReputationScore: number;
}

export function getHolderLeaderboardEntry(address: string, liveStatus?: HolderTierStatus | null): HolderLeaderboardEntry | null {
  if (!isHolderFeatureEnabled("holderLeaderboard")) return null;
  const status = liveStatus ?? getHolderTierStatus(address);
  return {
    address: address.toLowerCase(),
    totalScore: status.score.totalScore,
    tier: status.tier,
    votingWeight: status.votingWeight,
    communityReputationScore: status.communityReputationScore,
  };
}

export function rankHolderLeaderboard(entries: HolderLeaderboardEntry[]): HolderLeaderboardEntry[] {
  return [...entries].sort((a, b) => b.totalScore - a.totalScore);
}

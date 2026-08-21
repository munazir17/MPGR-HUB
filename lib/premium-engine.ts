// Premium Membership — Phase 2C, Module 1.
//
// Premium is NOT purchased and has NO NFT and NO lock system of its own.
// Tier is derived live, every read, from the connected wallet's on-chain
// Token Lock positions (snapshot written by hooks/useTokenLock.ts). There
// is deliberately no stored "premiumExpiresAt": because tier is recomputed
// from currently-active locked MPGR every time, Premium status ends
// automatically the moment enough locked MPGR is released to drop under
// the tier threshold. No separate expiry logic to keep in sync.
//
// This module owns only what Token Lock/XP/Rewards don't already track:
// Premium-only quest/achievement claims and the Weekly Treasure Box ledger.

import { getCachedWalletLock } from "@/lib/token-lock/token-lock-client";
import { awardXP, XP_ACTIONS, type Achievement } from "@/lib/xp-engine";
import { readJSON, writeJSON } from "@/lib/storage";
import {
  PREMIUM_TIERS,
  PREMIUM_XP_MULTIPLIER,
  PREMIUM_REWARDS_MULTIPLIER,
  TREASURE_BOX_CONFIG,
  type PremiumTierId,
  type PremiumTierDef,
} from "@/lib/premium-config";
import { setPremiumMultiplierProvider } from "@/lib/premium-multiplier-registry";

export type { PremiumTierId, PremiumTierDef };
export { PREMIUM_TIERS };

export interface PremiumStatus {
  tier: PremiumTierId;
  isPremium: boolean;
  activeLocked: number;
  lifetimeLocked: number;
  currentTierDef: PremiumTierDef | null;
  nextTierDef: PremiumTierDef | null;
  progressToNextTier: number;
  amountToNextTier: number;
  nextUnlockAt: string | null;
  xpMultiplier: number;
  rewardsMultiplier: number;
}

export function derivePremiumStatus(input: {
  activeLocked: number;
  lifetimeLocked?: number;
  nextUnlockAt?: string | null;
}): PremiumStatus {
  const activeLocked = Number.isFinite(input.activeLocked) ? Math.max(0, input.activeLocked) : 0;
  const lifetimeLocked =
    input.lifetimeLocked != null && Number.isFinite(input.lifetimeLocked)
      ? Math.max(0, input.lifetimeLocked)
      : activeLocked;

  const sortedAsc = [...PREMIUM_TIERS].sort((a, b) => a.minLocked - b.minLocked);
  const currentTierDef = [...sortedAsc].reverse().find((t) => activeLocked >= t.minLocked) ?? null;
  const nextTierDef = sortedAsc.find((t) => activeLocked < t.minLocked) ?? null;

  const progressToNextTier = nextTierDef
    ? Math.min(100, Math.round((activeLocked / nextTierDef.minLocked) * 100))
    : 100;
  const amountToNextTier = nextTierDef ? Math.max(0, nextTierDef.minLocked - activeLocked) : 0;

  return {
    tier: currentTierDef?.id ?? "none",
    isPremium: !!currentTierDef,
    activeLocked,
    lifetimeLocked,
    currentTierDef,
    nextTierDef,
    progressToNextTier,
    amountToNextTier,
    nextUnlockAt: input.nextUnlockAt ?? null,
    xpMultiplier: currentTierDef ? PREMIUM_XP_MULTIPLIER : 1,
    rewardsMultiplier: currentTierDef ? PREMIUM_REWARDS_MULTIPLIER : 1,
  };
}

export function getPremiumStatus(address: string): PremiumStatus {
  const live = getCachedWalletLock(address);
  if (live) {
    return derivePremiumStatus({
      activeLocked: live.totalLocked,
      lifetimeLocked: live.lifetimeLocked,
      nextUnlockAt: live.nextUnlockAt,
    });
  }
  return derivePremiumStatus({ activeLocked: 0, lifetimeLocked: 0, nextUnlockAt: null });
}

export interface PremiumCosmetics {
  frameClass: string;
  borderGradientClass: string;
}

export function getPremiumCosmetics(tier: PremiumTierId): PremiumCosmetics | null {
  switch (tier) {
    case "diamond":
      return { frameClass: "ring-2 ring-primary-glow shadow-glow-lg", borderGradientClass: "bg-gradient-blue" };
    case "gold":
      return { frameClass: "ring-2 ring-gold shadow-glow-gold-lg", borderGradientClass: "bg-gradient-gold" };
    case "silver":
      return { frameClass: "ring-2 ring-white/40 shadow-soft", borderGradientClass: "bg-gradient-to-br from-gray-200 to-gray-400" };
    default:
      return null;
  }
}

const STORAGE_PREFIX = "mpgr_premium_v1_";

interface TreasureBoxHistoryEntry {
  weekKey: string;
  amount: number;
  timestamp: string;
}

interface TreasureBoxLedger {
  lastClaimedWeekKey: string | null;
  totalClaimed: number;
  claimsCount: number;
  history: TreasureBoxHistoryEntry[];
}

export interface PremiumState {
  address: string;
  claimedQuests: string[];
  claimedAchievements: string[];
  treasureBox: TreasureBoxLedger;
}

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function emptyState(address: string): PremiumState {
  return {
    address: address.toLowerCase(),
    claimedQuests: [],
    claimedAchievements: [],
    treasureBox: { lastClaimedWeekKey: null, totalClaimed: 0, claimsCount: 0, history: [] },
  };
}

export function getPremiumState(address: string): PremiumState {
  return readJSON(storageKey(address), emptyState(address));
}

function savePremiumState(state: PremiumState) {
  writeJSON(storageKey(state.address), state);
}

export function getPremiumQuests(status: PremiumStatus, state: PremiumState): Achievement[] {
  const claimed = state.claimedQuests;
  const defs: Omit<Achievement, "claimed">[] = [
    {
      id: "quest-go-premium",
      title: "Go Premium",
      description: "Reach any Premium tier",
      unlocked: status.isPremium,
      progress: status.isPremium ? 1 : 0,
      target: 1,
    },
    {
      id: "quest-gold-tier",
      title: "Reach Gold Tier",
      description: "Have 50,000 MPGR actively locked",
      unlocked: status.activeLocked >= 50_000,
      progress: Math.min(status.activeLocked, 50_000),
      target: 50_000,
    },
    {
      id: "quest-diamond-tier",
      title: "Reach Diamond Tier",
      description: "Have 100,000 MPGR actively locked",
      unlocked: status.activeLocked >= 100_000,
      progress: Math.min(status.activeLocked, 100_000),
      target: 100_000,
    },
    {
      id: "quest-first-box",
      title: "Open Your First Box",
      description: "Claim a Weekly Premium Treasure Box",
      unlocked: state.treasureBox.claimsCount >= 1,
      progress: Math.min(state.treasureBox.claimsCount, 1),
      target: 1,
    },
    {
      id: "quest-box-collector",
      title: "Box Collector",
      description: "Claim 5 Weekly Premium Treasure Boxes",
      unlocked: state.treasureBox.claimsCount >= 5,
      progress: Math.min(state.treasureBox.claimsCount, 5),
      target: 5,
    },
  ];
  return defs.map((d) => ({ ...d, claimed: claimed.includes(d.id) }));
}

export function claimPremiumQuest(address: string, questId: string): PremiumState {
  const state = getPremiumState(address);
  const status = getPremiumStatus(address);
  const quest = getPremiumQuests(status, state).find((q) => q.id === questId);

  if (!quest || !quest.unlocked || state.claimedQuests.includes(questId)) {
    return state;
  }

  state.claimedQuests.push(questId);
  savePremiumState(state);
  awardXP(address, "QUEST_COMPLETED");
  return state;
}

export function getPremiumAchievements(status: PremiumStatus, state: PremiumState): Achievement[] {
  const claimed = state.claimedAchievements;
  const defs: Omit<Achievement, "claimed">[] = [
    {
      id: "premium-silver-circle",
      title: "Silver Circle",
      description: "Reach Silver tier",
      unlocked: status.activeLocked >= 10_000,
      progress: Math.min(status.activeLocked, 10_000),
      target: 10_000,
    },
    {
      id: "premium-gold-circle",
      title: "Gold Circle",
      description: "Reach Gold tier",
      unlocked: status.activeLocked >= 50_000,
      progress: Math.min(status.activeLocked, 50_000),
      target: 50_000,
    },
    {
      id: "premium-diamond-circle",
      title: "Diamond Circle",
      description: "Reach Diamond tier",
      unlocked: status.activeLocked >= 100_000,
      progress: Math.min(status.activeLocked, 100_000),
      target: 100_000,
    },
    {
      id: "premium-whale-locker",
      title: "Whale Locker",
      description: "Lock 200,000 MPGR lifetime (across all locks, active or released)",
      unlocked: status.lifetimeLocked >= 200_000,
      progress: Math.min(status.lifetimeLocked, 200_000),
      target: 200_000,
    },
    {
      id: "premium-box-veteran",
      title: "Box Veteran",
      description: "Claim 10 Weekly Premium Treasure Boxes",
      unlocked: state.treasureBox.claimsCount >= 10,
      progress: Math.min(state.treasureBox.claimsCount, 10),
      target: 10,
    },
  ];
  return defs.map((d) => ({ ...d, claimed: claimed.includes(d.id) }));
}

export function claimPremiumAchievement(address: string, achievementId: string): PremiumState {
  const state = getPremiumState(address);
  const status = getPremiumStatus(address);
  const achievement = getPremiumAchievements(status, state).find((a) => a.id === achievementId);

  if (!achievement || !achievement.unlocked || state.claimedAchievements.includes(achievementId)) {
    return state;
  }

  state.claimedAchievements.push(achievementId);
  savePremiumState(state);
  return state;
}

function getISOWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

export function canClaimTreasureBox(status: PremiumStatus, state: PremiumState): boolean {
  if (!status.isPremium) return false;
  return state.treasureBox.lastClaimedWeekKey !== getISOWeekKey(new Date());
}

export interface TreasureBoxResult {
  success: boolean;
  error?: string;
  amount?: number;
  state: PremiumState;
}

export function claimTreasureBox(address: string): TreasureBoxResult {
  const state = getPremiumState(address);
  const status = getPremiumStatus(address);

  if (!status.isPremium) {
    return { success: false, error: "Reach a Premium tier to open the Treasure Box.", state };
  }

  const currentWeek = getISOWeekKey(new Date());
  if (state.treasureBox.lastClaimedWeekKey === currentWeek) {
    return { success: false, error: "This week's Treasure Box is already claimed.", state };
  }

  const { rewardMin, rewardMax } = TREASURE_BOX_CONFIG;
  const amount = Math.round(rewardMin + Math.random() * (rewardMax - rewardMin));

  state.treasureBox.lastClaimedWeekKey = currentWeek;
  state.treasureBox.totalClaimed += amount;
  state.treasureBox.claimsCount += 1;
  state.treasureBox.history = [
    { weekKey: currentWeek, amount, timestamp: new Date().toISOString() },
    ...state.treasureBox.history,
  ].slice(0, 20);

  savePremiumState(state);
  return { success: true, amount, state };
}

export function hasEarlyMiniGameAccess(status: PremiumStatus): boolean {
  return status.isPremium;
}

setPremiumMultiplierProvider((address: string) => {
  const status = getPremiumStatus(address);
  return { xpMultiplier: status.xpMultiplier, rewardsMultiplier: status.rewardsMultiplier };
});

export const PREMIUM_QUEST_XP_REWARD = XP_ACTIONS.QUEST_COMPLETED.xp;

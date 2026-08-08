// lib/rewards/providers/legacy-engagement-provider.ts

import type { Address } from "viem";
import { getUserRecord } from "@/lib/xp-engine";
import {
  getRewardClaims,
  getRewardState,
  inferRewardMeta,
  type RewardClaim,
  type RewardSource,
} from "@/lib/rewards-engine";
import { tokenUtils } from "@/lib/token/token-utils";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";
import { REWARD_CATEGORY_METADATA } from "../reward-config";
import type { RewardCategoryKey, RewardCategorySummary, RewardClaimHistoryEntry, RewardProvider } from "../reward-types";

// Phase 3F Part 1 — Legacy Engagement Rewards Providers.
//
// Wraps lib/rewards-engine.ts (the existing local, XP-engine-driven claim
// system that already powers hooks/useRewards.ts and app/rewards/page.tsx)
// as three RewardProvider implementations — "daily", "referral", and
// "season" — instead of duplicating any of its claim/unlock logic.
// lib/rewards-engine.ts itself is completely untouched: this file only
// reads its exported functions and re-shapes the result into
// reward-types.ts's unified, bigint-based shape (amounts here are small
// human-readable numbers, e.g. 50 MPGR — converted to raw 18-decimal
// bigint at this boundary via tokenUtils.parseTokenAmount, the same
// helper lib/staking already uses for the same kind of conversion).
//
// RewardSource "LEVEL" (level-up milestones) is folded into the "daily"
// category alongside "DAILY_CHECK_IN"/"STREAK" — both are outcomes of the
// same day-to-day engagement loop, and no category on the Phase 3F
// roadmap maps to "level" on its own.

function toRaw(amount: number): bigint {
  return tokenUtils.parseTokenAmount(String(amount), MPGR_TOKEN_CONFIG.decimals);
}

const CATEGORY_SOURCES: Record<"daily" | "referral" | "season", RewardSource[]> = {
  daily: ["DAILY_CHECK_IN", "STREAK", "LEVEL"],
  referral: ["REFERRAL"],
  season: ["SEASON"],
};

function buildSummary(category: "daily" | "referral" | "season", address: Address): RewardCategorySummary {
  const record = getUserRecord(address);
  const claims = getRewardClaims(record);
  const sources = CATEGORY_SOURCES[category];
  const relevant = claims.filter((c) => sources.includes(c.source));

  const claimedRaw = relevant.filter((c) => c.claimed).reduce((sum, c) => sum + toRaw(c.amount), 0n);
  const claimableRaw = relevant
    .filter((c) => c.unlocked && !c.claimed)
    .reduce((sum, c) => sum + toRaw(c.amount), 0n);

  return {
    category,
    label: REWARD_CATEGORY_METADATA[category].label,
    isActive: true,
    totalEarnedRaw: claimedRaw + claimableRaw,
    claimedRaw,
    claimableRaw,
  };
}

function buildHistory(
  category: "daily" | "referral" | "season",
  address: Address,
  limit?: number
): RewardClaimHistoryEntry[] {
  const record = getUserRecord(address);
  const claims: RewardClaim[] = getRewardClaims(record);
  const sources = CATEGORY_SOURCES[category];
  const state = getRewardState(address);

  const entries: RewardClaimHistoryEntry[] = state.history
    .map((entry) => {
      const meta = inferRewardMeta(entry.rewardId, claims);
      return { entry, meta };
    })
    .filter(({ meta }) => sources.includes(meta.source))
    .map(({ entry, meta }) => ({
      id: `${entry.rewardId}:${entry.timestamp}`,
      category: category as RewardCategoryKey,
      title: meta.title,
      amountRaw: toRaw(entry.amount),
      timestamp: entry.timestamp,
    }))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return typeof limit === "number" ? entries.slice(0, limit) : entries;
}

function makeLegacyProvider(category: "daily" | "referral" | "season"): RewardProvider {
  return {
    category,
    label: REWARD_CATEGORY_METADATA[category].label,
    async getSummary(address: Address): Promise<RewardCategorySummary> {
      return buildSummary(category, address);
    },
    async getHistory(address: Address, limit?: number): Promise<RewardClaimHistoryEntry[]> {
      return buildHistory(category, address, limit);
    },
  };
}

export const dailyEngagementRewardsProvider = makeLegacyProvider("daily");
export const referralRewardsProvider = makeLegacyProvider("referral");
export const seasonRewardsProvider = makeLegacyProvider("season");

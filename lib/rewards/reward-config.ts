// lib/rewards/reward-config.ts

import type { RewardCategoryKey } from "./reward-types";

// Phase 3F Part 1 — Reward Hub V2 config.
//
// Mirrors the shape of lib/staking/staking-config.ts: cache TTLs, polling
// interval, and page size in one place. REWARD_CATEGORY_METADATA covers
// every category on the roadmap (see reward-types.ts's RewardCategoryKey)
// with static display copy only — label/description, not a live number.
// The treasury allocation figures in docs/REWARDS.md are protocol-level
// budget facts, not a per-wallet reward value, so they're deliberately
// not reproduced here; a category's real per-wallet numbers only ever
// come from its RewardProvider (or from isActive: false when none exists
// yet), never from this static config.

export const REWARD_CATEGORY_METADATA: Record<RewardCategoryKey, { label: string; description: string }> = {
  daily: {
    label: "Daily Rewards",
    description: "Check-in streaks and level milestones.",
  },
  weekly: {
    label: "Weekly Rewards",
    description: "Recurring weekly participation rewards.",
  },
  staking: {
    label: "Staking Rewards",
    description: "MPGR earned from the live staking pool.",
  },
  quest: {
    label: "Quest Rewards",
    description: "On-chain and community quest completions.",
  },
  game: {
    label: "Game Rewards",
    description: "Mini-game and competition payouts.",
  },
  referral: {
    label: "Referral Rewards",
    description: "Rewards for inviting new users.",
  },
  season: {
    label: "Season Rewards",
    description: "Season Pass and XP season milestones.",
  },
  ai: {
    label: "AI Rewards",
    description: "AI Agent task and automation rewards.",
  },
  premium: {
    label: "Premium Rewards",
    description: "Rewards exclusive to Premium membership.",
  },
  airdrop: {
    label: "Airdrop Rewards",
    description: "Future community airdrop allocations.",
  },
};

export const MPGR_REWARDS_CONFIG = {
  // Cache TTL for a category's aggregated summary. Kept close to
  // MPGR_STAKING_CONFIG.stakingReadCacheTtl (12s) since the "staking"
  // category's numbers come from the same source and should feel
  // similarly fresh.
  hubCacheTtl: 12 * 1000,
  // Cache TTL for the merged claim-history feed.
  historyCacheTtl: 20 * 1000,
  // Background refetch cadence while a page using useRewardHub is open,
  // matching MPGR_STAKING_CONFIG.liveReadPollingIntervalMs.
  liveReadPollingIntervalMs: 15 * 1000,
  // Default number of history entries returned per "page".
  historyPageSize: 10,
} as const;

export type MPGRRewardsConfig = typeof MPGR_REWARDS_CONFIG;

// lib/rewards/reward-types.ts

import type { Address, Hash } from "viem";

// Phase 3F Part 1 — Reward Hub V2 shared types.
//
// Mirrors the shape of lib/staking/staking-types.ts: every module in
// lib/rewards/ (providers, reward-service.ts, hooks/useRewardHub.ts)
// shares these definitions instead of each inventing its own, the same
// discipline lib/token and lib/staking already follow.
//
// This is a plug-in architecture: RewardCategoryKey lists every reward
// system the product roadmap names (see the Phase 3F kickoff), but only
// categories with a registered RewardProvider (see
// lib/rewards/providers/index.ts) are considered "active" in
// getSummary()'s isActive flag. Adding a future system (Quest, Game, AI,
// Premium, Airdrop, Weekly) means writing one new file that implements
// RewardProvider and adding it to the registry — nothing in this file,
// reward-service.ts, or useRewardHub.ts needs to change.

export type RewardCategoryKey =
  | "daily"
  | "weekly"
  | "staking"
  | "quest"
  | "game"
  | "referral"
  | "season"
  | "ai"
  | "premium"
  | "airdrop";

// A category's contribution to the hub, as of the last read. Every raw
// amount is 18-decimal MPGR (bigint), matching lib/staking's convention —
// never a plain `number` — so summary math never loses precision and
// never needs a second unit conversion downstream.
export interface RewardCategorySummary {
  category: RewardCategoryKey;
  label: string;
  // False for a category with no registered RewardProvider yet (Part 1:
  // weekly, quest, game, ai, premium, airdrop). The UI must render these
  // as "not yet available" rather than a real zero — isActive is what
  // distinguishes "genuinely nothing earned here" from "this system
  // doesn't exist yet," so nothing gets displayed as a fabricated 0.
  isActive: boolean;
  // Lifetime total = claimedRaw + claimableRaw. Never independently
  // fetched — always exactly the sum of the two fields below.
  totalEarnedRaw: bigint;
  claimedRaw: bigint;
  claimableRaw: bigint;
}

export interface RewardHubSummary {
  totalEarnedRaw: bigint;
  totalClaimedRaw: bigint;
  totalClaimableRaw: bigint;
  categories: RewardCategorySummary[];
}

// One historical claim/payout event, unified across every category's own
// underlying representation (an on-chain RewardPaid log for "staking", a
// local claim-history row for "daily"/"referral"/"season"). txHash is
// present only for entries that came from an on-chain event.
export interface RewardClaimHistoryEntry {
  id: string;
  category: RewardCategoryKey;
  title: string;
  amountRaw: bigint;
  timestamp: string; // ISO
  txHash?: Hash;
}

// The plug-in interface every reward system implements. A provider owns
// exactly one category and knows nothing about any other provider or
// about reward-service.ts's caching/aggregation — same separation
// staking-client.ts keeps from staking-service.ts.
export interface RewardProvider {
  category: RewardCategoryKey;
  label: string;
  getSummary(address: Address): Promise<RewardCategorySummary>;
  getHistory(address: Address, limit?: number): Promise<RewardClaimHistoryEntry[]>;
}

export interface RewardHubCacheEntry {
  summary: RewardHubSummary;
  timestamp: number;
  ttl: number;
}

export interface RewardHistoryCacheEntry {
  entries: RewardClaimHistoryEntry[];
  timestamp: number;
  ttl: number;
}

export type { Address, Hash };

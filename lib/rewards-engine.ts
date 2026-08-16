import { readJSON } from "@/lib/storage";

// --- Types -------------------------------------------------------------

// GAME/QUEST/WEEKLY/BONUS were added for the real on-chain Reward Vault
// module (see lib/reward-vault/) — this module itself never produces
// them; they exist here only so the shared RewardClaimCard UI/label/icon
// maps can render on-chain vault rewards without a parallel type system.
export type RewardSource = "DAILY_CHECK_IN" | "STREAK" | "LEVEL" | "REFERRAL" | "SEASON" | "GAME" | "QUEST" | "WEEKLY" | "BONUS";

// Kept for components/ui/RewardClaimCard.tsx and
// components/ui/OnChainRewardsSection.tsx, which adapt real on-chain
// VaultReward data (lib/reward-vault/reward-vault-types.ts) into this
// shape so the existing card UI can render it without a redesign. This
// module itself no longer produces RewardClaim values — the old local
// mock claim system that used to (checkin/streak/level/referral/season,
// via getRewardClaims()) was removed; see the Reward Vault cleanup note
// near getRewardState() below.
export interface RewardClaim {
  id: string;
  source: RewardSource;
  title: string;
  description: string;
  amount: number;
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

// Human-readable labels for each reward source, used by the UI for badges.
export const REWARD_SOURCE_LABEL: Record<RewardSource, string> = {
  DAILY_CHECK_IN: "Daily",
  STREAK: "Streak",
  LEVEL: "Level",
  REFERRAL: "Referral",
  SEASON: "Season",
  GAME: "Game",
  QUEST: "Quest",
  WEEKLY: "Weekly",
  BONUS: "Bonus",
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
//
// Reward Vault cleanup — this module used to also generate and claim a
// full local/mock reward set (daily check-in bonus, 7/30-day streaks,
// level 5/10 milestones, a referral milestone, and two season-points
// milestones, each with a hardcoded flat MPGR amount) via
// getRewardClaims()/claimReward()/claimAllRewards(), persisted through
// saveRewardState(). Real MPGR reward claiming now happens exclusively
// on-chain via the deployed MPGRRewardVault contract (see
// lib/reward-vault/, hooks/useRewardClaim.ts, and
// components/ui/OnChainRewardsSection.tsx), so all of that mock
// generation/claim logic was removed, along with its only two UI
// consumers: hooks/useRewards.ts and components/ui/RewardTimeline.tsx
// (both deleted) and components/ui/WeeklyRewardCard.tsx (deleted, its
// only data source was the removed getWeeklyClaimSeries()).
//
// getRewardState() itself is kept read-only: lib/staking-engine.ts,
// lib/burn-engine.ts, and lib/token-lock-engine.ts each read
// getRewardState(address).totalClaimed for their own "available
// balance" math, unrelated to the Rewards page. Existing users' stored
// claim history (RewardState.history) is left exactly as previously
// written — nothing new is ever appended to it now that the local claim
// functions are gone, but old entries aren't erased either.
export function getRewardState(address: string): RewardState {
  return readJSON(storageKey(address), emptyState(address));
}

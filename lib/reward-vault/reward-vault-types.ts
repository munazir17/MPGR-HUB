// lib/reward-vault/reward-vault-types.ts

import type { Address, Hash } from "viem";

// Reward Vault Integration — shared types for the real on-chain Reward
// Claim module. Mirrors lib/staking/staking-types.ts's shape so
// reward-vault-client, reward-vault-service, and hooks/useRewardClaim.ts
// share one set of definitions.

// Matches the deployed contract's `enum RewardType` exactly — do not
// reorder, these are the on-chain integer values.
export enum VaultRewardType {
  GAME = 0,
  QUEST = 1,
  WEEKLY = 2,
  SEASON = 3,
  REFERRAL = 4,
  BONUS = 5,
}

// Matches the deployed contract's `enum RewardStatus` exactly.
export enum VaultRewardStatus {
  NONE = 0,
  ALLOCATED = 1,
  CLAIMED = 2,
}

export const VAULT_REWARD_TYPE_LABEL: Record<VaultRewardType, string> = {
  [VaultRewardType.GAME]: "Game",
  [VaultRewardType.QUEST]: "Quest",
  [VaultRewardType.WEEKLY]: "Weekly",
  [VaultRewardType.SEASON]: "Season",
  [VaultRewardType.REFERRAL]: "Referral",
  [VaultRewardType.BONUS]: "Bonus",
};

// Raw on-chain reward, exactly as returned by getReward(rewardId). Raw
// bigint amount is kept separate from any UI-formatted value.
export interface VaultReward {
  rewardId: bigint;
  seasonId: bigint;
  user: Address;
  amount: bigint;
  rewardType: VaultRewardType;
  status: VaultRewardStatus;
  // Derived from isRewardClaimable(rewardId) — never inferred purely from
  // frontend state; always a direct read of the contract's own check.
  isClaimable: boolean;
}

export interface VaultSeason {
  seasonId: bigint;
  startTime: bigint;
  endTime: bigint;
  totalAllocated: bigint;
  totalClaimed: bigint;
  finalized: boolean;
}

export interface VaultWalletCacheEntry {
  rewards: VaultReward[];
  timestamp: number;
  ttl: number;
}

// One of the two wallet-signed actions the on-chain Reward Claim UI can
// submit.
export type VaultActionKind = "claim" | "claimMultiple";

export type VaultActionPhase = "idle" | "simulating" | "pending" | "confirming" | "success" | "error";

export interface VaultActionState {
  phase: VaultActionPhase;
  hash: Hash | null;
  error: string | null;
}

export function idleVaultActionState(): VaultActionState {
  return { phase: "idle", hash: null, error: null };
}

export type { Address, Hash };

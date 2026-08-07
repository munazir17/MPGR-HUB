// lib/staking/staking-types.ts

import type { Address, Hash } from "viem";

// Phase 3E Part 3 — Shared types for the live staking module. Mirrors the
// shape of lib/token/token-types.ts so staking-client, staking-service, and
// hooks/useStaking.ts share one set of definitions instead of each
// inventing their own.

// Pool-wide state — identical for every visitor, independent of the
// connected wallet. Every field is exactly what the contract returned;
// nothing here is derived or recomputed from another field.
export interface StakingGlobalState {
  totalStaked: bigint;
  rewardPoolBalance: bigint;
  currentAPRBps: bigint;
  rewardRate: bigint; // MPGR (raw, 18-decimal) emitted per second, pool-wide
  periodFinish: bigint; // unix seconds
  isPaused: boolean;
  minimumStake: bigint;
  // Phase 3E Part 4 — Live Reward Counter. Both already fetched by
  // stakingClient.getRewardState() as part of the existing Promise.all in
  // stakingService.getGlobalState(); previously read and then discarded.
  // Needed, together with rewardRate/periodFinish above and totalStaked,
  // to reproduce RewardMath.rewardPerToken() exactly on the client — see
  // lib/staking/reward-math.ts.
  rewardPerTokenStored: bigint;
  lastUpdateTime: bigint; // unix seconds
}

// Per-wallet state — the connected user's own position.
export interface StakingWalletState {
  stakedBalance: bigint;
  earnedRewards: bigint;
  allowance: bigint; // current MPGR approval for the staking contract
  // Phase 3E Part 4 — Live Reward Counter. Raw per-account checkpoint
  // values (contract's userRewardPerTokenPaid/rewards mappings) needed,
  // together with stakedBalance above, to reproduce
  // RewardMath.earned() exactly on the client. earnedRewards above is
  // left untouched and remains the authoritative value used for claim
  // eligibility and claim/exit payout amounts — these two fields are
  // additional inputs, not a replacement for it.
  userRewardPerTokenPaid: bigint;
  accruedRewards: bigint;
}

export interface StakingGlobalCacheEntry {
  state: StakingGlobalState;
  timestamp: number;
  ttl: number;
}

export interface StakingWalletCacheEntry {
  state: StakingWalletState;
  timestamp: number;
  ttl: number;
}

// One of the five wallet-signed actions the staking UI can submit.
export type StakingActionKind = "approve" | "stake" | "unstake" | "claim" | "exit";

// Lifecycle of a single submitted action, tracked per-action so submitting
// "claim" doesn't disturb "unstake"'s state and vice versa.
export type StakingActionPhase = "idle" | "simulating" | "pending" | "confirming" | "success" | "error";

export interface StakingActionState {
  phase: StakingActionPhase;
  hash: Hash | null;
  error: string | null;
}

export function idleActionState(): StakingActionState {
  return { phase: "idle", hash: null, error: null };
}

// A live-observed Staked/Unstaked/RewardPaid event for the connected
// wallet, captured via useWatchContractEvent while a staking page is open.
// Session-only — never persisted, never backfilled from history (this app
// has no indexer for the staking contract), so it only ever reflects
// events genuinely seen live. Never used as a substitute for the
// authoritative on-chain balances above.
export interface StakingLiveActivityEntry {
  id: string;
  kind: "Staked" | "Unstaked" | "RewardPaid";
  amount: bigint;
  txHash: Hash;
  observedAt: string;
}

export interface StakingActionResult {
  success: boolean;
  hash?: Hash;
  error?: string;
}

export type { Address };

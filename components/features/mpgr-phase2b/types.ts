// ============================================================================
// MPGR HUB — Phase 2B Part 1 — Shared Types
// Reward Claim · Staking · Token Lock
// ============================================================================

export type TxState = "idle" | "pending" | "confirming" | "success" | "error";

export interface TxResult {
  hash?: `0x${string}`;
  state: TxState;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Reward Claim
// ---------------------------------------------------------------------------

export interface ClaimableReward {
  id: string;
  label: string;
  amount: number;
  source: "check-in" | "referral" | "season" | "staking" | "bonus";
  availableAt: string; // ISO date
}

export interface ClaimHistoryItem {
  id: string;
  amount: number;
  date: string; // ISO date
  txHash: `0x${string}`;
  status: "confirmed" | "pending" | "failed";
}

export interface RewardClaimSnapshot {
  totalClaimable: number;
  rewards: ClaimableReward[];
  history: ClaimHistoryItem[];
}

// ---------------------------------------------------------------------------
// Staking
// ---------------------------------------------------------------------------

export interface StakingPool {
  id: string;
  name: string;
  aprPercent: number;
  lockDays: number;
  minStake: number;
}

export interface StakingPosition {
  poolId: string;
  staked: number;
  pendingRewards: number;
  stakedAt: string; // ISO date
  unlocksAt: string; // ISO date
}

export interface StakingSnapshot {
  walletBalance: number;
  pools: StakingPool[];
  positions: StakingPosition[];
  history: { date: string; totalStaked: number }[];
}

// ---------------------------------------------------------------------------
// Token Lock
// ---------------------------------------------------------------------------

export type LockDurationDays = 30 | 90 | 180 | 365;

export interface TokenLockPosition {
  id: string;
  amount: number;
  durationDays: LockDurationDays;
  lockedAt: string; // ISO date
  unlocksAt: string; // ISO date
  status: "locked" | "unlockable" | "withdrawn";
}

export interface TokenLockSnapshot {
  walletBalance: number;
  locks: TokenLockPosition[];
}

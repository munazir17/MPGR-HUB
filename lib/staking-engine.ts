import { getRewardState } from "@/lib/rewards-engine";
import { readJSON, writeJSON } from "@/lib/storage";

// --- Types ---------------------------------------------------------------

export type LockDurationDays = 30 | 90 | 180 | 365;

export interface LockOption {
  days: LockDurationDays;
  label: string;
  apy: number; // Mock APY %. Phase 2B swap point: once the staking contract
  // exists, this is read from chain instead of a static table.
}

export type StakingPositionStatus = "active" | "unlocked" | "unstaked";

export interface StakingPosition {
  id: string;
  amount: number;
  lockDurationDays: LockDurationDays;
  apy: number;
  startedAt: string;
  unlocksAt: string;
  claimedRewards: number;
  status: StakingPositionStatus;
}

export interface StakingPositionView extends StakingPosition {
  claimableReward: number; // accrued reward not yet claimed, as of now
  isUnlocked: boolean;
  progress: number; // 0-100, how far through the lock term
  daysRemaining: number;
}

export type StakingTransactionType = "stake" | "unstake" | "claim";

export interface StakingTransaction {
  id: string;
  type: StakingTransactionType;
  amount: number;
  positionId: string;
  timestamp: string;
}

export interface StakingState {
  address: string;
  positions: StakingPosition[];
  transactions: StakingTransaction[];
}

export interface StakingActionResult {
  success: boolean;
  error?: string;
  amount?: number; // amount moved by this action (staked / unstaked / claimed)
  state: StakingState;
}

// --- Storage layer ---------------------------------------------------
// Phase 2B swap point: replace get/save bodies with fetch()/contract calls
// to a real API or the staking contract — same pattern as
// lib/xp-engine.ts and lib/rewards-engine.ts.

const STORAGE_PREFIX = "mpgr_staking_v1_";

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function emptyState(address: string): StakingState {
  return {
    address: address.toLowerCase(),
    positions: [],
    transactions: [],
  };
}

export function getStakingState(address: string): StakingState {
  return readJSON(storageKey(address), emptyState(address));
}

function saveStakingState(state: StakingState) {
  writeJSON(storageKey(state.address), state);
}

// --- Lock durations & APY table ------------------------------------------
// Mock rates. Phase 2B swap point: once the staking contract exists, APY
// per duration is read from chain instead of this static table.

export const LOCK_OPTIONS: LockOption[] = [
  { days: 30, label: "30 Days", apy: 8 },
  { days: 90, label: "90 Days", apy: 14 },
  { days: 180, label: "180 Days", apy: 22 },
  { days: 365, label: "365 Days", apy: 32 },
];

export function getLockOption(days: LockDurationDays): LockOption {
  return LOCK_OPTIONS.find((o) => o.days === days) ?? LOCK_OPTIONS[0];
}

// --- Balance --------------------------------------------------------------
// Available-to-stake balance is derived, not stored twice: it's whatever the
// user has claimed via the Reward Claim Center (Module 1), minus whatever is
// currently staked (not yet unstaked). Reads lib/rewards-engine.ts's state —
// never writes to it, so Module 1's storage stays the single source of truth
// for lifetime claimed MPGR.

export function getTotalStaked(state: StakingState): number {
  return state.positions
    .filter((p) => p.status !== "unstaked")
    .reduce((sum, p) => sum + p.amount, 0);
}

export function getAvailableBalance(address: string): number {
  const claimed = getRewardState(address).totalClaimed;
  const staked = getTotalStaked(getStakingState(address));
  return Math.max(0, claimed - staked);
}

// --- Reward math -----------------------------------------------------------

function estimateFullTermReward(amount: number, lockDurationDays: LockDurationDays): number {
  const apy = getLockOption(lockDurationDays).apy;
  return amount * (apy / 100) * (lockDurationDays / 365);
}

export function estimateRewards(amount: number, lockDurationDays: LockDurationDays): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return estimateFullTermReward(amount, lockDurationDays);
}

function toView(position: StakingPosition, now: number): StakingPositionView {
  const start = new Date(position.startedAt).getTime();
  const end = new Date(position.unlocksAt).getTime();
  const totalMs = Math.max(1, end - start);
  const elapsedMs = Math.min(Math.max(0, now - start), totalMs);
  const progress = Math.round((elapsedMs / totalMs) * 100);
  const isUnlocked = now >= end;

  const fullTermReward = estimateFullTermReward(position.amount, position.lockDurationDays);
  const accrued = fullTermReward * (elapsedMs / totalMs);
  const claimableReward =
    position.status === "unstaked" ? 0 : Math.max(0, accrued - position.claimedRewards);

  const daysRemaining = Math.max(0, Math.ceil((end - now) / 86_400_000));

  return { ...position, claimableReward, isUnlocked, progress, daysRemaining };
}

export function getStakingPositions(address: string): StakingPositionView[] {
  const state = getStakingState(address);
  const now = Date.now();
  return [...state.positions]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .map((p) => toView(p, now));
}

// --- Actions ---------------------------------------------------------------

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function stake(
  address: string,
  amount: number,
  lockDurationDays: LockDurationDays
): StakingActionResult {
  const state = getStakingState(address);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: "Enter an amount greater than 0.", state };
  }

  const available = getAvailableBalance(address);
  if (amount > available) {
    return { success: false, error: "Amount exceeds your available MPGR balance.", state };
  }

  const apy = getLockOption(lockDurationDays).apy;
  const startedAt = new Date();
  const unlocksAt = new Date(startedAt.getTime() + lockDurationDays * 86_400_000);

  const position: StakingPosition = {
    id: makeId("stake"),
    amount,
    lockDurationDays,
    apy,
    startedAt: startedAt.toISOString(),
    unlocksAt: unlocksAt.toISOString(),
    claimedRewards: 0,
    status: "active",
  };

  state.positions.push(position);
  state.transactions.push({
    id: makeId("tx"),
    type: "stake",
    amount,
    positionId: position.id,
    timestamp: startedAt.toISOString(),
  });
  saveStakingState(state);

  return { success: true, amount, state };
}

export function claimStakingReward(address: string, positionId: string): StakingActionResult {
  const state = getStakingState(address);
  const position = state.positions.find((p) => p.id === positionId);

  if (!position) {
    return { success: false, error: "Staking position not found.", state };
  }
  if (position.status === "unstaked") {
    return { success: false, error: "This position has already been unstaked.", state };
  }

  const view = toView(position, Date.now());
  if (view.claimableReward <= 0) {
    return { success: false, error: "No rewards available to claim yet.", state };
  }

  position.claimedRewards += view.claimableReward;
  if (view.isUnlocked) position.status = "unlocked";

  state.transactions.push({
    id: makeId("tx"),
    type: "claim",
    amount: view.claimableReward,
    positionId: position.id,
    timestamp: new Date().toISOString(),
  });
  saveStakingState(state);

  return { success: true, amount: view.claimableReward, state };
}

export function unstake(address: string, positionId: string): StakingActionResult {
  const state = getStakingState(address);
  const position = state.positions.find((p) => p.id === positionId);

  if (!position) {
    return { success: false, error: "Staking position not found.", state };
  }
  if (position.status === "unstaked") {
    return { success: false, error: "This position has already been unstaked.", state };
  }

  const now = Date.now();
  const view = toView(position, now);
  if (!view.isUnlocked) {
    return {
      success: false,
      error: `Still locked — ${view.daysRemaining} day${view.daysRemaining === 1 ? "" : "s"} remaining.`,
      state,
    };
  }

  // Auto-claim any remaining unclaimed reward as part of unstaking, then
  // return principal + that reward as a single payout.
  const finalReward = view.claimableReward;
  position.claimedRewards += finalReward;
  position.status = "unstaked";

  const payout = position.amount + finalReward;

  state.transactions.push({
    id: makeId("tx"),
    type: "unstake",
    amount: payout,
    positionId: position.id,
    timestamp: new Date().toISOString(),
  });
  saveStakingState(state);

  return { success: true, amount: payout, state };
}

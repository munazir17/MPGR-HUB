import { getRewardState } from "@/lib/rewards-engine";
import { getTokenLockState, getTotalLocked } from "@/lib/token-lock-engine";
import { readJSON, writeJSON } from "@/lib/storage";
import {
  BURN_ADDRESS,
  BURN_TOTAL_SUPPLY,
  COMMUNITY_BURN_GOAL,
  buildAchievements,
  buildMilestones,
  sumInWindow,
} from "@/lib/burn-utils";
import type {
  BurnActionResult,
  BurnAchievement,
  BurnDashboardStats,
  BurnImpactPreview,
  BurnLeaderboardEntry,
  BurnMilestone,
  BurnState,
  BurnTransaction,
  PreparedBurnTransaction,
} from "@/lib/burn-types";

// Burn Portal — Phase 2B, Module 3. Same storage/action pattern as
// lib/token-lock-engine.ts. Burning is permanent: unlike a lock, there is
// no "release" path back — burned MPGR is deducted from available balance
// forever via getAvailableBalance below.

const STORAGE_PREFIX = "mpgr_burn_v1_";

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function emptyState(address: string): BurnState {
  return { address: address.toLowerCase(), transactions: [], totalBurned: 0 };
}

export function getBurnState(address: string): BurnState {
  return readJSON(storageKey(address), emptyState(address));
}

function saveBurnState(state: BurnState) {
  writeJSON(storageKey(state.address), state);
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Balance -------------------------------------------------------------
// Reuses Token Lock's own exports rather than re-deriving "how much is
// locked" here — single source of truth for what a wallet has committed
// elsewhere in MPGR HUB.

export function getAvailableBalance(address: string): number {
  const claimed = getRewardState(address).totalClaimed;
  const locked = getTotalLocked(getTokenLockState(address));
  const burned = getBurnState(address).totalBurned;
  return Math.max(0, claimed - locked - burned);
}

// --- Pure calculation helpers ---------------------------------------------
// Exported individually so BurnCard/BurnImpact can drive live "while typing"
// previews without needing a submitted transaction.

export function calculateBurnPercentage(totalBurned: number, totalSupply: number = BURN_TOTAL_SUPPLY): number {
  if (totalSupply <= 0) return 0;
  return Math.round((totalBurned / totalSupply) * 10000) / 100; // 2 decimal places
}

export function calculateSupply(totalSupply: number, totalBurned: number): number {
  return Math.max(0, totalSupply - totalBurned);
}

export function calculateCommunityProgress(contribution: number, goal: number = COMMUNITY_BURN_GOAL): number {
  if (goal <= 0) return 0;
  return Math.min(100, Math.round((contribution / goal) * 100));
}

export function estimateRemainingBalance(availableBalance: number, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return availableBalance;
  return Math.max(0, availableBalance - amount);
}

export function estimateSupplyImpact(
  currentTotalBurned: number,
  amount: number,
  totalSupply: number = BURN_TOTAL_SUPPLY
): BurnImpactPreview {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const currentSupply = calculateSupply(totalSupply, currentTotalBurned);
  const supplyAfterBurn = calculateSupply(totalSupply, currentTotalBurned + safeAmount);

  return {
    currentSupply,
    supplyAfterBurn,
    tokensRemoved: safeAmount,
    burnPercentageBefore: calculateBurnPercentage(currentTotalBurned, totalSupply),
    burnPercentageAfter: calculateBurnPercentage(currentTotalBurned + safeAmount, totalSupply),
    yourTotalBurnedAfter: currentTotalBurned + safeAmount,
  };
}

// Builds the payload a real Base burn transaction will eventually need.
// Phase 2B swap point: pass this straight into wagmi's writeContract as
// the `args`/`value` — no reshaping required.
export function prepareTransaction(address: string, amount: number): PreparedBurnTransaction {
  return {
    from: address.toLowerCase(),
    amount,
    to: BURN_ADDRESS,
    memo: "MPGR HUB Burn Portal",
  };
}

// --- Actions ---------------------------------------------------------------

export function burnTokens(address: string, amount: number): BurnActionResult {
  const state = getBurnState(address);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: "Enter an amount greater than 0.", state };
  }

  const available = getAvailableBalance(address);
  if (amount > available) {
    return { success: false, error: "Amount exceeds your available MPGR balance.", state };
  }

  const transaction: BurnTransaction = {
    id: makeId("burn"),
    address: address.toLowerCase(),
    amount,
    timestamp: new Date().toISOString(),
    status: "confirmed", // Phase 2B swap point: "pending" until the tx receipt confirms on Base
  };

  state.transactions.unshift(transaction);
  state.totalBurned += amount;
  saveBurnState(state);

  return { success: true, amount, state };
}

// --- Derived read-only stats -----------------------------------------------

export function getBurnDashboardStats(state: BurnState): BurnDashboardStats {
  const confirmed = state.transactions.filter((t) => t.status === "confirmed");
  const totalBurned = state.totalBurned;

  const burnedToday = sumInWindow(confirmed, 1, 0);
  const burnedThisWeek = sumInWindow(confirmed, 7, 0);
  const burnedThisMonth = sumInWindow(confirmed, 30, 0);

  const largestBurn = confirmed.reduce((max, t) => Math.max(max, t.amount), 0);
  const averageBurn = confirmed.length === 0 ? 0 : totalBurned / confirmed.length;

  return {
    totalBurned,
    burnedToday,
    burnedThisWeek,
    burnedThisMonth,
    remainingSupply: calculateSupply(BURN_TOTAL_SUPPLY, totalBurned),
    burnPercentage: calculateBurnPercentage(totalBurned),
    totalTransactions: confirmed.length,
    averageBurn,
    largestBurn,
    communityBurnGoal: COMMUNITY_BURN_GOAL,
    communityBurnProgress: calculateCommunityProgress(totalBurned),
  };
}

export function getBurnMilestones(totalBurned: number): BurnMilestone[] {
  return buildMilestones(totalBurned);
}

export function getBurnAchievements(state: BurnState): BurnAchievement[] {
  return buildAchievements(state.transactions, state.totalBurned);
}

// Rank is always 1 — see the type-level comment in burn-types.ts. Returns
// an empty array when there's nothing to show yet so the UI can render its
// own EmptyState instead of a fake single row.
export function getBurnLeaderboard(address: string, totalBurned: number): BurnLeaderboardEntry[] {
  if (totalBurned <= 0) return [];
  return [
    {
      rank: 1,
      address: address.toLowerCase(),
      totalBurned,
      contributionPercent: calculateBurnPercentage(totalBurned),
      isCurrentUser: true,
    },
  ];
}

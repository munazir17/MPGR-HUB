import { getRewardState } from "@/lib/rewards-engine";
import { readJSON, writeJSON } from "@/lib/storage";

// Token Lock — Phase 2B, Module 2B.
// Deliberately isolated from lib/staking-engine.ts: Token Lock is a
// separate product surface (fixed-term lock + maturity bonus, no ongoing
// yield accrual, optional early-exit penalty) with its own storage
// namespace, its own transaction log, and its own available-balance
// accounting. Phase 2B swap point: once the lock contract exists on Base,
// every function below swaps its body for a contract read/write while the
// exported types and shapes stay the same, so no UI changes are needed.

// --- Types -----------------------------------------------------------------

export type LockPeriodDays = 30 | 90 | 180 | 365;

export interface LockDurationOption {
  days: LockPeriodDays;
  label: string;
  bonusPercent: number; // Flat maturity bonus for the full term (not an APY).
}

// Stored status only distinguishes "still ours" vs "withdrawn". The
// user-facing Locked / Unlocking Soon / Unlocked / Released status is
// always derived from time in `toView`, never trusted from storage.
export type TokenLockStoredStatus = "active" | "released";

export type TokenLockDisplayStatus = "locked" | "unlocking_soon" | "unlocked" | "released";

export interface TokenLockPosition {
  id: string;
  amount: number;
  lockPeriodDays: LockPeriodDays;
  bonusPercent: number;
  lockedAt: string;
  unlocksAt: string;
  releasedAt: string | null;
  wasEarlyUnlock: boolean;
  storedStatus: TokenLockStoredStatus;
}

export interface TokenLockPositionView extends TokenLockPosition {
  status: TokenLockDisplayStatus;
  progress: number; // 0-100 through the lock term
  daysRemaining: number;
  isUnlocked: boolean;
  isUnlockingSoon: boolean;
  estimatedBonus: number; // full-term bonus, paid out only on normal release
  payoutIfReleasedNow: number; // what the user would receive right now
}

export type TokenLockTransactionType = "lock" | "release" | "early_unlock";

export interface TokenLockTransaction {
  id: string;
  type: TokenLockTransactionType;
  amount: number;
  positionId: string;
  lockPeriodDays: LockPeriodDays;
  timestamp: string;
}

export interface TokenLockState {
  address: string;
  positions: TokenLockPosition[];
  transactions: TokenLockTransaction[];
}

export interface TokenLockActionResult {
  success: boolean;
  error?: string;
  amount?: number; // amount moved by this action (locked / released / penalized payout)
  state: TokenLockState;
}

export interface TokenLockSummary {
  totalLocked: number;
  activeLocksCount: number;
  unlockingSoonCount: number;
  averageLockPeriodDays: number;
  longestLockDays: number;
  upcomingUnlockAt: string | null;
}

// --- Storage layer -----------------------------------------------------
// Same SSR-safe localStorage helper the rest of Phase 2B uses.

const STORAGE_PREFIX = "mpgr_token_lock_v1_";

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function emptyState(address: string): TokenLockState {
  return {
    address: address.toLowerCase(),
    positions: [],
    transactions: [],
  };
}

export function getTokenLockState(address: string): TokenLockState {
  return readJSON(storageKey(address), emptyState(address));
}

function saveTokenLockState(state: TokenLockState) {
  writeJSON(storageKey(state.address), state);
}

// --- Lock durations & bonus table -------------------------------------------
// Mock rates. Phase 2B swap point: once the lock contract exists, bonus per
// duration is read from chain instead of this static table.

export const LOCK_DURATION_OPTIONS: LockDurationOption[] = [
  { days: 30, label: "30 Days", bonusPercent: 5 },
  { days: 90, label: "90 Days", bonusPercent: 12 },
  { days: 180, label: "180 Days", bonusPercent: 20 },
  { days: 365, label: "365 Days", bonusPercent: 35 },
];

export function getLockDurationOption(days: LockPeriodDays): LockDurationOption {
  return LOCK_DURATION_OPTIONS.find((o) => o.days === days) ?? LOCK_DURATION_OPTIONS[0];
}

export const UNLOCKING_SOON_THRESHOLD_DAYS = 3;
export const EARLY_UNLOCK_PENALTY_PERCENT = 15;

// --- Balance -----------------------------------------------------------
// Same pattern as lib/staking-engine.ts: available-to-lock balance is
// derived from Module 1's claimed MPGR minus whatever this module
// currently has locked (never-released positions). Token Lock never
// writes to the rewards state — it only reads it.

export function getTotalLocked(state: TokenLockState): number {
  return state.positions
    .filter((p) => p.storedStatus !== "released")
    .reduce((sum, p) => sum + p.amount, 0);
}

export function getAvailableBalance(address: string): number {
  const claimed = getRewardState(address).totalClaimed;
  const locked = getTotalLocked(getTokenLockState(address));
  return Math.max(0, claimed - locked);
}

// --- Bonus math --------------------------------------------------------

export function estimateLockBonus(amount: number, lockPeriodDays: LockPeriodDays): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const { bonusPercent } = getLockDurationOption(lockPeriodDays);
  return amount * (bonusPercent / 100);
}

function toView(position: TokenLockPosition, now: number): TokenLockPositionView {
  const start = new Date(position.lockedAt).getTime();
  const end = new Date(position.unlocksAt).getTime();
  const totalMs = Math.max(1, end - start);
  const elapsedMs = Math.min(Math.max(0, now - start), totalMs);
  const progress = Math.round((elapsedMs / totalMs) * 100);
  const daysRemaining = Math.max(0, Math.ceil((end - now) / 86_400_000));

  const isReleased = position.storedStatus === "released";
  const isUnlocked = !isReleased && now >= end;
  const isUnlockingSoon = !isReleased && !isUnlocked && daysRemaining <= UNLOCKING_SOON_THRESHOLD_DAYS;

  const status: TokenLockDisplayStatus = isReleased
    ? "released"
    : isUnlocked
      ? "unlocked"
      : isUnlockingSoon
        ? "unlocking_soon"
        : "locked";

  const estimatedBonus = isReleased ? 0 : estimateLockBonus(position.amount, position.lockPeriodDays);

  let payoutIfReleasedNow = 0;
  if (!isReleased) {
    payoutIfReleasedNow = isUnlocked
      ? position.amount + estimatedBonus
      : position.amount * (1 - EARLY_UNLOCK_PENALTY_PERCENT / 100);
  }

  return {
    ...position,
    status,
    progress,
    daysRemaining,
    isUnlocked,
    isUnlockingSoon,
    estimatedBonus,
    payoutIfReleasedNow,
  };
}

export function getTokenLockPositions(address: string): TokenLockPositionView[] {
  const state = getTokenLockState(address);
  const now = Date.now();
  return [...state.positions]
    .sort((a, b) => new Date(b.lockedAt).getTime() - new Date(a.lockedAt).getTime())
    .map((p) => toView(p, now));
}

export function getTokenLockSummary(positions: TokenLockPositionView[]): TokenLockSummary {
  const active = positions.filter((p) => p.status !== "released");
  const totalLocked = active.reduce((sum, p) => sum + p.amount, 0);
  const activeLocksCount = active.length;
  const unlockingSoonCount = positions.filter((p) => p.status === "unlocking_soon").length;

  const averageLockPeriodDays =
    active.length === 0
      ? 0
      : Math.round(active.reduce((sum, p) => sum + p.lockPeriodDays, 0) / active.length);

  const longestLockDays = positions.reduce((max, p) => Math.max(max, p.lockPeriodDays), 0);

  const upcoming = active
    .filter((p) => p.status === "locked" || p.status === "unlocking_soon")
    .sort((a, b) => new Date(a.unlocksAt).getTime() - new Date(b.unlocksAt).getTime())[0];

  return {
    totalLocked,
    activeLocksCount,
    unlockingSoonCount,
    averageLockPeriodDays,
    longestLockDays,
    upcomingUnlockAt: upcoming ? upcoming.unlocksAt : null,
  };
}

// --- Actions -----------------------------------------------------------

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createLock(
  address: string,
  amount: number,
  lockPeriodDays: LockPeriodDays
): TokenLockActionResult {
  const state = getTokenLockState(address);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: "Enter an amount greater than 0.", state };
  }

  const available = getAvailableBalance(address);
  if (amount > available) {
    return { success: false, error: "Amount exceeds your available MPGR balance.", state };
  }

  const { bonusPercent } = getLockDurationOption(lockPeriodDays);
  const lockedAt = new Date();
  const unlocksAt = new Date(lockedAt.getTime() + lockPeriodDays * 86_400_000);

  const position: TokenLockPosition = {
    id: makeId("lock"),
    amount,
    lockPeriodDays,
    bonusPercent,
    lockedAt: lockedAt.toISOString(),
    unlocksAt: unlocksAt.toISOString(),
    releasedAt: null,
    wasEarlyUnlock: false,
    storedStatus: "active",
  };

  state.positions.push(position);
  state.transactions.push({
    id: makeId("tx"),
    type: "lock",
    amount,
    positionId: position.id,
    lockPeriodDays,
    timestamp: lockedAt.toISOString(),
  });
  saveTokenLockState(state);

  return { success: true, amount, state };
}

export function releaseLock(address: string, lockId: string): TokenLockActionResult {
  const state = getTokenLockState(address);
  const position = state.positions.find((p) => p.id === lockId);

  if (!position) {
    return { success: false, error: "Lock position not found.", state };
  }
  if (position.storedStatus === "released") {
    return { success: false, error: "This lock has already been released.", state };
  }

  const view = toView(position, Date.now());
  if (!view.isUnlocked) {
    return {
      success: false,
      error: `Still locked — ${view.daysRemaining} day${view.daysRemaining === 1 ? "" : "s"} remaining. Use Early Unlock to withdraw now.`,
      state,
    };
  }

  const payout = position.amount + view.estimatedBonus;
  position.storedStatus = "released";
  position.releasedAt = new Date().toISOString();
  position.wasEarlyUnlock = false;

  state.transactions.push({
    id: makeId("tx"),
    type: "release",
    amount: payout,
    positionId: position.id,
    lockPeriodDays: position.lockPeriodDays,
    timestamp: position.releasedAt,
  });
  saveTokenLockState(state);

  return { success: true, amount: payout, state };
}

export function earlyUnlockLock(address: string, lockId: string): TokenLockActionResult {
  const state = getTokenLockState(address);
  const position = state.positions.find((p) => p.id === lockId);

  if (!position) {
    return { success: false, error: "Lock position not found.", state };
  }
  if (position.storedStatus === "released") {
    return { success: false, error: "This lock has already been released.", state };
  }

  const now = Date.now();
  const view = toView(position, now);
  if (view.isUnlocked) {
    return {
      success: false,
      error: "This lock has already matured — use Release instead of Early Unlock.",
      state,
    };
  }

  // Early exit forfeits the maturity bonus entirely and applies a flat
  // penalty to the principal.
  const payout = position.amount * (1 - EARLY_UNLOCK_PENALTY_PERCENT / 100);
  position.storedStatus = "released";
  position.releasedAt = new Date(now).toISOString();
  position.wasEarlyUnlock = true;

  state.transactions.push({
    id: makeId("tx"),
    type: "early_unlock",
    amount: payout,
    positionId: position.id,
    lockPeriodDays: position.lockPeriodDays,
    timestamp: position.releasedAt,
  });
  saveTokenLockState(state);

  return { success: true, amount: payout, state };
  }

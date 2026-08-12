// lib/token-lock/token-lock-types.ts

import type { Address, Hash } from "viem";

// Shared types for the live Token Lock module. Mirrors the shape of
// lib/staking/staking-types.ts so token-lock-client, useTokenLock, and the
// Token Lock UI share one set of definitions instead of each inventing
// their own.

// --- Raw on-chain lock (exactly the deployed getLock() return tuple) -----

export interface TokenLockPosition {
  id: bigint;
  amount: bigint; // raw, 18-decimal MPGR
  unlockTime: bigint; // unix seconds
  withdrawn: boolean;
  owner: Address;
}

// Status vocabulary matches the contract's own getLockStatus() strings
// ("Locked" / "Unlocked" / "Withdrawn") plus one client-only refinement
// ("unlocking_soon") used purely for a UI badge — never trusted as
// on-chain truth, always re-derived from unlockTime/withdrawn.
export type TokenLockDisplayStatus = "locked" | "unlocking_soon" | "unlocked" | "withdrawn";

export interface TokenLockPositionView extends TokenLockPosition {
  status: TokenLockDisplayStatus;
  daysRemaining: number;
  isUnlocked: boolean;
  isUnlockingSoon: boolean;
  amountFormatted: number;
  // Preview-only figures for the Early Unlock modal, computed from the
  // known on-chain constant (10% — see MPGR_TOKEN_LOCK_CONFIG's comment).
  // Never used to decide or move funds; the contract alone executes the
  // actual split when earlyUnlock() is called.
  earlyUnlockPenaltyPreview: number;
  earlyUnlockPayoutPreview: number;
}

// --- Wallet-signed actions -------------------------------------------------

export type TokenLockActionKind = "approve" | "createLock" | "withdraw" | "earlyUnlock";

export type TokenLockActionPhase = "idle" | "simulating" | "pending" | "confirming" | "success" | "error";

export interface TokenLockActionState {
  phase: TokenLockActionPhase;
  hash: Hash | null;
  error: string | null;
}

export function idleActionState(): TokenLockActionState {
  return { phase: "idle", hash: null, error: null };
}

// A live-observed LockCreated/LockWithdrawn/EarlyUnlocked event for the
// connected wallet, captured via useWatchContractEvent while the Token
// Lock page is open. Session-only — never persisted, never backfilled
// from history. Never used as a substitute for the authoritative on-chain
// reads above.
export interface TokenLockLiveActivityEntry {
  id: string;
  kind: "LockCreated" | "LockWithdrawn" | "EarlyUnlocked";
  amount: bigint;
  txHash: Hash;
  observedAt: string;
}

export type { Address, Hash };


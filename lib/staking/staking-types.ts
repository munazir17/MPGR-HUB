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
}

// Per-wallet state — the connected user's own position.
export interface StakingWalletState {
  stakedBalance: bigint;
  earnedRewards: bigint;
  allowance: bigint; // current MPGR approval for the staking contract
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

// --- Phase 3E Part 4 — Staking History additions ----------------------------
//
// Unlike StakingLiveActivityEntry above (session-only, never backfilled),
// these represent real on-chain history fetched via eth_getLogs — they
// survive a page reload and reflect actions taken in another tab/device,
// exactly the way lib/token/token-types.ts's TokenTransferEvent does for
// the token module.

export type StakingHistoryEventKind = "Staked" | "Unstaked" | "RewardPaid";

export interface StakingHistoryEvent {
  id: string; // `${txHash}:${logIndex}` — unique even for two same-kind events in one tx
  kind: StakingHistoryEventKind;
  amount: bigint; // raw, 18-decimal MPGR
  txHash: Hash;
  blockNumber: bigint;
  timestamp: string; // ISO, resolved from the event's block
}

export interface StakingHistoryCacheEntry {
  entries: StakingHistoryEvent[];
  timestamp: number;
  ttl: number;
  lastBlockScanned: bigint;
}

export type { Address };

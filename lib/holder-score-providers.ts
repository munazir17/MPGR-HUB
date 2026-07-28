// lib/holder-score-providers.ts

// Holder Tier — data provider layer.
//
// Total Holder Score is an aggregation of three independent balances:
//   Live Wallet MPGR + Active Staked MPGR + Active Locked MPGR
//
// Each balance comes from a swappable *provider*. Today every provider
// reads mock/local state (the same localStorage-backed engines the rest of
// the app already uses). Tomorrow, each provider's body becomes an on-chain
// read (ERC20 balanceOf, staking contract, lock contract) — the registry
// below is the ONLY thing that needs to change; lib/holder-tier-engine.ts
// and hooks/useHolderTier.ts never need to know which kind of provider is
// currently wired in.
//
// No duplicated calculations: staked/locked totals are read straight from
// lib/staking-engine.ts and lib/token-lock-engine.ts (the same functions
// Staking/Token Lock/Premium already use), never recomputed here.

import { getStakingState, getTotalStaked } from "@/lib/staking-engine";
import { getTokenLockState, getTotalLocked } from "@/lib/token-lock-engine";
import { getRewardState } from "@/lib/rewards-engine";
import { getBurnState } from "@/lib/burn-engine";

// --- Provider contracts ----------------------------------------------------

export interface WalletBalanceProvider {
  // MPGR currently sitting freely in the wallet — i.e. not staked, not
  // locked, not burned. Swap point: on-chain version calls
  // erc20Abi.balanceOf(address) via wagmi's readContract, using
  // lib/erc20-abi.ts + lib/wagmi.ts, and simply returns that number
  // (already decimal-adjusted).
  getWalletBalance(address: string): number;
}

export interface StakedBalanceProvider {
  // Sum of ACTIVE staked MPGR only. Withdrawn/unstaked positions must not
  // count — enforced by the provider, not by callers.
  getStakedBalance(address: string): number;
}

export interface LockedBalanceProvider {
  // Sum of ACTIVE locked MPGR only. Released locks must not count —
  // enforced by the provider, not by callers.
  getLockedBalance(address: string): number;
}

// --- Default (mock) providers ----------------------------------------------
// Derived from existing engine state so there is exactly one place that
// knows "claimed minus staked minus locked minus burned = free balance".

const defaultWalletBalanceProvider: WalletBalanceProvider = {
  getWalletBalance(address: string): number {
    const totalClaimed = getRewardState(address).totalClaimed;
    const activeStaked = getTotalStaked(getStakingState(address));
    const activeLocked = getTotalLocked(getTokenLockState(address));
    const totalBurned = getBurnState(address).totalBurned;
    return Math.max(0, totalClaimed - activeStaked - activeLocked - totalBurned);
  },
};

const defaultStakedBalanceProvider: StakedBalanceProvider = {
  getStakedBalance(address: string): number {
    // getTotalStaked already excludes status === "unstaked" positions.
    return getTotalStaked(getStakingState(address));
  },
};

const defaultLockedBalanceProvider: LockedBalanceProvider = {
  getLockedBalance(address: string): number {
    // getTotalLocked already excludes storedStatus === "released" positions.
    return getTotalLocked(getTokenLockState(address));
  },
};

// --- Registry ---------------------------------------------------------
// Same swap-in-place pattern as lib/premium-multiplier-registry.ts: module
// state holds the active provider, defaulting to the mock implementation
// above. A future on-chain integration calls the setters once (e.g. from
// an app bootstrap file) to swap in a real provider — no changes needed
// anywhere else in the Holder Tier module.

let walletBalanceProvider: WalletBalanceProvider = defaultWalletBalanceProvider;
let stakedBalanceProvider: StakedBalanceProvider = defaultStakedBalanceProvider;
let lockedBalanceProvider: LockedBalanceProvider = defaultLockedBalanceProvider;

export function setWalletBalanceProvider(provider: WalletBalanceProvider): void {
  walletBalanceProvider = provider;
}

export function setStakedBalanceProvider(provider: StakedBalanceProvider): void {
  stakedBalanceProvider = provider;
}

export function setLockedBalanceProvider(provider: LockedBalanceProvider): void {
  lockedBalanceProvider = provider;
}

export function getWalletBalance(address: string): number {
  return walletBalanceProvider.getWalletBalance(address);
}

export function getStakedBalance(address: string): number {
  return stakedBalanceProvider.getStakedBalance(address);
}

export function getLockedBalance(address: string): number {
  return lockedBalanceProvider.getLockedBalance(address);
}

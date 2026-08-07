// lib/holder-score-providers.ts

// Holder Tier — data provider layer.
//
// Total Holder Score is an aggregation of three independent balances:
//   Live Wallet MPGR + Active Staked MPGR + Active Locked MPGR
//
// Each balance comes from a swappable *provider*. Phase 3E Part 3 swaps the
// wallet and staked providers to read live chain data — exactly the swap
// this file's registry was built for. Locked MPGR (Token Lock module) is
// out of scope for this phase and stays on its existing mock engine.
//
// No duplicated calculations: staked/wallet totals are read straight from
// the same shared services (stakingService, balanceService) the Staking
// module and Navbar/dashboard already use — never recomputed here.

import { formatUnits, type Address } from "viem";
import { getTokenLockState, getTotalLocked } from "@/lib/token-lock-engine";
import { balanceService } from "@/lib/token/balance-service";
import { stakingService } from "@/lib/staking/staking-service";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";

// --- Provider contracts ----------------------------------------------------

export interface WalletBalanceProvider {
  // MPGR currently sitting freely in the wallet — i.e. not staked, not
  // locked, not burned.
  getWalletBalance(address: string): number;
}

export interface StakedBalanceProvider {
  // Currently staked MPGR, read live from the deployed MPGRStaking
  // contract's balanceOf(address).
  getStakedBalance(address: string): number;
}

export interface LockedBalanceProvider {
  // Sum of ACTIVE locked MPGR only. Released locks must not count —
  // enforced by the provider, not by callers.
  getLockedBalance(address: string): number;
}

// --- Default providers -------------------------------------------------

const defaultWalletBalanceProvider: WalletBalanceProvider = {
  getWalletBalance(address: string): number {
    // Live wallet MPGR balance, read from the shared cache
    // useMPGRBalance/refreshManager populate elsewhere in the app. Real
    // on-chain balance already excludes staked MPGR (transferred to the
    // staking contract) and burned MPGR (sent to the dead address) — both
    // are real token movements, so nothing is subtracted for either here.
    // This provider's contract is synchronous, so it reads whatever is
    // currently cached rather than fetching — 0 until something else in
    // the app has fetched this wallet's balance at least once this
    // session, never a fabricated number.
    const cached = balanceService.getCachedBalance(address as Address);
    const rawBalance = cached?.raw ?? 0n;
    const freeWalletBalance = parseFloat(formatUnits(rawBalance, MPGR_TOKEN_CONFIG.decimals));

    // Locked MPGR (Token Lock module) is still mock/local-only — it has
    // not actually left the wallet on-chain — so it's subtracted here to
    // avoid double-counting the same MPGR as both "locked" and "free".
    const activeLocked = getTotalLocked(getTokenLockState(address));

    return Math.max(0, freeWalletBalance - activeLocked);
  },
};

const defaultStakedBalanceProvider: StakedBalanceProvider = {
  getStakedBalance(address: string): number {
    // Live staked MPGR balance, read from the shared cache
    // useStaking/refreshManager.refreshStaking populate elsewhere in the
    // app. Same synchronous-contract reasoning as above: returns 0 (not
    // an error) until that cache has been populated at least once this
    // session, rather than fabricating a value.
    const cached = stakingService.getCachedWalletState(address as Address);
    if (!cached) return 0;
    return parseFloat(formatUnits(cached.stakedBalance, MPGR_TOKEN_CONFIG.decimals));
  },
};

const defaultLockedBalanceProvider: LockedBalanceProvider = {
  getLockedBalance(address: string): number {
    // getTotalLocked already excludes storedStatus === "released" positions.
    return getTotalLocked(getTokenLockState(address));
  },
};

// --- Registry ---------------------------------------------------------
// Module state holds the active provider, defaulting to the implementations
// above. A future Token Lock on-chain integration calls setLockedBalanceProvider
// once to swap that provider the same way — no other change needed here.

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

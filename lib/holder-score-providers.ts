// lib/holder-score-providers.ts

// Holder Tier — data provider layer.
//
// Total Holder Score is an aggregation of three independent balances:
//   Live Wallet MPGR + Active Staked MPGR + Active Locked MPGR
//
// Each balance comes from a swappable *provider*. Wallet and staked
// providers read the same shared caches populated by useMPGRBalance /
// useStaking (balanceService, stakingService). Locked MPGR is the last
// successful on-chain read stored by hooks/useTokenLock.ts on
// lib/token-lock/token-lock-client.ts after getUserLockIds + getLock.
// Released/withdrawn locks are excluded by that summary. Missing last-read
// returns 0 — never a fabricated number, never lib/token-lock-engine.ts.

import { formatUnits, type Address } from "viem";
import { getCachedWalletLock } from "@/lib/token-lock/token-lock-client";
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
    //
    // Locked MPGR is added back on top of this by getHolderScore() (via
    // getLockedBalance) as its own line item, so it must NOT also be
    // subtracted here — doing both nets the locked amount to zero
    // contribution, contradicting the documented "each counted at 100%
    // weight" rule and silently erasing any credit for locking.
    const cached = balanceService.getCachedBalance(address as Address);
    const rawBalance = cached?.raw ?? 0n;
    const freeWalletBalance = parseFloat(formatUnits(rawBalance, MPGR_TOKEN_CONFIG.decimals));

    return freeWalletBalance;
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
    return getCachedWalletLock(address)?.totalLocked ?? 0;
  },
};

// --- Registry ---------------------------------------------------------

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

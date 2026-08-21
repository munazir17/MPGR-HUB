// lib/holder-score-providers.ts

// Holder Tier — data provider layer.
//
// Total Holder Score is an aggregation of three independent balances:
//   Live Wallet MPGR + Active Staked MPGR + Active Locked MPGR
//
// Each balance comes from a swappable *provider*. Phase 3E Part 3 swaps the
// wallet and staked providers to read live chain data — exactly the swap
// this file's registry was built for. Locked MPGR is read from the same
// live on-chain snapshot hooks/useTokenLock.ts writes after each contract
// read (lib/live-onchain-cache.ts) — never the leftover localStorage mock
// in lib/token-lock-engine.ts.
//
// No duplicated calculations: staked/wallet totals are read straight from
// the same shared services (stakingService, balanceService) the Staking
// module and Navbar/dashboard already use — never recomputed here. Locked
// totals are the active (non-withdrawn) sum already computed by the Token
// Lock module, not re-derived here.

import { formatUnits, type Address } from "viem";
import { getLiveLockSnapshot } from "@/lib/live-onchain-cache";
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
    // Live active locked MPGR, read from the on-chain snapshot written
    // by hooks/useTokenLock.ts after each successful MPGRTokenLock read.
    // That snapshot already excludes withdrawn/released positions (the
    // Token Lock module's equivalent of storedStatus === "released").
    // Same synchronous-contract reasoning as the wallet/staked providers:
    // returns 0 until that hook has loaded this wallet's locks at least
    // once this session — never a fabricated number, and never the
    // leftover localStorage mock from lib/token-lock-engine.ts.
    return getLiveLockSnapshot(address)?.totalLocked ?? 0;
  },
};

// --- Registry ---------------------------------------------------------
// Module state holds the active provider, defaulting to the implementations
// above. Callers always go through getWalletBalance / getStakedBalance /
// getLockedBalance; tests or a later swap can replace any provider via
// the setters without touching those callers.

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

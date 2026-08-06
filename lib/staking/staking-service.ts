// lib/staking/staking-service.ts

import type { Address } from "viem";
import { stakingClient } from "./staking-client";
import { MPGR_STAKING_CONFIG } from "./staking-config";
import type { StakingGlobalCacheEntry, StakingGlobalState, StakingWalletCacheEntry, StakingWalletState } from "./staking-types";

// Phase 3E Part 3 — Staking Service.
//
// Caching layer over staking-client.ts, mirroring lib/token/balance-service.ts's
// shape exactly (cache-first reads, short TTL, manual invalidation after a
// confirmed transaction). Every value returned is exactly what
// stakingClient read from the deployed contract on Base Mainnet — no
// reward math, no APR derivation, nothing recomputed here. This is the
// ONLY reward/staking calculation surface on the frontend, and it performs
// zero calculations: it caches and returns.

const GLOBAL_CACHE_KEY = "staking:global";
const globalCache = new Map<string, StakingGlobalCacheEntry>();
const walletCache = new Map<string, StakingWalletCacheEntry>();

function walletCacheKey(address: Address): string {
  return `staking:wallet:${address.toLowerCase()}`;
}

function isCacheValid(timestamp: number, ttl: number): boolean {
  return Date.now() - timestamp < ttl;
}

export const stakingService = {
  // Pool-wide state, shared across every visitor.
  async getGlobalState(): Promise<StakingGlobalState> {
    const cached = globalCache.get(GLOBAL_CACHE_KEY);
    if (cached && isCacheValid(cached.timestamp, cached.ttl)) {
      return cached.state;
    }

    const [totalStaked, rewardPoolBalance, currentAPRBps, rewardState, isPaused, minimumStake] = await Promise.all([
      stakingClient.getTotalStaked(),
      stakingClient.getRewardPoolBalance(),
      stakingClient.getCurrentAPRBps(),
      stakingClient.getRewardState(),
      stakingClient.isPaused(),
      stakingClient.getMinimumStake(),
    ]);

    const state: StakingGlobalState = {
      totalStaked,
      rewardPoolBalance,
      currentAPRBps,
      rewardRate: rewardState.rewardRate,
      periodFinish: rewardState.periodFinish,
      isPaused,
      minimumStake,
    };

    globalCache.set(GLOBAL_CACHE_KEY, {
      state,
      timestamp: Date.now(),
      ttl: MPGR_STAKING_CONFIG.stakingReadCacheTtl,
    });

    return state;
  },

  // Per-wallet state — the connected user's own staked balance, accrued
  // reward, and current MPGR allowance for the staking contract.
  async getWalletState(address: Address): Promise<StakingWalletState> {
    const cacheKey = walletCacheKey(address);
    const cached = walletCache.get(cacheKey);
    if (cached && isCacheValid(cached.timestamp, cached.ttl)) {
      return cached.state;
    }

    const [stakedBalance, earnedRewards, allowance] = await Promise.all([
      stakingClient.getStakedBalance(address),
      stakingClient.getEarnedRewards(address),
      stakingClient.getAllowance(address),
    ]);

    const state: StakingWalletState = { stakedBalance, earnedRewards, allowance };

    walletCache.set(cacheKey, {
      state,
      timestamp: Date.now(),
      ttl: MPGR_STAKING_CONFIG.stakingReadCacheTtl,
    });

    return state;
  },

  clearGlobalCache(): void {
    globalCache.delete(GLOBAL_CACHE_KEY);
  },

  clearWalletCache(address: Address): void {
    walletCache.delete(walletCacheKey(address));
  },

  clearAllCache(): void {
    globalCache.clear();
    walletCache.clear();
  },
} as const;

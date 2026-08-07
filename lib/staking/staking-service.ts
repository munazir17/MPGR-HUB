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
// reward math, no APR derivation, nothing recomputed here. Phase 3E Part 4
// adds rewardPerTokenStored/lastUpdateTime (global) and
// userRewardPerTokenPaid/accruedRewards (wallet) — still just raw reads,
// still zero computation; the reward math itself lives in
// lib/staking/reward-math.ts, consumed by hooks/useStaking.ts.

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
      // Phase 3E Part 4 — already returned by getRewardState() above;
      // previously discarded, now carried through for the live reward
      // counter's client-side rewardPerToken() computation.
      rewardPerTokenStored: rewardState.rewardPerTokenStored,
      lastUpdateTime: rewardState.lastUpdateTime,
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

    const [stakedBalance, earnedRewards, allowance, userRewardPerTokenPaid, accruedRewards] = await Promise.all([
      stakingClient.getStakedBalance(address),
      stakingClient.getEarnedRewards(address),
      stakingClient.getAllowance(address),
      // Phase 3E Part 4 — raw per-account checkpoint reads for the live
      // reward counter's client-side earned() computation. earnedRewards
      // above is untouched and remains the authoritative value for claim
      // eligibility and claim/exit payout amounts.
      stakingClient.getUserRewardPerTokenPaid(address),
      stakingClient.getAccruedRewards(address),
    ]);

    const state: StakingWalletState = {
      stakedBalance,
      earnedRewards,
      allowance,
      userRewardPerTokenPaid,
      accruedRewards,
    };

    walletCache.set(cacheKey, {
      state,
      timestamp: Date.now(),
      ttl: MPGR_STAKING_CONFIG.stakingReadCacheTtl,
    });

    return state;
  },

  // Synchronous cache-only reads — return null/stale-free data without
  // touching the RPC. Used by callers with a synchronous contract that
  // can't await a fetch (e.g. lib/holder-score-providers.ts). Never
  // triggers a fetch and never fabricates a value: null means "not
  // fetched by anything else yet this session."
  getCachedGlobalState(): StakingGlobalState | null {
    const cached = globalCache.get(GLOBAL_CACHE_KEY);
    return cached && isCacheValid(cached.timestamp, cached.ttl) ? cached.state : null;
  },

  getCachedWalletState(address: Address): StakingWalletState | null {
    const cached = walletCache.get(walletCacheKey(address));
    return cached && isCacheValid(cached.timestamp, cached.ttl) ? cached.state : null;
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

// lib/rewards/providers/staking-rewards-provider.ts

import type { Address } from "viem";
import { stakingService } from "@/lib/staking/staking-service";
import { stakingHistoryService } from "@/lib/staking/staking-history-service";
import { REWARD_CATEGORY_METADATA } from "../reward-config";
import type { RewardCategorySummary, RewardClaimHistoryEntry, RewardProvider } from "../reward-types";

// Phase 3F Part 1 — Staking Rewards Provider.
//
// The "staking" category's RewardProvider implementation. Reads exclusively
// through stakingService / stakingHistoryService's existing caching
// layer — the exact same functions hooks/useStaking.ts and
// hooks/useStakingHistory.ts already call — so this never issues a
// duplicate RPC call beyond what those TTL caches already allow, and
// never touches lib/staking/staking-client.ts or the contract directly.
// Read-only: claiming staking rewards still only ever happens through
// hooks/useStaking.ts's claimRewards() on the Staking page — this
// provider never submits a transaction.

const CATEGORY = "staking" as const;

export const stakingRewardsProvider: RewardProvider = {
  category: CATEGORY,
  label: REWARD_CATEGORY_METADATA[CATEGORY].label,

  async getSummary(address: Address): Promise<RewardCategorySummary> {
    const [walletState, historyEntries] = await Promise.all([
      stakingService.getWalletState(address),
      stakingHistoryService.getHistory(address, {}),
    ]);

    // getHistory()'s return value is limited to a page size; the cache
    // behind it holds everything scanned so far. Reading the cache
    // directly (immediately after the call above guarantees it's
    // populated) gives the full set to sum, the same pattern
    // hooks/useStakingHistory.ts uses for totalRewardsClaimedRaw.
    const fullHistory = stakingHistoryService.getCachedHistory(address) ?? historyEntries;

    const claimedRaw = fullHistory
      .filter((event) => event.kind === "RewardPaid")
      .reduce((sum, event) => sum + event.amount, 0n);

    // walletState.earnedRewards is the contract's own earned() value as
    // of the last read — currently accrued but not yet claimed.
    const claimableRaw = walletState.earnedRewards;

    return {
      category: CATEGORY,
      label: REWARD_CATEGORY_METADATA[CATEGORY].label,
      isActive: true,
      totalEarnedRaw: claimedRaw + claimableRaw,
      claimedRaw,
      claimableRaw,
    };
  },

  async getHistory(address: Address, limit?: number): Promise<RewardClaimHistoryEntry[]> {
    await stakingHistoryService.getHistory(address, limit ? { limit } : {});
    const fullHistory = stakingHistoryService.getCachedHistory(address) ?? [];

    const entries: RewardClaimHistoryEntry[] = fullHistory
      .filter((event) => event.kind === "RewardPaid")
      .map((event) => ({
        id: event.id,
        category: CATEGORY,
        title: "Staking reward claimed",
        amountRaw: event.amount,
        timestamp: event.timestamp,
        txHash: event.txHash,
      }));

    return typeof limit === "number" ? entries.slice(0, limit) : entries;
  },
};

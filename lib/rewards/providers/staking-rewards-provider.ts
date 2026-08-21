// lib/rewards/providers/staking-rewards-provider.ts

import type { Address } from "viem";
import { stakingService } from "@/lib/staking/staking-service";
import { stakingHistoryService } from "@/lib/staking/staking-history-service";
import { REWARD_CATEGORY_METADATA } from "../reward-config";
import type { RewardCategorySummary, RewardClaimHistoryEntry, RewardProvider } from "../reward-types";
// TEMPORARY — Phase 3F diagnostic trace only. See lib/_debug/reward-hub-trace.ts.
import { trace } from "@/lib/_debug/reward-hub-trace";

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
    // TEMPORARY — Phase 3F diagnostic trace only.
    const summaryStarted = trace.start("stakingRewardsProvider.getSummary", { address });

    // Phase 3I — Reward Hub loading fix (uncouple Summary from the cold
    // history scan). This used to also await
    // stakingHistoryService.getHistory(address, {}) here, in parallel
    // with getWalletState(). On a cold cache that call kicks off (or
    // joins, via inFlightScans) the full chunked eth_getLogs staking
    // history scan — which, per staking-config.ts's
    // historyInitialWindowBlocks/historyChunkSize/historyMaxCuPerSecond,
    // can take on the order of ~19s on its own even with a healthy RPC.
    // Awaiting it here meant getSummary() — and therefore the Reward Hub
    // Summary cards and Category grid, which render off this same
    // summary — could never resolve faster than that scan, even though
    // neither actually needs the full scan to render correctly.
    //
    // getWalletState() alone gives an exact, live claimableRaw
    // (walletState.earnedRewards, the contract's own earned() value) with
    // no dependency on history at all. claimedRaw is the one value that
    // genuinely comes from history — so instead of awaiting a fresh scan,
    // this reads whatever stakingHistoryService already has cached RIGHT
    // NOW (a synchronous, non-blocking read; never triggers a scan
    // itself). hooks/useRewardHub.ts calls getSummary() and getHistory()
    // independently (not awaiting one on the other) on every load/poll
    // cycle, so the history scan this summary no longer waits for is
    // still running — its own load path continues it in the background,
    // and stakingHistoryService's own inFlightScans dedup means this
    // never causes a second, duplicate scan.
    //
    // If no cache exists yet at all (this wallet's very first ever read,
    // before any history scan has completed), claimedRaw is computed as 0
    // rather than inventing a number for it — the same "render as
    // not-yet-known instead of a fabricated non-zero value" discipline
    // reward-service.ts's inactiveSummary() already applies for
    // not-yet-built categories. It is never permanently stuck at 0: the
    // very next Summary read (this hook polls every
    // MPGR_REWARDS_CONFIG.liveReadPollingIntervalMs, and also refreshes
    // immediately on the "staking_changed" event) picks up whatever the
    // background scan has found by then, and converges to the exact total
    // as backfill completes, exactly like the History list itself already
    // does.
    const walletStateStarted = trace.start("staking.getWalletState");
    const walletState = await stakingService.getWalletState(address);
    trace.end("staking.getWalletState", walletStateStarted);

    // Phase 3J — hole #2 fix. Was stakingHistoryService.getCachedHistory()
    // (TTL-gated: returns null, and therefore claimedRaw 0, the instant
    // historyCacheTtl elapses — even though a real, already-scanned
    // claimed total was sitting right there in the cache). Reads via
    // getCachedHistoryStale() instead, which returns the same cached
    // entries regardless of TTL, so a real claimedRaw never reverts to 0
    // just because this particular read happened to land after the TTL
    // window. This only changes what's read for *display* here — it does
    // not touch scanAndCache()'s own TTL/backfill/re-scan decisions in
    // staking-history-service.ts, which are unaffected and still govern
    // when the underlying data itself gets refreshed.
    const cachedHistory = stakingHistoryService.getCachedHistoryStale(address) ?? [];

    const claimedRaw = cachedHistory
      .filter((event) => event.kind === "RewardPaid")
      .reduce((sum, event) => sum + event.amount, 0n);

    // walletState.earnedRewards is the contract's own earned() value as
    // of the last read — currently accrued but not yet claimed.
    const claimableRaw = walletState.earnedRewards;

    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end("stakingRewardsProvider.getSummary", summaryStarted);

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
    // TEMPORARY — Phase 3F diagnostic trace only.
    const historyStarted = trace.start("stakingRewardsProvider.getHistory", { address, limit });
    const scanStarted = trace.start("stakingHistoryService.getHistory (from getHistory)");
    await stakingHistoryService.getHistory(address, limit ? { limit } : {});
    trace.end("stakingHistoryService.getHistory (from getHistory)", scanStarted);
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

    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end("stakingRewardsProvider.getHistory", historyStarted, { count: entries.length });

    return typeof limit === "number" ? entries.slice(0, limit) : entries;
  },
};

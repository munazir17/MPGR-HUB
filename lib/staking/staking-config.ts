// lib/staking/staking-config.ts
import { base } from "wagmi/chains";
import type { Address } from "viem";

// Phase 3E Part 3 — Live Staking & Rewards Integration.
//
// Single source of truth for the deployed MPGRStaking contract config on
// Base Mainnet. Mirrors the shape of lib/token/token-config.ts so the two
// live-infrastructure domains (token, staking) stay consistent to read.
//
// This is the FINAL Milestone 1C contract — see contracts/MPGRStaking.sol
// and contracts/interfaces/IMPGRStaking.sol in the contracts/ tree for the
// deployed source. No functional changes after deployment; only
// deployment itself and the 30,000,000 MPGR depositRewards() funding call
// have happened on-chain since.

export const MPGR_STAKING_CONFIG = {
  // Base Mainnet address for the deployed MPGRStaking contract.
  address: "0x1690C7b6d312284e30434d93498e56eE09fFa12c" as Address,

  // Chain the staking contract lives on. Base only — this app does not
  // support any other network for staking.
  chain: base,
  chainId: base.id as 8453,

  // MPGR token address.
  stakingTokenAddress: "0xB2000000000000000000008d204203177a78AF01" as Address,

  // Cache TTL for staking read data.
  stakingReadCacheTtl: 12 * 1000,

  // Refresh timeout.
  refreshTimeoutMs: 5000,

  // Transaction confirmation timeout.
  transactionConfirmationTimeoutMs: 90 * 1000,

  // Background/foreground refetch cadence.
  liveReadPollingIntervalMs: 15 * 1000,

  // Debounce duration for address changes.
  addressChangeDebounceMs: 500,

  // Shared retry policy for RPC-facing staking calls.
  retry: {
    maxAttempts: 3,
    baseDelayMs: 300,
    maxDelayMs: 4_000,
  },

  // --- Phase 3E Part 4 — Staking History additions --------------------------

  // Initial history lookback window — the full horizon a wallet's
  // history is eventually backfilled to. Unchanged in meaning from
  // before; reached progressively now (see historyInitialWindowBlocks /
  // historyBackfillStepBlocks below) rather than in one synchronous scan.
  historyLookbackBlocks: 200_000,

  // Maximum block span per eth_getLogs call.
  //
  // Alchemy's Free tier caps eth_getLogs at a 10-block range on Base
  // (Ethereum/Base/Optimism/Arbitrum/Worldchain/zkSync are all 10 on
  // Free; PAYG/Enterprise are unlimited). scanAllEvents() in
  // staking-history-reader.ts builds each request as exactly
  // [chunkStart, chunkStart + historyChunkSize - 1] — i.e. every
  // eth_getLogs call spans exactly this many blocks — so this constant
  // alone determines request compliance. 10 sits exactly at the
  // documented Free-tier ceiling.
  historyChunkSize: 10,

  // History cache TTL.
  historyCacheTtl: 20 * 1000,

  // Number of history entries returned per page.
  historyPageSize: 10,

  // --- Phase 3G — Alchemy Free-tier-compatible history strategy -----------
  //
  // The 10-block chunk size above means a full historyLookbackBlocks
  // (200,000) scan is 20,000 requests. Alchemy's Free tier throughput
  // cap is 500 CU/s account-wide, and eth_getLogs costs 75 CU/call
  // (Alchemy's own docs: reference/throughput, reference/compute-units)
  // — a hard sustained ceiling of ~6.7 eth_getLogs/s no matter how much
  // concurrency is used. 20,000 requests at that ceiling is ~50 minutes
  // minimum — chunk size and concurrency alone cannot make a full-window
  // synchronous scan fast on this tier; only the scan *strategy* can.
  //
  // The fix: don't scan the full window on cold load. Scan a small
  // initial window for a fast first result, then extend backward by a
  // bounded step on each subsequent call (piggybacking on the existing
  // liveReadPollingIntervalMs poll cycle) until the full
  // historyLookbackBlocks horizon is covered. See
  // staking-history-service.ts's scanAndCache for the implementation.
  // Reward totals still sum the exact same real on-chain data — they
  // just converge to the full total over the backfill period instead of
  // being complete instantly, which the 10-block cap makes physically
  // unavoidable on this tier for any wallet with history older than the
  // initial window.

  // Blocks scanned eagerly on a wallet's first-ever load (cache miss).
  // 1,000 blocks / 10 per chunk = 100 requests. At the paced rate below,
  // ~19s — the first-paint cost of this tier's 10-block cap.
  historyInitialWindowBlocks: 1_000,

  // Additional blocks walked backward per subsequent call, once an
  // initial scan exists and the historyLookbackBlocks horizon hasn't
  // been reached yet. 500 blocks / 10 per chunk = 50 requests, ~9.75s
  // paced — comfortably inside one liveReadPollingIntervalMs (15s) poll
  // cycle, so each poll makes one backfill step without overlapping the
  // next.
  historyBackfillStepBlocks: 500,

  // Number of history chunks processed concurrently by
  // staking-history-reader.ts. With CU-budget pacing (below) in place,
  // this mainly controls burst shape, not total throughput — total scan
  // time is governed by historyMaxCuPerSecond regardless of this value.
  // Kept modest to keep individual bursts well inside Alchemy's 10-second
  // token-bucket allowance.
  historyChunkConcurrency: 4,

  // Target sustained throughput budget for the history scan specifically,
  // in Compute Units/second. Set below Alchemy Free tier's documented
  // 500 CU/s account-wide cap to leave headroom for the app's other
  // concurrent reads (getWalletState, getBlockNumber, live polling)
  // sharing the same account-wide budget. staking-history-reader.ts
  // paces batches to this target with an explicit sleep, so the scan's
  // real submission rate can't outrun the account's actual throughput
  // and trigger avoidable 429 throttling.
  historyMaxCuPerSecond: 400,

  // Alchemy-documented eth_getLogs Compute Unit cost, used only to
  // compute the pacing delay above (not billing — informational/pacing
  // constant, sourced from Alchemy's own docs).
  historyGetLogsCuCostEstimate: 75,
} as const;

export type MPGRStakingConfig = typeof MPGR_STAKING_CONFIG;

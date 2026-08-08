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

  // Initial history lookback window.
  historyLookbackBlocks: 200_000,

  // Maximum block span per eth_getLogs call.
  historyChunkSize: 2_000,

  // History cache TTL.
  historyCacheTtl: 20 * 1000,

  // Number of history entries returned per page.
  historyPageSize: 10,

  // --- Phase 3F — Reward Hub performance fix -------------------------------
  //
  // Number of history chunks processed concurrently by
  // staking-history-reader.ts.
  //
  // Previously each chunk was awaited sequentially. With 200,000 blocks
  // and 2,000 blocks per chunk, that can mean ~100 sequential RPC
  // round-trips per event type.
  //
  // Keeping this bounded at 8 improves cold-start loading without
  // changing the block range, chunk size, or staking data accuracy.
  historyChunkConcurrency: 8,
} as const;

export type MPGRStakingConfig = typeof MPGR_STAKING_CONFIG;

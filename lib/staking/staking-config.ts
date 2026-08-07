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

  // MPGR token address, duplicated here (matches
  // lib/token/token-config.ts's MPGR_TOKEN_CONFIG.address) so staking
  // code that only imports this file — e.g. to build an approve() call
  // before stake() — doesn't need a second import just for the token
  // address. Single source of truth for the *value* is still
  // MPGR_TOKEN_CONFIG; keep both in sync if the token address ever changes.
  stakingTokenAddress: "0xB2000000000000000000008d204203177a78AF01" as Address,

  // Cache TTL for staking read data (balanceOf, earned, totalStaked,
  // rewardPoolBalance, currentAPRBps, etc). Reward accrual is
  // continuous, so this is intentionally shorter than
  // MPGR_TOKEN_CONFIG.balanceCacheTtl (30s) — staking numbers visibly
  // tick up on the UI and a longer TTL would make the page feel stale.
  stakingReadCacheTtl: 12 * 1000,

  // Refresh timeout — if a staking read/refresh takes longer than this,
  // skip the update to avoid blocking the UI. Matches
  // MPGR_TOKEN_CONFIG.refreshTimeoutMs for consistency.
  refreshTimeoutMs: 5000,

  // How long to poll for a staking transaction's receipt after submission
  // before surfacing a timeout state in the UI, distinct from the wallet
  // itself timing out.
  transactionConfirmationTimeoutMs: 90 * 1000,

  // Background/foreground refetch cadence for live staking reads while a
  // staking page is open (wagmi's useReadContract `refetchInterval`).
  // Kept modest since Base blocks are ~2s but staking numbers don't need
  // per-block freshness to feel live.
  liveReadPollingIntervalMs: 15 * 1000,

  // Debounce duration for address changes, matching
  // MPGR_TOKEN_CONFIG.addressChangeDebounceMs, so a fast wallet switch
  // doesn't fire duplicate staking reads.
  addressChangeDebounceMs: 500,

  // Shared retry policy for RPC-facing staking calls, matching the shape
  // of MPGR_TOKEN_CONFIG.retry (see lib/token/rpc-retry.ts — reused
  // as-is, not duplicated, by the staking service layer).
  retry: {
    maxAttempts: 3,
    baseDelayMs: 300,
    maxDelayMs: 4_000,
  },

  // --- Phase 3E Part 4 — Staking History additions --------------------------
  //
  // How far back (in blocks) an initial Staked/Unstaked/RewardPaid scan
  // looks for a wallet that's never been scanned before, mirroring
  // MPGR_TOKEN_CONFIG.transferLogLookbackBlocks. Kept smaller than the
  // token module's 300,000 — MPGRStaking is a recently deployed contract
  // (see comment above), so there's little history to miss by scanning a
  // shorter window; raise this if genesis-to-now history is ever needed.
  historyLookbackBlocks: 200_000,
  // Maximum block span per single eth_getLogs call — same rationale as
  // MPGR_TOKEN_CONFIG.transferLogChunkSize (public RPC endpoints commonly
  // cap/truncate wide log ranges).
  historyChunkSize: 2_000,
  // How long a scanned staking history stays valid before the next
  // getHistory() call re-checks the chain for new blocks.
  historyCacheTtl: 20 * 1000,
  // Number of history entries returned per "page" by default.
  historyPageSize: 10,
} as const;

export type MPGRStakingConfig = typeof MPGR_STAKING_CONFIG;

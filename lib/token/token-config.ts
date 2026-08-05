// lib/token/token-config.ts
import { base } from "wagmi/chains";
import type { Address } from "viem";

// Phase 3E Part 1 — B20 Foundation & Live Token Integration.
//
// Single source of truth for MPGR token configuration on Base Mainnet.
// Contract is a Base B20 token, not ERC20-verified, so no assumptions about
// verified source code — only standard token interactions (balanceOf,
// decimals, symbol, totalSupply, Transfer events). All values are
// compile-time constants; reuse everywhere token config is needed.

export const MPGR_TOKEN_CONFIG = {
  // Base Mainnet address for MPGR token.
  address: "0xb2000000000000000000008d204203177a78af01" as Address,
  // Chain where MPGR lives.
  chain: base,
  chainId: base.id as 8453,
  // Token symbol — "MPGR".
  symbol: "MPGR",
  // Token name — the full product name.
  name: "MPGR",
  // Standard token decimals — most Base tokens use 18.
  decimals: 18,
  // Cache TTL for token metadata (name, symbol, decimals, totalSupply).
  // Metadata changes rarely, so 1-hour TTL is safe.
  metadataCacheTtl: 60 * 60 * 1000,
  // Cache TTL for balance queries. Balances change frequently
  // (trading, transfers, staking rewards), so 30-second TTL strikes a
  // balance between freshness and RPC load.
  balanceCacheTtl: 30 * 1000,
  // Refresh timeout — if a balance fetch takes longer than this, skip
  // the update to avoid blocking the UI.
  refreshTimeoutMs: 5000,
  // Maximum number of automatic refresh attempts per session before
  // giving up (user can still manually refresh). Prevents spam on
  // broken RPC or token state.
  maxAutoRefreshAttempts: 5,
  // Debounce duration for address changes — if a user quickly switches
  // wallets, only refresh once after they've settled (to avoid
  // duplicate RPC calls).
  addressChangeDebounceMs: 500,

  // --- Phase 3E Part 2 — Live Token Infrastructure additions ---------------
  //
  // How far back (in blocks) an initial transaction history scan looks
  // when a wallet has never been scanned before. Base runs ~2s blocks, so
  // ~300,000 blocks is roughly a week of history — enough to be useful
  // for a "recent activity" timeline without scanning from genesis.
  transferLogLookbackBlocks: 300_000,
  // Maximum block span per single eth_getLogs call. Public RPC endpoints
  // (including Base's own mainnet.base.org) commonly reject or truncate
  // wide log ranges, so every scan is chunked to this width regardless of
  // how large the overall lookback window is.
  transferLogChunkSize: 2_000,
  // How long a scanned transaction history stays valid before the next
  // getHistory() call re-checks the chain for new blocks.
  transactionHistoryCacheTtl: 20 * 1000,
  // Number of transfers returned per "page" of history by default.
  transactionHistoryPageSize: 20,
  // Polling interval viem's watchContractEvent uses internally while the
  // configured transport is http() (see lib/wagmi.ts). Has no effect if
  // the transport is ever upgraded to a push-based one (e.g. webSocket()).
  watchPollingIntervalMs: 4_000,
  // Background portfolio sync cadence (balance + history together), and
  // the ceiling background-sync-scheduler backs off to on repeated
  // failures. Keeps a struggling RPC endpoint from being hammered at a
  // fixed interval regardless of how many consecutive syncs have failed.
  backgroundSyncIntervalMs: 20 * 1000,
  backgroundSyncMaxIntervalMs: 2 * 60 * 1000,
  // Shared retry policy for the RPC-facing calls this phase's modules
  // make (log scans, block lookups). Exponential backoff with jitter,
  // capped at maxDelayMs — see lib/token/rpc-retry.ts.
  retry: {
    maxAttempts: 3,
    baseDelayMs: 300,
    maxDelayMs: 4_000,
  },
} as const;

export type MPGRTokenConfig = typeof MPGR_TOKEN_CONFIG;

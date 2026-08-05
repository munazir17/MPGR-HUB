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
} as const;

export type MPGRTokenConfig = typeof MPGR_TOKEN_CONFIG;

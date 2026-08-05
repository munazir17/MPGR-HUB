// lib/token/token-types.ts

import type { Address } from "viem";

// Phase 3E Part 1 — Shared types for token operations.
//
// Every module in lib/token/ imports and extends these types, ensuring
// consistency across token client, balance service, transaction service,
// and hooks. All types are readonly where appropriate, and nullable
// fields are explicit about missing data (loading vs error).

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  address: Address;
  totalSupply: bigint;
}

export interface TokenBalance {
  raw: bigint;
  formatted: string;
  decimal: number;
}

export interface WalletTokenState {
  address: Address;
  balance: TokenBalance;
  metadata: TokenMetadata;
  isLoading: boolean;
  error: string | null;
  lastUpdated: string;
  cacheKey: string;
}

export interface TokenRefreshResult {
  success: boolean;
  balance?: TokenBalance;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export interface TokenOperationResult<T> {
  data?: T;
  error?: string;
  isLoading: boolean;
  success: boolean;
}

export interface BalanceCacheEntry {
  balance: TokenBalance;
  timestamp: number;
  ttl: number;
}

export interface MetadataCacheEntry {
  metadata: TokenMetadata;
  timestamp: number;
  ttl: number;
}

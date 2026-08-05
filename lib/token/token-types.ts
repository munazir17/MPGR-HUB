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

// --- Phase 3E Part 2 — Live Token Infrastructure types ----------------------
//
// Types for transfer-event reading, wallet activity history, background
// portfolio sync, and RPC retry/diagnostics. Every module in this phase
// (transfer-event-reader, transaction-history-service, portfolio-sync-service,
// background-sync-scheduler, rpc-retry) imports from here rather than
// defining its own shapes, the same way Phase 3E Part 1's modules all
// share the types above.

// Direction of a transfer relative to the wallet being scanned — "in"
// means the wallet is the Transfer event's `to`, "out" means it's `from`.
export type TransferDirection = "in" | "out";

// A single decoded, wallet-relative Transfer event, ready for display.
export interface TokenTransferEvent {
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  timestamp: string;
  from: Address;
  to: Address;
  // The wallet this event was scanned for — kept on the event itself so
  // a merged, multi-wallet list (not used today, but a natural future
  // need) doesn't lose track of whose timeline an entry belongs to.
  walletAddress: Address;
  direction: TransferDirection;
  amount: TokenBalance;
}

// Cache entry for a wallet's scanned transfer history. `lastBlockScanned`
// is what makes refreshes incremental — the next scan only asks the
// chain for blocks after this one, instead of re-scanning the full
// lookback window every time.
export interface TransactionHistoryCacheEntry {
  entries: TokenTransferEvent[];
  timestamp: number;
  ttl: number;
  lastBlockScanned: bigint;
}

// Which underlying mechanism a wallet's background sync is currently
// using. Only "polling" is implemented (lib/wagmi.ts's transport is
// http()); "websocket" exists in the type now so a future push-based
// transport doesn't require a breaking change to SyncStatus consumers.
export type SyncStrategyKind = "polling" | "websocket";

// Live status of a wallet's background sync loop, as tracked by
// background-sync-scheduler.ts. Read via backgroundSyncScheduler.getStatus().
export interface SyncStatus {
  isActive: boolean;
  strategy: SyncStrategyKind;
  lastSyncedAt: string | null;
  consecutiveFailures: number;
  nextRetryDelayMs: number;
}

// Exponential backoff parameters for lib/token/rpc-retry.ts's withRetry().
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// Rolling diagnostics for RPC calls made through withRetry() — surfaced
// for debugging/observability, not persisted anywhere.
export interface RpcDiagnostics {
  totalCalls: number;
  totalFailures: number;
  totalRetries: number;
  lastError: string | null;
  lastCallDurationMs: number;
  lastCallAt: string | null;
}

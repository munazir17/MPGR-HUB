// lib/reward-vault/reward-vault-config.ts
import { base } from "wagmi/chains";
import type { Address } from "viem";

// Reward Vault Integration — real deployed MPGRRewardVault contract.
//
// Single source of truth for the Reward Vault's address/chain/decimals,
// mirroring the shape of lib/staking/staking-config.ts and
// lib/token/token-config.ts so every live-contract module in this app
// stays consistent to read. The contract itself is already deployed and
// verified on BaseScan — nothing here deploys or changes it.

export const MPGR_REWARD_VAULT_CONFIG = {
  // Base Mainnet address for the deployed MPGRRewardVault contract.
  address: "0xbe4B0e8692670229129562a50A62f5173E30937C" as Address,

  // Chain the vault lives on. Base only — claim()/claimMultiple() must
  // never be sent on any other network.
  chain: base,
  chainId: base.id as 8453,

  // MPGR token address (same token used by staking/token-lock).
  tokenAddress: "0xB2000000000000000000008d204203177a78AF01" as Address,

  // MPGR uses 18 decimals.
  decimals: 18,

  // Cache TTL for vault read data (per-wallet reward list, availability).
  readCacheTtl: 12 * 1000,

  // Refresh timeout.
  refreshTimeoutMs: 5000,

  // Transaction confirmation timeout.
  transactionConfirmationTimeoutMs: 90 * 1000,

  // Background/foreground refetch cadence.
  liveReadPollingIntervalMs: 15 * 1000,

  // Shared retry policy for RPC-facing vault calls.
  retry: {
    maxAttempts: 3,
    baseDelayMs: 300,
    maxDelayMs: 4_000,
  },
} as const;

export type MPGRRewardVaultConfig = typeof MPGR_REWARD_VAULT_CONFIG;

// lib/reward-vault/reward-vault-config.ts
import { CHAIN, CHAIN_ID, MPGR_REWARD_VAULT_ADDRESS, MPGR_TOKEN_ADDRESS } from "@/lib/chain/base";

// Reward Vault Integration — real deployed MPGRRewardVault contract.
//
// Single source of truth for the Reward Vault's address/chain/decimals,
// mirroring the shape of lib/staking/staking-config.ts and
// lib/token/token-config.ts so every live-contract module in this app
// stays consistent to read. The contract itself is already deployed and
// verified on BaseScan — nothing here deploys or changes it.

export const MPGR_REWARD_VAULT_CONFIG = {
  // Base Mainnet address for the deployed MPGRRewardVault contract.
  address: MPGR_REWARD_VAULT_ADDRESS,

  // Chain the vault lives on. Base only — claim()/claimMultiple() must
  // never be sent on any other network.
  chain: CHAIN,
  chainId: CHAIN_ID,

  // MPGR token address (same token used by staking/token-lock).
  tokenAddress: MPGR_TOKEN_ADDRESS,

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

// lib/reward-vault/reward-vault-client.ts

import { readContract, writeContract, simulateContract, waitForTransactionReceipt } from "wagmi/actions";
import type { Address, Hash } from "viem";
import { config } from "@/lib/wagmi";
import { REWARD_VAULT_ABI } from "./reward-vault-abi";
import { MPGR_REWARD_VAULT_CONFIG } from "./reward-vault-config";
import { VaultRewardStatus, VaultRewardType, type VaultReward, type VaultSeason } from "./reward-vault-types";
import { withRetry } from "@/lib/token/rpc-retry";

// Reward Vault Integration — Reward Vault Client.
//
// Low-level wagmi/viem integration for the deployed MPGRRewardVault
// contract, mirroring lib/staking/staking-client.ts's shape exactly:
// pure RPC/wallet communication, no caching, no event emission. Reads
// throw on failure (never fabricate a fallback number); writes simulate
// before sending so a revert is caught and decoded (via
// REWARD_VAULT_ABI's custom errors) BEFORE the wallet prompts the user
// to sign. Every call is pinned to Base Mainnet via
// MPGR_REWARD_VAULT_CONFIG.chainId.
//
// Root-cause fix — "Failed to fetch your reward IDs: the request took
// too long to respond". lib/wagmi.ts's transport already disables
// viem's own per-request retry (retryCount: 0) in favor of ONE shared
// retry layer, lib/token/rpc-retry.ts's withRetry() — already used by
// every other RPC-facing module (lib/staking/staking-history-reader.ts,
// lib/token/transfer-event-reader.ts). This module was the one
// RPC-facing module that never got wired into it: every read below
// called readContract() directly, so a single transient RPC hiccup
// (one dropped connection, one slow node behind a load balancer) had
// zero retries anywhere in the stack and surfaced immediately as a hard
// failure. reward-vault-config.ts already defined a `retry` policy for
// exactly this — it just wasn't being read by anything. No new
// infrastructure, no new config: this wires reads through the same
// mechanism, and the same policy, that already exists.

const REWARD_VAULT_CONTRACT = {
  address: MPGR_REWARD_VAULT_CONFIG.address,
  abi: REWARD_VAULT_ABI,
  chainId: MPGR_REWARD_VAULT_CONFIG.chainId,
} as const;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

type RawRewardTuple = {
  rewardId: bigint;
  seasonId: bigint;
  user: Address;
  amount: bigint;
  rewardType: number;
  status: number;
};

type RawSeasonTuple = {
  seasonId: bigint;
  startTime: bigint;
  endTime: bigint;
  totalAllocated: bigint;
  totalClaimed: bigint;
  finalized: boolean;
};

export const rewardVaultClient = {
  // --- Reads (wallet-independent) -----------------------------------------

  async getAvailableBalance(): Promise<bigint> {
    try {
      return await withRetry(
        "rewardVaultClient.getAvailableBalance",
        () => readContract(config, { ...REWARD_VAULT_CONTRACT, functionName: "availableBalance" }),
        MPGR_REWARD_VAULT_CONFIG.retry
      );
    } catch (err) {
      console.error("rewardVaultClient.getAvailableBalance failed", { error: err });
      throw new Error(`Failed to fetch vault available balance: ${toError(err).message}`);
    }
  },

  async getVaultBalance(): Promise<bigint> {
    try {
      return await withRetry(
        "rewardVaultClient.getVaultBalance",
        () => readContract(config, { ...REWARD_VAULT_CONTRACT, functionName: "vaultBalance" }),
        MPGR_REWARD_VAULT_CONFIG.retry
      );
    } catch (err) {
      console.error("rewardVaultClient.getVaultBalance failed", { error: err });
      throw new Error(`Failed to fetch vault balance: ${toError(err).message}`);
    }
  },

  async getTotalClaimed(): Promise<bigint> {
    try {
      return await withRetry(
        "rewardVaultClient.getTotalClaimed",
        () => readContract(config, { ...REWARD_VAULT_CONTRACT, functionName: "totalClaimed" }),
        MPGR_REWARD_VAULT_CONFIG.retry
      );
    } catch (err) {
      console.error("rewardVaultClient.getTotalClaimed failed", { error: err });
      throw new Error(`Failed to fetch vault total claimed: ${toError(err).message}`);
    }
  },

  // --- Reads (wallet-dependent) --------------------------------------------

  async getUserRewardIds(user: Address): Promise<bigint[]> {
    try {
      const ids = await withRetry(
        "rewardVaultClient.getUserRewardIds",
        () =>
          readContract(config, {
            ...REWARD_VAULT_CONTRACT,
            functionName: "getUserRewardIds",
            args: [user],
          }),
        MPGR_REWARD_VAULT_CONFIG.retry
      );
      return ids as unknown as bigint[];
    } catch (err) {
      console.error("rewardVaultClient.getUserRewardIds failed", { user, error: err });
      throw new Error(`Failed to fetch your reward IDs: ${toError(err).message}`);
    }
  },

  async getReward(rewardId: bigint): Promise<VaultReward> {
    try {
      const [raw, isClaimable] = await withRetry(
        "rewardVaultClient.getReward",
        () =>
          Promise.all([
            readContract(config, { ...REWARD_VAULT_CONTRACT, functionName: "getReward", args: [rewardId] }),
            readContract(config, { ...REWARD_VAULT_CONTRACT, functionName: "isRewardClaimable", args: [rewardId] }),
          ]),
        MPGR_REWARD_VAULT_CONFIG.retry
      );
      const reward = raw as unknown as RawRewardTuple;
      return {
        rewardId: reward.rewardId,
        seasonId: reward.seasonId,
        user: reward.user,
        amount: reward.amount,
        rewardType: reward.rewardType as VaultRewardType,
        status: reward.status as VaultRewardStatus,
        isClaimable: isClaimable as unknown as boolean,
      };
    } catch (err) {
      console.error("rewardVaultClient.getReward failed", { rewardId: rewardId.toString(), error: err });
      throw new Error(`Failed to fetch reward #${rewardId}: ${toError(err).message}`);
    }
  },

  async getSeason(seasonId: bigint): Promise<VaultSeason> {
    try {
      const raw = await withRetry(
        "rewardVaultClient.getSeason",
        () => readContract(config, { ...REWARD_VAULT_CONTRACT, functionName: "getSeason", args: [seasonId] }),
        MPGR_REWARD_VAULT_CONFIG.retry
      );
      const season = raw as unknown as RawSeasonTuple;
      return {
        seasonId: season.seasonId,
        startTime: season.startTime,
        endTime: season.endTime,
        totalAllocated: season.totalAllocated,
        totalClaimed: season.totalClaimed,
        finalized: season.finalized,
      };
    } catch (err) {
      console.error("rewardVaultClient.getSeason failed", { seasonId: seasonId.toString(), error: err });
      throw new Error(`Failed to fetch season #${seasonId}: ${toError(err).message}`);
    }
  },

  async isRewardClaimable(rewardId: bigint): Promise<boolean> {
    try {
      return await withRetry(
        "rewardVaultClient.isRewardClaimable",
        () =>
          readContract(config, {
            ...REWARD_VAULT_CONTRACT,
            functionName: "isRewardClaimable",
            args: [rewardId],
          }),
        MPGR_REWARD_VAULT_CONFIG.retry
      );
    } catch (err) {
      console.error("rewardVaultClient.isRewardClaimable failed", { rewardId: rewardId.toString(), error: err });
      throw new Error(`Failed to check claimability for reward #${rewardId}: ${toError(err).message}`);
    }
  },

  // --- Writes ----------------------------------------------------------------
  // Each returns the submitted transaction hash once the wallet accepts it.
  // Confirmation is a separate step (waitForReceipt) so callers can show a
  // "submitted, waiting for confirmation" state distinct from "wallet is
  // asking you to sign."

  async claim(rewardId: bigint): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...REWARD_VAULT_CONTRACT,
      functionName: "claim",
      args: [rewardId],
    });
    return writeContract(config, request);
  },

  async claimMultiple(rewardIds: bigint[]): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...REWARD_VAULT_CONTRACT,
      functionName: "claimMultiple",
      args: [rewardIds],
    });
    return writeContract(config, request);
  },

  async waitForReceipt(hash: Hash) {
    return waitForTransactionReceipt(config, { hash, chainId: MPGR_REWARD_VAULT_CONFIG.chainId });
  },
} as const;

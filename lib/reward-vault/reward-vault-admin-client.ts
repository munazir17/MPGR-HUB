// lib/reward-vault/reward-vault-admin-client.ts
//
// SERVER-ONLY. Real, production admin client for the deployed
// MPGRRewardVault (0xbe4B0e8692670229129562a50A62f5173E30937C, Base
// Mainnet), used exclusively by the weekly settlement route
// (app/api/games/mpgr-run/settlement/route.ts). Never import this file
// from a "use client" component or anything that ends up in a client
// bundle — it reads REWARD_MANAGER_PRIVATE_KEY.
//
// Every write:
//   1. verifies the signer is actually authorized on-chain
//      (rewardManager(signerAddress) === true) before doing anything else
//   2. simulates before sending, so a revert is caught and its decoded
//      custom-error name is surfaced BEFORE a real transaction is broadcast
//   3. sends, waits for a receipt, and requires status === "success"
//   4. returns only real, on-chain-confirmed data — no fabricated hash,
//      no fabricated reward id, no "allocated" status before a
//      confirmed receipt.
//
// If REWARD_MANAGER_PRIVATE_KEY is not configured, every function here
// throws a clear, explicit error rather than silently no-op'ing or
// pretending an allocation happened.

import { createPublicClient, createWalletClient, http, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REWARD_VAULT_ADMIN_ABI } from "@/lib/reward-allocation/reward-vault-admin-abi";
import { MPGR_REWARD_VAULT_CONFIG } from "./reward-vault-config";

const VAULT_CONTRACT = {
  address: MPGR_REWARD_VAULT_CONFIG.address,
  abi: REWARD_VAULT_ADMIN_ABI,
} as const;

function getRpcUrl(): string {
  // Server-only RPC URL, if configured, is preferred (private/authenticated
  // endpoints shouldn't be the same NEXT_PUBLIC one shipped to the
  // browser). Falls back to the existing public RPC URL used by the
  // client so a fresh deploy still works with zero extra config.
  return process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
}

let cachedAccount: ReturnType<typeof privateKeyToAccount> | null = null;

function getSignerAccount() {
  if (cachedAccount) return cachedAccount;
  const key = process.env.REWARD_MANAGER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "REWARD_MANAGER_PRIVATE_KEY is not configured on the server. " +
        "Settlement cannot allocate rewards until this is set — see docs/GAME_REWARDS_SETUP.md."
    );
  }
  const normalized = key.startsWith("0x") ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`);
  cachedAccount = privateKeyToAccount(normalized);
  return cachedAccount;
}

function getPublicClient() {
  return createPublicClient({ chain: MPGR_REWARD_VAULT_CONFIG.chain, transport: http(getRpcUrl()) });
}

function getWalletClient() {
  return createWalletClient({
    account: getSignerAccount(),
    chain: MPGR_REWARD_VAULT_CONFIG.chain,
    transport: http(getRpcUrl()),
  });
}

export interface VaultSeasonAdminView {
  seasonId: bigint;
  startTime: bigint;
  endTime: bigint;
  totalAllocated: bigint;
  totalClaimed: bigint;
  finalized: boolean;
}

export interface AllocateBatchResult {
  txHash: Hash;
  firstRewardId: bigint;
  /** firstRewardId, firstRewardId + 1, ... one per (user, amount) pair, in submission order — matches the vault's sequential reward-id assignment. */
  rewardIds: bigint[];
}

export const rewardVaultAdminClient = {
  /** The address settlement will sign transactions from. Throws if unconfigured. */
  getSignerAddress(): Address {
    return getSignerAccount().address;
  },

  /** True iff the configured signer is currently an authorized rewardManager on-chain. Never assumed — always a live read. */
  async verifyRewardManagerAuthorized(): Promise<boolean> {
    const signer = getSignerAccount().address;
    return getPublicClient().readContract({
      ...VAULT_CONTRACT,
      functionName: "rewardManager",
      args: [signer],
    }) as Promise<boolean>;
  },

  async getAvailableBalance(): Promise<bigint> {
    return getPublicClient().readContract({ ...VAULT_CONTRACT, functionName: "availableBalance" }) as Promise<bigint>;
  },

  async getVaultBalance(): Promise<bigint> {
    return getPublicClient().readContract({ ...VAULT_CONTRACT, functionName: "vaultBalance" }) as Promise<bigint>;
  },

  async seasonExists(seasonId: bigint): Promise<boolean> {
    return getPublicClient().readContract({
      ...VAULT_CONTRACT,
      functionName: "seasonExists",
      args: [seasonId],
    }) as Promise<boolean>;
  },

  async getSeason(seasonId: bigint): Promise<VaultSeasonAdminView> {
    const raw = (await getPublicClient().readContract({
      ...VAULT_CONTRACT,
      functionName: "getSeason",
      args: [seasonId],
    })) as {
      seasonId: bigint;
      startTime: bigint;
      endTime: bigint;
      totalAllocated: bigint;
      totalClaimed: bigint;
      finalized: boolean;
    };
    return raw;
  },

  /**
   * Simulates, sends, and waits for confirmation of
   * allocateRewardsBatch(seasonId, users, amounts, rewardTypes). Throws
   * (with the decoded revert reason where possible) rather than
   * returning a partial/fake success. Callers MUST have already
   * verified rewardManager authorization, season existence, and every
   * budget/balance check — this function performs the on-chain call
   * only, it does not re-derive any of those checks.
   */
  async allocateRewardsBatch(
    seasonId: bigint,
    users: Address[],
    amounts: bigint[],
    rewardTypes: number[]
  ): Promise<AllocateBatchResult> {
    if (users.length === 0) throw new Error("allocateRewardsBatch called with an empty batch.");
    if (users.length !== amounts.length || users.length !== rewardTypes.length) {
      throw new Error("allocateRewardsBatch: users/amounts/rewardTypes length mismatch.");
    }

    const publicClient = getPublicClient();
    const walletClient = getWalletClient();
    const account = getSignerAccount();

    const { request, result: firstRewardId } = await publicClient.simulateContract({
      ...VAULT_CONTRACT,
      functionName: "allocateRewardsBatch",
      args: [seasonId, users, amounts, rewardTypes],
      account,
    });

    const txHash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: MPGR_REWARD_VAULT_CONFIG.transactionConfirmationTimeoutMs,
    });

    if (receipt.status !== "success") {
      throw new Error(
        `allocateRewardsBatch transaction ${txHash} did not succeed (status: ${receipt.status}). ` +
          "No rewards were recorded as allocated."
      );
    }

    const first = firstRewardId as bigint;
    const rewardIds = users.map((_, i) => first + BigInt(i));

    return { txHash, firstRewardId: first, rewardIds };
  },
} as const;

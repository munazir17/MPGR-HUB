// lib/staking/staking-client.ts

import { readContract, writeContract, simulateContract, waitForTransactionReceipt } from "wagmi/actions";
import type { Address, Hash } from "viem";
import { config } from "@/lib/wagmi";
import { erc20Abi } from "@/lib/erc20-abi";
import { STAKING_ABI } from "./staking-abi";
import { MPGR_STAKING_CONFIG } from "./staking-config";

// Phase 3E Part 3 — Staking Client.
//
// Low-level wagmi/viem integration for the deployed MPGRStaking contract,
// mirroring lib/token/token-client.ts's shape exactly: pure RPC/wallet
// communication, no caching, no event emission. Reads throw on failure
// (never fabricate a fallback number); writes simulate before sending so a
// revert is caught and decoded (via STAKING_ABI's custom errors) BEFORE
// the wallet prompts the user to sign — no "sign a transaction that's
// guaranteed to fail" UX. Every call is pinned to Base Mainnet via
// MPGR_STAKING_CONFIG.chainId.

const STAKING_CONTRACT = {
  address: MPGR_STAKING_CONFIG.address,
  abi: STAKING_ABI,
  chainId: MPGR_STAKING_CONFIG.chainId,
} as const;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const stakingClient = {
  // --- Reads (wallet-independent) -----------------------------------------

  async getTotalStaked(): Promise<bigint> {
    try {
      return await readContract(config, { ...STAKING_CONTRACT, functionName: "totalStaked" });
    } catch (err) {
      console.error("stakingClient.getTotalStaked failed", { error: err });
      throw new Error(`Failed to fetch total staked: ${toError(err).message}`);
    }
  },

  async getRewardPoolBalance(): Promise<bigint> {
    try {
      return await readContract(config, { ...STAKING_CONTRACT, functionName: "rewardPoolBalance" });
    } catch (err) {
      console.error("stakingClient.getRewardPoolBalance failed", { error: err });
      throw new Error(`Failed to fetch reward pool balance: ${toError(err).message}`);
    }
  },

  async getCurrentAPRBps(): Promise<bigint> {
    try {
      return await readContract(config, { ...STAKING_CONTRACT, functionName: "currentAPRBps" });
    } catch (err) {
      console.error("stakingClient.getCurrentAPRBps failed", { error: err });
      throw new Error(`Failed to fetch current APR: ${toError(err).message}`);
    }
  },

  async getRewardState(): Promise<{
    rewardRate: bigint;
    periodFinish: bigint;
    lastUpdateTime: bigint;
    rewardPerTokenStored: bigint;
  }> {
    try {
      const result = await readContract(config, { ...STAKING_CONTRACT, functionName: "rewardState" });
      const [rewardRate, periodFinish, lastUpdateTime, rewardPerTokenStored] = result as unknown as [
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      return { rewardRate, periodFinish, lastUpdateTime, rewardPerTokenStored };
    } catch (err) {
      console.error("stakingClient.getRewardState failed", { error: err });
      throw new Error(`Failed to fetch reward state: ${toError(err).message}`);
    }
  },

  async isPaused(): Promise<boolean> {
    try {
      return await readContract(config, { ...STAKING_CONTRACT, functionName: "paused" });
    } catch (err) {
      console.error("stakingClient.isPaused failed", { error: err });
      throw new Error(`Failed to fetch pause status: ${toError(err).message}`);
    }
  },

  async getMinimumStake(): Promise<bigint> {
    try {
      return await readContract(config, { ...STAKING_CONTRACT, functionName: "MINIMUM_STAKE" });
    } catch (err) {
      console.error("stakingClient.getMinimumStake failed", { error: err });
      throw new Error(`Failed to fetch minimum stake: ${toError(err).message}`);
    }
  },

  // --- Reads (wallet-dependent) --------------------------------------------

  async getStakedBalance(walletAddress: Address): Promise<bigint> {
    try {
      return await readContract(config, {
        ...STAKING_CONTRACT,
        functionName: "balanceOf",
        args: [walletAddress],
      });
    } catch (err) {
      console.error("stakingClient.getStakedBalance failed", { walletAddress, error: err });
      throw new Error(`Failed to fetch staked balance: ${toError(err).message}`);
    }
  },

  async getEarnedRewards(walletAddress: Address): Promise<bigint> {
    try {
      return await readContract(config, {
        ...STAKING_CONTRACT,
        functionName: "earned",
        args: [walletAddress],
      });
    } catch (err) {
      console.error("stakingClient.getEarnedRewards failed", { walletAddress, error: err });
      throw new Error(`Failed to fetch earned rewards: ${toError(err).message}`);
    }
  },

  async getAllowance(owner: Address): Promise<bigint> {
    try {
      return await readContract(config, {
        address: MPGR_STAKING_CONFIG.stakingTokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, MPGR_STAKING_CONFIG.address],
      });
    } catch (err) {
      console.error("stakingClient.getAllowance failed", { owner, error: err });
      throw new Error(`Failed to fetch allowance: ${toError(err).message}`);
    }
  },

  // --- Writes ----------------------------------------------------------------
  // Each returns the submitted transaction hash once the wallet accepts it.
  // Confirmation is a separate step (waitForReceipt) so callers can show a
  // "submitted, waiting for confirmation" state distinct from "wallet is
  // asking you to sign."

  // MPGR (stakingTokenAddress) is a Base B20 native asset — its approve()
  // executes inside the chain's Rust precompile, not EVM bytecode. The
  // standard eth_estimateGas binary search that RPC nodes run is tuned for
  // ordinary contract bytecode and has been observed to converge on a gas
  // limit (44090) that is too low for the precompile's actual approve()
  // execution, producing an on-chain "out of gas" revert even though the
  // call is entirely valid. Passing an explicit `gas` here means
  // simulateContract never calls eth_estimateGas for this request, and the
  // returned `request.gas` — which writeContract sends unchanged — carries
  // this value instead of the flawed estimate. 150,000 gas is a generous
  // safety margin over a normal ERC20 approve's ~46,000 gas cost and leaves
  // headroom for the precompile's own accounting; adjust if a specific
  // deployment ever needs more.
  async approve(amount: bigint): Promise<Hash> {
    const B20_APPROVE_GAS_LIMIT = 150_000n;

    const { request } = await simulateContract(config, {
      address: MPGR_STAKING_CONFIG.stakingTokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [MPGR_STAKING_CONFIG.address, amount],
      chainId: MPGR_STAKING_CONFIG.chainId,
      gas: B20_APPROVE_GAS_LIMIT,
    });
    return writeContract(config, request);
  },

  async stake(amount: bigint): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...STAKING_CONTRACT,
      functionName: "stake",
      args: [amount],
    });
    return writeContract(config, request);
  },

  async unstake(amount: bigint): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...STAKING_CONTRACT,
      functionName: "unstake",
      args: [amount],
    });
    return writeContract(config, request);
  },

  async claimRewards(): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...STAKING_CONTRACT,
      functionName: "claimRewards",
    });
    return writeContract(config, request);
  },

  async exit(): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...STAKING_CONTRACT,
      functionName: "exit",
    });
    return writeContract(config, request);
  },

  async waitForReceipt(hash: Hash) {
    return waitForTransactionReceipt(config, { hash, chainId: MPGR_STAKING_CONFIG.chainId });
  },
} as const;

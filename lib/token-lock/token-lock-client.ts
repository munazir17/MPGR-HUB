// lib/token-lock/token-lock-client.ts

import { readContract, writeContract, simulateContract, waitForTransactionReceipt } from "wagmi/actions";
import type { Address, Hash } from "viem";
import { config } from "@/lib/wagmi";
import { erc20Abi } from "@/lib/erc20-abi";
import { TOKEN_LOCK_ABI } from "./token-lock-abi";
import { MPGR_TOKEN_LOCK_CONFIG } from "./token-lock-config";

// Low-level wagmi/viem integration for the deployed, immutable
// MPGRTokenLock V1 contract, mirroring lib/staking/staking-client.ts's
// shape exactly: pure RPC/wallet communication, no caching, no event
// emission, no mock data, no localStorage. Reads throw on failure (never
// fabricate a fallback number); writes simulate before sending so a
// revert is caught BEFORE the wallet prompts the user to sign. Every call
// is pinned to Base Mainnet via MPGR_TOKEN_LOCK_CONFIG.chainId.

const TOKEN_LOCK_CONTRACT = {
  address: MPGR_TOKEN_LOCK_CONFIG.address,
  abi: TOKEN_LOCK_ABI,
  chainId: MPGR_TOKEN_LOCK_CONFIG.chainId,
} as const;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const tokenLockClient = {
  // --- Reads (wallet-independent) -----------------------------------------

  async getMpgrTokenAddress(): Promise<Address> {
    try {
      return await readContract(config, { ...TOKEN_LOCK_CONTRACT, functionName: "mpgrToken" });
    } catch (err) {
      console.error("tokenLockClient.getMpgrTokenAddress failed", { error: err });
      throw new Error(`Failed to fetch configured MPGR token address: ${toError(err).message}`);
    }
  },

  async getPenaltyRecipient(): Promise<Address> {
    try {
      return await readContract(config, { ...TOKEN_LOCK_CONTRACT, functionName: "penaltyRecipient" });
    } catch (err) {
      console.error("tokenLockClient.getPenaltyRecipient failed", { error: err });
      throw new Error(`Failed to fetch penalty recipient: ${toError(err).message}`);
    }
  },

  async getTotalLocked(): Promise<bigint> {
    try {
      return await readContract(config, { ...TOKEN_LOCK_CONTRACT, functionName: "totalLocked" });
    } catch (err) {
      console.error("tokenLockClient.getTotalLocked failed", { error: err });
      throw new Error(`Failed to fetch total locked: ${toError(err).message}`);
    }
  },

  async getNextLockId(): Promise<bigint> {
    try {
      return await readContract(config, { ...TOKEN_LOCK_CONTRACT, functionName: "nextLockId" });
    } catch (err) {
      console.error("tokenLockClient.getNextLockId failed", { error: err });
      throw new Error(`Failed to fetch next lock id: ${toError(err).message}`);
    }
  },

  // --- Reads (wallet-dependent) --------------------------------------------

  async getLock(lockId: bigint): Promise<{
    amount: bigint;
    unlockTime: bigint;
    withdrawn: boolean;
    user: Address;
  }> {
    try {
      const result = await readContract(config, {
        ...TOKEN_LOCK_CONTRACT,
        functionName: "getLock",
        args: [lockId],
      });
      const [amount, unlockTime, withdrawn, user] = result as unknown as [bigint, bigint, boolean, Address];
      return { amount, unlockTime, withdrawn, user };
    } catch (err) {
      console.error("tokenLockClient.getLock failed", { lockId, error: err });
      throw new Error(`Failed to fetch lock #${lockId}: ${toError(err).message}`);
    }
  },

  async getUserLockIds(user: Address): Promise<bigint[]> {
    try {
      const result = await readContract(config, {
        ...TOKEN_LOCK_CONTRACT,
        functionName: "getUserLockIds",
        args: [user],
      });
      return [...(result as readonly bigint[])];
    } catch (err) {
      console.error("tokenLockClient.getUserLockIds failed", { user, error: err });
      throw new Error(`Failed to fetch your lock ids: ${toError(err).message}`);
    }
  },

  async getUserLockCount(user: Address): Promise<bigint> {
    try {
      return await readContract(config, {
        ...TOKEN_LOCK_CONTRACT,
        functionName: "getUserLockCount",
        args: [user],
      });
    } catch (err) {
      console.error("tokenLockClient.getUserLockCount failed", { user, error: err });
      throw new Error(`Failed to fetch your lock count: ${toError(err).message}`);
    }
  },

  async isLockUnlocked(lockId: bigint): Promise<boolean> {
    try {
      return await readContract(config, {
        ...TOKEN_LOCK_CONTRACT,
        functionName: "isLockUnlocked",
        args: [lockId],
      });
    } catch (err) {
      console.error("tokenLockClient.isLockUnlocked failed", { lockId, error: err });
      throw new Error(`Failed to check unlock status for lock #${lockId}: ${toError(err).message}`);
    }
  },

  async getLockStatus(lockId: bigint): Promise<string> {
    try {
      return await readContract(config, {
        ...TOKEN_LOCK_CONTRACT,
        functionName: "getLockStatus",
        args: [lockId],
      });
    } catch (err) {
      console.error("tokenLockClient.getLockStatus failed", { lockId, error: err });
      throw new Error(`Failed to fetch status for lock #${lockId}: ${toError(err).message}`);
    }
  },

  async getAllowance(owner: Address): Promise<bigint> {
    try {
      return await readContract(config, {
        address: MPGR_TOKEN_LOCK_CONFIG.mpgrTokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, MPGR_TOKEN_LOCK_CONFIG.address],
      });
    } catch (err) {
      console.error("tokenLockClient.getAllowance failed", { owner, error: err });
      throw new Error(`Failed to fetch allowance: ${toError(err).message}`);
    }
  },

  // --- Writes ----------------------------------------------------------------
  // Each returns the submitted transaction hash once the wallet accepts it.
  // Confirmation is a separate step (waitForReceipt) so callers can show a
  // "submitted, waiting for confirmation" state distinct from "wallet is
  // asking you to sign."

  // MPGR is a Base B20 native asset — its approve() executes inside the
  // chain's Rust precompile, not EVM bytecode. The standard
  // eth_estimateGas binary search RPC nodes run is tuned for ordinary
  // contract bytecode and has been observed to converge on a gas limit
  // (44090) too low for the precompile's actual approve() execution,
  // producing an on-chain "out of gas" revert even though the call is
  // entirely valid. Passing an explicit `gas` here means simulateContract
  // never calls eth_estimateGas for this request, and the returned
  // `request.gas` — which writeContract sends unchanged — carries this
  // value instead of the flawed estimate. This is the exact same
  // workaround and the same 150,000 gas margin already proven in
  // lib/staking/staking-client.ts's approve().
  async approve(amount: bigint): Promise<Hash> {
    const B20_APPROVE_GAS_LIMIT = 150_000n;

    const { request } = await simulateContract(config, {
      address: MPGR_TOKEN_LOCK_CONFIG.mpgrTokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [MPGR_TOKEN_LOCK_CONFIG.address, amount],
      chainId: MPGR_TOKEN_LOCK_CONFIG.chainId,
      gas: B20_APPROVE_GAS_LIMIT,
    });
    return writeContract(config, request);
  },

  async createLock(amount: bigint, unlockTime: bigint): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...TOKEN_LOCK_CONTRACT,
      functionName: "createLock",
      args: [amount, unlockTime],
    });
    return writeContract(config, request);
  },

  async withdraw(lockId: bigint): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...TOKEN_LOCK_CONTRACT,
      functionName: "withdraw",
      args: [lockId],
    });
    return writeContract(config, request);
  },

  async earlyUnlock(lockId: bigint): Promise<Hash> {
    const { request } = await simulateContract(config, {
      ...TOKEN_LOCK_CONTRACT,
      functionName: "earlyUnlock",
      args: [lockId],
    });
    return writeContract(config, request);
  },

  async waitForReceipt(hash: Hash) {
    return waitForTransactionReceipt(config, { hash, chainId: MPGR_TOKEN_LOCK_CONFIG.chainId });
  },
} as const;


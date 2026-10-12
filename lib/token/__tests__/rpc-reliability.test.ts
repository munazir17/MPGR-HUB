import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import {
  getRpcDiagnostics,
  isNonRetryableRpcError,
  resetRpcDiagnostics,
  sanitizeRpcErrorMessage,
  withRetry,
} from "../rpc-retry";
import { balanceService } from "../balance-service";
import { tokenClient } from "../token-client";
import { transactionHistoryService } from "../transaction-history-service";
import { transferEventReader } from "../transfer-event-reader";
import { stakingService } from "@/lib/staking/staking-service";
import { stakingClient } from "@/lib/staking/staking-client";
import { rewardVaultService } from "@/lib/reward-vault/reward-vault-service";
import { rewardVaultClient } from "@/lib/reward-vault/reward-vault-client";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;

describe("lib/token/rpc-retry — non-retryable classification and sanitization", () => {
  beforeEach(() => {
    resetRpcDiagnostics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies HTTP 400/-32600 Free-tier range cap, HTTP 403, -32602, and contract reverts as non-retryable", () => {
    expect(
      isNonRetryableRpcError(
        Object.assign(
          new Error(
            "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
          ),
          { code: -32600, status: 400 },
        ),
      ),
    ).toBe(true);
    expect(isNonRetryableRpcError(Object.assign(new Error("Forbidden"), { status: 403 }))).toBe(true);
    expect(isNonRetryableRpcError(Object.assign(new Error("Invalid params"), { code: -32602 }))).toBe(true);
    expect(
      isNonRetryableRpcError(
        Object.assign(new Error("The contract function reverted."), {
          name: "ContractFunctionRevertedError",
        }),
      ),
    ).toBe(true);
    expect(isNonRetryableRpcError(Object.assign(new Error("Too Many Requests"), { status: 429 }))).toBe(false);
    expect(isNonRetryableRpcError(new Error("network timeout"))).toBe(false);
  });

  it("does NOT retry deterministic non-retryable RPC errors and redacts URLs in diagnostics", async () => {
    let attempts = 0;
    const err = Object.assign(
      new Error(
        "HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/SUPER_SECRET_KEY_123 Details: Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
      ),
      { code: -32600, status: 400 },
    );

    await expect(
      withRetry(
        "test.getLogs",
        async () => {
          attempts += 1;
          throw err;
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
      ),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
    const diag = getRpcDiagnostics();
    expect(diag.totalCalls).toBe(1);
    expect(diag.totalFailures).toBe(1);
    expect(diag.totalRetries).toBe(0);
    expect(diag.lastError).toContain("https://base-mainnet.g.alchemy.com");
    expect(diag.lastError).not.toContain("SUPER_SECRET_KEY_123");
    expect(sanitizeRpcErrorMessage(err)).not.toContain("SUPER_SECRET_KEY_123");
  });

  it("retries transient RPC failures up to maxAttempts", async () => {
    let attempts = 0;
    const result = await withRetry(
      "test.transient",
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("Service Unavailable"), { status: 503 });
        }
        return 42n;
      },
      { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 15 },
    );

    expect(result).toBe(42n);
    expect(attempts).toBe(3);
    expect(getRpcDiagnostics().totalRetries).toBe(2);
  });
});

describe("in-flight RPC deduplication and completeness-aware history boundaries", () => {
  beforeEach(() => {
    balanceService.clearAllCache();
    transactionHistoryService.clearAllCache();
    stakingService.clearAllCache();
    rewardVaultService.clearAllCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces concurrent cold-cache balanceService.getRawBalance calls into one RPC read", async () => {
    const spy = vi.spyOn(tokenClient, "getBalanceRaw").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 500_000_000_000_000_000_000n;
    });

    const results = await Promise.all([
      balanceService.getRawBalance(WALLET),
      balanceService.getRawBalance(WALLET),
      balanceService.getRawBalance(WALLET),
      balanceService.getRawBalance(WALLET),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      500_000_000_000_000_000_000n,
      500_000_000_000_000_000_000n,
      500_000_000_000_000_000_000n,
      500_000_000_000_000_000_000n,
    ]);
  });

  it("coalesces concurrent transactionHistoryService.getHistory scans and does not advance lastBlockScanned when incomplete", async () => {
    const blockSpy = vi.spyOn(transferEventReader, "getLatestBlockNumber").mockResolvedValue(1_000_000n);
    const scanSpy = vi
      .spyOn(transferEventReader, "fetchTransfersWithStatus")
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { events: [], complete: false };
      })
      .mockImplementationOnce(async () => ({
        events: [],
        complete: true,
      }));

    // Two concurrent calls share one scan.
    await Promise.all([
      transactionHistoryService.getHistory(WALLET),
      transactionHistoryService.getHistory(WALLET),
    ]);
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(blockSpy).toHaveBeenCalledTimes(1);

    // Because complete was false on the first scan, the cache was NOT marked
    // complete at block 1_000_000, so the next call re-attempts the full window.
    await transactionHistoryService.getHistory(WALLET);
    expect(scanSpy).toHaveBeenCalledTimes(2);

    // Now that complete is true, subsequent calls hit the valid cache.
    await transactionHistoryService.getHistory(WALLET);
    expect(scanSpy).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent stakingService.getGlobalState and getWalletState calls", async () => {
    const totalStakedSpy = vi.spyOn(stakingClient, "getTotalStaked").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return 1000n;
    });
    vi.spyOn(stakingClient, "getRewardPoolBalance").mockResolvedValue(500n);
    vi.spyOn(stakingClient, "getCurrentAPRBps").mockResolvedValue(1200n);
    vi.spyOn(stakingClient, "getRewardState").mockResolvedValue({
      rewardRate: 1n,
      periodFinish: 999999n,
      lastUpdateTime: 100n,
      rewardPerTokenStored: 0n,
    });
    vi.spyOn(stakingClient, "isPaused").mockResolvedValue(false);
    vi.spyOn(stakingClient, "getMinimumStake").mockResolvedValue(100n);

    const stakedBalSpy = vi.spyOn(stakingClient, "getStakedBalance").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return 250n;
    });
    vi.spyOn(stakingClient, "getEarnedRewards").mockResolvedValue(10n);
    vi.spyOn(stakingClient, "getAllowance").mockResolvedValue(0n);
    vi.spyOn(stakingClient, "getUserRewardPerTokenPaid").mockResolvedValue(0n);
    vi.spyOn(stakingClient, "getAccruedRewards").mockResolvedValue(10n);

    await Promise.all([
      stakingService.getGlobalState(),
      stakingService.getGlobalState(),
      stakingService.getGlobalState(),
      stakingService.getWalletState(WALLET),
      stakingService.getWalletState(WALLET),
      stakingService.getWalletState(WALLET),
    ]);

    expect(totalStakedSpy).toHaveBeenCalledTimes(1);
    expect(stakedBalSpy).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent rewardVaultService.getWalletRewards calls", async () => {
    const idsSpy = vi.spyOn(rewardVaultClient, "getUserRewardIds").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return [];
    });

    await Promise.all([
      rewardVaultService.getWalletRewards(WALLET),
      rewardVaultService.getWalletRewards(WALLET),
      rewardVaultService.getWalletRewards(WALLET),
    ]);

    expect(idsSpy).toHaveBeenCalledTimes(1);
  });
});

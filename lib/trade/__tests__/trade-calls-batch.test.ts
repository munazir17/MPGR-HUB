// lib/trade/__tests__/trade-calls-batch.test.ts
//
// Unit suite for the EIP-5792 atomic-batch layer that collects the MPGR
// Agent fee inside the swap transaction.
//
// The safety contract under test:
//   - capability detection is fail-closed (anything unreadable → "do not
//     batch"), so a wallet that cannot batch never gets a batch attempt;
//   - a batch is requested with atomicRequired and WITHOUT viem's
//     sequential `experimental_fallback`, so it can never silently become
//     two transactions;
//   - only a genuine capability failure is distinguishable from a wallet
//     rejection or a real send failure;
//   - the poll loop reports success / failure / "could not confirm"
//     honestly and always terminates.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSendCalls,
  mockCallsStatus,
  mockCapabilities,
  mockBalance,
} = vi.hoisted(() => ({
  mockSendCalls: vi.fn(),
  mockCallsStatus: vi.fn(),
  mockCapabilities: vi.fn(),
  mockBalance: vi.fn(),
}));

vi.mock("wagmi/actions", () => ({
  sendCalls: (...args: unknown[]) => mockSendCalls(...args),
  getCallsStatus: (...args: unknown[]) => mockCallsStatus(...args),
  getCapabilities: (...args: unknown[]) => mockCapabilities(...args),
  getBalance: (...args: unknown[]) => mockBalance(...args),
}));

vi.mock("@/lib/wagmi", () => ({ config: {} }));

const {
  TRADE_CALLS_POLL_INTERVAL_MS,
  TRADE_CALLS_STATUS_TIMEOUT_MS,
  awaitAtomicSwapBatch,
  readNativeBalance,
  sendAtomicSwapBatch,
  setCallsBatchTimingForTests,
  supportsAtomicCallBatches,
} = await import("../trade-calls-batch");

const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const SWAP_TARGET = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const FEE_WALLET = "0x1111111111111111111111111111111111111111" as const;
const SWAP_HASH = "0x" + "aa".repeat(32);
const FEE_HASH = "0x" + "bb".repeat(32);

function erc20FeeCall() {
  return { to: FEE_WALLET, data: "0xa9059cbb" as `0x${string}`, value: 0n };
}

function statusAnswer(overrides?: {
  status?: "success" | "failure" | "pending";
  receipts?: unknown[];
}) {
  return {
    atomic: true,
    chainId: 8453,
    version: "2.0.0",
    statusCode: (overrides?.status ?? "success") === "success" ? 200 : 500,
    status: overrides?.status ?? "success",
    receipts: overrides?.receipts ?? [
      { transactionHash: SWAP_HASH, status: "success", blockNumber: 1n, gasUsed: 21_000n },
      { transactionHash: FEE_HASH, status: "success", blockNumber: 1n, gasUsed: 21_000n },
    ],
  };
}

describe("trade-calls-batch — capability detection", () => {
  beforeEach(() => {
    mockCapabilities.mockReset();
  });

  it("accepts the per-chain map shape", async () => {
    mockCapabilities.mockResolvedValue({ "8453": { atomic: { supported: true } } });
    await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(true);
  });

  it("accepts the direct per-chain shape (chainId requested)", async () => {
    mockCapabilities.mockResolvedValue({ atomic: { supported: true } });
    await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(true);
  });

  it("rejects atomic.supported === false", async () => {
    mockCapabilities.mockResolvedValue({ "8453": { atomic: { supported: false } } });
    await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(false);
  });

  it("rejects a capabilities answer with no atomic entry", async () => {
    mockCapabilities.mockResolvedValue({ "8453": { paymasterService: { supported: true } } });
    await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(false);
  });

  it("rejects capabilities published only for another chain", async () => {
    mockCapabilities.mockResolvedValue({ "1": { atomic: { supported: true } } });
    await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(false);
  });

  it("rejects malformed payloads instead of guessing", async () => {
    for (const payload of [null, undefined, "atomic", 42, [], { "8453": null }, { "8453": "x" }]) {
      mockCapabilities.mockResolvedValue(payload);
      await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(false);
    }
  });

  it("rejects a non-object atomic entry", async () => {
    mockCapabilities.mockResolvedValue({ "8453": { atomic: true } });
    await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(false);
  });

  it("is fail-closed when wallet_getCapabilities throws", async () => {
    mockCapabilities.mockRejectedValue(new Error("MethodNotFoundRpcError"));
    await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(false);
  });

  it("is fail-closed when the wallet returns a non-promise", async () => {
    mockCapabilities.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(supportsAtomicCallBatches(ACCOUNT)).resolves.toBe(false);
  });
});

describe("trade-calls-batch — sendAtomicSwapBatch", () => {
  const swapCall = {
    to: SWAP_TARGET,
    data: "0xdeadbeef" as `0x${string}`,
    value: 0n,
  };

  beforeEach(() => {
    mockSendCalls.mockReset();
  });

  it("requests ONE atomic batch of [swap, fee] with atomicRequired", async () => {
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    const result = await sendAtomicSwapBatch({ account: ACCOUNT, swapCall, feeCall: erc20FeeCall() });

    expect(result).toEqual({ ok: true, id: "0xbatch" });
    expect(mockSendCalls).toHaveBeenCalledTimes(1);
    const params = mockSendCalls.mock.calls[0][1] as Record<string, unknown>;
    expect(params.forceAtomic).toBe(true);
    expect(params.chainId).toBe(8453);
    expect(params.account).toBe(ACCOUNT);
    expect(params.calls).toEqual([
      { to: SWAP_TARGET, data: "0xdeadbeef", value: 0n },
      { to: FEE_WALLET, data: "0xa9059cbb", value: 0n },
    ]);
  });

  it("never asks viem for the sequential eth_sendTransaction fallback", async () => {
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    await sendAtomicSwapBatch({ account: ACCOUNT, swapCall, feeCall: erc20FeeCall() });
    const params = mockSendCalls.mock.calls[0][1] as Record<string, unknown>;
    expect(params.experimental_fallback).toBeUndefined();
    expect(params.experimental_fallbackDelay).toBeUndefined();
  });

  it("carries a native-ETH fee leg as a plain value transfer", async () => {
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    await sendAtomicSwapBatch({
      account: ACCOUNT,
      swapCall,
      feeCall: { to: FEE_WALLET, value: 2_500_000_000_000_000n },
    });
    const params = mockSendCalls.mock.calls[0][1] as { calls: Array<Record<string, unknown>> };
    expect(params.calls[1]).toEqual({ to: FEE_WALLET, value: 2_500_000_000_000_000n });
    expect(params.calls[1].data).toBeUndefined();
  });

  it("classifies a wallet rejection as wallet_rejected", async () => {
    mockSendCalls.mockRejectedValue(new Error("User rejected the request."));
    await expect(
      sendAtomicSwapBatch({ account: ACCOUNT, swapCall, feeCall: erc20FeeCall() }),
    ).resolves.toEqual({ ok: false, reason: "wallet_rejected" });
  });

  it("classifies a missing method as batch_unavailable", async () => {
    mockSendCalls.mockRejectedValue(new Error("MethodNotFoundRpcError: wallet_sendCalls"));
    await expect(
      sendAtomicSwapBatch({ account: ACCOUNT, swapCall, feeCall: erc20FeeCall() }),
    ).resolves.toEqual({ ok: false, reason: "batch_unavailable" });
  });

  it("classifies unsupported atomicity as batch_unavailable", async () => {
    mockSendCalls.mockRejectedValue(
      Object.assign(new Error("atomicRequired is not supported"), {
        name: "AtomicityNotSupportedError",
      }),
    );
    await expect(
      sendAtomicSwapBatch({ account: ACCOUNT, swapCall, feeCall: erc20FeeCall() }),
    ).resolves.toEqual({ ok: false, reason: "batch_unavailable" });
  });

  it("classifies the EIP-5792 transport message as batch_unavailable", async () => {
    mockSendCalls.mockRejectedValue(
      new Error("The method does not exist / is not available on this wallet"),
    );
    await expect(
      sendAtomicSwapBatch({ account: ACCOUNT, swapCall, feeCall: erc20FeeCall() }),
    ).resolves.toEqual({ ok: false, reason: "batch_unavailable" });
  });

  it("classifies an unknown failure as send_failed (never silently batched)", async () => {
    mockSendCalls.mockRejectedValue(new Error("wallet exploded"));
    await expect(
      sendAtomicSwapBatch({ account: ACCOUNT, swapCall, feeCall: erc20FeeCall() }),
    ).resolves.toEqual({ ok: false, reason: "send_failed" });
  });

  it("treats a missing batch id as a send failure", async () => {
    mockSendCalls.mockResolvedValue({});
    await expect(
      sendAtomicSwapBatch({ account: ACCOUNT, swapCall, feeCall: erc20FeeCall() }),
    ).resolves.toEqual({ ok: false, reason: "send_failed" });
  });
});

describe("trade-calls-batch — awaitAtomicSwapBatch", () => {
  beforeEach(() => {
    mockCallsStatus.mockReset();
    setCallsBatchTimingForTests({
      pollIntervalMs: TRADE_CALLS_POLL_INTERVAL_MS,
      statusTimeoutMs: TRADE_CALLS_STATUS_TIMEOUT_MS,
    });
  });

  it("returns both hashes in call order on success", async () => {
    mockCallsStatus.mockResolvedValue(statusAnswer());
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "success",
      swapHash: SWAP_HASH,
      feeHash: FEE_HASH,
    });
  });

  it("returns a null feeHash when the wallet reports one receipt", async () => {
    mockCallsStatus.mockResolvedValue(
      statusAnswer({
        receipts: [{ transactionHash: SWAP_HASH, status: "success", blockNumber: 1n, gasUsed: 1n }],
      }),
    );
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "success",
      swapHash: SWAP_HASH,
      feeHash: null,
    });
  });

  it("reports failure when the batch status is a failure", async () => {
    mockCallsStatus.mockResolvedValue(statusAnswer({ status: "failure" }));
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "failed",
      swapHash: SWAP_HASH,
    });
  });

  it("reports failure when any leg reverted", async () => {
    mockCallsStatus.mockResolvedValue(
      statusAnswer({
        receipts: [
          { transactionHash: SWAP_HASH, status: "reverted", blockNumber: 1n, gasUsed: 1n },
          { transactionHash: FEE_HASH, status: "success", blockNumber: 1n, gasUsed: 1n },
        ],
      }),
    );
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "failed",
      swapHash: SWAP_HASH,
    });
  });

  it("polls while the batch is pending, then succeeds", async () => {
    setCallsBatchTimingForTests({ pollIntervalMs: 1, statusTimeoutMs: 2_000 });
    mockCallsStatus
      .mockResolvedValueOnce(statusAnswer({ status: "pending", receipts: [] }))
      .mockResolvedValueOnce(statusAnswer());
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "success",
      swapHash: SWAP_HASH,
      feeHash: FEE_HASH,
    });
    expect(mockCallsStatus).toHaveBeenCalledTimes(2);
  });

  it("never reports failure for a status it simply cannot read", async () => {
    setCallsBatchTimingForTests({ pollIntervalMs: 1, statusTimeoutMs: 20 });
    mockCallsStatus.mockRejectedValue(new Error("wallet_getCallsStatus unavailable"));
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "unresolved",
      batchId: "0xbatch",
    });
  });

  it("never reports failure for a success status with no usable hash", async () => {
    mockCallsStatus.mockResolvedValue(
      statusAnswer({
        receipts: [{ transactionHash: "0xnotahash", status: "success", blockNumber: 1n, gasUsed: 1n }],
      }),
    );
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "unresolved",
      batchId: "0xbatch",
    });
  });

  it("never reports failure for a success status with no receipts at all", async () => {
    mockCallsStatus.mockResolvedValue(statusAnswer({ receipts: [] }));
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "unresolved",
      batchId: "0xbatch",
    });
  });

  it("always terminates, even when the status never becomes terminal", async () => {
    setCallsBatchTimingForTests({ pollIntervalMs: 1, statusTimeoutMs: 20 });
    mockCallsStatus.mockResolvedValue(statusAnswer({ status: "pending", receipts: [] }));
    await expect(awaitAtomicSwapBatch({ id: "0xbatch" })).resolves.toEqual({
      status: "unresolved",
      batchId: "0xbatch",
    });
  });
});

describe("trade-calls-batch — readNativeBalance", () => {
  beforeEach(() => {
    mockBalance.mockReset();
  });

  it("returns the bigint balance", async () => {
    mockBalance.mockResolvedValue(1_000_000_000_000_000_000n);
    await expect(readNativeBalance(ACCOUNT)).resolves.toBe(1_000_000_000_000_000_000n);
  });

  it("returns null when the read throws (fail-closed for the fee)", async () => {
    mockBalance.mockRejectedValue(new Error("rpc down"));
    await expect(readNativeBalance(ACCOUNT)).resolves.toBeNull();
  });

  it("returns null on a non-bigint answer", async () => {
    mockBalance.mockResolvedValue("1000");
    await expect(readNativeBalance(ACCOUNT)).resolves.toBeNull();
  });
});

describe("trade-calls-batch — timing constants", () => {
  it("uses a bounded poll cadence and timeout", () => {
    expect(TRADE_CALLS_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(TRADE_CALLS_POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    expect(TRADE_CALLS_STATUS_TIMEOUT_MS).toBeGreaterThan(TRADE_CALLS_POLL_INTERVAL_MS);
    expect(TRADE_CALLS_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  });
});

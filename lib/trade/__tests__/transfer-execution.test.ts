import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { TransferProposal } from "../transfer-types";

const { mockSend, mockWait } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockWait: vi.fn(),
}));

vi.mock("wagmi/actions", () => ({
  sendTransaction: (...args: unknown[]) => mockSend(...args),
  waitForTransactionReceipt: (...args: unknown[]) => mockWait(...args),
}));

vi.mock("@/lib/wagmi", () => ({ config: {} }));

const { executeTransfer } = await import("../transfer-execution");
const { buildTransferProposal } = await import("../transfer-proposal");

const SENDER: Address = "0x2222222222222222222222222222222222222222";
const RECIPIENT: Address = "0x3333333333333333333333333333333333333333";
const USDC: Address = "0x4200000000000000000000000000000000000006";

function makeNativeProposal(overrides?: {
  id?: string;
  quotedAt?: string;
  sufficientBalance?: boolean;
}): TransferProposal {
  return {
    id: overrides?.id ?? "transfer-test-native",
    kind: "native-transfer" as const,
    network: "base" as const,
    chainId: 8453 as const,
    asset: {
      address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address,
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
      kind: "native" as const,
      verified: true,
    },
    amount: "10000000000000000",
    sender: SENDER,
    recipient: {
      input: RECIPIENT,
      inputKind: "address" as const,
      address: RECIPIENT,
      basename: null,
    },
    senderBalance: "1000000000000000000",
    sufficientBalance: overrides?.sufficientBalance ?? true,
    transaction: {
      to: RECIPIENT,
      data: "0x" as `0x${string}`,
      value: "10000000000000000",
    },
    quotedAt: overrides?.quotedAt ?? new Date().toISOString(),
    risk: [],
    warnings: [],
    displayAmount: "0.01 ETH",
    description: "Send 0.01 ETH",
    requiresConfirmation: true,
    phase: "idle" as const,
  };
}

function makeUsdcProposal(overrides?: {
  quotedAt?: string;
  sufficientBalance?: boolean;
}): TransferProposal {
  return {
    id: "transfer-test-usdc",
    kind: "erc20-transfer" as const,
    network: "base" as const,
    chainId: 8453 as const,
    asset: {
      address: USDC as Address,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      kind: "erc20" as const,
      verified: true,
    },
    amount: "1000000",
    sender: SENDER,
    recipient: {
      input: RECIPIENT,
      inputKind: "address" as const,
      address: RECIPIENT,
      basename: null,
    },
    senderBalance: "50000000",
    sufficientBalance: overrides?.sufficientBalance ?? true,
    transaction: {
      to: USDC,
      data: "0xa9059cbb00000000000000000000000033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000f4240" as `0x${string}`,
      value: "0",
    },
    quotedAt: overrides?.quotedAt ?? new Date().toISOString(),
    risk: [],
    warnings: [],
    displayAmount: "1 USDC",
    description: "Send 1 USDC",
    requiresConfirmation: true,
    phase: "idle" as const,
  };
}

describe("executeTransfer", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockWait.mockReset();
  });

  it("does not touch the wallet when confirmation is not READY", async () => {
    const snapshots: string[] = [];

    const result = await executeTransfer(
      {
        proposal: makeNativeProposal(),
        confirmationState: "VALIDATING",
        currentAccount: SENDER,
        currentChainId: 8453,
      },
      (s) => snapshots.push(s.state),
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(snapshots.at(-1)).toBe("ERROR");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not touch the wallet on the wrong network", async () => {
    const result = await executeTransfer(
      {
        proposal: makeNativeProposal(),
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 1,
      },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("UNSUPPORTED_NETWORK");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends a native Base transfer and verifies the receipt", async () => {
    mockSend.mockResolvedValue("0x" + "11".repeat(32));
    mockWait.mockResolvedValue({ status: "success" });

    const proposal = makeNativeProposal();

    const result = await executeTransfer(
      {
        proposal,
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.txHash).toBe("0x" + "11".repeat(32));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockWait).toHaveBeenCalledTimes(1);

    const tx = mockSend.mock.calls[0][1] as {
      account: string;
      chainId: number;
      to: string;
      data: string;
      value: bigint;
    };

    expect(tx.account.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(tx.chainId).toBe(8453);
    expect(tx.to.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(tx.data).toBe("0x");
    expect(tx.value).toBe(BigInt(proposal.transaction.value));
  });

  it("sends an ERC-20 transfer using the exact server-built calldata", async () => {
    mockSend.mockResolvedValue("0x" + "22".repeat(32));
    mockWait.mockResolvedValue({ status: "success" });

    const proposal = makeUsdcProposal();

    const result = await executeTransfer(
      {
        proposal,
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(mockSend).toHaveBeenCalledTimes(1);

    const tx = mockSend.mock.calls[0][1] as {
      account: string;
      chainId: number;
      to: string;
      data: string;
      value: bigint;
    };

    expect(tx.account.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(tx.chainId).toBe(8453);
    expect(tx.to.toLowerCase()).toBe(proposal.transaction.to.toLowerCase());
    expect(tx.data).toBe(proposal.transaction.data);
    expect(tx.value).toBe(0n);
  });

  it("classifies a rejected wallet request as WALLET_REJECTED", async () => {
    mockSend.mockRejectedValue(new Error("User rejected the request"));

    const result = await executeTransfer(
      {
        proposal: makeNativeProposal(),
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WALLET_REJECTED");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockWait).not.toHaveBeenCalled();
  });

  it("reports a failed on-chain receipt as SEND_FAILED", async () => {
    mockSend.mockResolvedValue("0x" + "33".repeat(32));
    mockWait.mockResolvedValue({ status: "reverted" });

    const result = await executeTransfer(
      {
        proposal: makeNativeProposal(),
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SEND_FAILED");
    expect(result.txHash).toBe("0x" + "33".repeat(32));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockWait).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale proposal when no refresh function is supplied", async () => {
    const proposal = makeNativeProposal({
      quotedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const result = await executeTransfer(
      {
        proposal,
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("EXECUTION_UNAVAILABLE");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("re-quotes a stale proposal before sending", async () => {
    mockSend.mockResolvedValue("0x" + "44".repeat(32));
    mockWait.mockResolvedValue({ status: "success" });

    const proposal = makeNativeProposal({
      quotedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const refreshed = makeNativeProposal();

    const refreshProposal = vi.fn().mockResolvedValue(refreshed);

    const result = await executeTransfer(
      {
        proposal,
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
        refreshProposal,
      },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(refreshProposal).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("rejects a refreshed proposal that changes the recipient", async () => {
    const proposal = makeNativeProposal();
    const changed = makeNativeProposal();
    changed.recipient = {
      ...changed.recipient,
      address: "0x4444444444444444444444444444444444444444" as Address,
    };

    const refreshProposal = vi.fn().mockResolvedValue(changed);

    const result = await executeTransfer(
      {
        proposal: {
          ...proposal,
          quotedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
        refreshProposal,
      },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("blocks a duplicate in-flight execution for the same account and proposal", async () => {
    let release!: (value: { status: "success" }) => void;

    mockSend.mockResolvedValue("0x" + "55".repeat(32));
    mockWait.mockReturnValue(
      new Promise<{ status: "success" }>((resolve) => {
        release = resolve;
      }),
    );

    const proposal = makeNativeProposal();

    const first = executeTransfer(
      {
        proposal,
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
      },
      () => {},
    );

    while (mockSend.mock.calls.length !== 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const second = await executeTransfer(
      {
        proposal,
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: SENDER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(second.state).toBe("ERROR");
    expect(second.error?.code).toBe("SEND_FAILED");
    expect(mockSend).toHaveBeenCalledTimes(1);

    release({ status: "success" });
    const firstResult = await first;

    expect(firstResult.state).toBe("SUCCESS");
  });
});

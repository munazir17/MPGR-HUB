import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend, mockSign, mockWait, mockRead, mockSendCalls, mockCapabilities } = vi.hoisted(
  () => ({
    mockSend: vi.fn(),
    mockSign: vi.fn(),
    mockWait: vi.fn(),
    mockRead: vi.fn(),
    mockSendCalls: vi.fn(),
    mockCapabilities: vi.fn(),
  }),
);

vi.mock("wagmi/actions", () => ({
  sendTransaction: (...args: unknown[]) => mockSend(...args),
  signTypedData: (...args: unknown[]) => mockSign(...args),
  waitForTransactionReceipt: (...args: unknown[]) => mockWait(...args),
  readContract: (...args: unknown[]) => mockRead(...args),
  sendCalls: (...args: unknown[]) => mockSendCalls(...args),
  getCallsStatus: vi.fn(),
  getCapabilities: (...args: unknown[]) => mockCapabilities(...args),
  getBalance: vi.fn(),
}));

vi.mock("@/lib/wagmi", () => ({ config: {} }));

const { executeTrade } = await import("../trade-execution");
const { buildTradeProposal } = await import("../trade-proposal");
const { BASE_USDC, BASE_WETH, PERMIT2_ADDRESS } = await import("../trade-config");

const TAKER = "0x2222222222222222222222222222222222222222";

function makeProposal(overrides?: { permit2?: boolean; allowance?: boolean }) {
  const built = buildTradeProposal({
    from: {
      address: BASE_USDC,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      kind: "erc20",
      verified: true,
    },
    to: {
      address: BASE_WETH,
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
      kind: "erc20",
      verified: true,
    },
    quote: {
      liquidityAvailable: true,
      fromToken: BASE_USDC,
      toToken: BASE_WETH,
      fromAmount: "1000000",
      toAmount: "400000000000000",
      minToAmount: "396000000000000",
      issues: {
        allowance: overrides?.allowance
          ? { currentAllowance: "0", spender: PERMIT2_ADDRESS }
          : null,
        balance: null,
        simulationIncomplete: false,
      },
      transaction: { to: PERMIT2_ADDRESS, data: "0xabcd", value: "0", gas: "210000" },
      permit2: overrides?.permit2
        ? {
            eip712: {
              domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS },
              types: {
                EIP712Domain: [{ name: "name", type: "string" }],
                PermitTransferFrom: [{ name: "spender", type: "address" }],
              },
              primaryType: "PermitTransferFrom",
              message: { spender: PERMIT2_ADDRESS },
            },
          }
        : null,
    },
    slippageBps: 100,
    taker: TAKER,
  });
  if (!built.ok) throw new Error("setup");
  return built.proposal;
}

describe("executeTrade", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSign.mockReset();
    mockWait.mockReset();
    mockRead.mockReset();
    mockSendCalls.mockReset();
    mockCapabilities.mockReset();
    // Default: the wallet does NOT advertise atomic batches on Base, so
    // every case here exercises the plain swap path.
    mockCapabilities.mockResolvedValue(undefined);
    // Pre-broadcast funds guard: the wallet is funded for every case here.
    // The allowance stays short so the approval steps these tests assert
    // still run (a covering allowance is covered by the funds-safety suite).
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 10_000_000n;
      if (params?.functionName === "allowance") return 0n;
      throw new Error(`unexpected read: ${String(params?.functionName)}`);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not touch the wallet when confirmation is not READY", async () => {
    const snapshots: string[] = [];
    await executeTrade(
      {
        proposal: makeProposal(),
        confirmationState: "VALIDATING",
        currentAccount: TAKER,
        currentChainId: 8453,
      },
      (s) => snapshots.push(s.state),
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toBe("ERROR");
  });

  it("approve → permit → swap when CDP requires both", async () => {
    mockSend
      .mockResolvedValueOnce("0xapprove")
      .mockResolvedValueOnce("0xswap");
    mockWait.mockResolvedValue({ status: "success" });
    mockSign.mockResolvedValue("0x" + "11".repeat(65));

    const result = await executeTrade(
      {
        proposal: makeProposal({ permit2: true, allowance: true }),
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: TAKER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBe("0xapprove");
    expect(result.swapHash).toBe("0xswap");
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSign).toHaveBeenCalledTimes(1);
    const typed = mockSign.mock.calls[0][1] as { types: Record<string, unknown> };
    expect(typed.types.EIP712Domain).toBeUndefined();
  });

  it("approve SwapRouter then swap for Aerodrome B20 — never signs Permit2", async () => {
    const { AERODROME_SLIPSTREAM_SWAP_ROUTER, AERODROME_SLIPSTREAM_PROVIDER_ID } =
      await import("../trade-config");
    const { COINBASE_B20_TOKENIZED_STOCKS } = await import("../tokenized-stocks");
    const aapl = COINBASE_B20_TOKENIZED_STOCKS[0].address;
    const built = buildTradeProposal({
      from: {
        address: BASE_USDC,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        kind: "erc20",
        verified: true,
      },
      to: {
        address: aapl,
        symbol: "AAPLc",
        name: "Apple Tokenized Stock (Coinbase)",
        decimals: 8,
        kind: "b20-tokenized-stock",
        verified: true,
      },
      quote: {
        liquidityAvailable: true,
        fromToken: BASE_USDC,
        toToken: aapl,
        fromAmount: "1000000",
        toAmount: "318834",
        minToAmount: "315645",
        issues: {
          allowance: { currentAllowance: "0", spender: AERODROME_SLIPSTREAM_SWAP_ROUTER },
          balance: null,
          simulationIncomplete: false,
        },
        transaction: { to: AERODROME_SLIPSTREAM_SWAP_ROUTER, data: "0xabcd", value: "0" },
        permit2: null,
      },
      slippageBps: 100,
      taker: TAKER,
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    });
    if (!built.ok) throw new Error("setup");

    mockSend.mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xswap");
    mockWait.mockResolvedValue({ status: "success" });

    const result = await executeTrade(
      {
        proposal: built.proposal,
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: TAKER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBe("0xapprove");
    expect(result.swapHash).toBe("0xswap");
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSign).not.toHaveBeenCalled();
    const swapTx = mockSend.mock.calls[1][1] as { to: string };
    expect(swapTx.to.toLowerCase()).toBe(AERODROME_SLIPSTREAM_SWAP_ROUTER.toLowerCase());
  });

  // The 2-step UX invariant, locked at the execution layer: a quoted fee on
  // a wallet that cannot batch must NOT add a third transaction, and must
  // not change the swap calldata, the approval, or the outcome.
  it("a quoted fee on a non-batching wallet never adds a third transaction", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT",
      "0x1111111111111111111111111111111111111111",
    );
    const withFee = makeProposal({ allowance: true });
    mockSend.mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xswap");
    mockWait.mockResolvedValue({ status: "success" });

    const result = await executeTrade(
      {
        proposal: withFee,
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: TAKER,
        currentChainId: 8453,
      },
      () => {},
    );

    // The fee WAS quoted…
    expect(withFee.agentFee?.status).toBe("applied");
    expect(withFee.agentFee?.amountAtomic).toBe("2500"); // 0.25% of 1 USDC
    // …but the wallet cannot batch, so the swap goes out unchanged.
    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBe("0xapprove");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeHash).toBeNull();
    expect(result.feeSkippedReason).toMatch(/does not support atomic batch calls/);
    // Exactly two wallet interactions: the approval and the swap.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSendCalls).not.toHaveBeenCalled();
    // The swap transaction is still the quoted one, byte for byte.
    const swapTx = mockSend.mock.calls[1][1] as { to: string; data: string; gas: bigint };
    expect(swapTx.to).toBe(PERMIT2_ADDRESS);
    expect(swapTx.data).toBe("0xabcd");
    expect(swapTx.gas).toBe(210000n);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend, mockSign, mockWait, mockRead } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSign: vi.fn(),
  mockWait: vi.fn(),
  mockRead: vi.fn(),
}));

vi.mock("wagmi/actions", () => ({
  sendTransaction: (...args: unknown[]) => mockSend(...args),
  signTypedData: (...args: unknown[]) => mockSign(...args),
  waitForTransactionReceipt: (...args: unknown[]) => mockWait(...args),
  readContract: (...args: unknown[]) => mockRead(...args),
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
    // Pre-broadcast funds guard: the wallet is funded for every case here.
    // The allowance stays short so the approval steps these tests assert
    // still run (a covering allowance is covered by the funds-safety suite).
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 10_000_000n;
      if (params?.functionName === "allowance") return 0n;
      throw new Error(`unexpected read: ${String(params?.functionName)}`);
    });
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

  it.each([
    ["wrong chain", { chainId: 1 }, "UNSUPPORTED_NETWORK"],
    ["missing confirmation", { requiresConfirmation: false }, "INVALID_INPUT"],
    ["changed slippage", { slippageBps: 9999 }, "QUOTE_CHANGED"],
    ["unfunded refreshed quote", { issues: { allowance: null, balance: { token: BASE_USDC, currentBalance: "0", requiredBalance: "1000000" }, simulationIncomplete: false } }, "INSUFFICIENT_BALANCE"],
  ])("validates the refreshed proposal before any wallet calls: %s", async (_name, changed, code) => {
    const old = { ...makeProposal(), quotedAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString() };
    const fresh = { ...makeProposal(), ...changed } as typeof old;
    const result = await executeTrade({
      proposal: old,
      confirmationState: "READY_FOR_CONFIRMATION",
      currentAccount: TAKER,
      currentChainId: 8453,
      refreshQuote: async () => fresh,
    }, () => {});
    expect(result).toMatchObject({ state: "ERROR", error: { code } });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });


  it.each([
    { slippageBps: 50 },
    { provider: "0x-swap-api" },
    { transaction: { to: "0x1111111111111111111111111111111111111111", data: "0xabcd", value: "0" } },
  ])("requires review again if refreshed route or execution parameters change: %j", async changed => {
    const old = { ...makeProposal(), quotedAt: new Date(0).toISOString() };
    const result = await executeTrade({ proposal: old, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453,
      refreshQuote: async () => ({ ...makeProposal(), ...changed }) as typeof old,
    }, () => {});
    expect(result).toMatchObject({ state: "ERROR", error: { code: "QUOTE_CHANGED" } });
    expect(mockSend).not.toHaveBeenCalled(); expect(mockSign).not.toHaveBeenCalled();
  });

  it("reports a reverted swap cleanly and never charges a fee", async () => {
    mockSend.mockResolvedValue("0xswap"); mockWait.mockResolvedValue({ status: "reverted" });
    const result = await executeTrade({ proposal: makeProposal(), confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 }, () => {});
    expect(result).toMatchObject({ state: "ERROR", swapHash: "0xswap", error: { code: "SEND_FAILED", message: "The swap transaction failed on Base." } });
    expect(mockSend).toHaveBeenCalledTimes(1); expect(mockSign).not.toHaveBeenCalled();
  });

  it("preserves a submitted swap hash and reports unknown confirmation without resending or charging a fee", async () => {
    mockSend.mockResolvedValue("0xswap");
    mockWait.mockRejectedValue(new Error("RPC timeout https://rpc.invalid/private-credential"));
    const result = await executeTrade({
      proposal: makeProposal(), confirmationState: "READY_FOR_CONFIRMATION",
      currentAccount: TAKER, currentChainId: 8453,
    }, () => {});
    expect(result).toMatchObject({ state: "ERROR", swapHash: "0xswap", error: { code: "PROVIDER_ERROR" } });
    expect(result.error?.message).toContain("status is unknown");
    expect(result.error?.message).not.toContain("private-credential");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSign).not.toHaveBeenCalled();
  });

});

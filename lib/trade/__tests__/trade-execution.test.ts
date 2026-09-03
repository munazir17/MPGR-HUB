import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSend, mockSign, mockWait } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSign: vi.fn(),
  mockWait: vi.fn(),
}));

vi.mock("wagmi/actions", () => ({
  sendTransaction: (...args: unknown[]) => mockSend(...args),
  signTypedData: (...args: unknown[]) => mockSign(...args),
  waitForTransactionReceipt: (...args: unknown[]) => mockWait(...args),
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
});

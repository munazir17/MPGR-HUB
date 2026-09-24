// lib/trade/__tests__/trade-0x-native-fee.test.ts
//
// Provider-native MPGR Agent fee on the 0x AllowanceHolder path.
//
// 0x Swap API v2 can embed our fee in the swap transaction it generates:
//   swapFeeRecipient, swapFeeBps = 25, swapFeeToken = sellToken
// The fee is then part of the provider's own settlement, so this app
// must NOT send a separate fee transfer or an atomic fee batch.
//
// Invariants under test:
//   - the native fee is only requested when it is FAITHFUL: the sell
//     token must be a real ERC-20, because 0x requires swapFeeToken to
//     be buyToken or sellToken and our fee is 25 bps of fromAmount in
//     the SELL token. Native-ETH sells are excluded (the only legal fee
//     token would be the buy token = a buy-side fee = wrong economics).
//   - the fee stays exactly floor(fromAmount * 25 / 10_000) in the sell
//     token — never silently becomes a buy-side/output fee.
//   - a provider-reported fee in an unexpected token/amount fails closed
//     to the app's own collection instead of being displayed as 25 bps.
//   - when the fee IS provider-native, execution sends exactly ONE
//     transaction and never a fee transfer or a batch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FEE_WALLET = "0x1111111111111111111111111111111111111111" as const;
const TAKER = "0x2222222222222222222222222222222222222222" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const NATIVE_ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

vi.mock("../trade-jwt", () => ({ generateCdpJwt: vi.fn(() => "a.b.c") }));

const { getZeroExSwapPrice, zeroExNativeFeeEligible } = await import("../trade-0x-client");
const { buildProposalAgentFee, resolveExecutionAgentFee } = await import("../trade-agent-fee");
const { buildTradeProposal } = await import("../trade-proposal");
import type { ZeroExSwapRequest } from "../trade-0x-client";

type Request = ZeroExSwapRequest;

function baseRequest(overrides?: Partial<Request>): Request {
  return {
    fromToken: USDC,
    toToken: WETH,
    fromAmount: "10000000", // 10 USDC
    taker: TAKER,
    slippageBps: 100,
    ...overrides,
  };
}

const USDC_TOKEN = {
  address: USDC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  kind: "erc20" as const,
  verified: true,
};

const WETH_TOKEN = {
  address: WETH,
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
  kind: "erc20" as const,
  verified: true,
};

/** 25 bps of 10 USDC = 0.025 USDC = 25000 base units. */
const EXPECTED_FEE = 25_000n;

describe("0x native fee — eligibility gate", () => {
  it("allows an ERC-20 sell token", () => {
    expect(
      zeroExNativeFeeEligible(baseRequest({ agentFee: { recipient: FEE_WALLET, bps: 25 } })),
    ).toBe(true);
  });

  it("refuses when no fee is configured", () => {
    expect(zeroExNativeFeeEligible(baseRequest())).toBe(false);
    expect(zeroExNativeFeeEligible(baseRequest({ agentFee: null }))).toBe(false);
  });

  it("refuses an invalid or zero fee recipient", () => {
    expect(
      zeroExNativeFeeEligible(baseRequest({ agentFee: { recipient: "not-an-address", bps: 25 } })),
    ).toBe(false);
    expect(
      zeroExNativeFeeEligible(
        baseRequest({ agentFee: { recipient: `0x${"0".repeat(40)}`, bps: 25 } }),
      ),
    ).toBe(false);
  });

  it("refuses a bps value outside 0x's 0–1000 range", () => {
    for (const bps of [0, -25, 1001, 1.5]) {
      expect(
        zeroExNativeFeeEligible(baseRequest({ agentFee: { recipient: FEE_WALLET, bps } })),
      ).toBe(false);
    }
    expect(
      zeroExNativeFeeEligible(baseRequest({ agentFee: { recipient: FEE_WALLET, bps: 1000 } })),
    ).toBe(true);
  });

  it("refuses a native-ETH sell — the only legal fee token would be the buy token", () => {
    // Selling native ETH: swapFeeToken must be buyToken or sellToken, and
    // the sentinel is not a contract address. Using buyToken would turn
    // the fee into a BUY-side fee, which is a different economic model.
    expect(
      zeroExNativeFeeEligible(
        baseRequest({
          fromToken: NATIVE_ETH_SENTINEL,
          toToken: USDC,
          fromAmount: "1000000000000000000",
          agentFee: { recipient: FEE_WALLET, bps: 25 },
        }),
      ),
    ).toBe(false);
  });

  it("allows an ERC-20 sell even when the BUY token is native ETH", () => {
    // swapFeeToken stays the sell token (USDC), which is still valid.
    expect(
      zeroExNativeFeeEligible(
        baseRequest({
          fromToken: USDC,
          toToken: NATIVE_ETH_SENTINEL,
          agentFee: { recipient: FEE_WALLET, bps: 25 },
        }),
      ),
    ).toBe(true);
  });

  it("allows WETH as the sell token (a normal ERC-20)", () => {
    expect(
      zeroExNativeFeeEligible(
        baseRequest({
          fromToken: WETH,
          toToken: USDC,
          fromAmount: "1000000000000000000",
          agentFee: { recipient: FEE_WALLET, bps: 25 },
        }),
      ),
    ).toBe(true);
  });
});

describe("0x native fee — request parameters", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("ZERO_EX_API_KEY", "test-key");
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          liquidityAvailable: true,
          sellToken: USDC,
          buyToken: WETH,
          sellAmount: "10000000",
          buyAmount: "400000000000000",
          minBuyAmount: "396000000000000",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function requestedParams(): URLSearchParams {
    const url = String(fetchMock.mock.calls[0]?.[0] ?? "");
    const query = url.slice(url.indexOf("?") + 1);
    return new URLSearchParams(query);
  }

  it("sends swapFeeRecipient/swapFeeBps/swapFeeToken on the AllowanceHolder path", async () => {
    await getZeroExSwapPrice(baseRequest({ agentFee: { recipient: FEE_WALLET, bps: 25 } }));

    const params = requestedParams();
    expect(params.get("swapFeeRecipient")).toBe(FEE_WALLET);
    expect(params.get("swapFeeBps")).toBe("25");
    // Always the SELL token — keeps the fee at 25 bps of fromAmount.
    expect(params.get("swapFeeToken")).toBe(USDC);
    // The AllowanceHolder path is preserved (not switched to Permit2).
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/swap/allowance-holder/price");
    // Existing params are untouched.
    expect(params.get("chainId")).toBe("8453");
    expect(params.get("sellToken")).toBe(USDC);
    expect(params.get("buyToken")).toBe(WETH);
    expect(params.get("sellAmount")).toBe("10000000");
    expect(params.get("taker")).toBe(TAKER);
    expect(params.get("slippageBps")).toBe("100");
  });

  it("omits every fee param when the fee is not eligible", async () => {
    await getZeroExSwapPrice(
      baseRequest({
        fromToken: NATIVE_ETH_SENTINEL,
        toToken: USDC,
        agentFee: { recipient: FEE_WALLET, bps: 25 },
      }),
    );

    const params = requestedParams();
    expect(params.has("swapFeeRecipient")).toBe(false);
    expect(params.has("swapFeeBps")).toBe(false);
    expect(params.has("swapFeeToken")).toBe(false);
  });

  it("omits every fee param when no fee is configured at all", async () => {
    await getZeroExSwapPrice(baseRequest());
    const params = requestedParams();
    expect(params.has("swapFeeRecipient")).toBe(false);
    expect(params.has("swapFeeBps")).toBe(false);
    expect(params.has("swapFeeToken")).toBe(false);
  });
});

describe("0x native fee — returned fee parsing", () => {
  function priceWithFees(fees: unknown): Promise<unknown> {
    return Promise.resolve({
      liquidityAvailable: true,
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: "10000000",
      buyAmount: "400000000000000",
      minBuyAmount: "396000000000000",
      fees,
    });
  }

  it("parses fees.integratorFee into the quote", async () => {
    vi.stubEnv("ZERO_EX_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            await priceWithFees({
              integratorFee: { amount: "25000", token: USDC, type: "volume" },
              gasFee: { amount: "100", token: "0x0000000000000000000000000000000000000000" },
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await getZeroExSwapPrice(
      baseRequest({ agentFee: { recipient: FEE_WALLET, bps: 25 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fee 0x reports is exactly 25 bps of the 10 USDC sell amount.
    expect(result.value.fees?.integratorFee).toEqual({ amount: "25000", token: USDC });
    // Existing fee parsing (gas) still works.
    expect(result.value.fees?.gasFee?.amount).toBe("100");
  });

  it("sums the multi-recipient integratorFees[] shape", async () => {
    vi.stubEnv("ZERO_EX_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            await priceWithFees({
              integratorFees: [
                { amount: "25000", token: USDC },
                { amount: "0", token: USDC },
              ],
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await getZeroExSwapPrice(
      baseRequest({ agentFee: { recipient: FEE_WALLET, bps: 25 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fees?.integratorFee).toEqual({ amount: "25000", token: USDC });
  });

  it("leaves integratorFee undefined when 0x reports none", async () => {
    vi.stubEnv("ZERO_EX_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(await priceWithFees({})), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await getZeroExSwapPrice(baseRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fees?.integratorFee).toBeUndefined();
  });

  it("ignores a malformed integratorFee rather than guessing", async () => {
    vi.stubEnv("ZERO_EX_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(await priceWithFees({ integratorFee: { amount: "abc", token: USDC } })),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await getZeroExSwapPrice(
      baseRequest({ agentFee: { recipient: FEE_WALLET, bps: 25 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fees?.integratorFee).toBeUndefined();
  });
});

describe("provider-native fee — proposal state", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks the fee provider-native and uses 0x's own reported amount", () => {
    const fee = buildProposalAgentFee({
      fromAmount: "10000000",
      from: USDC_TOKEN,
      taker: TAKER,
      executionAvailable: true,
      providerNativeFee: { amount: "25000", token: USDC },
    });

    expect(fee.status).toBe("applied");
    expect(fee.collection).toBe("provider-native");
    // Exactly 25 bps of the 10 USDC sell amount, in the sell token.
    expect(fee.amountAtomic).toBe("25000");
    expect(fee.displayAmount).toBe("0.025 USDC");
    expect(fee.bps).toBe(25);
    expect(fee.recipient).toBe(FEE_WALLET);
  });

  it("falls back to the app's own collection when 0x reports the fee in another token", () => {
    const fee = buildProposalAgentFee({
      fromAmount: "10000000",
      from: USDC_TOKEN,
      taker: TAKER,
      executionAvailable: true,
      // A buy-side fee — NOT our economic model.
      providerNativeFee: { amount: "99000", token: WETH },
    });

    expect(fee.status).toBe("applied");
    expect(fee.collection).toBe("post-swap");
    expect(fee.amountAtomic).toBe("25000");
  });

  it("falls back when the reported amount is zero or not smaller than the sell amount", () => {
    for (const amount of ["0", "10000000", "99999999"]) {
      const fee = buildProposalAgentFee({
        fromAmount: "10000000",
        from: USDC_TOKEN,
        taker: TAKER,
        executionAvailable: true,
        providerNativeFee: { amount, token: USDC },
      });
      expect(fee.collection).toBe("post-swap");
      expect(fee.amountAtomic).toBe("25000");
    }
  });

  it("falls back when the reported amount is not parseable", () => {
    const fee = buildProposalAgentFee({
      fromAmount: "10000000",
      from: USDC_TOKEN,
      taker: TAKER,
      executionAvailable: true,
      providerNativeFee: { amount: "not-a-number", token: USDC },
    });
    expect(fee.collection).toBe("post-swap");
    expect(fee.amountAtomic).toBe("25000");
  });

  it("stays post-swap when no provider fee is reported (CDP, Aerodrome, plain 0x)", () => {
    const fee = buildProposalAgentFee({
      fromAmount: "10000000",
      from: USDC_TOKEN,
      taker: TAKER,
      executionAvailable: true,
    });
    expect(fee.collection).toBe("post-swap");
    expect(fee.amountAtomic).toBe("25000");
  });

  it("a full 0x proposal carries the provider-native fee through", () => {
    const built = buildTradeProposal({
      from: USDC_TOKEN,
      to: WETH_TOKEN,
      quote: {
        liquidityAvailable: true,
        fromToken: USDC,
        toToken: WETH,
        fromAmount: "10000000",
        toAmount: "396000000000000",
        minToAmount: "392040000000000",
        issues: { allowance: null, balance: null, simulationIncomplete: false },
        transaction: { to: USDC, data: "0xdeadbeef", value: "0" },
        permit2: null,
        fees: { integratorFee: { amount: "25000", token: USDC } },
      },
      slippageBps: 100,
      taker: TAKER,
      provider: "0x-swap-api",
    });
    if (!built.ok) throw new Error(built.error.message);

    expect(built.proposal.agentFee?.collection).toBe("provider-native");
    expect(built.proposal.agentFee?.amountAtomic).toBe("25000");
    // The quote itself is untouched by the fee.
    expect(built.proposal.fromAmount).toBe("10000000");
    expect(built.proposal.minToAmount).toBe("392040000000000");
  });
});

describe("provider-native fee — no duplicate collection", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function providerNativeProposal() {
    const built = buildTradeProposal({
      from: USDC_TOKEN,
      to: WETH_TOKEN,
      quote: {
        liquidityAvailable: true,
        fromToken: USDC,
        toToken: WETH,
        fromAmount: "10000000",
        toAmount: "396000000000000",
        minToAmount: "392040000000000",
        issues: { allowance: null, balance: null, simulationIncomplete: false },
        transaction: { to: USDC, data: "0xdeadbeef", value: "0" },
        permit2: null,
        fees: { integratorFee: { amount: "25000", token: USDC } },
      },
      slippageBps: 100,
      taker: TAKER,
      provider: "0x-swap-api",
    });
    if (!built.ok) throw new Error(built.error.message);
    return built.proposal;
  }

  it("resolveExecutionAgentFee never asks for a transfer the provider already made", () => {
    const resolved = resolveExecutionAgentFee(providerNativeProposal());
    expect(resolved.send).toBe(false);
  });

  it("a post-swap fee is still requested for every non-native provider", () => {
    const built = buildTradeProposal({
      from: USDC_TOKEN,
      to: WETH_TOKEN,
      quote: {
        liquidityAvailable: true,
        fromToken: USDC,
        toToken: WETH,
        fromAmount: "10000000",
        toAmount: "396000000000000",
        minToAmount: "392040000000000",
        issues: { allowance: null, balance: null, simulationIncomplete: false },
        transaction: { to: USDC, data: "0xdeadbeef", value: "0" },
        permit2: null,
      },
      slippageBps: 100,
      taker: TAKER,
      provider: "cdp-trade-api",
    });
    if (!built.ok) throw new Error(built.error.message);
    expect(built.proposal.agentFee?.collection).toBe("post-swap");
    expect(resolveExecutionAgentFee(built.proposal).send).toBe(true);
  });

  it("execution sends exactly ONE transaction and reports no fee as skipped", async () => {
    const { mockSend, mockWait, mockRead, mockSendCalls, mockCapabilities } = vi.hoisted(() => ({
      mockSend: vi.fn(),
      mockWait: vi.fn(),
      mockRead: vi.fn(),
      mockSendCalls: vi.fn(),
      mockCapabilities: vi.fn(),
    }));
    vi.doMock("wagmi/actions", () => ({
      sendTransaction: (...a: unknown[]) => mockSend(...a),
      signTypedData: vi.fn(),
      waitForTransactionReceipt: (...a: unknown[]) => mockWait(...a),
      readContract: (...a: unknown[]) => mockRead(...a),
      sendCalls: (...a: unknown[]) => mockSendCalls(...a),
      getCallsStatus: vi.fn(),
      getCapabilities: (...a: unknown[]) => mockCapabilities(...a),
      getBalance: vi.fn(),
    }));
    vi.doMock("@/lib/wagmi", () => ({ config: {} }));

    const { executeTrade } = await import("../trade-execution");

    mockCapabilities.mockResolvedValue({ "8453": { atomic: { supported: true } } });
    mockRead.mockImplementation(async (_c: unknown, p: { functionName?: string }) => {
      if (p?.functionName === "balanceOf") return 10_000_000n;
      if (p?.functionName === "allowance") return 10_000_000n;
      throw new Error("unexpected read");
    });
    mockSend.mockResolvedValue("0xswap");
    mockWait.mockResolvedValue({ status: "success" });

    const result = await executeTrade(
      {
        proposal: providerNativeProposal(),
        confirmationState: "READY_FOR_CONFIRMATION",
        currentAccount: TAKER,
        currentChainId: 8453,
      },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    // The fee was collected by 0x inside that same transaction.
    expect(result.feeHash).toBeNull();
    expect(result.feeError).toBeNull();
    // NOT reported as skipped — it WAS collected.
    expect(result.feeSkippedReason).toBeNull();
    // Exactly one transaction: the swap. No fee transfer, no batch.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSendCalls).not.toHaveBeenCalled();
    // The provider's calldata is forwarded untouched.
    const swapTx = mockSend.mock.calls[0][1] as { to: string; data: string };
    expect(swapTx.to).toBe(USDC);
    expect(swapTx.data).toBe("0xdeadbeef");

    vi.doUnmock("../trade-execution");
    vi.doUnmock("wagmi/actions");
    vi.doUnmock("@/lib/wagmi");
    vi.resetModules();
  });

  it("the fee amount is exactly floor(fromAmount * 25 / 10_000) across decimals", () => {
    const cases: Array<{ fromAmount: string; decimals: number; symbol: string; expected: string }> = [
      { fromAmount: "10000000", decimals: 6, symbol: "USDC", expected: "25000" }, // 10 USDC
      { fromAmount: "1000000000000000000", decimals: 18, symbol: "WETH", expected: "2500000000000000" }, // 1 WETH
      { fromAmount: "400", decimals: 6, symbol: "USDC", expected: "1" }, // dust floor
      { fromAmount: "399", decimals: 6, symbol: "USDC", expected: "0" }, // rounds to zero
    ];
    for (const c of cases) {
      const fee = buildProposalAgentFee({
        fromAmount: c.fromAmount,
        from: { ...USDC_TOKEN, decimals: c.decimals, symbol: c.symbol },
        taker: TAKER,
        executionAvailable: true,
        // 0x's own number, which must match our derivation exactly.
        providerNativeFee: { amount: c.expected, token: USDC },
      });
      if (c.expected === "0") {
        expect(fee.status).toBe("skipped");
        continue;
      }
      expect(fee.amountAtomic).toBe(c.expected);
      expect(fee.collection).toBe("provider-native");
      expect(fee.bps).toBe(25);
    }
  });
});

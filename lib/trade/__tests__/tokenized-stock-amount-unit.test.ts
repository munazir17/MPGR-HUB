// lib/trade/__tests__/tokenized-stock-amount-unit.test.ts
//
// Regression suite for B20 order SIZING.
//
// Two real failures this pins down:
//   1. "Sell 5 AAPLc" was read as a $5 budget, so a 5-share sell became a
//      ~$5 sell (or, at the token's own 8 decimals, an unpricable one).
//   2. "Sell $5 of my AAPLc" divided with Number() and then demanded that
//      the float quotient fit AAPLc's 8 decimals — 5 / 337.595 expands
//      past 8, so the correct order was rejected with "Could not convert
//      that dollar amount into a B20 token size".
//
// The catalog (tokenized-stocks.ts / trade-tokens.ts) is deliberately NOT
// mocked: these assertions run against the real Coinbase B20 allowlist.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockOnchain, mockQuote, mockExecutor } = vi.hoisted(() => ({
  mockOnchain: vi.fn(),
  mockQuote: vi.fn(),
  mockExecutor: vi.fn(),
}));

// The B20 flow is executor-first (the fee is taken inside the executor swap). This suite is
// about ORDER SIZING, so the executor quote is stubbed with a faithful echo of the real one:
// same proposal shape, same 25 bps sell-token fee, same executor target. The real executor
// quote path (chain reads, quoter, calldata) has its own suites.
vi.mock("../trade-executor-quote", () => ({
  buildExecutorSwapProposal: (...args: unknown[]) => mockExecutor(...args),
}));

vi.mock("../tokenized-stocks-onchain", () => ({
  readTokenizedStockOnchain: (...args: unknown[]) => mockOnchain(...args),
}));
vi.mock("../trade-swap-router", () => ({
  createRoutedSwapQuote: (...args: unknown[]) => mockQuote(...args),
  getRoutedSwapPrice: (...args: unknown[]) => mockQuote(...args),
}));
vi.mock("../trade-price-impact", () => ({
  estimateSwapPriceImpactBps: async () => null,
  estimateQuotePriceImpactBps: async () => null,
}));

const { prepareTokenizedStockSwap } = await import("../tokenized-stock-swap");
const { BASE_USDC } = await import("../trade-config");
const { AERODROME_SLIPSTREAM_PROVIDER_ID } = await import("../trade-config");
const { findTokenizedStock } = await import("../tokenized-stocks");

/** The real catalog address for AAPLc — never a guessed contract. */
function aaplcAddress(): string {
  const entry = findTokenizedStock("AAPLc");
  if (!entry) throw new Error("AAPLc missing from the B20 catalog");
  return entry.address;
}

const TAKER = "0x2222222222222222222222222222222222222222";
// Live-shaped Chainlink implied price used by the failed "$5 of my AAPLc" order.
const PRICE = "337.595";

function onchainState(decimals = 8, impliedTokenPriceUsd: string | null = PRICE) {
  return {
    decimals,
    paused: false,
    totalSupply: "826742561031",
    impliedTokenPriceUsd,
  };
}

/** Quote stub that echoes the requested pair so we can assert on the sizing. */
function quoteEcho(provider = AERODROME_SLIPSTREAM_PROVIDER_ID) {
  return vi.fn(async (request: { fromToken: string; toToken: string; fromAmount: string }) => ({
    ok: true as const,
    provider,
    value: {
      liquidityAvailable: true,
      fromToken: request.fromToken,
      toToken: request.toToken,
      fromAmount: request.fromAmount,
      toAmount: "1000000",
      minToAmount: "990000",
      issues: { allowance: null, balance: null, simulationIncomplete: false },
      transaction: { to: "0x00000000000000000000000000000000000000aa", data: "0xdead", value: "0" },
      permit2: null,
    },
  }));
}

interface ExecutorEchoInput {
  from: { address: string; symbol: string; decimals: number };
  to: { address: string; symbol: string; decimals: number };
  fromAmount: string;
  taker: string;
  slippageBps: number;
}

/** Stand-in for the real executor quote: builds a real proposal with the real 25 bps fee. */
async function useExecutorEcho() {
  const { buildTradeProposal } = await import("../trade-proposal");
  const { buildExecutorAgentFee } = await import("../trade-agent-fee");
  const { BASE_MAINNET_EXECUTOR_DEPLOYMENT, EXECUTOR_DEFAULT_FEE_BPS } = await import("@/lib/executor/executor-config");
  mockExecutor.mockImplementation(async (input: ExecutorEchoInput) => {
    const fee = buildExecutorAgentFee({
      grossAmountIn: input.fromAmount,
      feeBps: EXECUTOR_DEFAULT_FEE_BPS,
      feeRecipient: BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient,
      from: input.from as never,
      taker: input.taker,
    });
    if (!fee.ok) return { ok: false, supported: true, error: { code: "EXECUTION_UNAVAILABLE", message: fee.reason } };
    const built = buildTradeProposal({
      from: input.from as never,
      to: input.to as never,
      slippageBps: input.slippageBps,
      taker: input.taker,
      provider: "mpgr-executor",
      agentFee: fee.fee,
      quote: {
        liquidityAvailable: true,
        fromToken: input.from.address,
        toToken: input.to.address,
        fromAmount: input.fromAmount,
        toAmount: "1000000",
        minToAmount: "990000",
        issues: { allowance: null, balance: null, simulationIncomplete: false },
        transaction: { to: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor, data: "0xdead", value: "0" },
        permit2: null,
      },
    });
    if (!built.ok) return { ok: false, supported: true, error: built.error };
    return { ok: true, proposal: built.proposal };
  });
}

describe("tokenized-stock order sizing (amountUnit)", () => {
  beforeEach(() => {
    mockOnchain.mockReset();
    mockQuote.mockReset();
    mockExecutor.mockReset();
  });

  it("sizes 'Sell 5 AAPLc' as 5 shares at the token's real 8 decimals", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    await useExecutorEcho();

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "SELL",
      amountHuman: "5",
      amountUnit: "token",
      taker: TAKER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 5 shares = 500,000,000 atomic at 8 decimals — sold INTO USDC.
    expect(result.proposal.fromAmount).toBe("500000000");
    expect(result.proposal.from.symbol).toBe("AAPLc");
    expect(result.proposal.from.address).toBe(aaplcAddress());
    expect(result.proposal.to.address.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(mockExecutor.mock.calls[0][0].fromAmount).toBe("500000000");
    // Selling shares must send the TOKEN as tokenIn, USDC as tokenOut.
    expect(mockExecutor.mock.calls[0][0].from.address).toBe(aaplcAddress());
    expect(mockExecutor.mock.calls[0][0].to.address.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    // Routed through the executor with the 25 bps fee applied to the SELL leg.
    expect(result.proposal.provider).toBe("mpgr-executor");
    expect(result.proposal.agentFee).toMatchObject({ status: "applied", bps: 25, amountAtomic: "1250000" });
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("sizes 'Sell 0.015 AAPLc' exactly", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    await useExecutorEcho();

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "SELL",
      amountHuman: "0.015",
      amountUnit: "token",
      taker: TAKER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.fromAmount).toBe("1500000"); // 0.015 × 10^8
  });

  it("sizes 'Sell $5 of my AAPLc' without float precision loss", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    await useExecutorEcho();

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "SELL",
      amountHuman: "5",
      amountUnit: "usd",
      taker: TAKER,
    });

    // floor(5 / 337.595 × 10^8) = 1,481,064 — an exact rational, not a
    // float that overflows the token's precision.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.fromAmount).toBe("1481064");
  });

  it("sizes 'Buy 0.01 AAPLc' as its live USD budget in USDC", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    await useExecutorEcho();

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "0.01",
      amountUnit: "token",
      taker: TAKER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 0.01 shares × $337.595 = $3.37595 → 3,375,950 atomic USDC (6dp).
    expect(result.proposal.fromAmount).toBe("3375950");
    expect(result.proposal.from.address.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(mockExecutor.mock.calls[0][0].fromAmount).toBe("3375950");
  });

  it("keeps the default (no amountUnit) dollar behavior unchanged", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    await useExecutorEcho();

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "50",
      taker: TAKER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.fromAmount).toBe("50000000"); // $50 of USDC
  });

  it("refuses the trade when the executor quote fails — never a fee-less fallback", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    mockExecutor.mockResolvedValue({ ok: false, supported: true, error: { code: "PROVIDER_ERROR", message: "unavailable" } });

    const result = await prepareTokenizedStockSwap({ symbol: "AAPLc", side: "BUY", amountHuman: "50", taker: TAKER });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROVIDER_ERROR");
    // The direct (fee-less) Slipstream quote must NOT take over.
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("keeps the existing non-executor provider for a pair with no registered executor route", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    mockExecutor.mockResolvedValue({ ok: false, supported: false }); // not an executor pair
    mockQuote.mockImplementation(quoteEcho());

    const result = await prepareTokenizedStockSwap({ symbol: "AAPLc", side: "BUY", amountHuman: "50", taker: TAKER });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.provider).toBe(AERODROME_SLIPSTREAM_PROVIDER_ID);
    expect(result.proposal.agentFee).toMatchObject({ status: "skipped" });
    expect(mockQuote).toHaveBeenCalledTimes(1);
  });

  it("rejects a token amount finer than the B20's on-chain precision", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    mockQuote.mockImplementation(quoteEcho());

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "SELL",
      amountHuman: "0.000000001", // 9dp against 8 on-chain decimals
      amountUnit: "token",
      taker: TAKER,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("refuses a share-denominated order with no live price for the USD leg", async () => {
    mockOnchain.mockResolvedValue(onchainState(8, null));
    mockQuote.mockImplementation(quoteEcho());

    const buy = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "1",
      amountUnit: "token",
      taker: TAKER,
    });
    expect(buy.ok).toBe(false);
    if (!buy.ok) expect(buy.error.code).toBe("LIQUIDITY_UNAVAILABLE");

    const sell = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "SELL",
      amountHuman: "5",
      amountUnit: "usd",
      taker: TAKER,
    });
    expect(sell.ok).toBe(false);
    if (!sell.ok) expect(sell.error.code).toBe("LIQUIDITY_UNAVAILABLE");
  });

  it("never sizes a token outside the Coinbase B20 allowlist", async () => {
    mockOnchain.mockResolvedValue(onchainState());
    mockQuote.mockImplementation(quoteEcho());

    const result = await prepareTokenizedStockSwap({
      symbol: "SCAMCOIN",
      side: "SELL",
      amountHuman: "5",
      amountUnit: "token",
      taker: TAKER,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_ASSET");
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("still fails closed when decimals cannot be verified", async () => {
    mockOnchain.mockResolvedValue({ ...onchainState(), decimals: null });
    mockQuote.mockImplementation(quoteEcho());

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "SELL",
      amountHuman: "5",
      amountUnit: "token",
      taker: TAKER,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROVIDER_ERROR");
    expect(mockQuote).not.toHaveBeenCalled();
  });
});

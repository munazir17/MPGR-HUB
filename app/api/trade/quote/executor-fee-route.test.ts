// app/api/trade/quote/executor-fee-route.test.ts
//
// REGRESSION: the browser quote route must route a supported pair through
// the MPGR Executor, and the proposal it hands to "Confirm & Swap" must be
// the executor's fee-aware swap — one transaction, fee inside it.
//
// Only external boundaries are mocked (session, rate limit, price impact and
// the chain reader); the real proposal builder, fee math and executor intent
// builder run.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress } from "viem";

import { resetTradeQuoteCache } from "@/lib/trade/trade-quote-cache";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, CANONICAL_WETH } from "@/lib/executor/executor-config";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";

const mocks = vi.hoisted(() => ({
  routed: vi.fn(),
  reader: null as unknown,
  wallet: "0x2222222222222222222222222222222222222222",
}));

vi.mock("@/lib/trade/trade-swap-router", () => ({ createRoutedSwapQuote: mocks.routed }));
vi.mock("@/lib/trade/trade-price-impact", () => ({ estimateQuotePriceImpactBps: async () => null }));
vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
  clientIpFromRequest: () => "test",
}));
vi.mock("@/lib/auth/session-store", () => ({ authenticateRequest: async () => ({ wallet: mocks.wallet }) }));
// B20 metadata is read on-chain before any amount math (fail-closed in production).
// This file mocks that boundary too, exactly like the chain reader above.
vi.mock("@/lib/trade/tokenized-stocks-onchain", () => ({
  readB20Decimals: async () => 8,
  readTokenizedStockOnchain: async () => ({
    decimals: 8,
    paused: false,
    totalSupply: "100000000000",
    impliedTokenPriceUsd: "100",
  }),
}));
vi.mock("@/lib/api/request-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/request-guard")>()),
  verifyTrustedOrigin: () => null,
}));
vi.mock("@/lib/executor/executor-chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/executor/executor-chain")>()),
  createChainReader: () => mocks.reader,
}));

const { POST } = await import("./route");

const EXECUTOR = getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor);
const FEE_RECIPIENT = getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient);
const WALLET = "0x2222222222222222222222222222222222222222";

function fakeReader(options: { allowance?: bigint; balance?: bigint; out?: bigint } = {}) {
  return {
    chainId: 8453,
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "feeBps":
          return 25n;
        case "feeRecipient":
          return FEE_RECIPIENT;
        case "paused":
          return false;
        case "MAX_FEE_BPS":
          return 100n;
        case "owner":
          return WALLET;
        case "allowance":
          return options.allowance ?? 0n;
        case "balanceOf":
          return options.balance ?? 100_000_000n;
        default:
          throw new Error(`unexpected read: ${functionName}`);
      }
    }),
    simulateContract: vi.fn(async () => ({ result: [options.out ?? 800_000_000_000_000n, 0n, 0n, 100_000n] as unknown })),
    getBalance: vi.fn(async () => 10n ** 18n),
    getTransactionReceipt: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
}

function post(body: Record<string, unknown>) {
  return new Request("https://app.test/api/trade/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromToken: "USDC", toToken: "WETH", amount: "2", slippageBps: 100, ...body }),
  });
}

beforeEach(() => {
  resetTradeQuoteCache();
  vi.clearAllMocks();
  mocks.wallet = WALLET;
  mocks.reader = fakeReader();
  mocks.routed.mockImplementation(async (arg: { fromToken: string; toToken: string; fromAmount: string }) => ({
    ok: true,
    provider: "cdp-trade-api",
    value: {
      ...arg,
      liquidityAvailable: true,
      toAmount: "2000000",
      minToAmount: "1980000",
      transaction: { to: "0x5555555555555555555555555555555555555555", data: "0xabcd", value: "0" },
      permit2: null,
      issues: { allowance: null, balance: null, simulationIncomplete: false },
    },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/trade/quote — supported pair goes through the MPGR Executor", () => {
  it("returns ONE executor transaction carrying the 25 bps fee (2 USDC → 0.005 USDC)", async () => {
    const response = await POST(post({}));
    const { proposal } = await response.json();

    expect(response.status).toBe(200);
    expect(proposal.provider).toBe("mpgr-executor");
    // The CDP/0x router is not consulted at all for a supported pair.
    expect(mocks.routed).not.toHaveBeenCalled();

    // The wallet signs this exact transaction: to the executor, not a router.
    expect(getAddress(proposal.transaction.to)).toBe(EXECUTOR);
    expect(proposal.transaction.value).toBe("0");
    expect(proposal.fromAmount).toBe("2000000");
    expect(proposal.agentFee).toMatchObject({
      status: "applied",
      bps: 25,
      recipient: FEE_RECIPIENT,
      amountAtomic: "5000",
      displayAmount: "0.005 USDC",
      collection: "mpgr-executor",
    });
    expect(proposal.agentFee.recipient.toLowerCase()).not.toBe(WALLET.toLowerCase());

    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: proposal.transaction.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.grossAmountIn).toBe(2_000_000n);
    expect(params.expectedFeeAmount).toBe(5_000n);
    expect((params.grossAmountIn as bigint) - (params.expectedFeeAmount as bigint)).toBe(1_995_000n);
    expect(params.amountOutMinimum).toBe(792_000_000_000_000n);

    // First-time ERC-20: exactly one separate approval, and it targets the
    // executor for the GROSS amount. Never a fee transfer.
    expect(proposal.needsPermit2Approval).toBe(true);
    expect(getAddress(proposal.permit2Spender)).toBe(EXECUTOR);
    expect(proposal.permit2).toBeNull();
    // The steps state the fee is taken inside the same transaction and never
    // promise an "after the swap settles" payment.
    expect(proposal.postConfirmationSteps).toContainEqual(
      expect.stringContaining("inside that same swap transaction"),
    );
    expect(proposal.postConfirmationSteps.some((step: string) => /after the swap settles|pay .*fee .*separately/i.test(step))).toBe(false);
  });

  it("skips the approval step once the allowance covers the gross amount", async () => {
    mocks.reader = fakeReader({ allowance: 2_000_000n });
    const response = await POST(post({}));
    const { proposal } = await response.json();
    expect(proposal.needsPermit2Approval).toBe(false);
    expect(proposal.agentFee.amountAtomic).toBe("5000");
  });

  it("native ETH in: the swap carries exactly the gross value and a WETH leg", async () => {
    const response = await POST(post({ fromToken: "ETH", toToken: "USDC", amount: "2" }));
    const { proposal } = await response.json();
    expect(proposal.provider).toBe("mpgr-executor");
    expect(proposal.transaction.value).toBe("2000000000000000000");
    expect(proposal.agentFee).toMatchObject({ amountAtomic: "5000000000000000", displayAmount: "0.005 ETH" });
    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: proposal.transaction.data });
    const [params] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(getAddress(params.tokenIn as string)).toBe(getAddress(CANONICAL_WETH));
    expect(params.grossAmountIn).toBe(2_000_000_000_000_000_000n);
    expect(params.expectedFeeAmount).toBe(5_000_000_000_000_000n);
  });

  it("keeps the existing provider for pairs without a proven executor route", async () => {
    const response = await POST(post({ toToken: "MPGR" }));
    const { proposal } = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.routed).toHaveBeenCalledTimes(1);
    expect(proposal.provider).toBe("cdp-trade-api");
    // No fee is invented for a route that cannot collect it in-swap.
    expect(proposal.agentFee).toMatchObject({ status: "skipped", amountAtomic: "0" });
  });

  it("fails loudly instead of silently re-routing when the executor quote cannot be built", async () => {
    mocks.reader = {
      ...fakeReader(),
      readContract: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    };
    const response = await POST(post({}));
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body.proposal).toBeUndefined();
    // Sanitized consumer copy: no internal provider text, no invented quote.
    expect(body.error).toMatch(/unavailable|try again/i);
    // Never a fallback to a non-executor venue: that would drop the fee.
    expect(mocks.routed).not.toHaveBeenCalled();
  });
});

describe("POST /api/trade/quote — B20 tokenized stocks use the SAME executor fee architecture", () => {
  const AAPLC = getAddress("0xb200000000000000000000C2e324d24d7eEcd1fb");
  const SLIP_ROUTER = getAddress("0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F");

  it("USDC → AAPLc: ONE executor transaction on the live Slipstream route, fee inside it", async () => {
    mocks.reader = fakeReader({ out: 587_536n });
    const response = await POST(post({ toToken: "AAPLc", amount: "2" }));
    const { proposal } = await response.json();

    expect(response.status).toBe(200);
    expect(proposal.provider).toBe("mpgr-executor");
    // The app's direct-Slipstream router path is NOT used: the wallet signs the executor tx.
    expect(mocks.routed).not.toHaveBeenCalled();
    expect(getAddress(proposal.transaction.to)).toBe(EXECUTOR);
    expect(proposal.transaction.value).toBe("0");

    // 2 USDC gross → 0.005 USDC fee → 1.995 USDC swapped; recipient is the executor's
    // configured feeRecipient, never the connected wallet.
    expect(proposal.fromAmount).toBe("2000000");
    expect(proposal.agentFee).toMatchObject({
      status: "applied",
      bps: 25,
      amountAtomic: "5000",
      displayAmount: "0.005 USDC",
      collection: "mpgr-executor",
      recipient: FEE_RECIPIENT,
    });
    expect(proposal.agentFee.recipient.toLowerCase()).not.toBe(WALLET.toLowerCase());

    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: proposal.transaction.data });
    expect(decoded.functionName).toBe("swapSlipstreamExactInputSingle");
    if (decoded.functionName !== "swapSlipstreamExactInputSingle") throw new Error("wrong entrypoint");
    const [params, tickSpacing] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(tickSpacing).toBe(10); // the live B20/USDC pool key (the executed swap used 10)
    expect(getAddress(params.router as string)).toBe(SLIP_ROUTER);
    expect(getAddress(params.tokenIn as string)).toBe(getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
    expect(getAddress(params.tokenOut as string)).toBe(AAPLC);
    expect(params.grossAmountIn).toBe(2_000_000n);
    expect(params.expectedFeeAmount).toBe(5_000n);
    expect((params.grossAmountIn as bigint) - (params.expectedFeeAmount as bigint)).toBe(1_995_000n);
    // Slippage on the POST-fee output: 587,536 × (1 − 1%) = 581,660 — exactly the
    // amountOutMinimum of the real executed swap this flow replaced.
    expect(params.amountOutMinimum).toBe(581_660n);
    expect(getAddress(params.recipient as string)).toBe(WALLET);

    // The pool is quoted for the NET amount only.
    const simulate = (mocks.reader as { simulateContract: ReturnType<typeof vi.fn> }).simulateContract;
    expect(simulate.mock.calls[0][0].args[0].amountIn).toBe(1_995_000n);

    // First-time ERC-20: one approval for the GROSS amount to the executor, then the swap.
    // NEVER a third transaction and never a fee/permit signature.
    expect(proposal.needsPermit2Approval).toBe(true);
    expect(getAddress(proposal.permit2Spender)).toBe(EXECUTOR);
    expect(proposal.permit2).toBeNull();
    expect(proposal.postConfirmationSteps).toContainEqual(expect.stringContaining("inside that same swap transaction"));
    expect(proposal.postConfirmationSteps.some((step: string) => /after the swap settles|pay .*fee .*separately/i.test(step))).toBe(false);
    // No step ever asks for a fee payment; the sanctioned copy negates a separate
    // fee transaction, so assert the forbidden prompts precisely (not "fee transaction").
    expect(JSON.stringify(proposal.postConfirmationSteps)).not.toMatch(/paid separately|pay the fee|separate fee payment|fee payment step/i);
  });

  it("AAPLc → USDC (sell): the fee is taken in AAPLc at its 8 decimals, inside the same swap", async () => {
    mocks.reader = fakeReader({ balance: 1_000_000_000n, out: 2_000_000n });
    const response = await POST(post({ fromToken: "AAPLc", toToken: "USDC", amount: "5" }));
    const { proposal } = await response.json();

    expect(response.status).toBe(200);
    expect(proposal.provider).toBe("mpgr-executor");
    expect(mocks.routed).not.toHaveBeenCalled();
    expect(proposal.fromAmount).toBe("500000000"); // 5 AAPLc at 8 decimals
    // floor(500,000,000 × 25 / 10_000) = 1,250,000 → 0.0125 AAPLc.
    expect(proposal.agentFee).toMatchObject({
      status: "applied",
      bps: 25,
      amountAtomic: "1250000",
      displayAmount: "0.0125 AAPLc",
      recipient: FEE_RECIPIENT,
    });
    expect(proposal.agentFee.recipient.toLowerCase()).not.toBe(WALLET.toLowerCase());

    const decoded = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: proposal.transaction.data });
    if (decoded.functionName !== "swapSlipstreamExactInputSingle") throw new Error("wrong entrypoint");
    const [params, tickSpacing] = decoded.args as unknown as readonly [Record<string, unknown>, number];
    expect(tickSpacing).toBe(10);
    expect(getAddress(params.tokenIn as string)).toBe(AAPLC);
    expect(getAddress(params.tokenOut as string)).toBe(getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
    expect(params.grossAmountIn).toBe(500_000_000n);
    expect(params.expectedFeeAmount).toBe(1_250_000n);
    expect((params.grossAmountIn as bigint) - (params.expectedFeeAmount as bigint)).toBe(498_750_000n);
    expect(params.amountOutMinimum).toBe(1_980_000n); // 2 USDC out − 1%
    expect(proposal.transaction.value).toBe("0");

    const simulate = (mocks.reader as { simulateContract: ReturnType<typeof vi.fn> }).simulateContract;
    expect(simulate.mock.calls[0][0].args[0].amountIn).toBe(498_750_000n);

    expect(proposal.needsPermit2Approval).toBe(true);
    expect(getAddress(proposal.permit2Spender)).toBe(EXECUTOR);
    expect(proposal.postConfirmationSteps.some((step: string) => /after the swap settles|pay .*fee .*separately/i.test(step))).toBe(false);
  });

  it("already approved → the B20 flow signs only the swap (max first-time flow is approve+swap)", async () => {
    mocks.reader = fakeReader({ allowance: 2_000_000n, out: 587_536n });
    const response = await POST(post({ toToken: "AAPLc", amount: "2" }));
    const { proposal } = await response.json();
    expect(response.status).toBe(200);
    expect(proposal.needsPermit2Approval).toBe(false);
    expect(proposal.agentFee).toMatchObject({ status: "applied", amountAtomic: "5000" });
    expect(getAddress(proposal.transaction.to)).toBe(EXECUTOR);
  });

  it("a failed executor quote for a B20 pair is an error — never a fee-less routed fallback", async () => {
    mocks.reader = {
      ...fakeReader({ out: 587_536n }),
      simulateContract: vi.fn(async () => {
        throw new Error("quoter reverted");
      }),
    };
    const response = await POST(post({ toToken: "AAPLc", amount: "2" }));
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body.proposal).toBeUndefined();
    expect(body.error).toMatch(/unavailable|try again/i);
    // The direct Slipstream route (same pool, no fee) must never take over.
    expect(mocks.routed).not.toHaveBeenCalled();
  });
});

// lib/trade/__tests__/trade-swap-funds-safety.test.ts
//
// Regression suite for the on-chain `STF` failure of a normal swap on Base.
//
// Reproduced from tx
// 0xc6adf5e0520924ab522a54f4382e95d165e2fed68015db32efa6e56d55d0e619:
//   USDC (0x8335…2913, 6dp) → MSTRc (0xb20000…883d, B20, 8dp)
//   via Aerodrome Slipstream SwapRouter 0x698Cb2…A92F
//   params: amountIn = 5_000_000, amountOutMinimum = 2_991_900, tickSpacing 10
// The router's inner USDC.transferFrom(wallet → pool, 5_000_000) reverted
// with "ERC20: transfer amount exceeds balance" (pool re-wrapped it as
// `STF`) because the wallet held ~2.49 USDC — while the quote already
// knew, and nothing blocked the broadcast.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress } from "viem";

const { mockSend, mockSign, mockWait, mockRead, rpc } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSign: vi.fn(),
  mockWait: vi.fn(),
  mockRead: vi.fn(),
  rpc: {
    /** Live `balanceOf` answer; null = the read itself fails (RPC blip). */
    balance: null as bigint | null,
    /** Live `allowance(owner, spender)` answer; null = the read fails. */
    allowance: null as bigint | null,
  },
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
const { revalidateTradeProposal, runTradeConfirmation } = await import("../trade-confirmation");
const { buildSwapRiskFacts } = await import("../trade-risk");
const { parseHumanTokenAmount } = await import("../trade-format");
const {
  AERODROME_SLIPSTREAM_PROVIDER_ID,
  AERODROME_SLIPSTREAM_SWAP_ROUTER,
  BASE_USDC,
} = await import("../trade-config");
const { applySlippageBps, encodeAerodromeExactInputSingle } = await import(
  "../aerodrome-slipstream"
);
const { aerodromeSwapRouterAbi } = await import("../aerodrome-slipstream");
const { erc20Abi } = await import("@/lib/erc20-abi");

import type { CdpSwapQuote, TradeProposal, TradeTokenRef } from "../trade-types";

const TAKER = "0x2222222222222222222222222222222222222222" as const;
const ROUTER = getAddress(AERODROME_SLIPSTREAM_SWAP_ROUTER);
// MSTRc — Coinbase tokenized stock (B20) on Base, 8 decimals on-chain.
const MSTRC = getAddress("0xb2000000000000000000004884b426556b92883d");
const DEADLINE = 1_790_177_105n;

/** The exact amountIn/fee math of the failed tx: 5 USDC in, 100 bps slippage. */
const AMOUNT_IN = 5_000_000n;
const QUOTED_OUT = 3_020_310n;
const MIN_OUT = applySlippageBps(QUOTED_OUT, 100);

const usdc: TradeTokenRef = {
  address: BASE_USDC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  kind: "erc20",
  verified: true,
};

const mstrc: TradeTokenRef = {
  address: MSTRC,
  symbol: "MSTRc",
  name: "MicroStrategy (Coinbase Tokenized Stock)",
  decimals: 8,
  kind: "b20-tokenized-stock",
  verified: true,
};

function aerodromeQuote(overrides?: {
  balanceIssue?: { currentBalance: string; requiredBalance: string } | null;
  allowanceIssue?: boolean;
  fees?: CdpSwapQuote["fees"];
}): CdpSwapQuote {
  return {
    liquidityAvailable: true,
    fromToken: BASE_USDC,
    toToken: MSTRC,
    fromAmount: AMOUNT_IN.toString(),
    toAmount: QUOTED_OUT.toString(),
    minToAmount: MIN_OUT.toString(),
    issues: {
      allowance: overrides?.allowanceIssue
        ? { currentAllowance: "0", spender: ROUTER }
        : null,
      balance: overrides?.balanceIssue
        ? { token: BASE_USDC, ...overrides.balanceIssue }
        : null,
      simulationIncomplete: false,
    },
    fees: overrides?.fees,
    transaction: {
      to: ROUTER,
      data: encodeAerodromeExactInputSingle({
        tokenIn: getAddress(BASE_USDC),
        tokenOut: MSTRC,
        recipient: TAKER,
        deadline: DEADLINE,
        amountIn: AMOUNT_IN,
        amountOutMinimum: MIN_OUT,
      }),
      value: "0",
    },
    permit2: null,
  };
}

function proposal(overrides?: Parameters<typeof aerodromeQuote>[0]): TradeProposal {
  const built = buildTradeProposal({
    from: usdc,
    to: mstrc,
    quote: aerodromeQuote(overrides),
    slippageBps: 100,
    taker: TAKER,
    provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
  });
  if (!built.ok) throw new Error(built.error.message);
  return built.proposal;
}

function decodeSwap(data: string) {
  const decoded = decodeFunctionData({
    abi: aerodromeSwapRouterAbi,
    data: data as `0x${string}`,
  });
  const params = (decoded.args as readonly [
    {
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      tickSpacing: number;
      recipient: `0x${string}`;
      deadline: bigint;
      amountIn: bigint;
      amountOutMinimum: bigint;
      sqrtPriceLimitX96: bigint;
    },
  ])[0];
  return params;
}

describe("normal Base swap — funds safety (STF regression)", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSign.mockReset();
    mockWait.mockReset();
    mockRead.mockReset();
    rpc.balance = AMOUNT_IN; // wallet already holds the 5 USDC it wants to sell
    rpc.allowance = AMOUNT_IN; // and the router already has the allowance
    mockWait.mockResolvedValue({ status: "success" });
    mockSend.mockResolvedValue("0xswap");
    mockRead.mockImplementation(
      async (_config: unknown, params: { functionName?: string }) => {
        if (params?.functionName === "balanceOf") {
          if (rpc.balance === null) throw new Error("rpc unavailable");
          return rpc.balance;
        }
        if (params?.functionName === "allowance") {
          if (rpc.allowance === null) throw new Error("rpc unavailable");
          return rpc.allowance;
        }
        throw new Error(`unexpected read: ${String(params?.functionName)}`);
      },
    );
  });

  it("1. insufficient allowance: flags the router approval and approves before swapping", async () => {
    const p = proposal({ allowanceIssue: true });
    expect(p.issues.allowance?.spender).toBe(AERODROME_SLIPSTREAM_SWAP_ROUTER);
    expect(p.needsPermit2Approval).toBe(true);

    rpc.allowance = 0n;
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xswap");

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(mockSend).toHaveBeenCalledTimes(2);
    const approveCall = mockSend.mock.calls[0][1] as { to: string; data: `0x${string}` };
    expect(getAddress(approveCall.to)).toBe(getAddress(BASE_USDC));
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approveCall.data });
    expect(decoded.functionName).toBe("approve");
    expect((decoded.args as readonly [string, bigint])[0]).toBe(ROUTER);
    expect((decoded.args as readonly [string, bigint])[1]).toBe(AMOUNT_IN);
  });

  it("2. correct spender: the approval targets the Aerodrome Slipstream SwapRouter", async () => {
    const p = proposal({ allowanceIssue: true });
    // Aerodrome's own route is an ERC-20 approve to the SwapRouter — this
    // route never uses Permit2 or 0x's AllowanceHolder.
    expect(p.provider).toBe("aerodrome-slipstream");
    expect(p.permit2).toBeNull();
    expect(p.permit2Spender).toBe(ROUTER);
    expect(p.permit2Spender).not.toBe(getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"));

    rpc.allowance = 0n;
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xswap");

    await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    const approveCall = mockSend.mock.calls[0][1] as { to: string };
    expect(getAddress(approveCall.to)).toBe(getAddress(BASE_USDC));
    const swapCall = mockSend.mock.calls[1][1] as { to: string };
    expect(getAddress(swapCall.to)).toBe(ROUTER);
  });

  it("3. amountIn/fee rounding: encoded amountIn and min-out match the quote exactly", async () => {
    const p = proposal();
    const params = decodeSwap(p.transaction!.data);

    // No fee is added to, or deducted from, the amount the wallet spends.
    expect(params.amountIn).toBe(AMOUNT_IN);
    // Slippage floor is applied once, with floor division (never round-up).
    expect(params.amountOutMinimum).toBe(MIN_OUT);
    expect(MIN_OUT).toBe((QUOTED_OUT * 9_900n) / 10_000n);
    expect(params.amountOutMinimum).toBe(2_990_106n);
    expect(p.fromAmount).toBe(AMOUNT_IN.toString());
    expect(p.minToAmount).toBe(MIN_OUT.toString());
    // No fee was added to the spend, so no approval is required for it.
    expect(p.permit2Spender).toBeNull();
    expect(p.needsPermit2Approval).toBe(false);
  });

  it("4. exact token decimals: USDC 6dp in / MSTRc 8dp out are encoded without unit drift", async () => {
    expect(parseHumanTokenAmount("5", 6)).toBe(AMOUNT_IN);
    // The 18-decimal guess that would have been a 10^12 unit error on a B20:
    expect(parseHumanTokenAmount("5", 18)).not.toBe(AMOUNT_IN);

    const p = proposal();
    expect(p.from.decimals).toBe(6);
    expect(p.to.decimals).toBe(8);
    expect(p.displayFromAmount).toBe("5 USDC");

    const params = decodeSwap(p.transaction!.data);
    expect(getAddress(params.tokenIn)).toBe(getAddress(BASE_USDC));
    expect(getAddress(params.tokenOut)).toBe(MSTRC);
    expect(params.amountIn).toBe(5_000_000n);
    expect(params.tickSpacing).toBe(10);
    expect(getAddress(params.recipient)).toBe(TAKER);
    expect(params.sqrtPriceLimitX96).toBe(0n);
  });

  it("4b. exact token decimals on the sell side: a B20 8dp balance blocks the swap", async () => {
    // Selling 0.3 MSTRc (30_000_000 atomic at 8dp) with only 0.2 MSTRc held.
    const sell = buildTradeProposal({
      from: mstrc,
      to: usdc,
      quote: {
        liquidityAvailable: true,
        fromToken: MSTRC,
        toToken: BASE_USDC,
        fromAmount: "30000000",
        toAmount: "4950000",
        minToAmount: "4900500",
        issues: { allowance: null, balance: null, simulationIncomplete: false },
        transaction: {
          to: ROUTER,
          data: encodeAerodromeExactInputSingle({
            tokenIn: MSTRC,
            tokenOut: getAddress(BASE_USDC),
            recipient: TAKER,
            deadline: DEADLINE,
            amountIn: 30_000_000n,
            amountOutMinimum: 4_900_500n,
          }),
          value: "0",
        },
        permit2: null,
      },
      slippageBps: 100,
      taker: TAKER,
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    });
    if (!sell.ok) throw new Error(sell.error.message);
    expect(sell.proposal.from.decimals).toBe(8);

    rpc.balance = 20_000_000n;
    const result = await executeTrade(
      { proposal: sell.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.error?.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.error?.message).toContain("0.2 MSTRc");
    expect(result.error?.message).toContain("0.3 MSTRc");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("5. fee-enabled swap: quoted fees never change amountIn or min-out", async () => {
    const withFees = proposal({
      fees: {
        protocolFee: { amount: "12500", token: BASE_USDC },
        gasFee: { amount: "3000", token: BASE_USDC },
      },
    });
    const withoutFees = proposal();
    expect(withFees.fees.protocolFee?.amount).toBe("12500");

    const a = decodeSwap(withFees.transaction!.data);
    const b = decodeSwap(withoutFees.transaction!.data);
    expect(a.amountIn).toBe(b.amountIn);
    expect(a.amountOutMinimum).toBe(b.amountOutMinimum);
    expect(a.amountIn).toBe(AMOUNT_IN);

    // A fee-bearing quote with a covering allowance still signs one tx.
    mockSend.mockReset();
    mockSend.mockResolvedValue("0xswap");
    const result = await executeTrade(
      { proposal: withFees, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );
    expect(result.state).toBe("SUCCESS");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("6. successful swap after correct approval: approve then swap", async () => {
    const p = proposal({ allowanceIssue: true });
    rpc.allowance = 0n;
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xswap");

    const states: string[] = [];
    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      (snapshot) => states.push(snapshot.state),
    );

    expect(states).toContain("APPROVING");
    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBe("0xapprove");
    expect(result.swapHash).toBe("0xswap");
  });

  it("7. no double approval/fee: a covering allowance skips the duplicate approval", async () => {
    // Quote was built when the allowance was short (so it still flags
    // approval), but the wallet has since approved — re-read says the
    // allowance covers amountIn, so no second approve/fee is signed.
    const p = proposal({ allowanceIssue: true });
    expect(p.needsPermit2Approval).toBe(true);
    rpc.allowance = AMOUNT_IN;

    mockSend.mockReset();
    mockSend.mockResolvedValue("0xswap");
    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const only = mockSend.mock.calls[0][1] as { to: string; data: `0x${string}` };
    expect(getAddress(only.to)).toBe(ROUTER);
    expect(decodeSwap(only.data).amountIn).toBe(AMOUNT_IN);
  });

  it("8. stale quote protection: a balance that dropped below amountIn aborts before signing", async () => {
    const p = proposal(); // quote-time balance read said the wallet could cover it
    rpc.balance = 2_490_955n; // …but it really holds 2.490955 USDC

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.error?.message).toContain("2.490955 USDC");
    expect(result.error?.message).toContain("5 USDC");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("8b. stale quote protection: a failed live read still blocks a known shortfall", async () => {
    const p = proposal({
      balanceIssue: { currentBalance: "2490955", requiredBalance: AMOUNT_IN.toString() },
    });
    rpc.balance = null; // RPC blip — must not invent an executable swap

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("INSUFFICIENT_BALANCE");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("9. confirmation is blocked (not merely warned) on an insufficient balance", async () => {
    const short = proposal({
      balanceIssue: { currentBalance: "2490955", requiredBalance: AMOUNT_IN.toString() },
    });
    const revalidated = revalidateTradeProposal(short, TAKER);
    expect(revalidated.state).toBe("VALIDATION_FAILED");
    expect(revalidated.error?.code).toBe("INSUFFICIENT_BALANCE");

    const snapshots: string[] = [];
    const confirmed = await runTradeConfirmation(short, TAKER, (s) => snapshots.push(s.state));
    expect(confirmed.state).not.toBe("READY_FOR_CONFIRMATION");
    expect(confirmed.error?.code).toBe("INSUFFICIENT_BALANCE");

    // The funded version of the same swap still reaches confirm.
    rpc.balance = AMOUNT_IN;
    const funded = proposal();
    expect(revalidateTradeProposal(funded, TAKER).state).toBe("VALIDATED");
  });

  it("10. the insufficient-balance risk fact is critical and states both amounts", () => {
    const facts = buildSwapRiskFacts({
      kind: "tokenized-stock-swap",
      from: usdc,
      to: mstrc,
      quote: aerodromeQuote({
        balanceIssue: { currentBalance: "2490955", requiredBalance: AMOUNT_IN.toString() },
      }),
      slippageBps: 100,
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    });
    const fact = facts.find((f) => f.id === "insufficient-balance");
    expect(fact?.severity).toBe("critical");
    expect(fact?.detail).toContain("2.490955 USDC");
    expect(fact?.detail).toContain("5 USDC");

    // No warning is raised when the wallet actually holds the amount.
    const fundedFacts = buildSwapRiskFacts({
      kind: "tokenized-stock-swap",
      from: usdc,
      to: mstrc,
      quote: aerodromeQuote(),
      slippageBps: 100,
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    });
    expect(fundedFacts.find((f) => f.id === "insufficient-balance")).toBeUndefined();
  });

  it("11. a funded wallet needs no approval and no extra spend", async () => {
    const p = proposal(); // allowance + balance already cover the swap
    mockSend.mockReset();
    mockSend.mockResolvedValue("0xswap");

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(p.needsPermit2Approval).toBe(false);
    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

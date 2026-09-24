// lib/trade/__tests__/trade-agent-fee.test.ts
//
// MPGR Agent swap fee (0.25% / 25 bps on the sell leg) —
//   1. fee calculation (exact, floor, dust, invalid)
//   2. fee-recipient configuration handling
//   3. proposal integration: buy, sell, different decimals, quote intact
//   4. pre-execution validation (displayed-only, drift-safe)
//   5. execution: separate post-swap transfer, non-blocking failures
//
// The fee must NEVER change the swap itself: quote amounts, calldata,
// approvals, slippage, routing, min-out, price impact, and gas stay
// byte-for-byte identical with and without the fee.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, zeroAddress } from "viem";

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
const {
  MPGR_AGENT_FEE_BPS,
  MPGR_AGENT_FEE_PERCENT_LABEL,
  buildAgentFeeTransfer,
  buildProposalAgentFee,
  calculateAgentFeeAmount,
  getAgentFeeRecipient,
  resolveExecutionAgentFee,
} = await import("../trade-agent-fee");
const {
  AERODROME_SLIPSTREAM_PROVIDER_ID,
  AERODROME_SLIPSTREAM_SWAP_ROUTER,
  BASE_USDC,
  CDP_TRADE_PROVIDER_ID,
  NATIVE_ETH_SENTINEL,
  PERMIT2_ADDRESS,
} = await import("../trade-config");
const { MPGR_TOKEN_CONFIG } = await import("@/lib/token/token-config");
const { erc20Abi } = await import("@/lib/erc20-abi");
const { encodeAerodromeExactInputSingle } = await import("../aerodrome-slipstream");

import type { CdpSwapQuote, TradeProposal, TradeTokenRef } from "../trade-types";

const TAKER = "0x2222222222222222222222222222222222222222" as const;
const FEE_WALLET = "0x1111111111111111111111111111111111111111" as const;
const ROUTER = getAddress(AERODROME_SLIPSTREAM_SWAP_ROUTER);
// MSTRc — Coinbase tokenized stock (B20) on Base, 8 decimals on-chain.
const MSTRC = getAddress("0xb2000000000000000000004884b426556b92883d");

const usdc: TradeTokenRef = {
  address: BASE_USDC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  kind: "erc20",
  verified: true,
};

const mpgr: TradeTokenRef = {
  address: MPGR_TOKEN_CONFIG.address,
  symbol: "MPGR",
  name: "MPGR",
  decimals: MPGR_TOKEN_CONFIG.decimals,
  kind: "erc20",
  verified: true,
};

const eth: TradeTokenRef = {
  address: NATIVE_ETH_SENTINEL,
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  kind: "native",
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

function cdpQuote(overrides: Partial<CdpSwapQuote> & Pick<CdpSwapQuote, "fromAmount" | "toAmount" | "minToAmount">): CdpSwapQuote {
  return {
    liquidityAvailable: true,
    fromToken: BASE_USDC,
    toToken: MPGR_TOKEN_CONFIG.address,
    issues: { allowance: null, balance: null, simulationIncomplete: false },
    fees: { gasFee: { amount: "3000", token: BASE_USDC } },
    transaction: { to: getAddress(PERMIT2_ADDRESS), data: "0xabcdef", value: "0", gas: "210000" },
    permit2: null,
    ...overrides,
  };
}

function withFeeEnv(): void {
  vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
}

describe("MPGR Agent fee — calculation", () => {
  it("1. fee rate is exactly 0.25% (25 bps)", () => {
    expect(MPGR_AGENT_FEE_BPS).toBe(25);
    expect(MPGR_AGENT_FEE_PERCENT_LABEL).toBe("0.25%");
  });

  it("2. exact fee on representative sizes", () => {
    // 5 USDC (6dp) → 0.0125 USDC
    expect(calculateAgentFeeAmount("5000000")).toBe(12_500n);
    // 1 USDC → 2500 atomic
    expect(calculateAgentFeeAmount("1000000")).toBe(2_500n);
    // 1 ETH (18dp) → 0.0025 ETH
    expect(calculateAgentFeeAmount("1000000000000000000")).toBe(2_500_000_000_000_000n);
    // 0.3 MSTRc (8dp) → 75_000 atomic
    expect(calculateAgentFeeAmount("30000000")).toBe(75_000n);
    // 100 MPGR (18dp)
    expect(calculateAgentFeeAmount("100000000000000000000")).toBe(250_000_000_000_000_000n);
  });

  it("3. floor division — never rounds up, always less than the input", () => {
    // 401 * 25 / 10000 = 1.0025 → 1
    expect(calculateAgentFeeAmount("401")).toBe(1n);
    // 399 * 25 / 10000 = 0.9975 → 0 (dust)
    expect(calculateAgentFeeAmount("399")).toBe(0n);
    expect(calculateAgentFeeAmount("400")).toBe(1n);
    expect(calculateAgentFeeAmount("1")).toBe(0n);
    for (const raw of ["1", "399", "401", "999", "5000000", "1000000000000000000"]) {
      const fee = calculateAgentFeeAmount(raw)!;
      expect(fee < BigInt(raw)).toBe(true);
    }
  });

  it("4. invalid amounts fail closed (null, never a guessed fee)", () => {
    expect(calculateAgentFeeAmount("0")).toBeNull();
    expect(calculateAgentFeeAmount("")).toBeNull();
    expect(calculateAgentFeeAmount("-5")).toBeNull();
    expect(calculateAgentFeeAmount("1.5")).toBeNull();
    expect(calculateAgentFeeAmount("0x10")).toBeNull();
    expect(calculateAgentFeeAmount("abc")).toBeNull();
    expect(calculateAgentFeeAmount("  ")).toBeNull();
  });
});

describe("MPGR Agent fee — recipient configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("5. unset recipient → not ok (swap proceeds, fee skipped)", () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    const result = getAgentFeeRecipient();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not configured/);
  });

  it("6. invalid recipient (garbage, zero address) → not ok", () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "not-an-address");
    expect(getAgentFeeRecipient().ok).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", zeroAddress);
    const zero = getAgentFeeRecipient();
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.reason).toMatch(/invalid/);
  });

  it("7. valid recipient is accepted", () => {
    withFeeEnv();
    const result = getAgentFeeRecipient();
    expect(result).toEqual({ ok: true, recipient: FEE_WALLET });
  });
});

describe("MPGR Agent fee — proposal fee", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("8. applied fee carries exact amount + human display (USDC 6dp)", () => {
    withFeeEnv();
    const fee = buildProposalAgentFee({
      fromAmount: "5000000",
      from: usdc,
      taker: TAKER,
      executionAvailable: true,
    });
    expect(fee.status).toBe("applied");
    expect(fee.bps).toBe(25);
    expect(fee.recipient).toBe(FEE_WALLET);
    expect(fee.amountAtomic).toBe("12500");
    expect(fee.displayAmount).toBe("0.0125 USDC");
    expect(fee.reason).toBeNull();
  });

  it("9. display respects token decimals (ETH 18dp, B20 8dp)", () => {
    withFeeEnv();
    const ethFee = buildProposalAgentFee({
      fromAmount: "1000000000000000000",
      from: eth,
      taker: TAKER,
      executionAvailable: true,
    });
    expect(ethFee.amountAtomic).toBe("2500000000000000");
    expect(ethFee.displayAmount).toBe("0.0025 ETH");

    const b20Fee = buildProposalAgentFee({
      fromAmount: "30000000",
      from: mstrc,
      taker: TAKER,
      executionAvailable: true,
    });
    expect(b20Fee.amountAtomic).toBe("75000");
    expect(b20Fee.displayAmount).toBe("0.00075 MSTRc");
  });

  it("10. skipped (never an error) when uncollectible", () => {
    // No execution → skipped.
    withFeeEnv();
    expect(
      buildProposalAgentFee({ fromAmount: "5000000", from: usdc, taker: TAKER, executionAvailable: false }).status,
    ).toBe("skipped");

    // No recipient → skipped.
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    const unconfigured = buildProposalAgentFee({
      fromAmount: "5000000",
      from: usdc,
      taker: TAKER,
      executionAvailable: true,
    });
    expect(unconfigured.status).toBe("skipped");
    expect(unconfigured.amountAtomic).toBe("0");
    expect(unconfigured.recipient).toBeNull();

    // Taker == recipient → skipped (never self-charge).
    withFeeEnv();
    const self = buildProposalAgentFee({
      fromAmount: "5000000",
      from: usdc,
      taker: FEE_WALLET,
      executionAvailable: true,
    });
    expect(self.status).toBe("skipped");

    // Dust → skipped.
    const dust = buildProposalAgentFee({
      fromAmount: "399",
      from: usdc,
      taker: TAKER,
      executionAvailable: true,
    });
    expect(dust.status).toBe("skipped");
    expect(dust.reason).toMatch(/zero/);

    // Invalid amount → skipped.
    const invalid = buildProposalAgentFee({
      fromAmount: "abc",
      from: usdc,
      taker: TAKER,
      executionAvailable: true,
    });
    expect(invalid.status).toBe("skipped");
  });
});

describe("MPGR Agent fee — proposal integration (buy/sell, quote intact)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function buyProposal(): TradeProposal {
    withFeeEnv();
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({
        fromToken: BASE_USDC,
        toToken: MPGR_TOKEN_CONFIG.address,
        fromAmount: "10000000",
        toAmount: "5000000000000000000",
        minToAmount: "4950000000000000000",
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    return built.proposal;
  }

  function sellProposal(): TradeProposal {
    withFeeEnv();
    const built = buildTradeProposal({
      from: mpgr,
      to: usdc,
      quote: cdpQuote({
        fromToken: MPGR_TOKEN_CONFIG.address,
        toToken: BASE_USDC,
        fromAmount: "5000000000000000000",
        toAmount: "10000000",
        minToAmount: "9900000",
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    return built.proposal;
  }

  it("11. BUY attaches the fee without touching the quote", () => {
    const p = buyProposal();
    expect(p.agentFee?.status).toBe("applied");
    expect(p.agentFee?.amountAtomic).toBe("25000"); // 0.25% of 10 USDC
    expect(p.agentFee?.displayAmount).toBe("0.025 USDC");
    // Quote intact.
    expect(p.fromAmount).toBe("10000000");
    expect(p.toAmount).toBe("5000000000000000000");
    expect(p.minToAmount).toBe("4950000000000000000");
    expect(p.slippageBps).toBe(100);
    expect(p.transaction).toEqual({ to: getAddress(PERMIT2_ADDRESS), data: "0xabcdef", value: "0", gas: "210000" });
    expect(p.fees.gasFee?.amount).toBe("3000");
    // Disclosure present.
    expect(p.risk.find((f) => f.id === "mpgr-agent-fee")?.severity).toBe("info");
    expect(p.postConfirmationSteps.some((s) => s.includes("0.25%") && s.includes("0.025 USDC"))).toBe(true);
    expect(p.description).toBe("Swap 10 USDC → ~5 MPGR on Base (min 4.95 MPGR).");
  });

  it("12. SELL attaches the fee in the SELL token (MPGR 18dp)", () => {
    const p = sellProposal();
    expect(p.agentFee?.status).toBe("applied");
    expect(p.agentFee?.amountAtomic).toBe("12500000000000000"); // 0.25% of 5 MPGR
    expect(p.agentFee?.displayAmount).toBe("0.0125 MPGR");
    expect(p.fromAmount).toBe("5000000000000000000");
    expect(p.minToAmount).toBe("9900000");
    expect(p.transaction?.data).toBe("0xabcdef");
  });

  it("13. native ETH sell: fee quoted in ETH, swap value untouched", () => {
    withFeeEnv();
    const built = buildTradeProposal({
      from: eth,
      to: usdc,
      quote: cdpQuote({
        fromToken: NATIVE_ETH_SENTINEL,
        toToken: BASE_USDC,
        fromAmount: "1000000000000000000",
        toAmount: "3000000000",
        minToAmount: "2970000000",
        transaction: { to: getAddress(PERMIT2_ADDRESS), data: "0xabcdef", value: "1000000000000000000" },
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    const p = built.proposal;
    expect(p.agentFee?.status).toBe("applied");
    expect(p.agentFee?.displayAmount).toBe("0.0025 ETH");
    // Swap still sends exactly 1 ETH — the fee is a separate transfer.
    expect(p.transaction?.value).toBe("1000000000000000000");
  });

  it("14. B20 buy AND sell (Aerodrome, 6dp↔8dp) keep calldata identical with/without fee", () => {
    const buyQuote: CdpSwapQuote = {
      liquidityAvailable: true,
      fromToken: BASE_USDC,
      toToken: MSTRC,
      fromAmount: "5000000",
      toAmount: "3020310",
      minToAmount: "2990106",
      issues: { allowance: null, balance: null, simulationIncomplete: false },
      transaction: {
        to: ROUTER,
        data: encodeAerodromeExactInputSingle({
          tokenIn: getAddress(BASE_USDC),
          tokenOut: MSTRC,
          recipient: TAKER,
          deadline: 1_790_177_105n,
          amountIn: 5_000_000n,
          amountOutMinimum: 2_990_106n,
        }),
        value: "0",
      },
      permit2: null,
    };

    withFeeEnv();
    const withFee = buildTradeProposal({
      from: usdc,
      to: mstrc,
      quote: buyQuote,
      slippageBps: 100,
      taker: TAKER,
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    });
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    const withoutFee = buildTradeProposal({
      from: usdc,
      to: mstrc,
      quote: buyQuote,
      slippageBps: 100,
      taker: TAKER,
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    });
    if (!withFee.ok || !withoutFee.ok) throw new Error("proposal build failed");

    // B20 BUY fee: 12_500 atomic USDC.
    expect(withFee.proposal.agentFee?.status).toBe("applied");
    expect(withFee.proposal.agentFee?.amountAtomic).toBe("12500");
    // Everything the wallet signs/executes is identical.
    expect(withFee.proposal.transaction).toEqual(withoutFee.proposal.transaction);
    expect(withFee.proposal.fromAmount).toBe(withoutFee.proposal.fromAmount);
    expect(withFee.proposal.minToAmount).toBe(withoutFee.proposal.minToAmount);
    expect(withFee.proposal.displayMinToAmount).toBe(withoutFee.proposal.displayMinToAmount);

    // B20 SELL (8dp in): fee in MSTRc atomic units.
    withFeeEnv();
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
            deadline: 1_790_177_105n,
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
    expect(sell.proposal.agentFee?.status).toBe("applied");
    expect(sell.proposal.agentFee?.amountAtomic).toBe("75000");
    expect(sell.proposal.agentFee?.displayAmount).toBe("0.00075 MSTRc");
  });

  it("15. unconfigured fee wallet → proposal reads exactly as before (fee skipped, silent)", () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({ fromAmount: "10000000", toAmount: "5000000000000000000", minToAmount: "4950000000000000000" }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    expect(built.proposal.agentFee?.status).toBe("skipped");
    expect(built.proposal.risk.find((f) => f.id === "mpgr-agent-fee")).toBeUndefined();
    expect(built.proposal.postConfirmationSteps.some((s) => s.includes("agent fee"))).toBe(false);
  });
});

describe("MPGR Agent fee — pre-execution validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function quotedProposal(): TradeProposal {
    withFeeEnv();
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({ fromAmount: "10000000", toAmount: "5000000000000000000", minToAmount: "4950000000000000000" }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    return built.proposal;
  }

  it("16. displayed + re-validated fee resolves to send", () => {
    const p = quotedProposal();
    const resolved = resolveExecutionAgentFee(p);
    expect(resolved).toEqual({ send: true, recipient: FEE_WALLET, amount: 25_000n });
  });

  it("17. legacy proposal (no agentFee) → never sends a fee the user did not review", () => {
    withFeeEnv();
    const p = quotedProposal();
    delete p.agentFee;
    expect(resolveExecutionAgentFee(p).send).toBe(false);
  });

  it("18. config drift after quoting (recipient changed) → no fee", () => {
    const p = quotedProposal();
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "0x3333333333333333333333333333333333333333");
    const resolved = resolveExecutionAgentFee(p);
    expect(resolved.send).toBe(false);
    if (!resolved.send) expect(resolved.reason).toMatch(/no longer matches/);
  });

  it("19. recipient removed after quoting → no fee", () => {
    const p = quotedProposal();
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    expect(resolveExecutionAgentFee(p).send).toBe(false);
  });

  it("20. tampered fee amount on the proposal → no fee", () => {
    const p = quotedProposal();
    p.agentFee = { ...p.agentFee!, amountAtomic: "999999999" };
    expect(resolveExecutionAgentFee(p).send).toBe(false);
  });

  it("21. fee transfer encoding: ERC-20 transfer vs native value", () => {
    const erc20 = buildAgentFeeTransfer({
      fromAddress: getAddress(BASE_USDC),
      recipient: getAddress(FEE_WALLET),
      amount: 25_000n,
    });
    expect(erc20.kind).toBe("erc20");
    if (erc20.kind !== "erc20") throw new Error("expected erc20");
    expect(erc20.to).toBe(getAddress(BASE_USDC));
    expect(erc20.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: erc20.data });
    expect(decoded.functionName).toBe("transfer");
    expect((decoded.args as readonly [string, bigint])[0]).toBe(getAddress(FEE_WALLET));
    expect((decoded.args as readonly [string, bigint])[1]).toBe(25_000n);

    const native = buildAgentFeeTransfer({
      fromAddress: NATIVE_ETH_SENTINEL,
      recipient: getAddress(FEE_WALLET),
      amount: 2_500_000_000_000_000n,
    });
    expect(native).toEqual({ kind: "native", to: getAddress(FEE_WALLET), value: 2_500_000_000_000_000n });
  });
});

describe("MPGR Agent fee — execution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function quotedProposal(): TradeProposal {
    withFeeEnv();
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({ fromAmount: "10000000", toAmount: "5000000000000000000", minToAmount: "4950000000000000000" }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    return built.proposal;
  }

  beforeEach(() => {
    mockSend.mockReset();
    mockSign.mockReset();
    mockWait.mockReset();
    mockRead.mockReset();
    mockWait.mockResolvedValue({ status: "success" });
    // Live balance covers the 10 USDC sell; allowance covers (no approve step).
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 10_000_000n;
      if (params?.functionName === "allowance") return 10_000_000n;
      throw new Error(`unexpected read: ${String(params?.functionName)}`);
    });
  });

  it("22. fee is a separate post-swap transfer; swap calldata + approval untouched", async () => {
    const p = quotedProposal();
    mockSend.mockResolvedValueOnce("0xswap").mockResolvedValueOnce("0xfee");

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeHash).toBe("0xfee");
    expect(result.feeError).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(2);

    // Call 1: the swap itself — exactly the quoted transaction.
    const swapCall = mockSend.mock.calls[0][1] as { to: string; data: string; value: bigint };
    expect(getAddress(swapCall.to)).toBe(getAddress(PERMIT2_ADDRESS));
    expect(swapCall.data).toBe("0xabcdef");
    expect(swapCall.value).toBe(0n);

    // Call 2: the fee — USDC.transfer(feeWallet, 25000), nothing else.
    const feeCall = mockSend.mock.calls[1][1] as { to: string; data: `0x${string}`; value: bigint };
    expect(getAddress(feeCall.to)).toBe(getAddress(BASE_USDC));
    expect(feeCall.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: feeCall.data });
    expect(decoded.functionName).toBe("transfer");
    expect((decoded.args as readonly [string, bigint])[0]).toBe(getAddress(FEE_WALLET));
    expect((decoded.args as readonly [string, bigint])[1]).toBe(25_000n);
  });

  it("23. approval covers the swap amount only — never the fee", async () => {
    withFeeEnv();
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({
        fromAmount: "10000000",
        toAmount: "5000000000000000000",
        minToAmount: "4950000000000000000",
        issues: {
          allowance: { currentAllowance: "0", spender: PERMIT2_ADDRESS },
          balance: null,
          simulationIncomplete: false,
        },
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 10_000_000n;
      if (params?.functionName === "allowance") return 0n;
      throw new Error("unexpected read");
    });
    mockSend.mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xswap").mockResolvedValueOnce("0xfee");

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(mockSend).toHaveBeenCalledTimes(3); // approve → swap → fee
    const approveCall = mockSend.mock.calls[0][1] as { data: `0x${string}` };
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approveCall.data });
    expect(decoded.functionName).toBe("approve");
    // Exactly fromAmount — the fee needs no approval (direct transfer).
    expect((decoded.args as readonly [string, bigint])[1]).toBe(10_000_000n);
  });

  it("24. recipient unconfigured at execution → single swap tx, SUCCESS, no fee", async () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({ fromAmount: "10000000", toAmount: "5000000000000000000", minToAmount: "4950000000000000000" }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    mockSend.mockResolvedValue("0xswap");

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.feeHash).toBeNull();
    expect(result.feeError).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("25. fee rejection is non-blocking: swap stands SUCCESS with feeError recorded", async () => {
    const p = quotedProposal();
    mockSend.mockResolvedValueOnce("0xswap").mockRejectedValueOnce(new Error("User rejected the request"));

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeHash).toBeNull();
    expect(result.feeError?.code).toBe("WALLET_REJECTED");
    expect(result.feeError?.message).toMatch(/swap settled/i);
  });

  it("26. failed fee receipt is non-blocking: SUCCESS with feeHash + feeError", async () => {
    const p = quotedProposal();
    mockSend.mockResolvedValueOnce("0xswap").mockResolvedValueOnce("0xfee");
    mockWait.mockResolvedValueOnce({ status: "success" }).mockResolvedValueOnce({ status: "reverted" });

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.feeHash).toBe("0xfee");
    expect(result.feeError?.code).toBe("SEND_FAILED");
  });

  it("27. failed swap → ERROR with NO fee transfer attempted", async () => {
    const p = quotedProposal();
    mockSend.mockResolvedValue("0xswap");
    mockWait.mockResolvedValue({ status: "reverted" });

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.feeHash).toBeNull();
    expect(result.feeError).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1); // swap only — fee never attempted
  });

  it("28. native ETH sell: fee is a plain value transfer to the fee wallet", async () => {
    withFeeEnv();
    const built = buildTradeProposal({
      from: eth,
      to: usdc,
      quote: cdpQuote({
        fromToken: NATIVE_ETH_SENTINEL,
        toToken: BASE_USDC,
        fromAmount: "1000000000000000000",
        toAmount: "3000000000",
        minToAmount: "2970000000",
        transaction: { to: getAddress(PERMIT2_ADDRESS), data: "0xabcdef", value: "1000000000000000000" },
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    mockSend.mockResolvedValueOnce("0xswap").mockResolvedValueOnce("0xfee");

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.feeHash).toBe("0xfee");
    const feeCall = mockSend.mock.calls[1][1] as { to: string; data?: string; value: bigint };
    expect(getAddress(feeCall.to)).toBe(getAddress(FEE_WALLET));
    expect(feeCall.value).toBe(2_500_000_000_000_000n);
    expect(feeCall.data).toBeUndefined();
  });

  it("29. tampered proposal fee amount → swap succeeds, no fee sent", async () => {
    const p = quotedProposal();
    p.agentFee = { ...p.agentFee!, amountAtomic: "999999999" };
    mockSend.mockResolvedValue("0xswap");

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.feeHash).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

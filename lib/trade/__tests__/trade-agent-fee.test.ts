// lib/trade/__tests__/trade-agent-fee.test.ts
//
// MPGR Agent swap fee (0.25% / 25 bps on the sell leg) —
//   1. fee calculation (exact, floor, dust, invalid)
//   2. fee-recipient configuration handling
//   3. proposal integration: buy, sell, different decimals, quote intact
//   4. pre-execution validation (displayed-only, drift-safe)
//   5. execution: ATOMIC with the swap via an EIP-5792 batch
//      ([swapCall, feeCall]) — never a separate fee transaction
//
// The fee must NEVER change the swap itself: quote amounts, calldata,
// approvals, slippage, routing, min-out, price impact, and gas stay
// byte-for-byte identical with and without the fee. And the swap must
// NEVER fail because the fee could not be collected: a wallet without
// atomic-batch support, or one that cannot fund sell + fee, still swaps
// normally with the fee skipped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, zeroAddress } from "viem";

const {
  mockSend,
  mockSign,
  mockWait,
  mockRead,
  mockSendCalls,
  mockCallsStatus,
  mockCapabilities,
  mockBalance,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSign: vi.fn(),
  mockWait: vi.fn(),
  mockRead: vi.fn(),
  mockSendCalls: vi.fn(),
  mockCallsStatus: vi.fn(),
  mockCapabilities: vi.fn(),
  mockBalance: vi.fn(),
}));

vi.mock("wagmi/actions", () => ({
  sendTransaction: (...args: unknown[]) => mockSend(...args),
  signTypedData: (...args: unknown[]) => mockSign(...args),
  waitForTransactionReceipt: (...args: unknown[]) => mockWait(...args),
  readContract: (...args: unknown[]) => mockRead(...args),
  sendCalls: (...args: unknown[]) => mockSendCalls(...args),
  getCallsStatus: (...args: unknown[]) => mockCallsStatus(...args),
  getCapabilities: (...args: unknown[]) => mockCapabilities(...args),
  getBalance: (...args: unknown[]) => mockBalance(...args),
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
  resetAgentFeeConfigWarningForTests,
  resolveExecutionAgentFee,
} = await import("../trade-agent-fee");
const {
  TRADE_CALLS_POLL_INTERVAL_MS,
  TRADE_CALLS_STATUS_TIMEOUT_MS,
  setCallsBatchTimingForTests,
} = await import("../trade-calls-batch");
const {
  AERODROME_SLIPSTREAM_PROVIDER_ID,
  AERODROME_SLIPSTREAM_SWAP_ROUTER,
  BASE_USDC,
  CDP_TRADE_PROVIDER_ID,
  NATIVE_ETH_SENTINEL,
  PERMIT2_ADDRESS,
  ZERO_EX_PROVIDER_ID,
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

  it("7b. server var is preferred, public var is the fallback", () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
    vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", "0x3333333333333333333333333333333333333333");
    expect(getAgentFeeRecipient()).toEqual({
      ok: true,
      recipient: "0x3333333333333333333333333333333333333333",
    });

    vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", "");
    expect(getAgentFeeRecipient()).toEqual({ ok: true, recipient: FEE_WALLET });

    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
    expect(getAgentFeeRecipient()).toEqual({ ok: true, recipient: FEE_WALLET });
  });

  it("7c. missing recipient warns once per process (diagnosable, not silent)", () => {
    resetAgentFeeConfigWarningForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
      expect(getAgentFeeRecipient().ok).toBe(false);
      expect(getAgentFeeRecipient().ok).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/not configured/);
    } finally {
      warn.mockRestore();
      resetAgentFeeConfigWarningForTests();
    }
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

  it("10b. server var alone quotes the fee (public var unset)", () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
    const fee = buildProposalAgentFee({
      fromAmount: "5000000",
      from: usdc,
      taker: TAKER,
      executionAvailable: true,
    });
    expect(fee.status).toBe("applied");
    expect(fee.recipient).toBe(FEE_WALLET);
    expect(fee.amountAtomic).toBe("12500");
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
    // Swap still sends exactly 1 ETH; the fee is a separate CALL in the
    // same transaction, not a separate transaction.
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

  it("18. STALE CLIENT (2026-09-24 incident): server-quoted fee sends even when the client bundle has no env", () => {
    const p = quotedProposal(); // server quoted while configured
    vi.unstubAllEnvs(); // ...but the running client bundle predates the env var
    const resolved = resolveExecutionAgentFee(p);
    expect(resolved).toEqual({ send: true, recipient: FEE_WALLET, amount: 25_000n });
  });

  it("19. ROTATION SKEW: server-quoted fee sends even when client env differs — server is source of truth", () => {
    const p = quotedProposal();
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "0x3333333333333333333333333333333333333333");
    const resolved = resolveExecutionAgentFee(p);
    expect(resolved).toEqual({ send: true, recipient: FEE_WALLET, amount: 25_000n });
  });

  it("20. tampered fee amount on the proposal → no fee", () => {
    const p = quotedProposal();
    p.agentFee = { ...p.agentFee!, amountAtomic: "999999999" };
    expect(resolveExecutionAgentFee(p).send).toBe(false);
  });

  it("20b. invalid quoted recipient (garbage, zero address, taker) → no fee", () => {
    for (const recipient of ["not-an-address", zeroAddress, TAKER]) {
      const p = quotedProposal();
      p.agentFee = { ...p.agentFee!, recipient: recipient as `0x${string}` };
      expect(resolveExecutionAgentFee(p).send).toBe(false);
    }
  });

  it("20c. zero quoted amount or non-executable proposal → no fee", () => {
    const zero = quotedProposal();
    zero.agentFee = { ...zero.agentFee!, amountAtomic: "0" };
    expect(resolveExecutionAgentFee(zero).send).toBe(false);

    const notExecutable = quotedProposal();
    notExecutable.executionAvailable = false;
    expect(resolveExecutionAgentFee(notExecutable).send).toBe(false);
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

// ---------------------------------------------------------------------------
// Execution — the fee is settled ATOMICALLY inside the swap transaction via
// an EIP-5792 batch of [swapCall, feeCall]. There is never a third
// transaction, and the swap is never put at risk by the fee.
// ---------------------------------------------------------------------------

const SWAP_HASH = "0x" + "aa".repeat(32);
const FEE_HASH = "0x" + "bb".repeat(32);

/** `wallet_getCapabilities` answer that advertises atomic batches on Base. */
function advertiseAtomicBatches(): void {
  mockCapabilities.mockResolvedValue({ "8453": { atomic: { supported: true } } });
}

/** `wallet_getCallsStatus` answer: both legs confirmed. */
function batchConfirmed(overrides?: {
  swapHash?: string | null;
  feeHash?: string | null;
  status?: "success" | "failure";
  swapStatus?: "success" | "reverted";
  feeStatus?: "success" | "reverted";
}): void {
  const swapHash = overrides?.swapHash === undefined ? SWAP_HASH : overrides.swapHash;
  const feeHash = overrides?.feeHash === undefined ? FEE_HASH : overrides.feeHash;
  const receipts: unknown[] = [];
  if (swapHash) {
    receipts.push({
      transactionHash: swapHash,
      status: overrides?.swapStatus ?? "success",
      blockNumber: 1n,
      gasUsed: 21_000n,
    });
  }
  if (feeHash) {
    receipts.push({
      transactionHash: feeHash,
      status: overrides?.feeStatus ?? "success",
      blockNumber: 1n,
      gasUsed: 21_000n,
    });
  }
  mockCallsStatus.mockResolvedValue({
    atomic: true,
    chainId: 8453,
    version: "2.0.0",
    statusCode: (overrides?.status ?? "success") === "success" ? 200 : 500,
    status: overrides?.status ?? "success",
    receipts,
  });
}

interface BatchCall {
  to?: string;
  data?: string;
  value?: bigint;
}

function batchCalls(): BatchCall[] {
  const params = mockSendCalls.mock.calls[0]?.[1] as {
    calls?: BatchCall[];
    forceAtomic?: boolean;
    experimental_fallback?: unknown;
    chainId?: number;
    account?: string;
  };
  return params.calls ?? [];
}

function batchParams(): {
  calls: BatchCall[];
  forceAtomic?: boolean;
  experimental_fallback?: unknown;
  chainId?: number;
  account?: string;
} {
  return mockSendCalls.mock.calls[0]?.[1] as {
    calls: BatchCall[];
    forceAtomic?: boolean;
    experimental_fallback?: unknown;
    chainId?: number;
    account?: string;
  };
}

function decodeTransfer(data: string | undefined): { fn: string; to: string; amount: bigint } {
  const decoded = decodeFunctionData({ abi: erc20Abi, data: data as `0x${string}` });
  const args = decoded.args as readonly [string, bigint];
  return { fn: decoded.functionName, to: getAddress(args[0]), amount: args[1] };
}

describe("MPGR Agent fee — atomic execution", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSign.mockReset();
    mockWait.mockReset();
    mockRead.mockReset();
    mockSendCalls.mockReset();
    mockCallsStatus.mockReset();
    mockCapabilities.mockReset();
    mockBalance.mockReset();
    setCallsBatchTimingForTests({
      pollIntervalMs: TRADE_CALLS_POLL_INTERVAL_MS,
      statusTimeoutMs: TRADE_CALLS_STATUS_TIMEOUT_MS,
    });
    mockWait.mockResolvedValue({ status: "success" });
    // Default: the wallet does NOT advertise atomic batches, so every test
    // that does not opt in exercises the plain swap path.
    mockCapabilities.mockResolvedValue(undefined);
    // Live balance covers the 10 USDC sell PLUS the 0.025 USDC fee, and the
    // allowance covers the swap (no approve step). Both legs of the atomic
    // batch must be fundable, so the default fixture is deliberately funded
    // for sell + fee; the underfunded tests below narrow it on purpose.
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 20_000_000n;
      if (params?.functionName === "allowance") return 10_000_000n;
      throw new Error(`unexpected read: ${String(params?.functionName)}`);
    });
  });

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

  it("22. ATOMIC: fee rides inside the swap transaction — one signature, two calls", async () => {
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    // NO separate fee transaction was ever broadcast.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendCalls).toHaveBeenCalledTimes(1);

    const params = batchParams();
    expect(params.forceAtomic).toBe(true);
    expect(params.chainId).toBe(8453);
    expect(params.account).toBe(TAKER);
    // viem's non-atomic fallback is deliberately never requested.
    expect(params.experimental_fallback).toBeUndefined();

    const calls = batchCalls();
    expect(calls).toHaveLength(2);

    // Call 1: the swap — exactly the quoted transaction, untouched.
    expect(getAddress(calls[0].to as string)).toBe(getAddress(PERMIT2_ADDRESS));
    expect(calls[0].data).toBe("0xabcdef");
    expect(calls[0].value).toBe(0n);

    // Call 2: the fee — USDC.transfer(feeWallet, 25000), nothing else.
    expect(getAddress(calls[1].to as string)).toBe(getAddress(BASE_USDC));
    expect(calls[1].value).toBe(0n);
    const fee = decodeTransfer(calls[1].data);
    expect(fee.fn).toBe("transfer");
    expect(fee.to).toBe(getAddress(FEE_WALLET));
    expect(fee.amount).toBe(25_000n);

    // Both hashes come from the SAME batch.
    expect(result.swapHash).toBe(SWAP_HASH);
    expect(result.feeHash).toBe(FEE_HASH);
    expect(result.feeError).toBeNull();
    expect(result.feeSkippedReason).toBeNull();
  });

  it("22b. approval is unchanged and still covers the swap amount only", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({
        fromAmount: "10000000",
        toAmount: "5000000000000000000",
        minToAmount: "4950000000000000000",
        issues: { allowance: { currentAllowance: "0", spender: PERMIT2_ADDRESS }, balance: null, simulationIncomplete: false },
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 20_000_000n;
      if (params?.functionName === "allowance") return 0n;
      throw new Error("unexpected read");
    });
    mockSend.mockResolvedValueOnce("0xapprove");

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBe("0xapprove");
    // Exactly two on-chain steps: the approval, then the atomic swap+fee.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSendCalls).toHaveBeenCalledTimes(1);
    const approveCall = mockSend.mock.calls[0][1] as { data: `0x${string}` };
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approveCall.data });
    expect(decoded.functionName).toBe("approve");
    // Exactly fromAmount — the fee leg needs no approval (direct transfer).
    expect((decoded.args as readonly [string, bigint])[1]).toBe(10_000_000n);
  });

  it("23. BUY: fee is charged in the SELL token (USDC) and routed to the fee wallet", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    const p = quotedProposal();
    expect(p.agentFee?.displayAmount).toBe("0.025 USDC");

    await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    const fee = decodeTransfer(batchCalls()[1].data);
    expect(fee.to).toBe(getAddress(FEE_WALLET));
    expect(fee.amount).toBe(25_000n);
    // The buy-token leg is untouched.
    expect(batchCalls()[0].data).toBe("0xabcdef");
  });

  it("23b. SELL: fee is charged in the SELL token (MPGR, 18dp)", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
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
    // 10 MPGR — covers the 5 MPGR sell plus the 0.0125 MPGR fee.
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 10_000_000_000_000_000_000n;
      if (params?.functionName === "allowance") return 0n;
      throw new Error("unexpected read");
    });

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    // Fee is a transfer of the SELL token (MPGR), not USDC.
    expect(getAddress(batchCalls()[1].to as string)).toBe(getAddress(MPGR_TOKEN_CONFIG.address));
    const fee = decodeTransfer(batchCalls()[1].data);
    expect(fee.amount).toBe(12_500_000_000_000_000n);
    expect(fee.to).toBe(getAddress(FEE_WALLET));
    // Swap calldata untouched.
    expect(batchCalls()[0].data).toBe("0xabcdef");
  });

  it("23c. native ETH sell: both legs carry value in ONE transaction", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
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
    // Wallet holds the swap amount plus the fee.
    mockBalance.mockResolvedValue(2_000_000_000_000_000_000n);

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    const calls = batchCalls();
    expect(calls).toHaveLength(2);
    // Swap still sends exactly 1 ETH.
    expect(calls[0].value).toBe(1_000_000_000_000_000_000n);
    // Fee leg is a plain value transfer — no calldata, no approval.
    expect(getAddress(calls[1].to as string)).toBe(getAddress(FEE_WALLET));
    expect(calls[1].value).toBe(2_500_000_000_000_000n);
    expect(calls[1].data).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("23d. native ETH sell with an underfunded wallet: swap proceeds, fee skipped", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
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
    // Only enough for the swap itself — the fee leg would revert the batch.
    mockBalance.mockResolvedValue(1_000_000_000_000_000_000n);
    mockSend.mockResolvedValue("0xswap");

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeHash).toBeNull();
    expect(result.feeSkippedReason).toMatch(/does not hold the swap amount plus the agent fee/);
    // No batch, and above all no third transaction.
    expect(mockSendCalls).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("23e. ERC-20 sell with an underfunded wallet: swap proceeds, fee skipped", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    const p = quotedProposal();
    // Wallet holds exactly the swap amount, nothing for the fee.
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 10_000_000n;
      if (params?.functionName === "allowance") return 10_000_000n;
      throw new Error("unexpected read");
    });
    mockSend.mockResolvedValue("0xswap");

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeHash).toBeNull();
    expect(result.feeSkippedReason).toMatch(/does not hold the swap amount plus the agent fee/);
    expect(mockSendCalls).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("24. UNSUPPORTED WALLET: plain swap, no batch, fee skipped — never a third tx", async () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
    // wallet_getCapabilities is missing / answers without atomic support.
    mockCapabilities.mockRejectedValue(new Error("MethodNotFoundRpcError: wallet_getCapabilities"));
    mockSend.mockResolvedValue("0xswap");
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeHash).toBeNull();
    expect(result.feeError).toBeNull();
    expect(result.feeSkippedReason).toMatch(/does not support atomic batch calls/);
    expect(mockSendCalls).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("24b. UNSUPPORTED WALLET (capabilities answer without atomic): same safe path", async () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET);
    mockCapabilities.mockResolvedValue({ "8453": { atomic: { supported: false } } });
    mockSend.mockResolvedValue("0xswap");
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeSkippedReason).toMatch(/does not support atomic batch calls/);
    expect(mockSendCalls).not.toHaveBeenCalled();
  });

  it("24c. no fee quoted at all (unconfigured wallet): plain swap, silent", async () => {
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    mockSend.mockResolvedValue("0xswap");
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({ fromAmount: "10000000", toAmount: "5000000000000000000", minToAmount: "4950000000000000000" }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.feeHash).toBeNull();
    expect(result.feeError).toBeNull();
    // Silent — exactly as an unconfigured fee wallet behaves today.
    expect(result.feeSkippedReason).toBeNull();
    expect(mockSendCalls).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("24d. STALE CLIENT: server-quoted fee still batches when the client bundle has no env", async () => {
    const p = quotedProposal(); // server quoted while configured
    vi.unstubAllEnvs(); // ...but the running client bundle predates the env var
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.feeHash).toBe(FEE_HASH);
    const fee = decodeTransfer(batchCalls()[1].data);
    expect(fee.to).toBe(getAddress(FEE_WALLET));
    expect(fee.amount).toBe(25_000n);
  });

  it("24e. tampered fee amount on the proposal → no fee leg, plain swap", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSend.mockResolvedValue("0xswap");
    const p = quotedProposal();
    // Below fromAmount, so it is the EXACT-AMOUNT re-validation that rejects it.
    p.agentFee = { ...p.agentFee!, amountAtomic: "123456" };

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.feeHash).toBeNull();
    expect(result.feeSkippedReason).toMatch(/does not match the swap amount/);
    expect(mockSendCalls).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("25. wallet CANNOT batch despite advertising it → swap falls back, fee skipped", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSendCalls.mockRejectedValue(
      Object.assign(new Error("atomicRequired is not supported"), {
        name: "AtomicityNotSupportedError",
      }),
    );
    mockSend.mockResolvedValue("0xswap");
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeHash).toBeNull();
    expect(result.feeSkippedReason).toMatch(/could not run an atomic batch/);
    // The swap still went out as a plain transaction.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("25b. wallet_sendCalls method missing → swap falls back, fee skipped", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSendCalls.mockRejectedValue(new Error("MethodNotFoundRpcError: wallet_sendCalls"));
    mockSend.mockResolvedValue("0xswap");
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe("0xswap");
    expect(result.feeSkippedReason).toMatch(/could not run an atomic batch/);
  });

  it("26. user cancels the atomic batch → ERROR, no swap, never retried", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSendCalls.mockRejectedValue(new Error("User rejected the request."));
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("WALLET_REJECTED");
    expect(result.swapHash).toBeNull();
    expect(result.feeHash).toBeNull();
    // No fallback prompt was raised for the swap.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("26b. generic batch send failure → ERROR, nothing broadcast", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSendCalls.mockRejectedValue(new Error("wallet exploded"));
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SEND_FAILED");
    expect(result.swapHash).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("27. the atomic batch reverts → ERROR (atomic means the swap did not settle)", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    batchConfirmed({ status: "failure", swapStatus: "reverted", feeStatus: "reverted" });
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SEND_FAILED");
    expect(result.error?.message).toMatch(/failed on Base/);
    expect(result.swapHash).toBe(SWAP_HASH);
    expect(result.feeHash).toBeNull();
    // Nothing was broadcast a second time.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("27b. only the fee leg reverted inside the batch → whole batch failed", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    batchConfirmed({ swapStatus: "success", feeStatus: "reverted" });
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("SEND_FAILED");
    expect(result.swapHash).toBe(SWAP_HASH);
    expect(result.feeHash).toBeNull();
  });

  it("27c. pending → confirmed: the batch is polled until it settles", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    setCallsBatchTimingForTests({ pollIntervalMs: 1, statusTimeoutMs: 2_000 });
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    mockCallsStatus
      .mockResolvedValueOnce({
        atomic: true,
        chainId: 8453,
        version: "2.0.0",
        statusCode: 100,
        status: "pending",
        receipts: [],
      })
      .mockResolvedValue({
        atomic: true,
        chainId: 8453,
        version: "2.0.0",
        statusCode: 200,
        status: "success",
        receipts: [
          { transactionHash: SWAP_HASH, status: "success", blockNumber: 1n, gasUsed: 21_000n },
          { transactionHash: FEE_HASH, status: "success", blockNumber: 1n, gasUsed: 21_000n },
        ],
      });
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBe(SWAP_HASH);
    expect(result.feeHash).toBe(FEE_HASH);
    expect(mockCallsStatus).toHaveBeenCalledTimes(2);
  });

  it("27d. batch status unresolvable → SUCCESS with an explicit, honest warning", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    setCallsBatchTimingForTests({ pollIntervalMs: 1, statusTimeoutMs: 20 });
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    mockCallsStatus.mockRejectedValue(new Error("wallet_getCallsStatus unavailable"));
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    // The batch WAS submitted, so this is not an error — but no hash is
    // claimed either.
    expect(result.state).toBe("SUCCESS");
    expect(result.swapHash).toBeNull();
    expect(result.feeHash).toBeNull();
    expect(result.feeError?.code).toBe("SEND_FAILED");
    expect(result.feeError?.message).toMatch(/could not be confirmed/);
    expect(result.feeError?.message).toContain("0xbatch");
  });

  it("28. plain swap path still reverted → ERROR and no fee was ever attempted", async () => {
    withFeeEnv();
    // No atomic support: the swap goes out on its own.
    mockSend.mockResolvedValue("0xswap");
    mockWait.mockResolvedValue({ status: "reverted" });
    const p = quotedProposal();

    const result = await executeTrade(
      { proposal: p, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("ERROR");
    expect(result.feeHash).toBeNull();
    expect(result.feeError).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSendCalls).not.toHaveBeenCalled();
  });

  it("29. Aerodrome B20 provider: swap call targets the Slipstream SwapRouter, fee leg in USDC", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
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
    const built = buildTradeProposal({
      from: usdc,
      to: mstrc,
      quote: buyQuote,
      slippageBps: 100,
      taker: TAKER,
      provider: AERODROME_SLIPSTREAM_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    const calls = batchCalls();
    expect(getAddress(calls[0].to as string)).toBe(ROUTER);
    expect(calls[0].data).toBe(buyQuote.transaction!.data);
    expect(getAddress(calls[1].to as string)).toBe(getAddress(BASE_USDC));
    const fee = decodeTransfer(calls[1].data);
    expect(fee.amount).toBe(12_500n);
    expect(fee.to).toBe(getAddress(FEE_WALLET));
  });

  it("30. 0x provider: swap calldata is forwarded verbatim into the batch", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    const zxData = "0x" + "cd".repeat(40) as `0x${string}`;
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({
        fromAmount: "10000000",
        toAmount: "5000000000000000000",
        minToAmount: "4950000000000000000",
        transaction: { to: getAddress(PERMIT2_ADDRESS), data: zxData, value: "0", gas: "250000" },
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: ZERO_EX_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(batchCalls()[0].data).toBe(zxData);
    expect(batchCalls()[0].to).toBe(getAddress(PERMIT2_ADDRESS));
    expect(decodeTransfer(batchCalls()[1].data).amount).toBe(25_000n);
  });

  it("31. Permit2 flow (CDP) is unaffected: signature appended, then one atomic batch", async () => {
    withFeeEnv();
    advertiseAtomicBatches();
    batchConfirmed();
    mockSendCalls.mockResolvedValue({ id: "0xbatch" });
    mockSign.mockResolvedValue("0x" + "11".repeat(65));
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({
        fromAmount: "10000000",
        toAmount: "5000000000000000000",
        minToAmount: "4950000000000000000",
        permit2: {
          eip712: {
            domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS },
            types: {
              EIP712Domain: [{ name: "name", type: "string" }],
              PermitTransferFrom: [{ name: "spender", type: "address" }],
            },
            primaryType: "PermitTransferFrom",
            message: { spender: PERMIT2_ADDRESS },
          },
        },
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: CDP_TRADE_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);

    const result = await executeTrade(
      { proposal: built.proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(mockSign).toHaveBeenCalledTimes(1);
    // The Permit2 signature is still appended to the swap calldata.
    const swapData = batchCalls()[0].data as string;
    expect(swapData.startsWith("0xabcdef")).toBe(true);
    expect(swapData.length).toBeGreaterThan("0xabcdef".length);
    expect(mockSendCalls).toHaveBeenCalledTimes(1);
  });

  it("32. the poll cadence constant is a sane, bounded default", () => {
    expect(TRADE_CALLS_POLL_INTERVAL_MS).toBeGreaterThan(0);
    expect(TRADE_CALLS_POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("MPGR Agent fee — provider-native disclosure", () => {
  it("33. provider-native fee is disclosed as charged by the provider", () => {
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
        fees: {
          gasFee: { amount: "3000", token: BASE_USDC },
          integratorFee: { amount: "25000", token: BASE_USDC },
        },
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: ZERO_EX_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);

    const p = built.proposal;
    expect(p.agentFee?.collection).toBe("provider-native");
    expect(p.agentFee?.amountAtomic).toBe("25000");
    // Quote intact — the fee never touches amounts.
    expect(p.fromAmount).toBe("10000000");
    expect(p.toAmount).toBe("5000000000000000000");
    expect(p.minToAmount).toBe("4950000000000000000");

    // The disclosure must NOT claim a separate fee transfer.
    const fact = p.risk.find((f) => f.id === "mpgr-agent-fee");
    expect(fact?.severity).toBe("info");
    expect(fact?.detail).toContain("0.025 USDC");
    expect(fact?.detail).toContain(FEE_WALLET);
    expect(fact?.detail).toContain("charged by the swap provider");
    // Nothing in the copy implies an extra signature or a skipped fee.
    expect(fact?.detail).not.toContain("cannot settle it atomically");
    expect(fact?.detail).not.toContain("collected inside the swap transaction");

    // Post-confirmation step wording matches the provider-native reality.
    const step = p.postConfirmationSteps.find((s) => s.includes("0.25%"));
    expect(step).toBeDefined();
    expect(step).toContain("0.025 USDC");
    expect(step).toContain("charged by the swap provider");
    // The step must never promise a second signature.
    expect(step).toContain("no separate fee signature");
  });

  it("34. post-swap fee disclosure is unchanged for non-native providers", () => {
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

    const p = built.proposal;
    expect(p.agentFee?.collection).toBe("post-swap");
    const fact = p.risk.find((f) => f.id === "mpgr-agent-fee");
    // Existing wording is preserved verbatim.
    expect(fact?.detail).toContain("collected inside the swap transaction");
    expect(fact?.detail).toContain("settle it atomically");
    expect(fact?.detail).not.toContain("charged by the swap provider");
    const step = p.postConfirmationSteps.find((s) => s.includes("0.25%"));
    expect(step).toContain("is collected inside that same swap transaction");
    expect(step).not.toContain("charged by the swap provider");
  });

  it("35. a provider fee in the wrong token falls back and keeps the honest copy", () => {
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
        fees: {
          gasFee: { amount: "3000", token: BASE_USDC },
          // Buy-side fee — NOT our economic model.
          integratorFee: { amount: "99000", token: MPGR_TOKEN_CONFIG.address },
        },
      }),
      slippageBps: 100,
      taker: TAKER,
      provider: ZERO_EX_PROVIDER_ID,
    });
    if (!built.ok) throw new Error(built.error.message);

    expect(built.proposal.agentFee?.collection).toBe("post-swap");
    expect(built.proposal.agentFee?.amountAtomic).toBe("25000");
    expect(built.proposal.risk.find((f) => f.id === "mpgr-agent-fee")?.detail).toContain(
      "collected inside the swap transaction",
    );
  });
});

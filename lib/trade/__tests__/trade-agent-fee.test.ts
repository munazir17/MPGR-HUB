// lib/trade/__tests__/trade-agent-fee.test.ts
//
// MPGR Agent swap fee (0.25% / 25 bps on the sell leg) — the fee is
// collected by the MPGR Executor INSIDE the swap transaction.
//
//   1. fee calculation (exact, floor, dust, invalid)
//   2. 0x fallback fee-recipient configuration (MCP path only)
//   3. executor fee quoting (recipient comes from the executor)
//   4. non-executor routes carry no fee at all
//   5. execution: approve + swap at most, never a third (fee) transaction
//
// REGRESSION GUARANTEES:
//   - no separate fee transaction is ever created, signed or sent;
//   - the fee recipient is the executor's configured feeRecipient, never
//     the connected wallet;
//   - first-time ERC-20 = approve + swap; sufficient allowance = swap only;
//   - a proposal that claims a fee without an executor swap is refused
//     before any wallet prompt.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress, zeroAddress, type Address } from "viem";

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
const { buildExecutorSwapProposal } = await import("../trade-executor-quote");
const {
  AGENT_FEE_EXECUTOR_ONLY_REASON,
  MPGR_AGENT_FEE_BPS,
  MPGR_AGENT_FEE_PERCENT_LABEL,
  buildExecutorAgentFee,
  calculateAgentFeeAmount,
  getAgentFeeRecipient,
  resetAgentFeeConfigWarningForTests,
  recordedExecutorAddress,
  recordedExecutorFeeRecipient,
  skippedAgentFee,
  verifyAgentFeeInSwapTransaction,
} = await import("../trade-agent-fee");
const {
  BASE_USDC,
  CDP_TRADE_PROVIDER_ID,
  MPGR_EXECUTOR_PROVIDER_ID,
  NATIVE_ETH_SENTINEL,
  PERMIT2_ADDRESS,
  TRADE_CHAIN_ID,
} = await import("../trade-config");
const { BASE_MAINNET_EXECUTOR_DEPLOYMENT, CANONICAL_WETH } = await import("@/lib/executor/executor-config");
const { MPGR_EXECUTOR_ABI } = await import("@/lib/executor/mpgr-executor-abi");
const { erc20Abi } = await import("@/lib/erc20-abi");
const { MPGR_TOKEN_CONFIG } = await import("@/lib/token/token-config");

import type { CdpSwapQuote, TradeProposal, TradeTokenRef } from "../trade-types";
import type { ChainReader } from "@/lib/executor/executor-chain";

const TAKER = "0x2222222222222222222222222222222222222222";
/** The connected owner wallet that runs the deployment — never a fee target. */
const OWNER_WALLET = "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e";
const FEE_WALLET = "0x1111111111111111111111111111111111111111" as Address;
const EXECUTOR = getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor);
const EXECUTOR_FEE_RECIPIENT = getAddress(BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient);

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

const weth: TradeTokenRef = {
  address: CANONICAL_WETH,
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
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

/** CDP/0x-style quote — a NON-executor route. */
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
    // 2 USDC (6dp) → 0.005 USDC (the required gross → fee example)
    expect(calculateAgentFeeAmount("2000000")).toBe(5_000n);
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

describe("MPGR Agent fee — 0x fallback recipient config (MCP path only)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("5. unset recipient → not ok (the browser flow does not use this at all)", () => {
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

  it("7. valid recipient is accepted; server var wins over the public one", () => {
    withFeeEnv();
    expect(getAgentFeeRecipient()).toEqual({ ok: true, recipient: FEE_WALLET });

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

  it("7b. missing recipient warns once per process (diagnosable, not silent)", () => {
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

describe("MPGR Agent fee — quoted from the executor", () => {
  it("8. 2 USDC gross → 0.005 USDC fee, recipient = the executor's feeRecipient", () => {
    const built = buildExecutorAgentFee({
      grossAmountIn: "2000000",
      feeBps: 25,
      feeRecipient: EXECUTOR_FEE_RECIPIENT,
      from: usdc,
      taker: TAKER,
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.fee).toEqual({
      status: "applied",
      bps: 25,
      recipient: EXECUTOR_FEE_RECIPIENT,
      amountAtomic: "5000",
      displayAmount: "0.005 USDC",
      reason: null,
      collection: "mpgr-executor",
    });
    // Never the connected wallet, and never the recorded-owner wallet.
    expect(built.fee.recipient!.toLowerCase()).not.toBe(TAKER.toLowerCase());
    expect(built.fee.recipient!.toLowerCase()).not.toBe(OWNER_WALLET.toLowerCase());
    expect(recordedExecutorFeeRecipient()).toBe(EXECUTOR_FEE_RECIPIENT);
    expect(recordedExecutorAddress()).toBe(EXECUTOR);
  });

  it("9. display respects sell-token decimals (ETH 18dp)", () => {
    const built = buildExecutorAgentFee({
      grossAmountIn: "2000000000000000000",
      feeBps: 25,
      feeRecipient: EXECUTOR_FEE_RECIPIENT,
      from: eth,
      taker: TAKER,
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.fee.amountAtomic).toBe("5000000000000000");
    expect(built.fee.displayAmount).toBe("0.005 ETH");
  });

  it("10. fails closed (never an error, never a fee the swap cannot take)", () => {
    const base = { grossAmountIn: "2000000", feeBps: 25, from: usdc, taker: TAKER };
    // No recipient configured on the executor.
    expect(buildExecutorAgentFee({ ...base, feeRecipient: null }).ok).toBe(false);
    expect(buildExecutorAgentFee({ ...base, feeRecipient: zeroAddress }).ok).toBe(false);
    expect(buildExecutorAgentFee({ ...base, feeRecipient: "not-an-address" }).ok).toBe(false);
    // Recipient == taker → the contract reverts TakerIsFeeRecipient.
    expect(buildExecutorAgentFee({ ...base, feeRecipient: TAKER }).ok).toBe(false);
    // Dust → the contract reverts FeeRoundsToZero.
    expect(buildExecutorAgentFee({ ...base, grossAmountIn: "399", feeRecipient: FEE_WALLET }).ok).toBe(false);
    // Invalid amount / bps.
    expect(buildExecutorAgentFee({ ...base, grossAmountIn: "abc", feeRecipient: FEE_WALLET }).ok).toBe(false);
    expect(buildExecutorAgentFee({ ...base, feeBps: 0, feeRecipient: FEE_WALLET }).ok).toBe(false);
  });
});

describe("MPGR Agent fee — non-executor routes carry no fee", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function cdpProposal(): TradeProposal {
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

  it("11. CDP/0x/Aerodrome proposals are fee-less even with the 0x fee wallet configured", () => {
    withFeeEnv(); // the 0x fallback wallet is configured…
    const p = cdpProposal();
    // …and the browser flow still charges nothing out-of-band.
    expect(p.agentFee).toEqual(skippedAgentFee(AGENT_FEE_EXECUTOR_ONLY_REASON));
    expect(p.agentFee?.amountAtomic).toBe("0");
    expect(p.risk.find((f) => f.id === "mpgr-agent-fee")).toBeUndefined();
    expect(p.postConfirmationSteps.some((s) => s.toLowerCase().includes("agent fee"))).toBe(false);
    expect(p.transaction?.to).toBe(getAddress(PERMIT2_ADDRESS));
  });

  it("12. an applied fee without an executor transaction is rejected before signing", () => {
    const p = cdpProposal();
    // A tampered proposal that claims a fee but points at Permit2 (the old
    // separate-transfer architecture) must never be signed.
    p.agentFee = {
      status: "applied",
      bps: 25,
      recipient: FEE_WALLET,
      amountAtomic: "25000",
      displayAmount: "0.025 USDC",
      reason: null,
      collection: "mpgr-executor",
    };
    const invariant = verifyAgentFeeInSwapTransaction(p);
    expect(invariant.ok).toBe(false);
    if (!invariant.ok) expect(invariant.reason).toMatch(/not collected by the MPGR Executor/i);
  });

  it("13. tampered amounts/recipients are rejected; fee-less proposals pass untouched", () => {
    const p = cdpProposal();
    p.transaction = { to: EXECUTOR, data: "0x", value: "0" };
    p.agentFee = {
      status: "applied", bps: 25, recipient: EXECUTOR_FEE_RECIPIENT,
      amountAtomic: "999999", displayAmount: "1 USDC", reason: null, collection: "mpgr-executor",
    };
    expect(verifyAgentFeeInSwapTransaction(p).ok).toBe(false);

    p.agentFee = { ...p.agentFee!, amountAtomic: "25000" };
    expect(verifyAgentFeeInSwapTransaction(p).ok).toBe(true);

    p.agentFee = { ...p.agentFee!, recipient: TAKER as Address };
    expect(verifyAgentFeeInSwapTransaction(p).ok).toBe(false);

    p.agentFee = { ...p.agentFee!, recipient: EXECUTOR_FEE_RECIPIENT, collection: null };
    expect(verifyAgentFeeInSwapTransaction(p).ok).toBe(false);

    const legacy = cdpProposal();
    delete legacy.agentFee;
    expect(verifyAgentFeeInSwapTransaction(legacy)).toEqual({ ok: true, fee: null });
  });
});

describe("MPGR Agent fee — execution never sends a separate fee transaction", () => {
  function fakeExecutorReader(options: { allowance?: bigint; feeRecipient?: Address } = {}): ChainReader {
    return {
      chainId: TRADE_CHAIN_ID,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "feeBps":
            return 25n;
          case "feeRecipient":
            return options.feeRecipient ?? EXECUTOR_FEE_RECIPIENT;
          case "paused":
            return false;
          case "MAX_FEE_BPS":
            return 100n;
          case "owner":
            return OWNER_WALLET;
          case "allowance":
            return options.allowance ?? 0n;
          case "balanceOf":
            return 100_000_000n;
          default:
            throw new Error(`unexpected read: ${functionName}`);
        }
      }),
      simulateContract: vi.fn(async () => ({ result: [800_000_000_000_000n, 0n, 0n, 100_000n] as unknown })),
      getBalance: vi.fn(async () => 10n ** 18n),
      getTransactionReceipt: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
  }

  /** A real executor proposal: 2 USDC gross, 0.005 USDC fee, executor tx. */
  async function executorProposal(options: { allowance?: bigint } = {}): Promise<TradeProposal> {
    const result = await buildExecutorSwapProposal({
      from: usdc,
      to: weth,
      fromAmount: "2000000",
      taker: TAKER,
      slippageBps: 100,
      reader: fakeExecutorReader({ allowance: options.allowance ?? 0n }),
      quotedAt: new Date(),
    });
    if (!result.ok) throw new Error("executor proposal setup failed");
    return result.proposal;
  }

  function legacyCdpProposal(): TradeProposal {
    const built = buildTradeProposal({
      from: usdc,
      to: mpgr,
      quote: cdpQuote({ fromAmount: "2000000", toAmount: "1000000000000000", minToAmount: "990000000000000" }),
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
    // Live balance covers the gross sell; the live allowance read decides
    // whether the approval step runs at all.
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 2_000_000n;
      if (params?.functionName === "allowance") return 0n;
      throw new Error(`unexpected read: ${String(params?.functionName)}`);
    });
  });

  it("14. first-time ERC-20 flow is EXACTLY approve + swap (no fee transaction)", async () => {
    const proposal = await executorProposal({ allowance: 0n });
    expect(proposal.agentFee).toMatchObject({ status: "applied", amountAtomic: "5000", collection: "mpgr-executor" });

    mockSend.mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xswap");
    const result = await executeTrade(
      { proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );

    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBe("0xapprove");
    expect(result.swapHash).toBe("0xswap");
    // Two wallet transactions, maximum, and nothing after the swap.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSign).not.toHaveBeenCalled();

    // 1) approve(executor, GROSS) — the fee is part of the gross pull.
    const approveTx = mockSend.mock.calls[0][1] as { to: string; data: `0x${string}`; value: bigint };
    expect(getAddress(approveTx.to)).toBe(getAddress(BASE_USDC));
    expect(approveTx.value).toBe(0n);
    const approval = decodeFunctionData({ abi: erc20Abi, data: approveTx.data });
    expect(approval.functionName).toBe("approve");
    expect(getAddress((approval.args as readonly [string, bigint])[0])).toBe(EXECUTOR);
    expect((approval.args as readonly [string, bigint])[1]).toBe(2_000_000n);

    // 2) the executor swap: gross, expected fee, post-fee minimum.
    const swapTx = mockSend.mock.calls[1][1] as { to: string; data: `0x${string}`; value: bigint };
    expect(getAddress(swapTx.to)).toBe(EXECUTOR);
    expect(swapTx.value).toBe(0n);
    const swap = decodeFunctionData({ abi: MPGR_EXECUTOR_ABI, data: swapTx.data });
    expect(swap.functionName).toBe("swapUniswapV3ExactInputSingle");
    const [params] = swap.args as unknown as readonly [Record<string, unknown>, number];
    expect(params.grossAmountIn).toBe(2_000_000n);
    expect(params.expectedFeeAmount).toBe(5_000n);
    expect(params.amountOutMinimum).toBe(792_000_000_000_000n);
    expect(getAddress(params.recipient as string)).toBe(getAddress(TAKER));

    // No third transaction exists anywhere — least of all an ERC-20
    // transfer of the fee to a fee wallet.
    for (const call of mockSend.mock.calls) {
      const tx = call[1] as { to: string; data?: `0x${string}` };
      if (tx.data?.startsWith("0xa9059cbb")) throw new Error(`unexpected ERC-20 transfer to ${tx.to}`);
      expect(getAddress(tx.to)).not.toBe(EXECUTOR_FEE_RECIPIENT);
      expect(getAddress(tx.to)).not.toBe(FEE_WALLET);
      expect(getAddress(tx.to)).not.toBe(OWNER_WALLET);
    }
  });

  it("15. sufficient allowance → swap only (one wallet transaction)", async () => {
    const proposal = await executorProposal({ allowance: 2_000_000n });
    expect(proposal.needsPermit2Approval).toBe(false);
    mockRead.mockImplementation(async (_config: unknown, params: { functionName?: string }) => {
      if (params?.functionName === "balanceOf") return 2_000_000n;
      if (params?.functionName === "allowance") return 2_000_000n;
      throw new Error("unexpected read");
    });
    mockSend.mockResolvedValue("0xswap");

    const result = await executeTrade(
      { proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );
    expect(result.state).toBe("SUCCESS");
    expect(result.approvalHash).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(getAddress((mockSend.mock.calls[0][1] as { to: string }).to)).toBe(EXECUTOR);
  });

  it("16. a stale approval is refreshed once, then the swap — still no fee tx", async () => {
    const proposal = await executorProposal({ allowance: 1_999_999n });
    expect(proposal.needsPermit2Approval).toBe(true);
    mockSend.mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xswap");
    const result = await executeTrade(
      { proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );
    expect(result.state).toBe("SUCCESS");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("17. tampered fee amount → nothing is signed (no fallback fee transfer)", async () => {
    const proposal = await executorProposal({ allowance: 2_000_000n });
    proposal.agentFee = { ...proposal.agentFee!, amountAtomic: "999999" };
    const states: string[] = [];
    const result = await executeTrade(
      { proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      (s) => states.push(s.state),
    );
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(states).not.toContain("APPROVING");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("18. swap transaction retargeted away from the executor → nothing is signed", async () => {
    const proposal = await executorProposal({ allowance: 2_000_000n });
    proposal.transaction = { ...proposal.transaction!, to: getAddress(PERMIT2_ADDRESS) };
    const result = await executeTrade(
      { proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );
    expect(result.state).toBe("ERROR");
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("19. legacy fee-less proposals still execute as a single swap (unchanged)", async () => {
    const proposal = legacyCdpProposal();
    expect(proposal.agentFee?.status).toBe("skipped");
    mockSend.mockResolvedValue("0xswap");
    const result = await executeTrade(
      { proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );
    expect(result.state).toBe("SUCCESS");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(getAddress((mockSend.mock.calls[0][1] as { to: string }).to)).toBe(getAddress(PERMIT2_ADDRESS));
  });

  it("20. a reverted swap stops there — no fee transaction after it", async () => {
    const proposal = await executorProposal({ allowance: 2_000_000n });
    mockSend.mockResolvedValue("0xswap");
    mockWait.mockResolvedValue({ status: "reverted" });
    const result = await executeTrade(
      { proposal, confirmationState: "READY_FOR_CONFIRMATION", currentAccount: TAKER, currentChainId: 8453 },
      () => {},
    );
    expect(result).toMatchObject({ state: "ERROR", swapHash: "0xswap", error: { code: "SEND_FAILED" } });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("21. the fee never targets the connected wallet even when it owns the executor", async () => {
    const result = await buildExecutorSwapProposal({
      from: usdc,
      to: weth,
      fromAmount: "2000000",
      taker: OWNER_WALLET,
      slippageBps: 100,
      reader: fakeExecutorReader(),
      quotedAt: new Date(),
    });
    if (!result.ok) throw new Error("expected an executor proposal");
    expect(result.proposal.agentFee!.recipient).toBe(EXECUTOR_FEE_RECIPIENT);
    expect(result.proposal.agentFee!.recipient!.toLowerCase()).not.toBe(OWNER_WALLET.toLowerCase());
    expect(result.proposal.provider).toBe(MPGR_EXECUTOR_PROVIDER_ID);
  });
});

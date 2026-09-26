import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTradeConfirmationModal } from "./AgentTradeConfirmationModal";
import { buildTradeProposal } from "@/lib/trade/trade-proposal";
import { AERODROME_SLIPSTREAM_SWAP_ROUTER, BASE_USDC, BASE_WETH } from "@/lib/trade/trade-config";
import { ZERO_EX_ALLOWANCE_HOLDER_BASE as ZERO_EX_ALLOWANCE_HOLDER } from "@/lib/trade/zero-ex-native-fee";
import { COINBASE_B20_TOKENIZED_STOCKS } from "@/lib/trade/tokenized-stocks";
import type { TradeProposal } from "@/lib/trade/trade-types";

const TAKER = "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e";
const FEE_WALLET = "0x1111111111111111111111111111111111111111";
const EXECUTOR = "0xD982726e28275661F8aB64054E6b17a70a63505A";
const EXECUTOR_FEE_RECIPIENT = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4";
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const HASH = `0x${"ab".repeat(32)}` as const;
const APPROVAL_HASH = `0x${"cd".repeat(32)}` as const;
type Props = ComponentProps<typeof AgentTradeConfirmationModal>;

/**
 * The MPGR Executor flow the modal must present: the wallet signs ONE
 * transaction to the executor, which takes the 0.25% fee from the gross
 * sell amount inside that swap. 2 USDC gross → 0.005 USDC fee.
 */
function executorProposal(): TradeProposal {
  const from = { address: BASE_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, kind: "erc20" as const, verified: true };
  const to = { address: BASE_WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18, kind: "erc20" as const, verified: true };
  const result = buildTradeProposal({
    from, to, taker: TAKER, slippageBps: 100,
    provider: "mpgr-executor",
    agentFee: {
      status: "applied", bps: 25, recipient: EXECUTOR_FEE_RECIPIENT,
      amountAtomic: "5000", displayAmount: "0.005 USDC", reason: null, collection: "mpgr-executor",
    },
    quote: {
      liquidityAvailable: true, fromToken: from.address, toToken: to.address,
      fromAmount: "2000000", toAmount: "800000000000000", minToAmount: "792000000000000",
      transaction: { to: EXECUTOR, data: "0xabcd", value: "0" }, permit2: null,
      issues: { allowance: { spender: EXECUTOR, currentAllowance: "0" }, balance: null, simulationIncomplete: false },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.proposal;
}

// Offline presentation fixtures. These are not live quotes.
function proposal(reverse = false, stock = false): TradeProposal {
  const usdc = { address: BASE_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, kind: "erc20" as const, verified: true };
  const weth = { address: BASE_WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18, kind: "erc20" as const, verified: true };
  const aapl = COINBASE_B20_TOKENIZED_STOCKS.find((token) => token.symbol === "AAPLc")!;
  const from = reverse ? weth : usdc;
  const to = stock ? { address: aapl.address, symbol: aapl.symbol, name: aapl.name, decimals: 8, kind: "b20-tokenized-stock" as const, verified: true } : reverse ? usdc : weth;
  const spender = stock ? AERODROME_SLIPSTREAM_SWAP_ROUTER : ZERO_EX_ALLOWANCE_HOLDER;
  const result = buildTradeProposal({
    from, to, taker: TAKER, slippageBps: 100,
    provider: stock ? "aerodrome-slipstream" : "0x-swap-api",
    quote: {
      liquidityAvailable: true, fromToken: from.address, toToken: to.address,
      fromAmount: reverse ? "100000000000000" : "1000000",
      toAmount: stock ? "293205" : reverse ? "267304" : "370006219589809",
      minToAmount: stock ? "290272" : reverse ? "264630" : "366306157393910",
      transaction: { to: spender, data: "0xabcd", value: "0" }, permit2: null,
      issues: { allowance: { spender, currentAllowance: "0" }, balance: null, simulationIncomplete: false },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.proposal;
}

function render(overrides: Partial<Props> = {}) {
  return renderToStaticMarkup(createElement(AgentTradeConfirmationModal, {
    open: true, onClose: () => {}, proposal: proposal(),
    confirmationState: "READY_FOR_CONFIRMATION", confirmationError: null,
    executionState: "IDLE", executionError: null, approvalHash: null, swapHash: null,
    stepLabel: null, onConfirmAndSwap: () => {}, ...overrides,
  }));
}

function expectConsumerCopy(html: string) {
  expect(html).not.toMatch(/Aerodrome|Uniswap|SwapRouter|AllowanceHolder|Permit2|MCP|Executor|0x Swap API|Coinbase CDP|pool fee|This quote[’']s route/i);
  expect(html).not.toMatch(/not configured|No fee transfer is prepared|MPGR fee not applied|NEXT_PUBLIC_|BASE_RPC_URL/);
  expect(html).not.toContain('aria-label="Trade progress"');
  expect(html).not.toContain('aria-current="step"');
  for (const label of [">Quote<", ">Prepare<", ">Approval (if needed)<", ">User signature<", ">Executing<", ">Confirmed<"]) expect(html).not.toContain(label);
  for (const address of [TAKER, FEE_WALLET, EXECUTOR, ROUTER, ZERO_EX_ALLOWANCE_HOLDER, AERODROME_SLIPSTREAM_SWAP_ROUTER]) {
    expect(html.toLowerCase()).not.toContain(address.toLowerCase());
  }
}

beforeEach(() => vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET));
afterEach(() => vi.unstubAllEnvs());

describe("consumer swap confirmation (presentation only; no wallet calls)", () => {
  it("shows the executor fee as a plain 'MPGR fee (0.25%)  0.005 USDC' row", () => {
    const html = render({ proposal: executorProposal() });
    expect(html).toContain("Confirm swap");
    expect(html).toContain("2 USDC");
    expect(html).toContain("~0.0008 WETH");
    expect(html).toContain("Minimum received");
    expect(html).toContain("0.000792 WETH");
    expect(html).toContain("Base");
    expect(html).toContain("1%");
    expect(html).toContain("MPGR fee (0.25%)");
    expect(html).toContain("0.005 USDC");
    expect(html).toContain("0xE0e0…486e");
    expect(html).toContain("Your wallet signs and sends this transaction. MPGR never has access to your private key.");
    expect(html).toContain("Confirm &amp; Swap");
    expectConsumerCopy(html);
  });

  it("never mentions a separate or post-swap fee payment (fails the old copy)", () => {
    const html = render({ proposal: executorProposal() });
    expect(html).not.toContain("Paid separately after the swap");
    expect(html).not.toContain("Paid separately");
    expect(html).not.toContain("Pay fee");
    expect(html).not.toContain("separate fee");
    expect(html).not.toContain("after the swap");
    // The fee itself is still disclosed, exactly once, next to its amount.
    expect(html.match(/MPGR fee/g)).toHaveLength(1);
  });

  it("shows a non-executor route without inventing an MPGR fee", () => {
    const html = render(); // CDP/0x proposal from the shared fixture
    expect(html).not.toContain("MPGR fee");
    expect(html).not.toContain("0.0025 USDC");
    expectConsumerCopy(html);
  });

  it("preserves tiny WETH fees and reverse-direction amounts without rounding to zero", () => {
    const p = proposal(true);
    p.agentFee = {
      status: "applied", bps: 25, recipient: EXECUTOR_FEE_RECIPIENT,
      amountAtomic: "250000000000", displayAmount: "0.00000025 WETH", reason: null, collection: "mpgr-executor",
    };
    p.provider = "mpgr-executor";
    p.transaction = { to: EXECUTOR, data: "0xabcd", value: "0" };
    const html = render({ proposal: p });
    for (const value of ["0.0001 WETH", "~0.267304 USDC", "0.26463 USDC", "0.00000025 WETH"]) expect(html).toContain(value);
    expect(html).not.toContain(">0 WETH");
    expectConsumerCopy(html);
  });

  it("reproduces the AAPLc screen without leaking fee configuration or router warnings", () => {
    vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", "");
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    const p = proposal(false, true);
    expect(p.agentFee?.status).toBe("skipped");
    expect(p.agentFee?.reason).toContain("does not route this pair");
    expect(p.risk.some((risk) => risk.title === "Aerodrome router approval required")).toBe(true);
    const html = render({ proposal: p });
    for (const value of ["1 USDC", "~0.00293205 AAPLc", "0.00290272 AAPLc", "Token approval required"]) expect(html).toContain(value);
    expect(html).not.toContain("MPGR fee");
    expect(html).not.toContain("Swapping AAPLc on Base");
    expect(html).not.toContain("Confirm tokenized-stock swap");
    expectConsumerCopy(html);
  });

  it.each(["absent", "skipped"] as const)("omits the MPGR fee row when %s without hiding other applicable fees", (state) => {
    const p = proposal();
    p.agentFee = state === "absent" ? undefined : { status: "skipped", bps: null, recipient: null, amountAtomic: "0", displayAmount: null, reason: "The MPGR fee is collected inside the swap transaction by the MPGR Executor, which does not route this pair — no fee is charged." };
    p.fees = { protocolFee: { amount: "500", token: BASE_USDC }, gasFee: { amount: "250000000000", token: BASE_WETH } };
    const html = render({ proposal: p });
    expect(html).not.toContain("MPGR fee");
    expect(html).toContain("0.0005 USDC");
    expect(html).toContain("0.00000025 WETH");
    expect(html).toContain("Est. network fee");
    expectConsumerCopy(html);
  });

  it("does not render an unknown fee-token contract or invent its decimals", () => {
    const p = proposal();
    p.fees = { protocolFee: { amount: "123", token: EXECUTOR } };
    const html = render({ proposal: p });
    expect(html).toContain("123 base units");
    expectConsumerCopy(html);
  });

  it.each([null, undefined, NaN, Infinity])("omits unavailable price impact: %s", (priceImpactBps) => {
    const html = render({ proposal: { ...proposal(), priceImpactBps } });
    expect(html).not.toContain("Price impact");
    expect(html).not.toContain("not reported");
  });

  it.each([[0, "0.00%"], [-125, "-1.25%"], [25, "+0.25%"]])("retains a reported price impact of %s bps", (priceImpactBps, display) => {
    const html = render({ proposal: { ...proposal(), priceImpactBps: Number(priceImpactBps) } });
    expect(html).toContain("Price impact");
    expect(html).toContain(display);
  });

  it.each(["Aerodrome Slipstream", "Uniswap V3", "0x Swap API", "Coinbase CDP Trade API"])("never renders internal route copy from %s or raw addresses in metadata", (providerLabel) => {
    const p = proposal();
    p.providerLabel = providerLabel;
    p.description = `Separate MCP flow, not the MCP Executor; pool fee 3000. Router ${ROUTER}`;
    p.permit2Spender = EXECUTOR;
    p.postConfirmationSteps = [`Approve ${ZERO_EX_ALLOWANCE_HOLDER}`];
    const before = JSON.stringify(p);
    const html = render({ proposal: p, stepLabel: p.description });
    expectConsumerCopy(html);
    expect(JSON.stringify(p)).toBe(before); // internal execution/analytics data remains intact
  });

  it("keeps mobile scrolling and a named dialog without the internal stage grid", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("max-h-[90dvh]");
    expect(html).toContain("overflow-y-auto");
    expect(html).not.toContain("grid-cols");
    expectConsumerCopy(html);
  });

  it.each([true, false])("shows understandable approval guidance only when required: %s", (needsPermit2Approval) => {
    const html = render({ proposal: { ...proposal(), needsPermit2Approval } });
    expect(html.includes("Token approval required")).toBe(needsPermit2Approval);
    expectConsumerCopy(html);
  });

  it("does not ask for another approval after an approval hash exists", () => {
    const html = render({ approvalHash: APPROVAL_HASH });
    expect(html).not.toContain("Token approval required");
    expect(html).toContain(`https://basescan.org/tx/${APPROVAL_HASH}`);
  });

  it.each([
    ["REQUOTING", "Updating swap details…"],
    ["APPROVING", "Waiting for wallet confirmation…"],
    ["AWAITING_PERMIT", "Waiting for wallet confirmation…"],
    ["AWAITING_WALLET", "Waiting for wallet confirmation…"],
    ["PENDING", "Transaction submitted…"],
  ] as const)("shows simple state and disables duplicate confirmation/close while %s", (executionState, text) => {
    const onConfirmAndSwap = vi.fn();
    const html = render({ executionState, onConfirmAndSwap, stepLabel: `Approve Aerodrome SwapRouter ${ROUTER}` });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Close"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*class="btn-primary/);
    expect(html).toContain('role="status"');
    expect(html).toContain(text);
    expect(onConfirmAndSwap).not.toHaveBeenCalled();
    expectConsumerCopy(html);
  });

  it("does not enable confirmation during validation", () => {
    const html = render({ confirmationState: "VALIDATING" });
    expect(html).toContain("Updating swap details…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*class="btn-primary/);
  });

  it.each([
    ["WALLET_REJECTED", "You declined the wallet request."],
    ["SEND_FAILED", "Swap failed."],
    ["APPROVAL_FAILED", "Token approval failed."],
    ["CREDENTIALS_MISSING", "This swap is currently unavailable."],
    ["QUOTE_EXPIRED", "This quote has expired."],
  ] as const)("keeps %s visible without echoing internal provider/debug text", (code, message) => {
    const html = render({ executionState: "ERROR", executionError: { code, message: `Aerodrome router ${ROUTER}: BASE_RPC_URL not configured` }, approvalHash: APPROVAL_HASH });
    expect(html).toContain('role="alert"');
    expect(html).toContain(message);
    expect(html).toContain(`https://basescan.org/tx/${APPROVAL_HASH}`);
    expect(html).not.toContain("Swap confirmed");
    expectConsumerCopy(html);
  });

  it("preserves an unknown confirmation state and submitted hash without claiming a failed swap", () => {
    const html = render({ executionState: "ERROR", executionError: { code: "PROVIDER_ERROR", message: "RPC error with internal routing details" }, swapHash: HASH });
    expect(html).toContain("Confirmation is unavailable");
    expect(html).not.toContain("Swap failed");
    expect(html).not.toContain("Swap confirmed");
    expect(html).toContain(`https://basescan.org/tx/${HASH}`);
  });

  it("keeps the confirmed swap and both explorer links, with no fee-payment UI", () => {
    const html = render({ executionState: "SUCCESS", swapHash: HASH, approvalHash: APPROVAL_HASH });
    expect(html).toContain("Swap confirmed");
    for (const hash of [HASH, APPROVAL_HASH]) expect(html).toContain(`href="https://basescan.org/tx/${hash}"`);
    expect(html).not.toContain(`>${HASH}<`);
    expect(html).not.toContain("Confirm &amp; Swap");
    // A settled swap is final: there is nothing left to pay or retry.
    expect(html).not.toContain("View fee");
    expect(html).not.toContain("fee payment");
    expect(html).not.toContain('role="alert"');
    expectConsumerCopy(html);
  });

  it("preserves genuine safety warnings while removing technical descriptions", () => {
    const p = proposal();
    p.risk = [
      { id: "unverified-to", severity: "critical", title: `Raw token ${ROUTER}`, detail: "MCP diagnostic" },
      { id: "no-liquidity", severity: "critical", title: "Aerodrome liquidity", detail: "Uniswap V3" },
      { id: "sim-incomplete", severity: "warning", title: "CDP simulation", detail: EXECUTOR },
    ];
    const html = render({ proposal: p });
    expect(html).toContain("token you are buying is unverified");
    expect(html).toContain("This swap is currently unavailable");
    expect(html).toContain("could not be fully checked and may fail");
    expectConsumerCopy(html);
  });

  it("keeps unavailable execution disabled", () => {
    const html = render({ proposal: { ...proposal(), executionAvailable: false } });
    expect(html).toContain("Swap unavailable");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*class="btn-primary/);
  });

  it("renders nothing when closed or without a proposal", () => {
    expect(render({ open: false })).toBe("");
    expect(render({ proposal: null })).toBe("");
  });
});

it("shows a confirmed on-chain failure without raw errors or hiding the transaction link", () => {
  const html = render({ executionState: "ERROR", executionError: { code: "SEND_FAILED", message: "The swap transaction failed on Base." }, swapHash: HASH });
  expect(html).toContain("Transaction failed on-chain.");
  expect(html).toContain(`href="https://basescan.org/tx/${HASH}"`);
  expect(html).not.toContain("Swap confirmed");
  expectConsumerCopy(html);
});

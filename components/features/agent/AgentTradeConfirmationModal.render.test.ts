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
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const HASH = `0x${"ab".repeat(32)}` as const;
const APPROVAL_HASH = `0x${"cd".repeat(32)}` as const;
const FEE_HASH = `0x${"ef".repeat(32)}` as const;
type Props = ComponentProps<typeof AgentTradeConfirmationModal>;

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
  it("shows exact trade amounts, fee, network, slippage and short recipient", () => {
    const html = render();
    expect(html).toContain("Confirm swap");
    expect(html).toContain("1 USDC");
    expect(html).toContain("~0.000370006219589809 WETH");
    expect(html).toContain("Minimum received");
    expect(html).toContain("0.00036630615739391 WETH");
    expect(html).toContain("Base");
    expect(html).toContain("1%");
    expect(html).toContain("MPGR fee (0.25%)");
    expect(html).toContain("0.0025 USDC");
    expect(html).toContain("Paid separately after the swap");
    expect(html).toContain("0xE0e0…486e");
    expect(html).toContain("Your wallet signs and sends this transaction. MPGR never has access to your private key.");
    expect(html).toContain("Confirm &amp; Swap");
    expectConsumerCopy(html);
  });

  it("preserves tiny WETH fees and reverse-direction amounts without rounding to zero", () => {
    const html = render({ proposal: proposal(true) });
    for (const value of ["0.0001 WETH", "~0.267304 USDC", "0.26463 USDC", "0.00000025 WETH"]) expect(html).toContain(value);
    expect(html).not.toContain(">0 WETH");
    expectConsumerCopy(html);
  });

  it("reproduces the AAPLc screen without leaking missing-fee configuration or router warnings", () => {
    vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", "");
    vi.stubEnv("NEXT_PUBLIC_MPGR_AGENT_FEE_RECIPIENT", "");
    const p = proposal(false, true);
    expect(p.agentFee?.status).toBe("skipped");
    expect(p.agentFee?.reason).toContain("not configured");
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
    p.agentFee = state === "absent" ? undefined : { status: "skipped", bps: null, recipient: null, amountAtomic: "0", displayAmount: null, reason: "MPGR agent-fee wallet is not configured" };
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

  it("keeps the confirmed swap and all explorer links, without printing raw hashes in the summary", () => {
    const html = render({ executionState: "SUCCESS", swapHash: HASH, approvalHash: APPROVAL_HASH, feeHash: FEE_HASH });
    expect(html).toContain("Swap confirmed");
    for (const hash of [HASH, APPROVAL_HASH, FEE_HASH]) expect(html).toContain(`href="https://basescan.org/tx/${hash}"`);
    expect(html).not.toContain(`>${HASH}<`);
    expect(html).not.toContain("Confirm &amp; Swap");
    expectConsumerCopy(html);
  });

  it.each(["WALLET_REJECTED", "SEND_FAILED"] as const)("keeps fee-payment %s visible without undoing swap success", (code) => {
    const html = render({ executionState: "SUCCESS", swapHash: HASH, feeHash: FEE_HASH, feeError: { code, message: `Internal Executor fee diagnostic ${EXECUTOR}` } });
    expect(html).toContain("Swap confirmed");
    expect(html).toContain('role="alert"');
    expect(html).toContain(code === "WALLET_REJECTED" ? "declined the separate fee payment" : "fee payment could not be confirmed");
    expect(html).toContain(`https://basescan.org/tx/${FEE_HASH}`);
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

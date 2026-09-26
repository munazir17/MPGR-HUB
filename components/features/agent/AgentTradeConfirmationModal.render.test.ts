import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTradeConfirmationModal } from "./AgentTradeConfirmationModal";
import { buildTradeProposal } from "@/lib/trade/trade-proposal";
import { BASE_USDC, BASE_WETH } from "@/lib/trade/trade-config";
import { ZERO_EX_ALLOWANCE_HOLDER_BASE as ZERO_EX_ALLOWANCE_HOLDER } from "@/lib/trade/zero-ex-native-fee";
import type { TradeProposal } from "@/lib/trade/trade-types";

const TAKER = "0x2222222222222222222222222222222222222222";
const FEE_WALLET = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}` as const;
type Props = ComponentProps<typeof AgentTradeConfirmationModal>;

function proposal(reverse = false): TradeProposal {
  const usdc = { address: BASE_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, kind: "erc20" as const, verified: true };
  const weth = { address: BASE_WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18, kind: "erc20" as const, verified: true };
  const from = reverse ? weth : usdc;
  const to = reverse ? usdc : weth;
  const result = buildTradeProposal({
    from, to, taker: TAKER, slippageBps: 100, provider: "0x-swap-api",
    quote: {
      liquidityAvailable: true, fromToken: from.address, toToken: to.address,
      fromAmount: reverse ? "100000000000000" : "1000000",
      toAmount: reverse ? "267304" : "370006219589809",
      minToAmount: reverse ? "264630" : "366306157393910",
      transaction: { to: ZERO_EX_ALLOWANCE_HOLDER, data: "0xabcd", value: "0" },
      permit2: null,
      issues: { allowance: { spender: ZERO_EX_ALLOWANCE_HOLDER, currentAllowance: "0" }, balance: null, simulationIncomplete: false },
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

beforeEach(() => vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET));
afterEach(() => vi.unstubAllEnvs());

describe("trade confirmation clarity (render only; no wallet calls)", () => {
  it("shows exact fee, minimum, recipient and actual spender before confirmation", () => {
    const html = render();
    expect(html).toContain("25 bps (0.25%)");
    expect(html).toContain("0.0025 USDC (separate tx)");
    expect(html).toContain("0.00036630615739391 WETH");
    expect(html).toContain(TAKER);
    expect(html).toContain(ZERO_EX_ALLOWANCE_HOLDER);
    expect(html).toContain("Your wallet signs and sends");
    expect(html).toContain("not deducted from the amount above");
  });

  it("does not round a nonzero WETH fee down to zero in the reverse direction", () => {
    const html = render({ proposal: proposal(true) });
    expect(html).toContain("0.0001 WETH");
    expect(html).toContain("0.00000025 WETH (separate tx)");
    expect(html).toContain("0.267304 USDC");
    expect(html).not.toContain(">0 WETH");
  });

  it("distinguishes the actual in-app provider from the separate MCP Uniswap route", () => {
    const html = render();
    expect(html).toContain("0x Swap API (Base)");
    expect(html).toContain("Separate MCP flow");
    expect(html).toContain("Uniswap V3 on Base");
    expect(html).toContain("3000 / 0.30%");
    expect(html).toContain("not the MCP Executor");
  });

  it("keeps a real Aerodrome quote accurately labeled instead of cosmetically rerouting it", () => {
    const html = render({ proposal: { ...proposal(), provider: "aerodrome-slipstream", providerLabel: "Aerodrome Slipstream" } });
    expect(html).toContain("Aerodrome Slipstream");
    expect(html).toContain("Separate MCP flow");
  });

  it("provides bounded mobile scrolling, a named dialog and the six progress stages", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("max-h-[90dvh]");
    expect(html).toContain("overflow-y-auto");
    for (const label of ["Quote", "Prepare", "Approval (if needed)", "User signature", "Executing", "Confirmed"]) expect(html).toContain(label);
  });

  it.each(["REQUOTING", "APPROVING", "AWAITING_PERMIT", "AWAITING_WALLET", "PENDING"] as const)("retains progress and disables duplicate confirmation/close while %s", (executionState) => {
    const html = render({ executionState, stepLabel: "Wallet operation in progress" });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Close"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Awaiting your wallet/);
    expect(html).toContain('role="status"');
    expect(html).toContain("Wallet operation in progress");
  });

  it("does not hide rejection or failure, and preserves links for any submitted transactions", () => {
    const html = render({ executionState: "ERROR", executionError: { code: "WALLET_REJECTED", message: "You rejected the swap in your wallet." }, approvalHash: HASH });
    expect(html).toContain('role="alert"');
    expect(html).toContain("You rejected the swap in your wallet.");
    expect(html).toContain(`https://basescan.org/tx/${HASH}`);
    expect(html).toContain("Close and request a fresh quote");
    expect(html).not.toContain("Swap confirmed on Base");
  });

  it("keeps a settled swap confirmed while exposing a separate fee failure", () => {
    const html = render({ executionState: "SUCCESS", swapHash: HASH, feeError: { code: "SEND_FAILED", message: "Separate fee transfer failed." } });
    expect(html).toContain("Swap confirmed on Base");
    expect(html).toContain("Separate fee transfer failed.");
    expect(html).toContain(`https://basescan.org/tx/${HASH}`);
    expect(html).not.toContain("Confirm &amp; Swap");
  });
});

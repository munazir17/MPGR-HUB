import { describe, expect, it } from "vitest";
import { calculateAgentFeeAmount } from "@/lib/trade/trade-agent-fee";
import { expectedIntegratorFee } from "@/lib/trade/zero-ex-native-fee";
import { PUBLIC_ROUTER_FEE_BLOCK, publicRouterPolicyError } from "../route-desk";
import { swapFeePolicyError } from "../swap-policy";
import {
  APPROVAL_STILL_INSUFFICIENT,
  APPROVAL_VERIFICATION_DELAYED,
  classifyPostApprovalAllowance,
} from "../approval-verification";
import { simulatedExecutorQuote } from "@/tests/mobile/flow-fixtures";
import { chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
import type { TradeProposal } from "@/lib/trade/trade-types";

const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest("Buy AAPLc whenever price falls below $200 worth 1 USDC")!, "Buy AAPLc whenever price falls below $200 worth 1 USDC"));

describe("25 bps is exact integer math on the gross sell amount", () => {
  it.each([
    ["5 USDC", "5000000", 12_500n],
    ["1 USDC", "1000000", 2_500n],
    ["100 USDC", "100000000", 250_000n],
    ["100000000 atomic (0.0025 of 1e8)", "100000000", 250_000n],
    ["dust below 1 unit of fee", "399", 0n],
    ["smallest charged unit", "400", 1n],
  ])("%s", (_label, raw, fee) => {
    expect(calculateAgentFeeAmount(raw)).toBe(fee === 0n && raw === "399" ? 0n : fee);
    expect(expectedIntegratorFee(BigInt(raw))).toBe(fee);
  });

  it("never uses floating point and charges the fee once", () => {
    const gross = 5_000_000n;
    const fee = (gross * 25n) / 10_000n;
    expect(fee).toBe(12_500n);
    expect(fee + (gross - fee)).toBe(gross);
    expect(Number.isInteger(Number(fee))).toBe(true);
  });
});

describe("unfee'd fallbacks cannot execute", () => {
  it("rejects a public router even when the quote admits the fee was skipped", () => {
    expect(publicRouterPolicyError({ provider: "public-router", agentFee: { status: "skipped" } })).toBe(PUBLIC_ROUTER_FEE_BLOCK);
    const proposal = simulatedExecutorQuote(form);
    proposal.provider = "public-router";
    expect(swapFeePolicyError(proposal as TradeProposal)).toBe(PUBLIC_ROUTER_FEE_BLOCK);
  });

  it.each(["cdp-trade-api", "0x-swap-api", "aerodrome-slipstream"] as const)("still blocks fee-skipping %s on Swap", (provider) => {
    const proposal = simulatedExecutorQuote(form);
    proposal.provider = provider;
    expect(swapFeePolicyError(proposal)).toMatch(/cannot safely collect/);
  });
});

describe("approval confirmation is not an allowance-read failure", () => {
  it("keeps a delayed read distinct from an insufficient allowance and from a failed transaction", () => {
    expect(classifyPostApprovalAllowance(null, 5_000_000n)).toBe("delayed");
    expect(classifyPostApprovalAllowance(4_999_999n, 5_000_000n)).toBe("insufficient");
    expect(classifyPostApprovalAllowance(5_000_000n, 5_000_000n)).toBe("verified");
    expect(APPROVAL_VERIFICATION_DELAYED).not.toMatch(/failed|could not be verified|blindly/i);
    expect(APPROVAL_STILL_INSUFFICIENT).toMatch(/insufficient/);
  });
});

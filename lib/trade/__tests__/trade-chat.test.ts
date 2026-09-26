import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildTradeProposal } from "../trade-proposal";
import { BASE_USDC, BASE_WETH } from "../trade-config";
import { formatTradeReview, formatTradeSuccess, formatTradePrice, publicAgentContent, publicTradeError } from "../trade-chat";
import { formatAtomicAmount } from "../trade-format";
const HASH = `0x${"ab".repeat(32)}` as const;
const WALLET = "0x2222222222222222222222222222222222222222";
const FEE_WALLET = "0x1111111111111111111111111111111111111111" as const;
const EXECUTOR = "0xD982726e28275661F8aB64054E6b17a70a63505A" as const;
/** Executor-routed fixture: the fee is taken inside the signed swap tx. */
function proposal(reverse = false) {
  const usdc = { address: BASE_USDC, decimals: 6, symbol: "USDC", name: "USD Coin", kind: "erc20" as const, verified: true };
  const weth = { address: BASE_WETH, decimals: 18, symbol: "WETH", name: "Wrapped Ether", kind: "erc20" as const, verified: true };
  const from = reverse ? weth : usdc; const to = reverse ? usdc : weth;
  const gross = reverse ? "100000000000000" : "1000000";
  const fee = (BigInt(gross) * 25n) / 10_000n;
  const result = buildTradeProposal({ from, to, taker: WALLET, slippageBps: 100, provider: "mpgr-executor",
    agentFee: {
      status: "applied", bps: 25, recipient: FEE_WALLET,
      amountAtomic: fee.toString(),
      displayAmount: `${formatAtomicAmount(fee.toString(), from.decimals, from.decimals)} ${from.symbol}`,
      reason: null, collection: "mpgr-executor",
    },
    quote: {
    fromToken: from.address, toToken: to.address, fromAmount: gross, toAmount: reverse ? "267304" : "370006219589809", minToAmount: reverse ? "264630" : "366306157393910", liquidityAvailable: true,
    transaction: { to: EXECUTOR, data: "0xabcd", value: "0" }, permit2: null,
  } });
  if (!result.ok) throw Error("fixture"); return result.proposal;
}
beforeEach(() => vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", FEE_WALLET));
afterEach(() => vi.unstubAllEnvs());

describe("consumer trade chat", () => {
  it("shows exact reviewed amounts and applicable fees without tool implementation data", () => {
    const text = formatTradeReview(proposal());
    expect(text).toContain("1 USDC → ~0.000370006219589809 WETH");
    expect(text).toContain("Minimum received: 0.00036630615739391 WETH");
    expect(text).toContain("0.0025 USDC"); expect(text).toContain("0.25%");
    // The fee is disclosed as part of the swap, never as a separate payment.
    expect(text).toContain("taken from the swap amount in the same transaction");
    expect(text).not.toMatch(/separate|pay fee|after the swap/i);
    expect(text).toContain("Your wallet signs and sends");
    expect(text).toContain("Confirm swap?");
    expect(text).not.toMatch(/0x|provider|MCP|Executor|Permit2|calldata|liquidityAvailable/);
  });
  it("does not round a very small WETH fee to zero", () => {
    expect(formatTradeReview(proposal(true))).toContain("0.00000025 WETH");
  });
  it("omits missing-fee debug explanations", () => {
    const p = proposal(); p.agentFee = { status: "skipped", bps: null, recipient: null, amountAtomic: "0", displayAmount: null, reason: "The MPGR fee is collected inside the swap transaction by the MPGR Executor, which does not route this pair — no fee is charged." };
    expect(formatTradeReview(p)).not.toMatch(/fee|configured/);
  });
  it("keeps success concise with one explorer link and no approval internals; output remains explicitly an estimate", () => {
    const text = formatTradeSuccess(proposal(), HASH);
    expect(text).toContain("Swap confirmed.");
    expect(text).toContain(`Transaction: https://basescan.org/tx/${HASH}`);
    expect(text.split(HASH)).toHaveLength(2);
    expect(text).toContain("quoted output");
    expect(text).not.toMatch(/Approval|router|Executor|MCP|calldata|Status:/);
  });
  it.each(["Live quote: {\"liquidityAvailable\":true}", '```json\n{"transaction":{"data":"0xabcd"}}\n```', 'Bearer secret123', 'api_key=secret', 'https://rpc.test?key=secret', '[{"symbol":"TEST"}]'])("suppresses raw tool or credential-bearing text: %s", input => {
    const text = publicAgentContent(input);
    expect(text).toContain("safely"); expect(text).not.toMatch(/liquidityAvailable|secret|0xabcd/);
  });
  it.each(["WALLET_REJECTED", "SEND_FAILED", "PROVIDER_ERROR", "APPROVAL_FAILED"])("renders clean %s errors without raw provider objects", code => {
    const text = publicTradeError({ code, message: 'Error {"authorization":"Bearer secret"} at internal.ts:1' });
    expect(text).not.toMatch(/secret|internal|authorization|Bearer/);
    if (code === "WALLET_REJECTED") expect(text).toBe("Your wallet rejected the transaction.");
    if (code === "SEND_FAILED") expect(text).toContain("Transaction failed");
  });
  it("formats a quote from structured token decimals only, not JSON", () => {
    const p = proposal();
    expect(formatTradePrice({ from: p.from, to: p.to, price: { fromToken: p.from.address, toToken: p.to.address, fromAmount: p.fromAmount, toAmount: p.toAmount, minToAmount: p.minToAmount, liquidityAvailable: true } })).toContain("1 USDC → ~0.000370006219589809 WETH");
    expect(formatTradePrice({ price: { liquidityAvailable: true } as never })).not.toContain("liquidityAvailable");
  });
});

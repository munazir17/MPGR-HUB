import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildTradeProposal } from "../trade-proposal";
import { BASE_USDC, BASE_WETH } from "../trade-config";
import { formatTradeReview, formatTradeSuccess, formatTradePrice, publicAgentContent, publicTradeError } from "../trade-chat";
const HASH = `0x${"ab".repeat(32)}` as const;
const WALLET = "0x2222222222222222222222222222222222222222";
function proposal(reverse = false) {
  const usdc = { address: BASE_USDC, decimals: 6, symbol: "USDC", name: "USD Coin", kind: "erc20" as const, verified: true };
  const weth = { address: BASE_WETH, decimals: 18, symbol: "WETH", name: "Wrapped Ether", kind: "erc20" as const, verified: true };
  const from = reverse ? weth : usdc; const to = reverse ? usdc : weth;
  const result = buildTradeProposal({ from, to, taker: WALLET, slippageBps: 100, quote: {
    fromToken: from.address, toToken: to.address, fromAmount: reverse ? "100000000000000" : "1000000", toAmount: reverse ? "267304" : "370006219589809", minToAmount: reverse ? "264630" : "366306157393910", liquidityAvailable: true,
    transaction: { to: WALLET, data: "0xabcd", value: "0" }, permit2: null,
  } });
  if (!result.ok) throw Error("fixture"); return result.proposal;
}
beforeEach(() => vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", "0x1111111111111111111111111111111111111111"));
afterEach(() => vi.unstubAllEnvs());

describe("consumer trade chat", () => {
  it("shows exact reviewed amounts and applicable fees without tool implementation data", () => {
    const text = formatTradeReview(proposal());
    expect(text).toContain("1 USDC → ~0.000370006219589809 WETH");
    expect(text).toContain("Minimum received: 0.00036630615739391 WETH");
    expect(text).toContain("0.0025 USDC"); expect(text).toContain("0.25%");
    expect(text).toContain("Your wallet signs and sends");
    expect(text).toContain("Confirm swap?");
    expect(text).not.toMatch(/0x|provider|MCP|Executor|Permit2|calldata|liquidityAvailable/);
  });
  it("does not round a very small WETH fee to zero", () => {
    expect(formatTradeReview(proposal(true))).toContain("0.00000025 WETH");
  });
  it("omits missing-fee debug explanations", () => {
    const p = proposal(); p.agentFee = { status: "skipped", bps: null, recipient: null, amountAtomic: "0", displayAmount: null, reason: "MPGR fee wallet is not configured" };
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

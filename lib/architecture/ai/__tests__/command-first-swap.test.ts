import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../agent-tool-calling", () => ({ runRegisteredTool: vi.fn(), runToolCallingLoop: vi.fn() }));
import { runRegisteredTool, runToolCallingLoop } from "../agent-tool-calling";
import { getAIProvider } from "../ai-provider-registry";
import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { AIProviderRequest } from "../ai-provider";
import { buildTradeProposal } from "@/lib/trade/trade-proposal";
import { resolveTradeToken } from "@/lib/trade/trade-tokens";
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
const runTool = vi.mocked(runRegisteredTool);
const account = "0x1111111111111111111111111111111111111111";
const request = (prompt: string): AIProviderRequest => ({ prompt, address: account, previousIntent: null, agentContext: { isConnected: true } as AIProviderRequest["agentContext"], memoryContext: { relevantHistory: [], favoriteTopics: [], conversationSummaries: [] } as unknown as AIProviderRequest["memoryContext"] });
function quote(amount: string, symbol = "ETH") {
  const from = resolveTradeToken("USDC"), to = resolveTradeToken(symbol);
  if (!from.ok || !to.ok) throw Error("fixture token");
  const built = buildTradeProposal({ from: from.token, to: to.token, taker: account, slippageBps: 100, provider: "cdp-trade-api", quote: {
    fromToken: from.token.address, toToken: to.token.address, fromAmount: `${BigInt(amount) * 1000000n}`, toAmount: "2000000000000000", minToAmount: "1980000000000000", liquidityAvailable: true, transaction: { to: "0x2222222222222222222222222222222222222222", data: "0xabcd", value: "0" }, permit2: null,
    fees: { gasFee: { amount: "1000000000000", token: "ETH" } },
  } });
  if (!built.ok) throw Error("fixture proposal"); return built.proposal;
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", "gemini"); });
afterEach(() => vi.unstubAllEnvs());
describe("command-first Base swaps use existing prepare-only tools before the model", () => {
  it.each([
    ["Buy $10 of ETH on Base", "10", "ETH"],
    ["Swap 20 USDC to WETH", "20", "WETH"],
    ["Quote 20 USDC to ETH", "20", "ETH"],
    ["Show me the best available route for 100 USDC to ETH", "100", "ETH"],
  ])("preserves exact asset/amount for %s", async (prompt, amount, target) => {
    const proposal = quote(amount, target); runTool.mockResolvedValue(toolSuccess("prepare_swap", { proposal }));
    const response = await getAIProvider().generateReply(request(prompt));
    expect(runTool).toHaveBeenCalledExactlyOnceWith("prepare_swap", { amount, sellSymbol: "USDC", buySymbol: target }, expect.anything());
    expect(runToolCallingLoop).not.toHaveBeenCalled(); expect(response.tradeProposal).toBe(proposal);
    expect(response.tradeProposal).toMatchObject({ chainId: 8453, requiresConfirmation: true });
    expect(response.reply).toContain("Min received"); expect(response.reply).not.toMatch(/best route|swap confirmed|successful|Executable alternatives/i);
    expect(response.reply).toContain("0.000001 ETH");
  });
  it.each(["Swap 20 USDC to WETH on Ethereum", "Buy $10 of ETH on chain 1", "Swap 20 USDC to WETH on Base Sepolia", "Show me the best available route for 100 USDC to ETH chain ID 84532", "Swap 20 USDC to WETH on UnknownChain"])("rejects a non-Base chain before any model/tool: %s", async prompt => {
    for (const provider of [getAIProvider(), new DeterministicAIProvider()]) { const response = await provider.generateReply(request(prompt)); expect(response.reply).toContain("8453"); expect(response.tradeProposal).toBeUndefined(); expect(response.autonomyGoalDraft).toBeUndefined(); }
    expect(runTool).not.toHaveBeenCalled(); expect(runToolCallingLoop).not.toHaveBeenCalled();
  });
  it.each(["Place a limit order to buy AAPLc if its price falls below $200", "Place limit orders for ETH on Base"])("never substitutes an Agent goal for a protocol order: %s", async prompt => { const response = await getAIProvider().generateReply(request(prompt)); expect(response.reply).toContain("limit orders are not integrated"); expect(response.tradeProposal).toBeUndefined(); expect(response.autonomyGoalDraft).toBeUndefined(); expect(runTool).not.toHaveBeenCalled(); expect(runToolCallingLoop).not.toHaveBeenCalled(); });
  it.each(["Swap 20 USDC to ETH or WETH", "Swap 20 USDC to ETH and WETH", "Swap 20 USDC to ETH and then buy AAPLc", "Buy 2 ETH"])("asks rather than guessing an amount/asset or executing multiple orders: %s", async prompt => { const response = await getAIProvider().generateReply(request(prompt)); expect(response.reply).toContain("Specify"); expect(response.tradeProposal).toBeUndefined(); expect(runTool).not.toHaveBeenCalled(); expect(runToolCallingLoop).not.toHaveBeenCalled(); });
  it("asks for missing route fields without a reference price or model guess", async () => { const response = await getAIProvider().generateReply(request("Show me the best available route for USDC")); expect(response.reply).toContain("sell amount"); expect(response.tradeProposal).toBeUndefined(); expect(runTool).not.toHaveBeenCalled(); expect(runToolCallingLoop).not.toHaveBeenCalled(); });
  it.each(["LIQUIDITY_UNAVAILABLE", "PROVIDER_ERROR", "WALLET_REQUIRED", "INSUFFICIENT_BALANCE"] as const)("returns actual prepare refusal %s, not success or a fabricated route", async code => { runTool.mockResolvedValue(toolError("prepare_swap", { code: "DATA_UNAVAILABLE", message: `${code}: Live quote unavailable; check wallet and try again.` })); const response = await getAIProvider().generateReply(request("Show me the best available route for 100 USDC to ETH")); expect(response.reply).toContain("Live quote unavailable"); expect(response.reply).toContain("Nothing was signed or submitted"); expect(response.tradeProposal).toBeUndefined(); expect(runToolCallingLoop).not.toHaveBeenCalled(); });
});

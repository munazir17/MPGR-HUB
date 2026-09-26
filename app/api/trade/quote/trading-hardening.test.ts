import { getAIProvider } from "@/lib/architecture/ai/ai-provider-registry";
import type { AIProviderRequest } from "@/lib/architecture/ai/ai-provider";
import { resetTokenDiscoveryCache } from "@/lib/trade/trade-token-discovery";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { resetTradeQuoteCache } from "@/lib/trade/trade-quote-cache";
import { BASE_USDC } from "@/lib/trade/trade-config";
import { isTradeQuoteFresh } from "@/lib/trade/trade-proposal";

const mocks = vi.hoisted(() => ({ quote: vi.fn(), code: vi.fn(), read: vi.fn(), wallet: "0x2222222222222222222222222222222222222222" }));
vi.mock("@/lib/trade/trade-public-client", () => ({ getTradePublicClient: () => ({ getCode: mocks.code, readContract: mocks.read }) }));
vi.mock("@/lib/trade/trade-swap-router", () => ({ createRoutedSwapQuote: mocks.quote }));
vi.mock("@/lib/trade/trade-price-impact", () => ({ estimateQuotePriceImpactBps: async () => null }));
vi.mock("@/lib/trade/trade-rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), clientIpFromRequest: () => "test" }));
vi.mock("@/lib/auth/session-store", () => ({ authenticateRequest: async () => ({ wallet: mocks.wallet }) }));
vi.mock("@/lib/api/request-guard", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/api/request-guard")>(), verifyTrustedOrigin: () => null }));
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const SECOND = "0x4444444444444444444444444444444444444444";
const ROUTER = "0x5555555555555555555555555555555555555555";
function req(overrides: Record<string, unknown> = {}) {
  return new Request("https://app.test/api/trade/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromToken: "USDC", toToken: ADDRESS, amount: "1", slippageBps: 100, ...overrides }) });
}
function echo(arg: { fromToken: string; toToken: string; fromAmount: string }) {
  return { ok: true, provider: "0x-swap-api", value: { ...arg, liquidityAvailable: true, toAmount: "2000000", minToAmount: "1980000", transaction: { to: ROUTER, data: "0xabcd", value: "0" }, permit2: null, issues: { allowance: null, balance: null, simulationIncomplete: false } } };
}
beforeEach(() => {
  resetTradeQuoteCache(); vi.clearAllMocks(); vi.stubEnv("MPGR_AGENT_FEE_RECIPIENT", SECOND);
  mocks.wallet = "0x2222222222222222222222222222222222222222";
  mocks.code.mockResolvedValue("0x6000");
  mocks.read.mockImplementation(async ({ functionName }) => ({ decimals: 6, symbol: "TEST", name: "Test Token", balanceOf: 0n, totalSupply: 100n })[functionName as "decimals"]);
  mocks.quote.mockImplementation(async arg => echo(arg));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("RPC-resolved token → existing quote/prepare route", () => {
  it("prepares an executable non-catalog ERC20 without claiming verification", async () => {
    const response = await POST(req()); const { proposal } = await response.json();
    expect(response.status).toBe(200);
    expect(proposal.to).toMatchObject({ symbol: "TEST", decimals: 6, verified: false });
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.executionAvailable).toBe(true);
    expect(proposal.fromAmount).toBe("1000000");
    expect(proposal.agentFee).toMatchObject({ status: "applied", bps: 25, amountAtomic: "2500" });
    expect(mocks.quote).toHaveBeenCalledWith(expect.objectContaining({ fromToken: BASE_USDC, toToken: proposal.to.address, fromAmount: "1000000", taker: mocks.wallet }));
  });
  it.each(["no-liquidity", "no-transaction", "provider-no-route"])("reports a found token but no executable route: %s", async scenario => {
    mocks.quote.mockImplementation(async arg => scenario === "provider-no-route" ? { ok: false, error: { code: "LIQUIDITY_UNAVAILABLE", message: "internal router diagnostics" } } : { ...echo(arg), value: { ...echo(arg).value, ...(scenario === "no-liquidity" ? { liquidityAvailable: false } : { transaction: null }) } });
    const response = await POST(req()); const body = await response.json();
    expect(body.proposal).toBeUndefined();
    expect(body.error).toBe("Token contract found, but no executable Base liquidity route is currently available.");
    expect(body.error).not.toMatch(/unknown|router|provider/i);
  });
  it("does not query liquidity for an EOA", async () => {
    mocks.code.mockResolvedValue("0x");
    expect(await (await POST(req())).json()).toMatchObject({ code: "TOKEN_NOT_CONTRACT" });
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it("deduplicates simultaneous prepare/quote calls including proposal construction and timestamp", async () => {
    const responses = await Promise.all([POST(req()), POST(req()), POST(req())]);
    const bodies = await Promise.all(responses.map(r => r.json()));
    expect(mocks.quote).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]);
  });
  it("refreshes expired cache entries and never stamps a reused quote as fresh", async () => {
    vi.useFakeTimers();
    const first = await (await POST(req())).json();
    vi.advanceTimersByTime(2_000);
    const reused = await (await POST(req())).json();
    expect(reused.proposal.quotedAt).toBe(first.proposal.quotedAt);
    vi.advanceTimersByTime(31_000);
    expect(isTradeQuoteFresh(first.proposal)).toBe(false);
    const fresh = await (await POST(req())).json();
    expect(mocks.quote).toHaveBeenCalledTimes(2);
    expect(isTradeQuoteFresh(fresh.proposal)).toBe(true);
  });
  it("does not cache failed provider results or leak credentials", async () => {
    mocks.quote.mockResolvedValueOnce({ ok: false, error: { code: "PROVIDER_ERROR", message: "Bearer secret https://rpc.test?key=credential" } });
    const fail = await (await POST(req())).json();
    expect(fail.error).not.toMatch(/secret|credential|rpc.test/);
    expect((await POST(req())).status).toBe(200);
    expect(mocks.quote).toHaveBeenCalledTimes(2);
  });
  it.each([{ amount: "2" }, { toToken: SECOND }, { slippageBps: 50 }])("changed execution parameters require a new quote: %j", async changed => {
    await POST(req()); await POST(req(changed)); expect(mocks.quote).toHaveBeenCalledTimes(2);
  });
  it("isolates quotes by the authenticated wallet", async () => {
    await POST(req()); mocks.wallet = SECOND; await POST(req()); expect(mocks.quote).toHaveBeenCalledTimes(2);
  });
  it.each(["fromToken", "toToken", "fromAmount"])("never prepares a quote with a mismatched %s", async field => {
    mocks.quote.mockImplementation(async arg => ({ ...echo(arg), value: { ...echo(arg).value, [field]: field === "fromAmount" ? "999999" : SECOND } }));
    expect(await (await POST(req())).json()).toMatchObject({ code: "QUOTE_CHANGED" });
  });
});

// Integrated OFFLINE flow: real parser/provider/tool runtime/API/proposal builder;
// only network/RPC/DEX/session boundaries are mocked. No wallet write functions.
describe("natural-language request through the real tool runtime", () => {
  it.each([
    ["Swap 1 USDC to " + ADDRESS, "1000000"],
    ["Swap 1 USDC to DEGEN", "1000000"],
    ["Buy DEGEN with 0.08 USDC", "80000"],
    ["Swap.0.08 USDC for MPGR", "80000"],
  ])("prepares exactly the requested amount without intermediate tool JSON: %s", async (prompt, expectedAtomic) => {
    resetTokenDiscoveryCache();
    const http = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://tokens.uniswap.org") return new Response(JSON.stringify({ tokens: [{ chainId: 8453, address: ADDRESS, symbol: "DEGEN", name: "Degen", decimals: 18 }] }));
      if (url === "/api/trade/quote") return POST(new Request("https://app.test" + url, init));
      throw new Error("Unexpected network/capability request");
    });
    vi.stubGlobal("fetch", http);
    const result = await getAIProvider().generateReply({ prompt, address: mocks.wallet, agentContext: { isConnected: true }, previousIntent: null, memoryContext: {} } as AIProviderRequest);
    expect(result.tradeProposal?.fromAmount).toBe(expectedAtomic);
    expect(result.tradeProposal?.requiresConfirmation).toBe(true);
    expect(mocks.quote).toHaveBeenCalledTimes(1);
    expect(http.mock.calls.filter(([url]) => url === "/api/trade/quote")).toHaveLength(1);
    expect(result.reply).not.toMatch(/liquidityAvailable|transaction.*data|calldata|router|Executor|MCP|0x/);
    expect(result.reply).toContain("Confirm swap?");
  });
});

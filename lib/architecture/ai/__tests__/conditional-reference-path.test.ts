import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Use the real registered get_pair tool, pair route, single-token recovery,
// response projection, and reference validator. Only network data is mocked.
vi.mock("@/lib/markets/tape", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/markets/tape")>(),
  getTapeSnapshot: vi.fn(),
}));
vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })), clientIpFromRequest: () => "203.0.113.1",
}));
import { getTapeSnapshot } from "@/lib/markets/tape";
import { findBasePair } from "@/lib/markets/base-pairs";
import { BASE_USDC } from "@/lib/trade/trade-config";
import { GET } from "@/app/api/market/pair/route";
import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { AIProviderRequest } from "../ai-provider";

const prompt = "Buy AAPLc whenever price falls 1% worth 1 USDC";
const pair = findBasePair("AAPLc")!;
const request = (text = prompt): AIProviderRequest => ({
  prompt: text, previousIntent: null, agentContext: { isConnected: true } as AIProviderRequest["agentContext"],
  memoryContext: { relevantHistory: [], favoriteTopics: [], conversationSummaries: [] } as unknown as AIProviderRequest["memoryContext"],
});
const network = vi.fn<typeof fetch>();
let status: number;
let upstream: unknown;
beforeEach(() => {
  status = 200;
  upstream = { pairs: [{ chainId: "base", dexId: "aerodrome", baseToken: { address: pair.address }, quoteToken: { address: BASE_USDC },
    priceUsd: "347", liquidity: { usd: 1_000_000 } }] };
  vi.mocked(getTapeSnapshot).mockResolvedValue({
    asOf: new Date().toISOString(), chainId: 8453, blockNumber: 1, wrapped: [],
    stocks: [{ symbol: pair.symbol, name: pair.name, address: pair.address, usdFeed: null, usdDex: null,
      premiumBps: null, change24h: null, source: "unavailable", stale: true, feedStale: true, paused: null, feedUpdatedAt: null, dexUpdatedAt: null }],
  });
  network.mockReset();
  network.mockImplementation(async (url, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    if (url === "/api/market/pair?symbol=AAPLc") return GET(new Request(`https://preview.example${url}`));
    if (url === `https://api.dexscreener.com/latest/dex/tokens/${pair.address}`) return new Response(JSON.stringify(upstream), { status });
    throw new Error(`Unexpected request in read-only test: ${String(url)}`);
  });
  vi.stubGlobal("fetch", network);
});
afterEach(() => vi.unstubAllGlobals());

describe("actual conditional reference lookup path", () => {
  it("recovers the missing batch entry and anchors through the real API/tool projection", async () => {
    const response = await new DeterministicAIProvider().generateReply(request());
    expect(response.autonomyGoalDraft).toMatchObject({ targetAsset: "AAPLc", amountPerTrade: "1", spendAsset: "USDC",
      percentDrop: 1, referencePrice: "347", triggerPrice: "343.53", sourcePrompt: prompt });
    expect(response.tradeProposal).toBeUndefined();
    expect(network).toHaveBeenCalledTimes(2); // Pair GET + upstream GET, no goal/authorization/quote POST.
  });
  it.each([503, 429])("fails closed on upstream HTTP %s and preserves the parsed request in the reply", async (code) => {
    status = code;
    upstream = {};
    const response = await new DeterministicAIProvider().generateReply(request());
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.reply).toContain("1 USDC per trade at a 1% drop");
    expect(response.tradeProposal).toBeUndefined();
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("rejects a malformed successful upstream response", async () => {
    upstream = { price: 347 }; // Not a DexScreener pair response.
    const response = await new DeterministicAIProvider().generateReply(request());
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.reply).toMatch(/could not get a live/);
  });
  it.each([429, 502])("fails closed when our pair API returns HTTP %s", async (status) => {
    network.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Pair unavailable", code: "TAPE_UNAVAILABLE" }), { status }));
    const response = await new DeterministicAIProvider().generateReply(request());
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.reply).toContain("1 USDC per trade at a 1% drop");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("refuses a malformed pair API payload rather than confusing stockEntry with the tool's stock projection", async () => {
    network.mockResolvedValueOnce(new Response(JSON.stringify({ usdFeed: 347 }), { status: 200 }));
    const response = await new DeterministicAIProvider().generateReply(request());
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each([
    "Buy AAPLc when it falls below 250 or above 300 worth 1 USDC",
    "Buy AAPLc whenever price falls 1% worth 1 USDC or 2 USDC",
    "Buy AAPLc whenever price falls 1% worth -1 USDC",
  ])("deterministic fallback refuses ambiguous/invalid source input without a price or execution call: %s", async (prompt) => {
    const response = await new DeterministicAIProvider().generateReply(request(prompt));
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.tradeProposal).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });
  it("never looks up an unsupported symbol", async () => {
    const response = await new DeterministicAIProvider().generateReply(request(prompt.replace("AAPLc", "FOOc")));
    expect(response.autonomyGoalDraft?.supported).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });
});

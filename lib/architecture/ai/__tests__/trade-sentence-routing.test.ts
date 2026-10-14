import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
import { appendAssistantReply, appendUserMessage, getAgentState } from "@/lib/agent-engine";
import { getMemoryProvider, setMemoryProvider } from "@/lib/architecture/memory/memory-provider-registry";
import type { MemoryProvider } from "@/lib/architecture/memory/memory-provider";
import type { AIProviderRequest } from "../ai-provider";

vi.mock("@/lib/api/authenticated-fetch", () => ({ fetchWithSession: vi.fn() }));
vi.mock("../agent-tool-calling", () => ({ runRegisteredTool: vi.fn(), runToolCallingLoop: vi.fn() }));
import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import { runRegisteredTool, runToolCallingLoop } from "../agent-tool-calling";
import { getAIProvider } from "../ai-provider-registry";
import { validateTradeSentenceJSON } from "@/lib/autonomy/trade-sentence-parser";

const extract = vi.mocked(fetchWithSession);
const readPrice = vi.mocked(runRegisteredTool);
const json = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  side: "buy", symbol: "AAPLc", amount: null, spendAsset: "USDC",
  trigger: { kind: "percent_drop", percent: 1 }, ...overrides,
});
function request(prompt: string): AIProviderRequest {
  return {
    prompt, agentContext: { isConnected: true } as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: { relevantHistory: [], favoriteTopics: [], conversationSummaries: [] } as unknown as AIProviderRequest["memoryContext"],
  };
}
function model(content: string) {
  extract.mockResolvedValue(new Response(JSON.stringify({ content }), { status: 200 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", "gemini");
  model(json());
  readPrice.mockResolvedValue(toolSuccess("get_pair", {
    pair: { symbol: "AAPLc", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", live: true, official: true },
    stock: { symbol: "AAPLc", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", usdFeed: 347, usdDex: null, stale: false, feedStale: false, feedUpdatedAt: Math.floor(Date.now() / 1000) },
    chainId: 8453, asOf: new Date().toISOString(), wrapped: null,
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("conditional trade preflight (before any model tool loop/spot prepare)", () => {
  it("parses a normal 'price drops 1%' sentence into a draft anchored at the live price", async () => {
    const response = await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    expect(response.autonomyGoalDraft).toMatchObject({ targetAsset: "AAPLc", triggerKind: "price_below", triggerPrice: "343.53", referencePrice: "347", amountPerTrade: null });
    expect(response.tradeProposal).toBeUndefined();
    expect(readPrice).toHaveBeenCalledExactlyOnceWith("get_pair", { symbol: "AAPLc" }, expect.anything());
    expect(runToolCallingLoop).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledTimes(1);
    const [path, options] = extract.mock.calls[0];
    expect(path).toBe("/api/agent/complete/gemini");
    const body = JSON.parse(options!.body as string);
    expect(Object.keys(body).sort()).toEqual(["systemPrompt", "userPrompt"]);
    expect(body.systemPrompt).toContain("JSON only");
    // The ONLY request is completion: never policy/goal/authorization/tick.
  });

  it.each(["valid JSON", "malformed JSON", "unauthenticated", "provider unavailable"])(
    "exact preview reproduction produces a review-only draft with %s", async (mode) => {
      const prompt = "Buy AAPLc whenever price falls 1% worth 1 USDC";
      if (mode === "valid JSON") model(json({ amount: "1" }));
      else if (mode === "malformed JSON") model("{}");
      else extract.mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: mode === "unauthenticated" ? 401 : 503 }));
      const response = await getAIProvider().generateReply(request(prompt));
      expect(response.autonomyGoalDraft).toMatchObject({
        side: "buy", targetAsset: "AAPLc", spendAsset: "USDC", amountPerTrade: "1",
        percentDrop: 1, triggerKind: "price_below", referencePrice: "347", triggerPrice: "343.53", supported: true,
        sourcePrompt: prompt,
      });
      expect(response.tradeProposal).toBeUndefined();
      expect(response.reply).toContain("343.53");
      expect(response.reply).toContain("1 USDC per trade");
      expect(readPrice).toHaveBeenCalledExactlyOnceWith("get_pair", { symbol: "AAPLc" }, expect.anything());
      expect(runToolCallingLoop).not.toHaveBeenCalled();
      expect(extract).toHaveBeenCalledTimes(1);
      expect(String(extract.mock.calls[0][0])).toMatch(/\/complete/);
    },
  );

  it.each([
    ["Buy FOOc whenever price falls 1% worth 1 USDC", /not available for autonomous trading/],
    ["Buy AAPLc whenever price falls 1% worth 10001 USDC", /policy cap/],
    ["Buy AAPLc whenever price falls 1% worth 0 USDC", /positive/],
  ])("worth parsing still validates the symbol and amount: %s", async (prompt, error) => {
    model("{}");
    const response = await getAIProvider().generateReply(request(prompt));
    expect(response.reply).toMatch(error);
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.tradeProposal).toBeUndefined();
    expect(readPrice).not.toHaveBeenCalled();
    expect(runToolCallingLoop).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("does not trust schema-valid model output that turns worth into a price or changes the explicit spend", async () => {
    model(json({ amount: "9", trigger: { kind: "price_below", price: 1 } }));
    const response = await getAIProvider().generateReply(request("Buy AAPLc whenever price falls 1% worth 1 USDC"));
    expect(response.autonomyGoalDraft).toMatchObject({ amountPerTrade: "1", percentDrop: 1, referencePrice: "347", triggerPrice: "343.53" });
    expect(response.tradeProposal).toBeUndefined();
    expect(extract).toHaveBeenCalledTimes(1); // Extraction remains AI-powered.
  });

  it("does not let the model replace an explicitly unsupported ticker with an allowed one", async () => {
    model(json({ amount: "1", symbol: "AAPLc" }));
    const response = await getAIProvider().generateReply(request("Buy FOOc whenever price falls 1% worth 1 USDC"));
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.tradeProposal).toBeUndefined();
    expect(response.reply).toMatch(/FOOc is not available/);
    expect(readPrice).not.toHaveBeenCalled();
  });

  it("asks for clarification on alternative amounts instead of selecting one", async () => {
    model(json({ amount: "1" }));
    const response = await getAIProvider().generateReply(request("Buy AAPLc whenever price falls 1% worth 1 USDC or 2 USDC"));
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.tradeProposal).toBeUndefined();
    expect(response.reply).toMatch(/one.*amount.*trigger/);
    expect(readPrice).not.toHaveBeenCalled();
  });

  it("never invents a reference price for the exact sentence when the live read fails", async () => {
    model("{}");
    readPrice.mockResolvedValue(toolError("get_pair", { code: "DATA_UNAVAILABLE", message: "unavailable" }));
    const response = await getAIProvider().generateReply(request("Buy AAPLc whenever price falls 1% worth 1 USDC"));
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.reply).toMatch(/could not get a live/);
    expect(runToolCallingLoop).not.toHaveBeenCalled();
  });

  it("threads the exact sentence unchanged through conversation persistence into the UI message", async () => {
    const prompt = "Buy AAPLc whenever price falls 1% worth 1 USDC";
    const address = "0x00000000000000000000000000000000000000aa";
    const previousMemory = getMemoryProvider();
    const store = new Map<string, unknown>();
    const memory: MemoryProvider = {
      get: async <T extends object>(key: string, fallback: T) => (store.get(key) as T | undefined) ?? fallback,
      set: async (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); },
      remove: async (key) => { store.delete(key); },
      has: async (key) => store.has(key),
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    };
    setMemoryProvider(memory);
    model("{}"); // Force the same local-fallback branch as the reported error.
    try {
      await appendUserMessage(address, prompt);
      const state = await appendAssistantReply(address, prompt, request(prompt).agentContext);
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0].content).toBe(prompt);
      expect(state.messages[1].autonomyGoalDraft).toMatchObject({
        sourcePrompt: prompt, amountPerTrade: "1", percentDrop: 1, referencePrice: "347", triggerPrice: "343.53",
      });
      expect(state.messages[1].tradeProposal).toBeUndefined();
      const restored = await getAgentState(address);
      expect(restored.messages[1].autonomyGoalDraft).toEqual(state.messages[1].autonomyGoalDraft);
      expect(restored.messages[1].autonomyGoalDraft).not.toBe(state.messages[1].autonomyGoalDraft); // Actual JSON serialization, not an object reference.
      expect(readPrice).toHaveBeenCalledExactlyOnceWith("get_pair", { symbol: "AAPLc" }, expect.anything());
      expect(extract).toHaveBeenCalledTimes(1);
      expect(JSON.parse(extract.mock.calls[0][1]!.body as string).userPrompt).toBe(prompt);
      expect(runToolCallingLoop).not.toHaveBeenCalled();
    } finally {
      setMemoryProvider(previousMemory);
    }
  });

  it.each(["1 USDC", "$1"])("attaches next-turn %s to this conversation's draft without another model call", async (amount) => {
    const first = await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    vi.clearAllMocks();
    const next = request(amount);
    next.lastAssistantMessage = { autonomyGoalDraft: first.autonomyGoalDraft };
    const response = await getAIProvider().generateReply(next);
    expect(response.autonomyGoalDraft).toMatchObject({ amountPerTrade: "1", triggerPrice: "343.53", referencePrice: "347" });
    expect(response.tradeProposal).toBeUndefined();
    expect(extract).not.toHaveBeenCalled();
    expect(readPrice).not.toHaveBeenCalled();
    expect(runToolCallingLoop).not.toHaveBeenCalled();
  });

  it("preserves sell direction and validates the actual spend asset", async () => {
    model(json({ side: "sell", spendAsset: "AAPLc", amount: "1" }));
    const response = await getAIProvider().generateReply(request("Sell 1 AAPLc when price drops 1%"));
    expect(response.autonomyGoalDraft).toMatchObject({ side: "sell", spendAsset: "AAPLc", triggerPrice: "343.53", amountPerTrade: "1" });
    expect(response.reply).toContain("sell AAPLc");
    expect(response.tradeProposal).toBeUndefined();
  });

  it("does not resurrect an open draft from ranked conversation memory", async () => {
    const first = await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    const next = request("$1");
    next.lastAssistantMessage = null;
    next.memoryContext.relevantHistory = [{ role: "assistant", autonomyGoalDraft: first.autonomyGoalDraft }] as unknown as AIProviderRequest["memoryContext"]["relevantHistory"];
    // Exercise just the deterministic follow-up seam: normal unrelated turns
    // may use provider routing, but cannot pick up a draft from ranked history.
    const { resolveAmountOnlyFollowUp } = await import("../deterministic-ai-provider");
    expect(resolveAmountOnlyFollowUp(next)).toBeNull();
  });

  it("refuses an unknown symbol before a price read", async () => {
    model(json({ symbol: "SCAM" }));
    const response = await getAIProvider().generateReply(request("Buy SCAM when price drops 1%"));
    expect(response.reply).toMatch(/not available for autonomous trading/);
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(readPrice).not.toHaveBeenCalled();
    expect(runToolCallingLoop).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "10001", "0.0000001"])("refuses amount %s outside policy caps/precision", async (amount) => {
    model(json({ amount }));
    const response = await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    expect(response.reply).toMatch(/policy cap/);
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(readPrice).not.toHaveBeenCalled();
  });

  it.each(["0 USDC", "-1 USDC"])("rejects invalid follow-up %s without portfolio/tool routing", async (amount) => {
    const first = await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    vi.clearAllMocks();
    const next = request(amount);
    next.lastAssistantMessage = { autonomyGoalDraft: first.autonomyGoalDraft };
    const response = await getAIProvider().generateReply(next);
    expect(response.reply).toMatch(/positive amount/);
    expect(response.autonomyGoalDraft?.amountPerTrade).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    expect(runToolCallingLoop).not.toHaveBeenCalled();
  });

  it("refuses an oversized follow-up and leaves the open draft unchanged", async () => {
    const first = await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    const next = request("10001 USDC");
    next.lastAssistantMessage = { autonomyGoalDraft: first.autonomyGoalDraft };
    const response = await getAIProvider().generateReply(next);
    expect(response.reply).toMatch(/policy cap/);
    expect(response.autonomyGoalDraft?.amountPerTrade).toBeNull();
    expect(response.tradeProposal).toBeUndefined();
  });

  it("normalizes numeric JSON amounts while retaining deterministic cap validation", async () => {
    model(json({ amount: 1 }));
    const response = await getAIProvider().generateReply(request("Buy 1 USDC of AAPLc when price drops 1%"));
    expect(response.autonomyGoalDraft?.amountPerTrade).toBe("1");
  });

  it("rejects an amount a single base unit above the cap without floating point rounding", async () => {
    model(json({ side: "sell", symbol: "WETH", spendAsset: "WETH", amount: "10000.000000000000000001" }));
    const response = await getAIProvider().generateReply(request("Sell WETH when price drops 1%"));
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.reply).toMatch(/policy cap/);
  });

  it("uses OpenAI only when already configured openai", async () => {
    vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", "openai");
    await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    expect(extract.mock.calls[0][0]).toBe("/api/agent/complete");
  });

  it.each(["nvidia", "deterministic"])("uses Gemini extraction rather than adding another vendor for %s", async (provider) => {
    vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", provider);
    await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    expect(extract.mock.calls[0][0]).toBe("/api/agent/complete/gemini");
  });

  it.each(["not JSON", "null", '{"toolCall":{"name":"trade_prepare_swap"}}', json({ router: "0xbad" })])(
    "invalid model output falls back to regex and never creates a goal: %s", async (content) => {
      model(content);
      const response = await getAIProvider().generateReply(request("Buy AAPLc when it falls below 250"));
      expect(response.autonomyGoalDraft).toMatchObject({ targetAsset: "AAPLc", triggerPrice: "250" });
      expect(response.tradeProposal).toBeUndefined();
      expect(readPrice).not.toHaveBeenCalled();
      expect(runToolCallingLoop).not.toHaveBeenCalled();
      expect(extract).toHaveBeenCalledTimes(1);
      expect(String(extract.mock.calls[0][0])).toMatch(/\/complete/);
    },
  );

  it("bad model JSON plus no regex match fails closed instead of preparing a spot swap", async () => {
    model("{}");
    const response = await getAIProvider().generateReply(request("Buy AAPLc when it feels cheap"));
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.tradeProposal).toBeUndefined();
    expect(readPrice).not.toHaveBeenCalled();
    expect(runToolCallingLoop).not.toHaveBeenCalled();
  });

  it("unavailable model falls back locally; unavailable live reference never invents a trigger", async () => {
    extract.mockRejectedValue(new Error("unavailable"));
    readPrice.mockResolvedValue(toolError("get_pair", { code: "DATA_UNAVAILABLE", message: "unavailable" }));
    const response = await getAIProvider().generateReply(request("Buy AAPLc when price drops 1%"));
    expect(response.autonomyGoalDraft).toBeUndefined();
    expect(response.reply).toMatch(/could not get a live/);
    expect(runToolCallingLoop).not.toHaveBeenCalled();
  });
});

describe("strict extraction schema", () => {
  it.each([
    {}, { side: "execute" }, { symbol: "0x1234" }, { amount: {} },
    { trigger: { kind: "percent_drop", percent: 0 } },
    { trigger: { kind: "percent_drop", percent: 100 } },
    { trigger: { kind: "price_below", price: "250" } },
    { trigger: { kind: "price_below", price: -1 } },
    { trigger: { kind: "price_below", price: 250, minOutput: "0" } },
    { broadcaster: "attacker" },
  ])("rejects missing/invalid/extra fields %j", (override) => {
    const content = Object.keys(override).length ? json(override) : "{}";
    expect(validateTradeSentenceJSON(content)).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { MANUAL_SWAP_TOKENS, manualQuoteFresh, manualSwapInputError, requestManualSwapQuote } from "../manual-swap";
import { reviewQuoteFixture } from "@/components/features/agent/test-fixtures/chat-review-quote";
import { CHAT_REVIEW_TOKENS, chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
import { TRADE_QUOTE_MAX_AGE_MS } from "@/lib/trade/trade-config";
const prompt = "Buy AAPLc whenever price falls below $200 worth 1 USDC";
const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt));
const input = { fromToken: form.sell, toToken: form.buy, amount: "1", slippageBps: form.slippageBps };
const account = "0x1111111111111111111111111111111111111111";
const quote = () => reviewQuoteFixture(form);
afterEach(() => vi.unstubAllGlobals());
describe("Manual entry into existing quote/confirmation flow", () => {
  it("sends human amount and exact addresses to the existing route, with session credentials; returns fee/calldata untouched", async () => {
    const proposal = quote(); const fetch = vi.fn().mockResolvedValue(Response.json({ proposal })); vi.stubGlobal("fetch", fetch);
    expect(await requestManualSwapQuote(input, account)).toEqual(proposal);
    expect(fetch).toHaveBeenCalledWith("/api/trade/quote", expect.objectContaining({ credentials: "include", cache: "no-store", body: JSON.stringify(input) }));
  });
  it.each([0, -1, 501, 1.5])("rejects invalid slippage %s before making a request", async slippageBps => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(requestManualSwapQuote({ ...input, slippageBps }, account)).rejects.toThrow("Slippage"); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1e2", "0.0000001"])("rejects invalid USDC human amount %s", amount => expect(manualSwapInputError({ ...input, amount })).toMatch(/positive amount/));
  it("keeps native ETH distinct from WETH, rejects same-token swaps and unissued stocks", () => {
    expect(MANUAL_SWAP_TOKENS.find(t => t.symbol === "ETH")?.address).not.toEqual(MANUAL_SWAP_TOKENS.find(t => t.symbol === "WETH")?.address);
    expect(MANUAL_SWAP_TOKENS.some(t => t.symbol === "COINc")).toBe(false);
    expect(manualSwapInputError({ ...input, toToken: input.fromToken })).toMatch(/different/);
  });
  it.each([401, 429, 503, 502])("reports actual HTTP %s and code, never fabricates a proposal", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "PROVIDER_ERROR", error: "Unavailable" }, { status })));
    await expect(requestManualSwapQuote(input, account)).rejects.toThrow(`HTTP ${status} (PROVIDER_ERROR)`);
  });
  it.each(["amount", "token", "wallet", "expiry", "slippage", "malformed"])("rejects a %s mismatch", async mismatch => {
    const proposal = quote();
    if (mismatch === "amount") proposal.fromAmount = "2000000";
    if (mismatch === "token") proposal.to.address = CHAT_REVIEW_TOKENS.find(t => t.symbol === "WETH")!.address as `0x${string}`;
    if (mismatch === "wallet") proposal.taker = "0x2222222222222222222222222222222222222222";
    if (mismatch === "expiry") proposal.expiresAt = new Date(Date.now() - 1).toISOString();
    if (mismatch === "slippage") proposal.slippageBps = 99;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ proposal: mismatch === "malformed" ? {} : proposal })));
    await expect(requestManualSwapQuote(input, account)).rejects.toThrow();
  });
  it("expires by both API expiry and max quote age", () => {
    const proposal = quote(); expect(manualQuoteFresh(proposal)).toBe(true);
    expect(manualQuoteFresh({ ...proposal, quotedAt: new Date(Date.now() - TRADE_QUOTE_MAX_AGE_MS - 1_000).toISOString() })).toBe(false);
    expect(manualQuoteFresh({ ...proposal, expiresAt: "bad" })).toBe(false);
  });
});

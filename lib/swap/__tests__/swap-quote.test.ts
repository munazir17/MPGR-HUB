import { afterEach, expect, it, vi } from "vitest";
import { requestSwapQuote } from "../swap-quote";
import { ManualSwapQuoteError } from "@/lib/trade/manual-swap";
import { BASE_USDC, NATIVE_ETH_SENTINEL, BASE_WETH } from "@/lib/trade/trade-config";
import { simulatedExecutorQuote } from "@/tests/mobile/flow-fixtures";
import { chatDraftToForm } from "@/components/features/agent/chat-autonomy-review";
import { buildGoalDraft, detectAutonomousTradeRequest } from "@/lib/autonomy/chat-draft";
const prompt = "Buy AAPLc whenever price falls below $200 worth 1 USDC";
const form = chatDraftToForm(buildGoalDraft(detectAutonomousTradeRequest(prompt)!, prompt));
const make = () => structuredClone(simulatedExecutorQuote({ ...form, sell: BASE_USDC, buy: NATIVE_ETH_SENTINEL }));
const input = { fromToken: BASE_USDC, toToken: NATIVE_ETH_SENTINEL, amount: "1", slippageBps: form.slippageBps };
function serve(value: unknown, status = 200) { const mock = vi.fn(async () => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", mock); return mock; }
afterEach(() => vi.unstubAllGlobals());
it("uses only strict endpoint with cookie auth and immutable policy; explicit refresh stays explicit", async () => {
 const p = make(); const fetch = serve({ proposal: p }); expect(await requestSwapQuote(input, p.taker, undefined, undefined, { fresh: true })).toEqual(p);
 expect(fetch.mock.calls[0]).toEqual(["/api/swap/quote", expect.objectContaining({ credentials: "include", cache: "no-store", body: JSON.stringify({ ...input, requireMPGRFee: true, refreshQuote: true }) })]);
});
it.each([401, 422, 429, 503])("actionable %s preserves auth/status identity without raw HTTP prefix", async status => {
 const p = make(); serve({ error: "Verify the approved route before retrying", code: status === 401 ? "AUTH_REQUIRED" : "EXECUTION_UNAVAILABLE", reason: status === 401 ? undefined : "FEE_ROUTE_UNREGISTERED" }, status);
 try { await requestSwapQuote(input, p.taker); throw Error("Expected refusal"); } catch (e) { expect(e).toBeInstanceOf(ManualSwapQuoteError); expect(e).toMatchObject({ status, message: "Verify the approved route before retrying" }); }
});
it.each(["amount", "slippage", "account", "asset", "expired", "fee", "malformed"])("rejects %s response drift", async kind => {
 const p = make(); if (kind === "amount") p.fromAmount = "2000000"; if (kind === "slippage") p.slippageBps = 50; if (kind === "account") p.taker = "0x9999999999999999999999999999999999999999"; if (kind === "asset") p.to.address = BASE_WETH; if (kind === "expired") p.expiresAt = new Date(Date.now() - 1000).toISOString(); if (kind === "fee") p.agentFee!.bps = 0;
 serve({ proposal: kind === "malformed" ? {} : p }); await expect(requestSwapQuote(input, make().taker)).rejects.toThrow();
});
it("ETH/WETH is refused without fetching", async () => { const mock = serve({}); await expect(requestSwapQuote({ ...input, fromToken: NATIVE_ETH_SENTINEL, toToken: BASE_WETH }, make().taker)).rejects.toThrow(/underlying/); expect(mock).not.toHaveBeenCalled(); });

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpDeps } from "@/lib/mcp/mcp-deps";
import { getCapabilities, getQuote, prepareTrade } from "@/lib/mcp/mcp-trade-service";

const TAKER = "0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e";
const MPGR = "0xb2000000000000000000008d204203177a78af01";
const FIVE_USDC = "5000000";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(!process.env.LIVE_MPGR_QUOTE)("live MCP USDC/MPGR", () => {
  it("quotes and prepares an unsigned swap with one 25 bps fee", async () => {
    vi.stubEnv("MPGR_MCP_ENABLE_BASE_MAINNET", "true");
    vi.stubEnv("AUTH_SESSION_SECRET", "live-mpgr-quote-secret-not-a-key-32b");
    const deps = createMcpDeps();
    const caps = getCapabilities(deps);
    expect(caps.ok).toBe(true);
    const quote = await getQuote(deps, {
      chainId: 8453,
      taker: TAKER,
      sellToken: "USDC",
      buyToken: MPGR,
      sellAmount: FIVE_USDC,
      slippageBps: 100,
    });
    expect(quote.ok, !quote.ok ? `${quote.error.code}: ${quote.error.message}` : "").toBe(true);
    if (!quote.ok) return;
    const data = quote.data as Record<string, unknown>;
    expect(data.feeBps).toBe(25);
    expect(data.feeAmount).toBe("12500");
    expect(BigInt(String(data.expectedBuyAmount))).toBeGreaterThan(0n);
    expect(String(data.quoteId).length).toBeGreaterThan(20);
    expect(JSON.stringify(data)).not.toMatch(/private key|seed phrase/i);
    const prepared = await prepareTrade(deps, { quoteId: data.quoteId, authorization: "APPROVAL" });
    expect(prepared.ok, !prepared.ok ? `${prepared.error.code}: ${prepared.error.message}` : "").toBe(true);
    if (!prepared.ok) return;
    const body = prepared.data as {
      transactionRequest: { to: string; data: string; value: string };
      steps: { step: string; transactionRequest: { to: string } }[];
    };
    expect(body.transactionRequest.to).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.transactionRequest.data.startsWith("0x")).toBe(true);
    expect(body.transactionRequest.value).toBe("0");
    expect(body.transactionRequest).not.toHaveProperty("signature");
    expect(body.steps.map((step) => step.step)).toContain("sendSwapTransaction");
    const back = await getQuote(deps, {
      chainId: 8453,
      taker: TAKER,
      sellToken: MPGR,
      buyToken: "USDC",
      sellAmount: String(data.expectedBuyAmount),
      slippageBps: 100,
    });
    expect(back.ok, !back.ok ? `${back.error.code}: ${back.error.message}` : "").toBe(true);
    if (!back.ok) return;
    const reverse = back.data as Record<string, unknown>;
    const backGross = BigInt(String(data.expectedBuyAmount));
    expect(reverse.feeAmount).toBe((backGross * 25n / 10_000n).toString());
    expect(BigInt(String(reverse.expectedBuyAmount))).toBeGreaterThan(0n);
    console.log(JSON.stringify({
      provider: data.provider,
      feeAmount: data.feeAmount,
      expectedBuyAmount: data.expectedBuyAmount,
      minBuyAmount: data.minBuyAmount,
      steps: body.steps.map((step) => step.step),
      unsignedTo: body.transactionRequest.to,
      reverseFee: reverse.feeAmount,
      reverseOut: reverse.expectedBuyAmount,
    }));
  }, 180_000);
});

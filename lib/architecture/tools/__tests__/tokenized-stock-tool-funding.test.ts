import { afterEach, describe, expect, it, vi } from "vitest";

// The tool layer must FORWARD an explicitly named funding asset to
// /api/trade/stocks/quote so the server can honor-or-refuse it — the
// silent-USDC substitution happened because this hop had no way to carry
// the user's "with ETH".

const { tokenizedStockPrepareOrderTool } = await import("../trade-tool-definitions");

const WALLET = "0x2222222222222222222222222222222222222222";

const fetchMock = vi.fn();
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function okProposal() {
  return new Response(JSON.stringify({ proposal: { id: "p1" }, executed: false }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("tokenized_stock_prepare_order — fundingAsset forwarding", () => {
  it("forwards fundingAsset to the quote endpoint when provided", async () => {
    fetchMock.mockResolvedValue(okProposal());
    vi.stubGlobal("fetch", fetchMock);

    const result = await tokenizedStockPrepareOrderTool.execute(
      { symbol: "AAPLc", amount: "0.001", side: "BUY", amountUnit: "token", fundingAsset: "ETH" },
      { walletAddress: WALLET } as never,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/trade/stocks/quote");
    const body = JSON.parse(String(init.body));
    expect(body.fundingAsset).toBe("ETH");
    expect(body.symbol).toBe("AAPLc");
    expect(body.side).toBe("BUY");
  });

  it("omits fundingAsset entirely when not provided (historical bodies unchanged)", async () => {
    fetchMock.mockResolvedValue(okProposal());
    vi.stubGlobal("fetch", fetchMock);

    await tokenizedStockPrepareOrderTool.execute(
      { symbol: "AAPLc", amount: "0.001", side: "BUY", amountUnit: "token" },
      { walletAddress: WALLET } as never,
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect("fundingAsset" in body).toBe(false);
  });

  it("surfaces the server's UNSUPPORTED_INPUT refusal as a tool error (no fabricated proposal)", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Tokenized-stock orders currently fund with USDC only — ETH is not supported for this route. Nothing was signed or submitted.",
          code: "UNSUPPORTED_INPUT",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tokenizedStockPrepareOrderTool.execute(
      { symbol: "AAPLc", amount: "0.001", side: "BUY", amountUnit: "token", fundingAsset: "ETH" },
      { walletAddress: WALLET } as never,
    );

    expect(result.success).toBe(false);
    if (!result.success && result.error) {
      // The tool's error taxonomy buckets unsupported input under
      // INVALID_INPUT; the full refusal text is preserved in the message.
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(String(result.error.message)).toContain("USDC only");
      expect(String(result.error.message)).toContain("Nothing was signed");
    }
  });
});

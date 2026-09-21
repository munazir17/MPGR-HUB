import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTapeTool,
  getPairTool,
  verifyB20ContractTool,
  getStockHoldingsTool,
  getPremiumTool,
  describeX402TapeTool,
  prepareSwapTool,
} = await import("../stocks-tool-definitions");

// The runtime's deterministic router reroutes prepare_swap onto
// tokenized_stock_prepare_order (B20 legs) or trade_prepare_swap, so the
// test registry must contain the real targets too.
import { tokenizedStockPrepareOrderTool, tradePrepareSwapTool } from "../trade-tool-definitions";
import { AgentToolRegistry } from "../agent-tool-registry";
import { AgentToolRuntime } from "../agent-tool-runtime";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";

const WALLET = "0x2222222222222222222222222222222222222222";
// Official AAPLc B20 contract (docs.base.org allowlist).
const AAPLC = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const NVDA_PAIR = { symbol: "NVDAc", address: "0xb20000000000000000000078ee7ce2fE4908108C" };

function makeRuntime() {
  const registry = new AgentToolRegistry();
  for (const tool of [
    getTapeTool,
    getPairTool,
    verifyB20ContractTool,
    getStockHoldingsTool,
    getPremiumTool,
    describeX402TapeTool,
    prepareSwapTool,
    tokenizedStockPrepareOrderTool,
    tradePrepareSwapTool,
  ]) {
    registry.register(tool);
  }
  const eventBus: EventBus = { on: () => () => {}, off: () => {}, emit: () => {}, use: () => () => {} };
  const logger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };
  const performanceMonitor: PerformanceMonitor = {
    time: async (_l, fn) => fn(),
    timeSync: (_l, fn) => fn(),
    getMetrics: () => [],
    clear: () => {},
  };
  return new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);
}

function stubJson(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

beforeEach(() => {
  // Default stub: any network call a fail-closed path should NOT make
  // blows up loudly instead of hitting the sandbox-blocked internet.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stocks tools — registration safety envelope", () => {
  it("none of the Base Stocks tools can execute — read/prepare only", () => {
    for (const tool of [
      getTapeTool,
      getPairTool,
      verifyB20ContractTool,
      getStockHoldingsTool,
      getPremiumTool,
      describeX402TapeTool,
      prepareSwapTool,
    ]) {
      expect(tool.mode === "read" || tool.mode === "prepare").toBe(true);
    }
  });

  it("prepare_swap is prepare-mode, medium risk, wallet + confirmation required", () => {
    expect(prepareSwapTool.mode).toBe("prepare");
    expect(prepareSwapTool.riskLevel).toBe("medium");
    expect(prepareSwapTool.requiresWallet).toBe(true);
    expect(prepareSwapTool.requiresConfirmation).toBe(true);
  });

  it("get_stock_holdings requires the session wallet; tape/pair/premium/verify do not", () => {
    expect(getStockHoldingsTool.requiresWallet).toBe(true);
    expect(getTapeTool.requiresWallet).toBe(false);
    expect(getPairTool.requiresWallet).toBe(false);
    expect(getPremiumTool.requiresWallet).toBe(false);
    expect(verifyB20ContractTool.requiresWallet).toBe(false);
    expect(describeX402TapeTool.requiresWallet).toBe(false);
  });
});

describe("get_tape", () => {
  it("returns a compacted snapshot and never hits the network on failure paths unhandled", async () => {
    stubJson(200, {
      asOf: 1700000000,
      chainId: 8453,
      blockNumber: 1234,
      wrapped: [
        { symbol: "cbBTC", usd: 60000, change24h: 1.5, stale: false, source: "dexscreener", address: "0x", decimals: 8, change1h: null, change6h: null, liquidityUsd: null, dexId: null, pairAddress: null },
      ],
      stocks: [
        { symbol: "NVDAc", usdFeed: 180, usdDex: 181, premiumBps: 55, change24h: -0.4, stale: false, feedStale: false, paused: false, address: NVDA_PAIR.address, feedAddress: "0x", feedUpdatedAt: 1, source: "chainlink+dexscreener", liquidityUsd: null, dexId: null, pairAddress: null },
      ],
    });
    const runtime = makeRuntime();
    const result = await runtime.executeTool("get_tape", {}, { confirmationMode: "always_confirm", requestId: "t-tape", walletAddress: WALLET });
    expect(result.success).toBe(true);
    const tape = (result.data as { tape: { stocks: unknown[] } }).tape;
    expect(tape.stocks).toHaveLength(1);
    const called = vi.mocked(fetch).mock.calls[0];
    expect(String(called?.[0])).toBe("/api/market/tape");
  });

  it("surfaces the route error code when the tape endpoint fails", async () => {
    stubJson(503, { error: "Tape sources unavailable", code: "TAPE_UNAVAILABLE" });
    const runtime = makeRuntime();
    const result = await runtime.executeTool("get_tape", {}, { confirmationMode: "always_confirm", requestId: "t-tape-fail" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATA_UNAVAILABLE");
    expect(result.error?.retryable).toBe(true);
  });
});

describe("get_pair", () => {
  it("requires symbol and queries the pair route with it", async () => {
    const runtime = makeRuntime();
    const missing = await runtime.executeTool("get_pair", {}, { confirmationMode: "always_confirm", requestId: "t-pair-0" });
    expect(missing.success).toBe(false);
    expect(missing.error?.code).toBe("INVALID_INPUT");

    stubJson(200, {
      pair: { symbol: "AAPLc", kind: "b20-stock", address: AAPLC, name: "Apple Tokenized Stock", decimals: null },
      stockEntry: { usdFeed: 250, usdDex: 251, premiumBps: 40 },
      wrappedEntry: null,
      asOf: 1700000000,
      blockNumber: 999,
    });
    const ok = await runtime.executeTool("get_pair", { symbol: "AAPLc" }, { confirmationMode: "always_confirm", requestId: "t-pair-1" });
    expect(ok.success).toBe(true);
    const called = vi.mocked(fetch).mock.calls[0];
    expect(String(called?.[0])).toBe("/api/market/pair?symbol=AAPLc");
    expect((ok.data as { pair: { address: string } }).pair.address).toBe(AAPLC);
  });

  it("passes UNKNOWN_SYMBOL through as INVALID_INPUT for off-allowlist tickers", async () => {
    stubJson(404, { error: 'No allowlisted Base pair matches "bNVDA".', code: "UNKNOWN_SYMBOL" });
    const runtime = makeRuntime();
    const result = await runtime.executeTool("get_pair", { symbol: "bNVDA" }, { confirmationMode: "always_confirm", requestId: "t-pair-2" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });
});

describe("verify_b20_contract", () => {
  it("answers official:true from the allowlist for a real B20 address", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool("verify_b20_contract", { address: AAPLC }, { confirmationMode: "always_confirm", requestId: "t-v1" });
    expect(result.success).toBe(true);
    const verification = (result.data as { verification: { official: boolean; symbol?: string } }).verification;
    expect(verification.official).toBe(true);
    expect(verification.symbol).toBe("AAPLc");
  });

  it("answers official:false — never throws — for a look-alike 0xb200 address", async () => {
    const runtime = makeRuntime();
    const fake = `0xb200${"11".repeat(18)}`;
    const result = await runtime.executeTool("verify_b20_contract", { address: fake }, { confirmationMode: "always_confirm", requestId: "t-v2" });
    expect(result.success).toBe(true);
    const verification = (result.data as { verification: { official: boolean } }).verification;
    expect(verification.official).toBe(false);
  });

  it("rejects malformed addresses with INVALID_ADDRESS without any network call", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool("verify_b20_contract", { address: "not-an-address" }, { confirmationMode: "always_confirm", requestId: "t-v3" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_ADDRESS");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });
});

describe("get_stock_holdings", () => {
  it("is refused by the runtime without a connected wallet", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool("get_stock_holdings", {}, { confirmationMode: "always_confirm", requestId: "t-h1" });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("WALLET_NOT_CONNECTED");
  });

  it("maps a 401 from the route to a WALLET_NOT_CONNECTED guidance error", async () => {
    stubJson(401, { error: "Authentication required", code: "AUTH_REQUIRED" });
    const runtime = makeRuntime();
    const result = await runtime.executeTool("get_stock_holdings", {}, { confirmationMode: "always_confirm", requestId: "t-h2", walletAddress: WALLET });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("WALLET_NOT_CONNECTED");
  });

  it("returns holdings + USDC balance on success", async () => {
    stubJson(200, {
      holdings: [{ symbol: "AAPLc", address: AAPLC, raw: "1000000", decimals: 6, human: "1" }],
      usdc: { raw: "10000000", decimals: 6, human: "10" },
      asOf: 1700000000,
      source: "Base RPC balanceOf",
    });
    const runtime = makeRuntime();
    const result = await runtime.executeTool("get_stock_holdings", {}, { confirmationMode: "always_confirm", requestId: "t-h3", walletAddress: WALLET });
    expect(result.success).toBe(true);
    const out = result.data as { holdings: unknown[]; usdc: { human: string } };
    expect(out.holdings).toHaveLength(1);
    expect(out.usdc.human).toBe("10");
  });
});

describe("get_premium", () => {
  it("rejects non-B20 symbols deterministically — no network call", async () => {
    const runtime = makeRuntime();
    for (const symbol of ["cbBTC", "USDC", "bNVDA", ""]) {
      const result = await runtime.executeTool("get_premium", { symbol }, { confirmationMode: "always_confirm", requestId: "t-p" });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_INPUT");
    }
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it("reports premiumBps null as unknown instead of estimating", async () => {
    stubJson(200, {
      pair: { symbol: "NVDAc" },
      stockEntry: { usdFeed: 180, usdDex: null, premiumBps: null, feedStale: false, paused: false },
      asOf: 1700000000,
      blockNumber: 1,
    });
    const runtime = makeRuntime();
    const result = await runtime.executeTool("get_premium", { symbol: "NVDAc" }, { confirmationMode: "always_confirm", requestId: "t-p2" });
    expect(result.success).toBe(true);
    const out = result.data as { premiumBps: number | null; interpretation: string };
    expect(out.premiumBps).toBeNull();
    expect(out.interpretation).toContain("unknown");
  });

  it("returns the signed premium with interpretation when both legs exist", async () => {
    stubJson(200, {
      pair: { symbol: "NVDAc" },
      stockEntry: { usdFeed: 180, usdDex: 180.9, premiumBps: 50, feedStale: false, paused: false },
      asOf: 1700000000,
      blockNumber: 1,
    });
    const runtime = makeRuntime();
    const result = await runtime.executeTool("get_premium", { symbol: "NVDAc" }, { confirmationMode: "always_confirm", requestId: "t-p3" });
    expect(result.success).toBe(true);
    const out = result.data as { premiumBps: number; interpretation: string };
    expect(out.premiumBps).toBe(50);
    expect(out.interpretation).toContain("above");
  });
});

describe("describe_x402_tape", () => {
  it("documents the paid tape endpoint without paying anything", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool("describe_x402_tape", {}, { confirmationMode: "always_confirm", requestId: "t-x1" });
    expect(result.success).toBe(true);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
    const out = result.data as { path: string; payment: { asset: string; priceUsdc: string } };
    expect(out.path).toBe("/api/x402/tape");
    expect(out.payment.asset).toContain("USDC");
    expect(out.payment.priceUsdc).toContain("0.02");
  });
});

describe("prepare_swap", () => {
  it("fails closed on off-allowlist symbols — never invents a contract", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "prepare_swap",
      { sellSymbol: "USDC", buySymbol: "bNVDA", amount: "10" },
      { confirmationMode: "always_confirm", requestId: "t-s1", walletAddress: WALLET },
    );
    expect(result.success).toBe(false);
    // The deterministic router drops off-allowlist tickers, so the
    // target tool's schema validation fails closed with INVALID_INPUT —
    // no quote route is ever reached, no contract is invented.
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });

  it("is refused without a wallet even for allowlisted pairs", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "prepare_swap",
      { sellSymbol: "USDC", buySymbol: "AAPLc", amount: "10" },
      { confirmationMode: "always_confirm", requestId: "t-s2" },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("WALLET_NOT_CONNECTED");
  });

  it("rejects sell === buy and non-positive amounts", async () => {
    const runtime = makeRuntime();
    const same = await runtime.executeTool(
      "prepare_swap",
      { sellSymbol: "USDC", buySymbol: "USDC", amount: "10" },
      { confirmationMode: "always_confirm", requestId: "t-s3", walletAddress: WALLET },
    );
    expect(same.success).toBe(false);
    expect(same.error?.code).toBe("INVALID_INPUT");

    const negative = await runtime.executeTool(
      "prepare_swap",
      { sellSymbol: "USDC", buySymbol: "cbBTC", amount: "-1" },
      { confirmationMode: "always_confirm", requestId: "t-s4", walletAddress: WALLET },
    );
    expect(negative.success).toBe(false);
    expect(negative.error?.code).toBe("INVALID_INPUT");
  });

  it("routes USDC → B20 stock through the deterministic router onto /api/trade/stocks/quote", async () => {
    stubJson(200, {
      proposal: {
        id: "b20_x",
        requiresConfirmation: true,
        network: "base",
        provider: "aerodrome-slipstream",
        kind: "erc20-swap",
      },
      executed: false,
    });
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "prepare_swap",
      { sellSymbol: "USDC", buySymbol: "AAPLc", amount: "10" },
      { confirmationMode: "always_confirm", requestId: "t-s5", walletAddress: WALLET },
    );
    expect(result.success).toBe(true);
    const called = vi.mocked(fetch).mock.calls[0];
    expect(String(called?.[0])).toBe("/api/trade/stocks/quote");
    const body = JSON.parse(String((called?.[1] as RequestInit).body));
    expect(body.symbol).toBe("AAPLc");
    expect(body.side).toBe("BUY");
    expect(body.amount).toBe("10");
    // The session wallet is bound server-side — no taker leaked from the model.
    expect(result.data).toMatchObject({ proposal: { id: "b20_x" } });
  });

  it("routes non-B20 allowlisted swaps (USDC → cbBTC) to the general quote route with resolved addresses", async () => {
    stubJson(200, {
      proposal: { id: "cdp_x", requiresConfirmation: true, network: "base", provider: "0x", kind: "erc20-swap" },
    });
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "prepare_swap",
      { sellSymbol: "USDC", buySymbol: "cbBTC", amount: "25" },
      { confirmationMode: "always_confirm", requestId: "t-s6", walletAddress: WALLET },
    );
    expect(result.success).toBe(true);
    const called = vi.mocked(fetch).mock.calls[0];
    expect(String(called?.[0])).toBe("/api/trade/quote");
    // The runtime's shared hydration turns allowlist addresses into
    // known-token symbols + atomic fromAmount + session taker — the
    // exact contract /api/trade/quote expects (same as trade_prepare_swap).
    const body = JSON.parse(String((called?.[1] as RequestInit).body));
    expect(body.fromToken).toBe("USDC");
    expect(body.toToken).toBe("cbBTC");
    expect(body.fromAmount).toBe("25000000");
    expect(body.taker).toBe(WALLET);
    expect(result.data).toMatchObject({ proposal: { id: "cdp_x" } });
  });

  it("surfaces route failures (e.g. liquidity) as structured tool errors", async () => {
    stubJson(409, { error: "No on-chain liquidity found for that route.", code: "LIQUIDITY_UNAVAILABLE" });
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "prepare_swap",
      { sellSymbol: "USDC", buySymbol: "SNDKc", amount: "10" },
      { confirmationMode: "always_confirm", requestId: "t-s7", walletAddress: WALLET },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("DATA_UNAVAILABLE");
  });
});

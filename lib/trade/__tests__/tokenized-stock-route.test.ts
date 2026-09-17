import { describe, expect, it } from "vitest";

import { COINBASE_B20_TOKENIZED_STOCKS, findTokenizedStock } from "../tokenized-stocks";
import { resolveTokenizedStockPrepareRoute } from "../tokenized-stock-route";

describe("tokenized-stock catalog resolution", () => {
  it("lists the official Coinbase B20 catalog including AAPLc", () => {
    const tickers = COINBASE_B20_TOKENIZED_STOCKS.map((stock) => stock.ticker);
    expect(tickers).toContain("AAPLc");
    expect(COINBASE_B20_TOKENIZED_STOCKS).toHaveLength(13);
  });

  it("resolves AAPL to the exact AAPLc catalog asset", () => {
    const stock = findTokenizedStock("AAPL");
    expect(stock?.ticker).toBe("AAPLc");
    expect(stock?.address).toBe("0xb200000000000000000000C2e324d24d7eEcd1fb");
    expect(findTokenizedStock("AAPLc")?.ticker).toBe("AAPLc");
    expect(findTokenizedStock("0xb200000000000000000000C2e324d24d7eEcd1fb")?.ticker).toBe("AAPLc");
  });

  it("does not invent an unknown ticker", () => {
    expect(findTokenizedStock("FAKESHARE")).toBeNull();
    expect(findTokenizedStock("")).toBeNull();
  });
});

describe("resolveTokenizedStockPrepareRoute", () => {
  it("canonicalizes AAPL on the dedicated prepare tool", () => {
    const routed = resolveTokenizedStockPrepareRoute("tokenized_stock_prepare_order", {
      symbol: "AAPL",
      amount: "50",
      side: "BUY",
    });
    expect(routed.toolId).toBe("tokenized_stock_prepare_order");
    expect(routed.args.symbol).toBe("AAPLc");
    expect(routed.args.amount).toBe("50");
  });

  it("does not send a B20 prepare through generic swap routing", () => {
    const routed = resolveTokenizedStockPrepareRoute("trade_prepare_swap", {
      fromToken: "USDC",
      toToken: "AAPL",
      amount: "50",
    });
    expect(routed.toolId).toBe("tokenized_stock_prepare_order");
    expect(routed.args).toEqual({
      symbol: "AAPLc",
      amount: "50",
      side: "BUY",
    });
  });

  it("routes a B20 sell through the dedicated path", () => {
    const routed = resolveTokenizedStockPrepareRoute("trade_prepare_swap", {
      fromToken: "AAPLc",
      toToken: "USDC",
      amount: "50",
    });
    expect(routed.toolId).toBe("tokenized_stock_prepare_order");
    expect(routed.args.side).toBe("SELL");
    expect(routed.args.symbol).toBe("AAPLc");
  });

  it("leaves a generic ETH/USDC swap on trade_prepare_swap", () => {
    const routed = resolveTokenizedStockPrepareRoute("trade_prepare_swap", {
      fromToken: "ETH",
      toToken: "USDC",
      amount: "0.1",
    });
    expect(routed.toolId).toBe("trade_prepare_swap");
    expect(routed.args.fromToken).toBe("ETH");
  });
});

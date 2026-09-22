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

  describe("prepare_swap alias (Base Stocks Agent)", () => {
    it("maps USDC → AAPLc onto the dedicated B20 prepare tool", () => {
      const routed = resolveTokenizedStockPrepareRoute("prepare_swap", {
        sellSymbol: "USDC",
        buySymbol: "AAPLc",
        amount: "10",
      });
      expect(routed.toolId).toBe("tokenized_stock_prepare_order");
      expect(routed.args).toEqual({ symbol: "AAPLc", amount: "10", side: "BUY" });
    });

    it("maps a B20 sell back to USDC onto the dedicated tool", () => {
      const routed = resolveTokenizedStockPrepareRoute("prepare_swap", {
        sellSymbol: "TSLAc",
        buySymbol: "USDC",
        amount: "2",
      });
      expect(routed.toolId).toBe("tokenized_stock_prepare_order");
      expect(routed.args.side).toBe("SELL");
      expect(routed.args.symbol).toBe("TSLAc");
    });

    it("maps non-B20 allowlisted swaps onto trade_prepare_swap with resolved addresses", () => {
      const routed = resolveTokenizedStockPrepareRoute("prepare_swap", {
        sellSymbol: "USDC",
        buySymbol: "cbBTC",
        amount: "25",
      });
      expect(routed.toolId).toBe("trade_prepare_swap");
      expect(String(routed.args.fromToken).toLowerCase()).toBe(
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      );
      expect(String(routed.args.toToken).toLowerCase()).toBe(
        "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
      );
      expect(routed.args.amount).toBe("25");
      expect(routed.args.sellSymbol).toBeUndefined();
      expect(routed.args.buySymbol).toBeUndefined();
    });

    it("fails closed on off-allowlist tickers by dropping the unresolvable side", () => {
      const routed = resolveTokenizedStockPrepareRoute("prepare_swap", {
        sellSymbol: "USDC",
        buySymbol: "bNVDA",
        amount: "10",
      });
      expect(routed.toolId).toBe("trade_prepare_swap");
      expect(routed.args.toToken).toBeUndefined();
    });

    it("fails closed on same-token swaps and non-positive amounts", () => {
      const same = resolveTokenizedStockPrepareRoute("prepare_swap", {
        sellSymbol: "USDC",
        buySymbol: "USDC",
        amount: "10",
      });
      expect(same.toolId).toBe("trade_prepare_swap");
      expect(same.args.fromToken).toBeUndefined();

      const negative = resolveTokenizedStockPrepareRoute("prepare_swap", {
        sellSymbol: "USDC",
        buySymbol: "cbBTC",
        amount: "-1",
      });
      expect(negative.args.fromToken).toBeUndefined();
    });
  });
});

describe("prepare_swap alias — published-but-not-live B20 assets", () => {
  // COINc/CRCLc/INTCc have Coinbase-published addresses but are not live on
  // Base's official list. Rerouting them onto a quote route would surface a
  // confusing liquidity failure, so they stay on prepare_swap, whose execute
  // refuses with an explicit "not live yet" message and no network call.
  it("keeps a not-live buy on prepare_swap instead of a quote route", () => {
    const routed = resolveTokenizedStockPrepareRoute("prepare_swap", {
      sellSymbol: "USDC",
      buySymbol: "COINc",
      amount: "10",
    });
    expect(routed.toolId).toBe("prepare_swap");
    expect(routed.args).toEqual({ sellSymbol: "USDC", buySymbol: "COINc", amount: "10" });
  });

  it("keeps a not-live sell on prepare_swap", () => {
    const routed = resolveTokenizedStockPrepareRoute("prepare_swap", {
      sellSymbol: "CRCLc",
      buySymbol: "USDC",
      amount: "5",
    });
    expect(routed.toolId).toBe("prepare_swap");
  });

  it("still reroutes the ten live stocks onto the dedicated B20 prepare tool", () => {
    const routed = resolveTokenizedStockPrepareRoute("prepare_swap", {
      sellSymbol: "USDC",
      buySymbol: "MSTRc",
      amount: "25",
    });
    expect(routed.toolId).toBe("tokenized_stock_prepare_order");
    expect(routed.args).toEqual({ symbol: "MSTRc", amount: "25", side: "BUY" });
  });
});

describe("not-yet-live B20 assets can never reach a quote route", () => {
  const COINC_ADDRESS = "0xb200000000000000000000c85a31389D71F3ecfb";

  it("hands a not-live symbol on the dedicated B20 tool to prepare_swap's gate", () => {
    const routed = resolveTokenizedStockPrepareRoute("tokenized_stock_prepare_order", {
      symbol: "COINc",
      amount: "10",
      side: "BUY",
    });
    expect(routed.toolId).toBe("prepare_swap");
    expect(routed.args).toEqual({ sellSymbol: "USDC", buySymbol: "COINc", amount: "10" });
  });

  it("keeps the sell direction when translating a not-live order", () => {
    const routed = resolveTokenizedStockPrepareRoute("tokenized_stock_prepare_order", {
      symbol: "CRCLc",
      amount: "5",
      side: "SELL",
    });
    expect(routed.toolId).toBe("prepare_swap");
    expect(routed.args).toEqual({ sellSymbol: "CRCLc", buySymbol: "USDC", amount: "5" });
  });

  it("catches a raw not-live address passed to the generic swap tool", () => {
    const routed = resolveTokenizedStockPrepareRoute("trade_prepare_swap", {
      fromToken: "USDC",
      toToken: COINC_ADDRESS,
      amount: "25",
    });
    expect(routed.toolId).toBe("prepare_swap");
    expect(routed.args).toEqual({ sellSymbol: "USDC", buySymbol: "COINc", amount: "25" });
  });

  it("leaves every live B20 asset on the dedicated prepare tool", () => {
    for (const symbol of ["AAPLc", "MSTRc", "SNDKc", "SPCXc", "NVDAc"]) {
      const routed = resolveTokenizedStockPrepareRoute("tokenized_stock_prepare_order", {
        symbol,
        amount: "10",
        side: "BUY",
      });
      expect(routed.toolId, symbol).toBe("tokenized_stock_prepare_order");
      expect(routed.args.symbol, symbol).toBe(symbol);
    }
  });
});

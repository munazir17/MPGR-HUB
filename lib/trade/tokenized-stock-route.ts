// lib/trade/tokenized-stock-route.ts
//
// Deterministic router from a generic Base swap prepare onto the
// dedicated Coinbase B20 tokenized-stock prepare path.
//
// Catalog resolution happens here (AAPL → AAPLc, etc.). This never
// invents a ticker, address, price, or venue — unknown inputs stay
// unresolved so the dedicated prepare tool can fail closed.

import { findTokenizedStock } from "./tokenized-stocks";

function humanAmountFromSwapArgs(args: Record<string, unknown>): string {
  if (typeof args.amount === "string" && args.amount.trim()) {
    return args.amount.trim().replace(/^\$/, "");
  }
  return "";
}

export function resolveTokenizedStockPrepareRoute(
  toolId: string,
  args: Record<string, unknown>,
): { toolId: string; args: Record<string, unknown> } {
  if (toolId === "tokenized_stock_prepare_order") {
    const rawSymbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
    if (!rawSymbol) return { toolId, args };
    const catalog = findTokenizedStock(rawSymbol);
    if (!catalog) return { toolId, args };
    if (catalog.ticker === rawSymbol) return { toolId, args };
    return { toolId, args: { ...args, symbol: catalog.ticker } };
  }

  if (toolId !== "trade_prepare_swap") return { toolId, args };

  const fromToken = typeof args.fromToken === "string" ? args.fromToken.trim() : "";
  const toToken = typeof args.toToken === "string" ? args.toToken.trim() : "";
  const fromStock = fromToken ? findTokenizedStock(fromToken) : null;
  const toStock = toToken ? findTokenizedStock(toToken) : null;
  if (!fromStock && !toStock) return { toolId, args };

  const stock = toStock ?? fromStock;
  if (!stock) return { toolId, args };

  const side: "BUY" | "SELL" = fromStock && !toStock ? "SELL" : "BUY";

  return {
    toolId: "tokenized_stock_prepare_order",
    args: {
      symbol: stock.ticker,
      amount: humanAmountFromSwapArgs(args),
      side,
    },
  };
}

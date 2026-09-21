// lib/trade/tokenized-stock-route.ts
//
// Deterministic router from a generic Base swap prepare onto the
// dedicated Coinbase B20 tokenized-stock prepare path.
//
// Catalog resolution happens here (AAPL → AAPLc, etc.). This never
// invents a ticker, address, price, or venue — unknown inputs stay
// unresolved so the dedicated prepare tool can fail closed.

import { findBasePair } from "@/lib/markets/base-pairs";
import { findTokenizedStock } from "./tokenized-stocks";
import { resolveTradeToken } from "./trade-tokens";

function humanAmountFromSwapArgs(args: Record<string, unknown>): string {
  if (typeof args.amount === "string" && args.amount.trim()) {
    return args.amount.trim().replace(/^\$/, "");
  }
  return "";
}

/**
 * prepare_swap is the Base Stocks Agent's generic alias. It is mapped
 * deterministically onto trade_prepare_swap with allowlist-resolved
 * token references before any other routing runs — the B20 branch below
 * then reroutes USDC↔stock legs onto the dedicated Slipstream prepare
 * tool exactly as it already does for trade_prepare_swap.
 */
function normalizePrepareSwapArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sellRaw =
    (typeof args.sellSymbol === "string" && args.sellSymbol.trim()) ||
    (typeof args.sellAddress === "string" && args.sellAddress.trim()) ||
    "";
  const buyRaw =
    (typeof args.buySymbol === "string" && args.buySymbol.trim()) ||
    (typeof args.buyAddress === "string" && args.buyAddress.trim()) ||
    "";

  // Resolve each side against the allowlists (Base pairs first, then the
  // known trade token catalog: ETH/WETH/USDC/MPGR/B20). Anything that
  // resolves to neither a known token nor a raw 0x address is DROPPED —
  // the target tool's required-field validation then fails closed with
  // INVALID_INPUT instead of an unknown ticker reaching a quote route.
  const resolveSide = (raw: string): string | undefined => {
    if (!raw) return undefined;
    const pair = findBasePair(raw);
    if (pair) return pair.address;
    if (resolveTradeToken(raw).ok) return raw;
    return undefined;
  };

  const fromToken = resolveSide(sellRaw) ?? (typeof args.fromToken === "string" ? args.fromToken : undefined);
  const toToken = resolveSide(buyRaw) ?? (typeof args.toToken === "string" ? args.toToken : undefined);

  // Same-token swaps are rejected deterministically (no provider call).
  if (
    typeof fromToken === "string" &&
    typeof toToken === "string" &&
    fromToken.trim() &&
    resolveTradeToken(fromToken).ok &&
    resolveTradeToken(toToken).ok
  ) {
    const fromResolved = resolveTradeToken(fromToken);
    const toResolved = resolveTradeToken(toToken);
    if (
      fromResolved.ok &&
      toResolved.ok &&
      fromResolved.token.address.toLowerCase() === toResolved.token.address.toLowerCase()
    ) {
      return { toolId: "trade_prepare_swap", args: {} };
    }
  }

  // Negative/zero/garbage amounts fail closed before any provider call.
  const amountRaw = typeof args.amount === "string" ? args.amount.trim() : "";
  if (!amountRaw || !/^\d+(\.\d+)?$/.test(amountRaw) || Number(amountRaw) <= 0) {
    return { toolId: "trade_prepare_swap", args: {} };
  }

  const next: Record<string, unknown> = { ...args };
  if (fromToken) next.fromToken = fromToken;
  if (toToken) next.toToken = toToken;
  next.amount = amountRaw;
  delete next.sellSymbol;
  delete next.sellAddress;
  delete next.buySymbol;
  delete next.buyAddress;
  return next;
}

export function resolveTokenizedStockPrepareRoute(
  toolId: string,
  args: Record<string, unknown>,
): { toolId: string; args: Record<string, unknown> } {
  if (toolId === "prepare_swap") {
    // Continue through the trade_prepare_swap routing below with
    // normalized arguments (B20 legs land on the dedicated tool).
    return resolveTokenizedStockPrepareRoute(
      "trade_prepare_swap",
      normalizePrepareSwapArgs(args),
    );
  }

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

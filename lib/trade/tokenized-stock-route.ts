// lib/trade/tokenized-stock-route.ts
//
// Deterministic router from a generic Base swap prepare onto the
// dedicated Coinbase B20 tokenized-stock prepare path.
//
// Catalog resolution happens here (AAPL → AAPLc, etc.). This never
// invents a ticker, address, price, or venue — unknown inputs stay
// unresolved so the dedicated prepare tool can fail closed.

import { findBasePair, isNotYetLiveB20 } from "@/lib/markets/base-pairs";
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

  // Keep literal unknown names/addresses for authoritative discovery and RPC
  // validation at the quote API. Never drop or replace them with display labels.
  const resolveSide = (raw: string): string | undefined => {
    if (!raw) return undefined;
    const pair = findBasePair(raw);
    if (pair) return pair.address;
    return raw;
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

/**
 * True when any leg of the arguments names a Coinbase-published B20 address
 * that Base's official list marks as NOT LIVE yet (COINc, CRCLc, INTCc —
 * removed from the live list by base/docs#1955, 2026-09-11: no issued supply
 * and no Chainlink feed). Accepts symbols, underlying tickers and raw
 * addresses, because a leg may arrive as any of the three.
 */
function namesNotYetLiveB20(args: Record<string, unknown>): boolean {
  return ["sellSymbol", "sellAddress", "buySymbol", "buyAddress", "symbol", "fromToken", "toToken"].some(
    (key) => {
      const raw = args[key];
      if (typeof raw !== "string" || !raw.trim()) return false;
      const pair = findBasePair(raw);
      return pair !== null && pair.kind === "b20-stock" && !pair.live;
    },
  );
}

/**
 * prepare_swap-shaped arguments for a not-yet-live B20 leg, so the refusal
 * comes from prepare_swap's own allowlist gate (an explicit "not live yet"
 * error, no network call) instead of a confusing liquidity failure from a
 * quote route — or a generic schema-validation error.
 */
function notLivePrepareSwapArgs(
  ticker: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const side = String(args.side ?? "BUY").trim().toUpperCase();
  const amount =
    typeof args.amount === "string" || typeof args.amount === "number"
      ? String(args.amount)
      : (args.amount ?? "");
  return side === "SELL"
    ? { sellSymbol: ticker, buySymbol: "USDC", amount }
    : { sellSymbol: "USDC", buySymbol: ticker, amount };
}

export function resolveTokenizedStockPrepareRoute(
  toolId: string,
  args: Record<string, unknown>,
): { toolId: string; args: Record<string, unknown> } {
  if (toolId === "prepare_swap") {
    // Never reroute a not-yet-live B20 leg onto a quote route: keep it on
    // prepare_swap, which refuses it deterministically with a real
    // explanation and makes no network call.
    if (namesNotYetLiveB20(args)) return { toolId, args };
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
    // The pre-existing B20 prepare tool must not quote an asset Base's
    // official list does not carry as live — hand it to prepare_swap's
    // allowlist gate so the user gets "not live yet", not a liquidity error.
    if (isNotYetLiveB20(catalog.ticker)) {
      return { toolId: "prepare_swap", args: notLivePrepareSwapArgs(catalog.ticker, args) };
    }
    if (catalog.ticker === rawSymbol) return { toolId, args };
    return { toolId, args: { ...args, symbol: catalog.ticker } };
  }

  // trade_prepare_swap with a not-yet-live B20 leg (e.g. the model called it
  // directly with a raw COINc address) also fails closed on prepare_swap.
  if (toolId === "trade_prepare_swap" && namesNotYetLiveB20(args)) {
    const normalized = normalizePrepareSwapArgs(args);
    const notLive = ["fromToken", "toToken"]
      .map((key) => (typeof normalized[key] === "string" ? (normalized[key] as string) : ""))
      .map((value) => findBasePair(value))
      .find((pair) => pair !== null && pair.kind === "b20-stock" && !pair.live);
    if (notLive) {
      const side =
        typeof normalized.fromToken === "string" &&
        findBasePair(normalized.fromToken)?.symbol === notLive.symbol
          ? "SELL"
          : "BUY";
      return { toolId: "prepare_swap", args: notLivePrepareSwapArgs(notLive.symbol, { ...args, side }) };
    }
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

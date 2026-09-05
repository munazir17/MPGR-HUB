import "server-only";

// lib/trade/tokenized-stock-order.ts
//
// Bridges the existing B20 tokenized-stock catalog (tokenized-stocks.ts)
// to Coinbase Advanced Trade orders. This is the piece that makes
// "buy $10 of AAPLc" actually executable, using the equities product
// Coinbase's own docs describe:
//   https://docs.cdp.coinbase.com/coinbase-for-agents/overview
//   "Equities: trade S&P 500 US stocks on Coinbase Advanced Trade"
//   using product IDs like AAPL-USD or AAPL-USDC.
//
// IMPORTANT: this does NOT touch crypto routing. A B20 ticker match
// is required before anything here runs — see classifyTradeAsset in
// trade-asset-router.ts. Assets that are not in the B20 catalog never
// reach this file.
//
// IMPORTANT: not every B20 ticker is guaranteed to have a live
// Advanced Trade product. Some Coinbase tokenized stocks track
// companies that are not (or not yet) listed/tradeable that way — the
// live GET /products/{id} lookup is the source of truth, not a
// hardcoded assumption. If it 404s, this is reported clearly rather
// than guessed at.

import { findTokenizedStock } from "./tokenized-stocks";
import {
  getAdvancedTradeProduct,
  previewAdvancedTradeOrder,
  createAdvancedTradeOrder,
  type AdvancedTradeOrderPreview,
  type AdvancedTradeOrderResult,
} from "./advanced-trade-client";
import { ADVANCED_TRADE_QUOTE_CURRENCY } from "./advanced-trade-config";
import type { TokenizedStockCatalogEntry, TradeError } from "./trade-types";

export function advancedTradeProductIdFor(catalog: TokenizedStockCatalogEntry): string {
  return `${catalog.underlyingTicker}-${ADVANCED_TRADE_QUOTE_CURRENCY}`;
}

export interface TokenizedStockOrderContext {
  catalog: TokenizedStockCatalogEntry;
  productId: string;
}

export type TokenizedStockOrderContextResult =
  | { ok: true; value: TokenizedStockOrderContext }
  | { ok: false; error: TradeError };

/**
 * Resolves a B20 ticker/symbol to its Advanced Trade product and
 * confirms — live, not assumed — that the product exists and is
 * tradeable right now.
 */
export async function resolveTokenizedStockProduct(
  symbolOrAddress: string,
): Promise<TokenizedStockOrderContextResult> {
  const catalog = findTokenizedStock(symbolOrAddress);
  if (!catalog) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_ASSET",
        message: `"${symbolOrAddress}" is not in the official Coinbase B20 tokenized-stock catalog.`,
      },
    };
  }

  const productId = advancedTradeProductIdFor(catalog);
  const product = await getAdvancedTradeProduct(productId);
  if (!product.ok) {
    return {
      ok: false,
      error: {
        code: product.error.code,
        message:
          product.error.code === "UNSUPPORTED_ASSET"
            ? `${catalog.ticker} (${productId}) is not currently listed on Coinbase Advanced Trade. This B20 token cannot be traded through this path right now.`
            : product.error.message,
      },
    };
  }
  if (product.value.tradingDisabled || product.value.status !== "online") {
    return {
      ok: false,
      error: {
        code: "LIQUIDITY_UNAVAILABLE",
        message: `${productId} exists on Coinbase Advanced Trade but is not currently open for trading (status: ${product.value.status}).`,
      },
    };
  }

  return { ok: true, value: { catalog, productId } };
}

export interface TokenizedStockOrderPreviewResult {
  catalog: TokenizedStockCatalogEntry;
  productId: string;
  side: "BUY" | "SELL";
  quoteAmount: string;
  preview: AdvancedTradeOrderPreview;
}

export type TokenizedStockOrderPreviewOutcome =
  | { ok: true; value: TokenizedStockOrderPreviewResult }
  | { ok: false; error: TradeError };

/**
 * Dry-run only — calls Advanced Trade's /orders/preview. Never
 * creates a real order. This is the "prepare" step, same boundary as
 * trade_prepare_swap for crypto.
 */
export async function previewTokenizedStockOrder(
  symbolOrAddress: string,
  side: "BUY" | "SELL",
  quoteAmountHuman: string,
): Promise<TokenizedStockOrderPreviewOutcome> {
  const resolved = await resolveTokenizedStockProduct(symbolOrAddress);
  if (!resolved.ok) return resolved;

  const amount = Number(quoteAmountHuman);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: `"${quoteAmountHuman}" is not a valid USDC amount.` },
    };
  }

  const preview = await previewAdvancedTradeOrder({
    productId: resolved.value.productId,
    side,
    quoteSize: quoteAmountHuman,
  });
  if (!preview.ok) return preview;

  return {
    ok: true,
    value: {
      catalog: resolved.value.catalog,
      productId: resolved.value.productId,
      side,
      quoteAmount: quoteAmountHuman,
      preview: preview.value,
    },
  };
}

export interface TokenizedStockOrderExecuteResult {
  catalog: TokenizedStockCatalogEntry;
  productId: string;
  side: "BUY" | "SELL";
  order: AdvancedTradeOrderResult;
}

export type TokenizedStockOrderExecuteOutcome =
  | { ok: true; value: TokenizedStockOrderExecuteResult }
  | { ok: false; error: TradeError };

/**
 * REAL execution — creates a live Advanced Trade order. This moves
 * real funds and must only be called from a route that sits behind
 * the same explicit user-confirmation boundary as crypto swap
 * execution (never directly from an agent tool).
 */
export async function executeTokenizedStockOrder(
  symbolOrAddress: string,
  side: "BUY" | "SELL",
  quoteAmountHuman: string,
  clientOrderId: string,
): Promise<TokenizedStockOrderExecuteOutcome> {
  const resolved = await resolveTokenizedStockProduct(symbolOrAddress);
  if (!resolved.ok) return resolved;

  const order = await createAdvancedTradeOrder({
    productId: resolved.value.productId,
    side,
    quoteSize: quoteAmountHuman,
    clientOrderId,
  });
  if (!order.ok) return order;

  return {
    ok: true,
    value: {
      catalog: resolved.value.catalog,
      productId: resolved.value.productId,
      side,
      order: order.value,
    },
  };
}

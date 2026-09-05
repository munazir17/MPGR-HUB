import "server-only";

// lib/trade/advanced-trade-client.ts
//
// Coinbase Advanced Trade REST client — used ONLY for Coinbase B20
// tokenized-stock equities (AAPLc, TSLAc, etc.), mapped to their
// underlying Advanced Trade product (AAPL-USD, TSLA-USD, ...).
//
// This is a SEPARATE product from CDP EVM Swaps (trade-cdp-client.ts,
// used for crypto). Nothing here touches that file or its behavior.
//
// Auth: reuses generateCdpJwt from trade-jwt.ts unchanged — same
// CDP_API_KEY_ID / CDP_API_KEY_SECRET env vars, same JWT scheme, just
// a different host + path in the signed `uri` claim. No new
// credentials required.
//
// Docs: https://docs.cdp.coinbase.com/coinbase-for-agents/overview

import { generateCdpJwt } from "./trade-jwt";
import {
  ADVANCED_TRADE_API_HOST,
  ADVANCED_TRADE_ORDERS_PATH,
  ADVANCED_TRADE_ORDERS_PREVIEW_PATH,
  ADVANCED_TRADE_REQUEST_TIMEOUT_MS,
  advancedTradeProductPath,
  advancedTradeUrl,
} from "./advanced-trade-config";
import type { TradeError } from "./trade-types";

function readCdpApiCredentials(): { apiKeyId: string; apiKeySecret: string } | null {
  const apiKeyId = process.env.CDP_API_KEY_ID?.trim();
  const apiKeySecret = process.env.CDP_API_KEY_SECRET?.trim();
  if (!apiKeyId || !apiKeySecret) return null;
  return { apiKeyId, apiKeySecret };
}

export function hasAdvancedTradeCredentials(): boolean {
  return readCdpApiCredentials() !== null;
}

function credentialsMissing(): TradeError {
  return {
    code: "CREDENTIALS_MISSING",
    message: "Coinbase CDP API credentials are not configured for Advanced Trade.",
  };
}

export type AdvancedTradeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TradeError };

async function advancedTradeFetch(
  method: "GET" | "POST",
  requestPath: string,
  jsonBody?: unknown,
): Promise<{ status: number; body: unknown }> {
  const creds = readCdpApiCredentials();
  if (!creds) {
    throw Object.assign(new Error("missing credentials"), {
      tradeError: credentialsMissing(),
    });
  }

  const jwt = generateCdpJwt({
    apiKeyId: creds.apiKeyId,
    apiKeySecret: creds.apiKeySecret,
    requestMethod: method,
    requestHost: ADVANCED_TRADE_API_HOST,
    requestPath,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADVANCED_TRADE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(advancedTradeUrl(requestPath), {
      method,
      headers: {
        Authorization: "Bearer " + jwt,
        Accept: "application/json",
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeAdvancedTradeError(status: number, body: unknown): TradeError {
  if (isPlainObject(body)) {
    const msg = asString(body.message) ?? asString(body.error) ?? asString(body.error_details);
    if (msg && msg.length < 220) {
      return { code: "PROVIDER_ERROR", message: msg };
    }
  }
  if (status === 401 || status === 403) {
    return {
      code: "CREDENTIALS_MISSING",
      message: "Coinbase rejected the Advanced Trade API credentials (401/403).",
    };
  }
  if (status === 404) {
    return {
      code: "UNSUPPORTED_ASSET",
      message: "This product is not listed on Coinbase Advanced Trade.",
    };
  }
  return {
    code: "PROVIDER_ERROR",
    message: `Coinbase Advanced Trade returned HTTP ${status} with no usable error detail.`,
  };
}

// --- GET /products/{product_id} — used to confirm a ticker is live ---

export interface AdvancedTradeProduct {
  productId: string;
  price: string;
  quoteCurrencyId: string;
  baseCurrencyId: string;
  tradingDisabled: boolean;
  status: string;
}

function parseProduct(body: unknown): AdvancedTradeProduct | null {
  if (!isPlainObject(body)) return null;
  const productId = asString(body.product_id);
  const price = asString(body.price);
  if (!productId || !price) return null;
  return {
    productId,
    price,
    quoteCurrencyId: asString(body.quote_currency_id) ?? "",
    baseCurrencyId: asString(body.base_currency_id) ?? "",
    tradingDisabled: body.trading_disabled === true,
    status: asString(body.status) ?? "unknown",
  };
}

export async function getAdvancedTradeProduct(
  productId: string,
): Promise<AdvancedTradeResult<AdvancedTradeProduct>> {
  if (!hasAdvancedTradeCredentials()) {
    return { ok: false, error: credentialsMissing() };
  }
  try {
    const path = advancedTradeProductPath(productId);
    const { status, body } = await advancedTradeFetch("GET", path);
    if (status < 200 || status >= 300) {
      return { ok: false, error: sanitizeAdvancedTradeError(status, body) };
    }
    const product = parseProduct(body);
    if (!product) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "Advanced Trade returned a product payload this app could not use.",
        },
      };
    }
    return { ok: true, value: product };
  } catch (err) {
    const tradeError = (err as { tradeError?: TradeError }).tradeError;
    if (tradeError) return { ok: false, error: tradeError };
    return {
      ok: false,
      error: { code: "PROVIDER_ERROR", message: "Could not reach Coinbase Advanced Trade." },
    };
  }
}

// --- POST /orders/preview — dry run, never creates a real order ---

export interface AdvancedTradeOrderPreview {
  orderTotal: string;
  commissionTotal: string;
  quoteSize: string | null;
  baseSize: string | null;
  averageFilledPrice: string | null;
  slippage: string | null;
  warning: string | null;
}

function parsePreview(body: unknown): AdvancedTradeOrderPreview | null {
  if (!isPlainObject(body)) return null;
  const orderTotal = asString(body.order_total);
  const commissionTotal = asString(body.commission_total);
  if (!orderTotal || !commissionTotal) return null;
  return {
    orderTotal,
    commissionTotal,
    quoteSize: asString(body.quote_size) ?? null,
    baseSize: asString(body.base_size) ?? null,
    averageFilledPrice: asString(body.average_filled_price) ?? null,
    slippage: asString(body.slippage) ?? null,
    warning: asString(body.warning) ?? null,
  };
}

export interface AdvancedTradeMarketOrderRequest {
  productId: string;
  side: "BUY" | "SELL";
  /** Human quote-currency amount, e.g. "10" for $10. */
  quoteSize: string;
}

export async function previewAdvancedTradeOrder(
  request: AdvancedTradeMarketOrderRequest,
): Promise<AdvancedTradeResult<AdvancedTradeOrderPreview>> {
  if (!hasAdvancedTradeCredentials()) {
    return { ok: false, error: credentialsMissing() };
  }
  try {
    const { status, body } = await advancedTradeFetch("POST", ADVANCED_TRADE_ORDERS_PREVIEW_PATH, {
      product_id: request.productId,
      side: request.side,
      order_configuration: {
        market_market_ioc: { quote_size: request.quoteSize },
      },
    });
    if (status < 200 || status >= 300) {
      return { ok: false, error: sanitizeAdvancedTradeError(status, body) };
    }
    const preview = parsePreview(body);
    if (!preview) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "Advanced Trade returned a preview payload this app could not use.",
        },
      };
    }
    return { ok: true, value: preview };
  } catch (err) {
    const tradeError = (err as { tradeError?: TradeError }).tradeError;
    if (tradeError) return { ok: false, error: tradeError };
    return {
      ok: false,
      error: { code: "PROVIDER_ERROR", message: "Could not reach Coinbase Advanced Trade." },
    };
  }
}

// --- POST /orders — REAL order creation. Only call this behind the ---
// --- same explicit-confirmation boundary trade_prepare_swap uses.   ---

export interface AdvancedTradeOrderResult {
  orderId: string;
  success: boolean;
  failureReason: string | null;
}

function parseOrderResult(body: unknown): AdvancedTradeOrderResult | null {
  if (!isPlainObject(body)) return null;
  const success = body.success === true;
  const orderId =
    asString(body.order_id) ??
    (isPlainObject(body.success_response) ? asString(body.success_response.order_id) : undefined);
  if (!orderId && success) return null;
  const failureReason = isPlainObject(body.error_response)
    ? asString(body.error_response.message) ?? asString(body.error_response.error) ?? null
    : null;
  return { orderId: orderId ?? "", success, failureReason };
}

/**
 * Creates a REAL Advanced Trade market order. This moves real funds.
 * Callers MUST have already shown the user a preview (above) and
 * gotten explicit confirmation — same boundary as trade_prepare_swap
 * → hooks/useTradeConfirmation for crypto. Do not call this from an
 * agent tool directly.
 */
export async function createAdvancedTradeOrder(
  request: AdvancedTradeMarketOrderRequest & { clientOrderId: string },
): Promise<AdvancedTradeResult<AdvancedTradeOrderResult>> {
  if (!hasAdvancedTradeCredentials()) {
    return { ok: false, error: credentialsMissing() };
  }
  try {
    const { status, body } = await advancedTradeFetch("POST", ADVANCED_TRADE_ORDERS_PATH, {
      client_order_id: request.clientOrderId,
      product_id: request.productId,
      side: request.side,
      order_configuration: {
        market_market_ioc: { quote_size: request.quoteSize },
      },
    });
    if (status < 200 || status >= 300) {
      return { ok: false, error: sanitizeAdvancedTradeError(status, body) };
    }
    const result = parseOrderResult(body);
    if (!result) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "Advanced Trade returned an order payload this app could not use.",
        },
      };
    }
    if (!result.success) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: result.failureReason ?? "Coinbase rejected the order.",
        },
      };
    }
    return { ok: true, value: result };
  } catch (err) {
    const tradeError = (err as { tradeError?: TradeError }).tradeError;
    if (tradeError) return { ok: false, error: tradeError };
    return {
      ok: false,
      error: { code: "PROVIDER_ERROR", message: "Could not reach Coinbase Advanced Trade." },
    };
  }
}

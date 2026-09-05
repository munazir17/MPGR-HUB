import "server-only";

// lib/trade/advanced-trade-config.ts
//
// Coinbase Advanced Trade (the "Coinbase for Agents" equities product)
// config. Separate from trade-config.ts (CDP EVM Swaps for crypto),
// which is completely untouched by this feature.
//
// Docs: https://docs.cdp.coinbase.com/coinbase-for-agents/overview
//   "Equities: trade S&P 500 US stocks on Coinbase Advanced Trade"
//   using product IDs like AAPL-USD or AAPL-USDC.
//
// Auth: SAME CDP Secret API Key JWT as the rest of this app
// (CDP_API_KEY_ID + CDP_API_KEY_SECRET, see trade-jwt.ts). Coinbase
// unified CDP auth covers both the EVM Swaps product and Advanced
// Trade under the same key — no new credentials or env vars needed.

export const ADVANCED_TRADE_API_HOST = "api.coinbase.com";

export const ADVANCED_TRADE_ORDERS_PATH = "/api/v3/brokerage/orders";
export const ADVANCED_TRADE_ORDERS_PREVIEW_PATH =
  "/api/v3/brokerage/orders/preview";

export function advancedTradeProductPath(productId: string): string {
  return `/api/v3/brokerage/products/${encodeURIComponent(productId)}`;
}

export function advancedTradeUrl(path: string): string {
  return `https://${ADVANCED_TRADE_API_HOST}${path}`;
}

/** Advanced Trade order timeout — this is a plain REST call, no chain wait. */
export const ADVANCED_TRADE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Which quote currency to trade tokenized-stock products against.
 * Advanced Trade lists both `<TICKER>-USD` and `<TICKER>-USDC` for
 * most equities; USDC keeps this consistent with the rest of the app
 * (which is USDC-denominated throughout).
 */
export const ADVANCED_TRADE_QUOTE_CURRENCY = "USDC" as const;

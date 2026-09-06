import "server-only";

// lib/trade/trade-swap-router.ts
//
// Single entry for Base swap price/quote used by API routes and agent tools.
//
// Order:
//   1. Coinbase CDP Trade API (existing crypto path — unchanged client)
//   2. If CDP rejects the token (allowlist) or reports no liquidity,
//      0x Swap API v2 on Base (AllowanceHolder)
//
// Coinbase for Agents / Advanced Trade is NOT used here. That product
// places custodial S&P 500 orders in a Coinbase brokerage account and
// does not deliver B20 tokens to the user's Base wallet.

import { createCdpSwapQuote, getCdpSwapPrice } from "./trade-cdp-client";
import { createZeroExSwapQuote, getZeroExSwapPrice, hasZeroExApiKey } from "./trade-0x-client";
import type { CdpSwapPrice, CdpSwapQuote, TradeError, TradeProvider } from "./trade-types";

export interface RoutedSwapRequest {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  taker: string;
  slippageBps?: number;
}

export type RoutedSwapResult<T> =
  | { ok: true; value: T; provider: TradeProvider }
  | { ok: false; error: TradeError };

function isAllowlistRejection(error: TradeError): boolean {
  const text = error.message.toLowerCase();
  return (
    text.includes("isn't authorized") ||
    text.includes("is not authorized") ||
    text.includes("not authorized for this swap") ||
    text.includes("buy_token_not_authorized") ||
    text.includes("sell_token_not_authorized") ||
    text.includes("authorized for this swap")
  );
}

function shouldFallbackToZeroEx(result: { ok: true; value: CdpSwapPrice } | { ok: false; error: TradeError }): boolean {
  if (!hasZeroExApiKey()) return false;
  if (!result.ok) {
    if (result.error.code === "CREDENTIALS_MISSING") return false;
    return (
      result.error.code === "PROVIDER_ERROR" ||
      result.error.code === "LIQUIDITY_UNAVAILABLE" ||
      isAllowlistRejection(result.error)
    );
  }
  return result.value.liquidityAvailable !== true;
}

export async function getRoutedSwapPrice(
  request: RoutedSwapRequest,
): Promise<RoutedSwapResult<CdpSwapPrice>> {
  const cdp = await getCdpSwapPrice(request);
  if (cdp.ok && cdp.value.liquidityAvailable) {
    return { ok: true, value: cdp.value, provider: "cdp-trade-api" };
  }
  if (!shouldFallbackToZeroEx(cdp)) {
    if (cdp.ok) return { ok: true, value: cdp.value, provider: "cdp-trade-api" };
    return cdp;
  }

  const zx = await getZeroExSwapPrice(request);
  if (zx.ok && zx.value.liquidityAvailable) {
    return { ok: true, value: zx.value, provider: "0x-swap-api" };
  }
  if (cdp.ok) return { ok: true, value: cdp.value, provider: "cdp-trade-api" };
  if (zx.ok) return { ok: true, value: zx.value, provider: "0x-swap-api" };
  if (isAllowlistRejection(cdp.error) && zx.ok === false) {
    return {
      ok: false,
      error: {
        code: "LIQUIDITY_UNAVAILABLE",
        message:
          "Coinbase CDP will not authorize this token for a swap, and 0x also could not quote it on Base. Research only — nothing will be signed.",
      },
    };
  }
  return cdp;
}

export async function createRoutedSwapQuote(
  request: RoutedSwapRequest,
): Promise<RoutedSwapResult<CdpSwapQuote>> {
  const cdp = await createCdpSwapQuote(request);
  if (cdp.ok && cdp.value.liquidityAvailable && cdp.value.transaction) {
    return { ok: true, value: cdp.value, provider: "cdp-trade-api" };
  }
  if (!shouldFallbackToZeroEx(cdp)) {
    if (cdp.ok) return { ok: true, value: cdp.value, provider: "cdp-trade-api" };
    return cdp;
  }

  const zx = await createZeroExSwapQuote(request);
  if (zx.ok && zx.value.liquidityAvailable && zx.value.transaction) {
    return { ok: true, value: zx.value, provider: "0x-swap-api" };
  }
  if (cdp.ok && cdp.value.liquidityAvailable) {
    return { ok: true, value: cdp.value, provider: "cdp-trade-api" };
  }
  if (zx.ok) return { ok: true, value: zx.value, provider: "0x-swap-api" };
  if (!cdp.ok && isAllowlistRejection(cdp.error)) {
    return {
      ok: false,
      error: {
        code: zx.ok === false ? zx.error.code : "LIQUIDITY_UNAVAILABLE",
        message:
          zx.ok === false
            ? `Coinbase CDP rejected this token. 0x fallback: ${zx.error.message}`
            : "No executable Base DEX route is available for this pair.",
      },
    };
  }
  return cdp.ok ? { ok: true, value: cdp.value, provider: "cdp-trade-api" } : cdp;
}

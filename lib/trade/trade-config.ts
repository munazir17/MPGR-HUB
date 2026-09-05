// lib/trade/trade-config.ts
//
// P4 — compile-time-constant trade configuration.
//
// Official provider: Coinbase Developer Platform Trade API (EVM Swaps)
// on Base Mainnet only.
//
// Documented endpoints (do not invent others):
//   GET  https://api.cdp.coinbase.com/platform/v2/evm/swaps/quote  (getSwapPrice)
//   POST https://api.cdp.coinbase.com/platform/v2/evm/swaps        (createSwapQuote)
//
// Auth: CDP Secret API Key JWT (CDP_API_KEY_ID + CDP_API_KEY_SECRET).
// WALLET_SECRET is NOT required — this app uses the user's connected
// wallet (BYO / viem) to sign, matching AgentKit's prepare-only policy.
//
// This file does NOT:
//   - fetch anything
//   - sign anything
//   - invent token addresses, quotes, or routes
//   - enable Coinbase Advanced Trade (custodial equities / MCP)

import { base } from "wagmi/chains";
import { TOOL_CHAIN_ID } from "@/lib/architecture/tools/tool-helpers";

/** CDP Trade API network enum for Base Mainnet. */
export const TRADE_NETWORK = "base" as const;
export type TradeNetwork = typeof TRADE_NETWORK;

export const TRADE_CHAIN_ID = TOOL_CHAIN_ID;
export const TRADE_VIEM_CHAIN = base;

/**
 * Canonical Permit2 contract. Same address on Ethereum and Base.
 * CDP Swap quotes spend via Permit2; ERC-20 fromToken must approve it.
 * Documented in CDP Trade API / wallets swaps guide.
 */
export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/**
 * CDP/0x sentinel for native ETH (not WETH). Used as fromToken/toToken
 * when the user is swapping the gas token itself.
 */
export const NATIVE_ETH_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

/** Wrapped ETH on Base Mainnet. */
export const BASE_WETH =
  "0x4200000000000000000000000000000000000006" as const;

/** Native USDC on Base Mainnet (same address P3 x402 already uses). */
export const BASE_USDC =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export const CDP_TRADE_API_HOST = "api.cdp.coinbase.com";
/**
 * Official CDP OpenAPI (from @coinbase/cdp-sdk):
 *   GET  /v2/evm/swaps/quote  → getSwapPrice
 *   POST /v2/evm/swaps        → createSwapQuote
 * Hosted at https://api.cdp.coinbase.com/platform
 *
 * GET /platform/v2/evm/swaps is NOT allowed (HTTP 405). Price lives at
 * /swaps/quote.
 */
export const CDP_TRADE_PRICE_PATH = "/platform/v2/evm/swaps/quote";
export const CDP_TRADE_QUOTE_PATH = "/platform/v2/evm/swaps";
export const CDP_TRADE_PRICE_URL: string =
  "https://" + CDP_TRADE_API_HOST + CDP_TRADE_PRICE_PATH;
export const CDP_TRADE_QUOTE_URL: string =
  "https://" + CDP_TRADE_API_HOST + CDP_TRADE_QUOTE_PATH;
/** @deprecated use CDP_TRADE_QUOTE_PATH — kept as the POST quote path. */
export const CDP_TRADE_API_BASE_PATH = CDP_TRADE_QUOTE_PATH;
export const CDP_TRADE_API_URL = CDP_TRADE_QUOTE_URL;

export const CDP_TRADE_PROVIDER_ID = "cdp-trade-api" as const;
export const CDP_TRADE_PROVIDER_LABEL = "Coinbase CDP Trade API";

/** Default slippage: 100 bps = 1%, matching CDP docs examples. */
export const TRADE_DEFAULT_SLIPPAGE_BPS = 100;
/** Hard cap we will send to CDP (API allows 0–10000). Above this is rejected here. */
export const TRADE_MAX_SLIPPAGE_BPS = 500;
export const TRADE_MIN_SLIPPAGE_BPS = 1;

/** Quotes go stale quickly; confirm/execute re-quotes past this age. */
export const TRADE_QUOTE_MAX_AGE_MS = 30_000;

export const TRADE_PRICE_TIMEOUT_MS = 12_000;
export const TRADE_QUOTE_TIMEOUT_MS = 15_000;

export function isNativeEthSentinel(address: string): boolean {
  return address.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase();
}

export function clampSlippageBps(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < TRADE_MIN_SLIPPAGE_BPS || value > TRADE_MAX_SLIPPAGE_BPS) {
    return null;
  }
  return value;
}

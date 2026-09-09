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

/**
 * Aerodrome Slipstream (Gauges V3) contracts used by Coinbase B20
 * USDC pools on Base. These are NOT the legacy factory
 * `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A` that the public
 * Aerodrome docs Quoter is bound to — that quoter reverts on B20 pools.
 *
 * Verified on-chain:
 *   SwapRouter.factory() === CLFactory
 *   CLFactory.getPool(USDC, AAPLc, 10) is a live pool
 *   QuoterV2.quoteExactInputSingle(struct) returns a USDC→AAPLc quote
 */
export const AERODROME_SLIPSTREAM_FACTORY =
  "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef" as const;
export const AERODROME_SLIPSTREAM_SWAP_ROUTER =
  "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F" as const;
export const AERODROME_SLIPSTREAM_QUOTER_V2 =
  "0x514c8B5f54112481E28028F1166Bd78501089259" as const;
/** B20/USDC Slipstream pools are tickSpacing 10 (0.05% fee). */
export const AERODROME_B20_TICK_SPACING = 10;

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
export const ZERO_EX_PROVIDER_ID = "0x-swap-api" as const;
export const ZERO_EX_PROVIDER_LABEL = "0x Swap API (Base)";
export const AERODROME_SLIPSTREAM_PROVIDER_ID = "aerodrome-slipstream" as const;
export const AERODROME_SLIPSTREAM_PROVIDER_LABEL = "Aerodrome Slipstream (Base)";
export const ZERO_EX_API_HOST = "api.0x.org";
export const ZERO_EX_PRICE_PATH = "/swap/allowance-holder/price";
export const ZERO_EX_QUOTE_PATH = "/swap/allowance-holder/quote";
export const ZERO_EX_REQUEST_TIMEOUT_MS = 15_000;

export function tradeProviderLabel(
  provider: "cdp-trade-api" | "0x-swap-api" | "aerodrome-slipstream",
): string {
  if (provider === "aerodrome-slipstream") return AERODROME_SLIPSTREAM_PROVIDER_LABEL;
  if (provider === "0x-swap-api") return ZERO_EX_PROVIDER_LABEL;
  return CDP_TRADE_PROVIDER_LABEL;
}

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

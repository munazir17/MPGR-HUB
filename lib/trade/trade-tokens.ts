// lib/trade/trade-tokens.ts
//
// Closed catalog of Base Mainnet tokens this app will label as verified.
// Unknown 0x addresses may still be quoted via CDP (the API is the
// liquidity source of truth) but are marked verified: false with a risk
// warning. Tickers that are not in this catalog AND not a 0x address
// are rejected — we never invent a contract.

import { getAddress, isAddress, type Address } from "viem";

import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";
import {
  BASE_USDC,
  BASE_WETH,
  NATIVE_ETH_SENTINEL,
  isNativeEthSentinel,
} from "./trade-config";
import { BASE_PAIRS } from "@/lib/markets/base-pairs";
import { COINBASE_B20_TOKENIZED_STOCKS } from "./tokenized-stocks";
import type { TradeTokenKind, TradeTokenRef } from "./trade-types";

export interface KnownTradeToken {
  aliases: readonly string[];
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: TradeTokenKind;
}

export const KNOWN_TRADE_TOKENS: readonly KnownTradeToken[] = [
  {
    aliases: ["eth", "ethereum", "native"],
    address: NATIVE_ETH_SENTINEL,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    kind: "native",
  },
  {
    aliases: ["weth"],
    address: BASE_WETH,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    kind: "erc20",
  },
  {
    aliases: ["usdc", "usd-coin"],
    address: BASE_USDC,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    kind: "erc20",
  },
  {
    aliases: ["mpgr"],
    address: MPGR_TOKEN_CONFIG.address,
    symbol: "MPGR",
    name: "MPGR",
    decimals: MPGR_TOKEN_CONFIG.decimals,
    kind: "erc20",
  },
  ...COINBASE_B20_TOKENIZED_STOCKS.map((stock) => ({
    aliases: [stock.ticker.toLowerCase(), stock.symbol.toLowerCase(), stock.underlyingTicker.toLowerCase()],
    address: stock.address,
    symbol: stock.symbol,
    name: stock.name,
    // 8 decimals — read live from every issued B20 token contract (AAPLc, AMZNc, GOOGLc,
    // METAc, MSFTc, MSTRc, NVDAc, SNDKc, SPCXc, TSLAc) and consistent with the on-chain
    // transfer amounts this app has executed. This is the display/parse default only: the
    // tokenized-stock swap path re-reads `decimals()` live and fails closed if it cannot be
    // verified (lib/trade/tokenized-stocks-onchain.ts), and the executor/proposal path is
    // atomic-unit exact, so a wrong default can never move funds — only a label.
    decimals: 8,
    kind: "b20-tokenized-stock" as const,
  })),
  // Coinbase wrapped assets from the typed Base pairs allowlist
  // (lib/markets/base-pairs.ts). USDC already has its entry above, so
  // `stable` pairs are skipped here. Decimals are the officially
  // documented values (Basescan-verified). B20 decimals are fixed at 8
  // (live-verified above) and are STILL re-read on-chain — fail closed —
  // by every path that actually prepares a B20 trade.
  ...BASE_PAIRS.filter(
    (pair): pair is typeof pair & { decimals: number } =>
      pair.kind === "wrapped" && pair.decimals !== null,
  ).map((pair) => ({
    aliases: [pair.symbol.toLowerCase()],
    address: pair.address,
    symbol: pair.symbol,
    name: pair.name,
    decimals: pair.decimals,
    kind: "erc20" as const,
  })),
];

function checksumOrAsGiven(address: string): Address {
  try {
    return getAddress(address.toLowerCase());
  } catch {
    return address as Address;
  }
}

export function findKnownTradeTokenMatches(input: string): KnownTradeToken[] {
  const key = input.trim().toLowerCase();
  return [...new Map(KNOWN_TRADE_TOKENS.filter(token => token.aliases.includes(key) || token.symbol.toLowerCase() === key || token.name.toLowerCase() === key).map(token => [token.address.toLowerCase(), token])).values()];
}

export function findKnownTradeToken(input: string): KnownTradeToken | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const alias = trimmed.toLowerCase();
  const matches = findKnownTradeTokenMatches(alias);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  if (!isAddress(trimmed, { strict: false }) && !isNativeEthSentinel(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  return (
    KNOWN_TRADE_TOKENS.find((token) => token.address.toLowerCase() === lower) ??
    null
  );
}

export type ResolveTradeTokenResult =
  | { ok: true; token: TradeTokenRef }
  | { ok: false; message: string };

/**
 * Resolves a user/model token input to a TradeTokenRef.
 *
 * Accepts a catalog alias (`USDC`, `AAPLc`, `ETH`) or a 0x address.
 * Does not invent a contract for an unknown ticker.
 */
export function resolveTradeToken(input: unknown): ResolveTradeTokenResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, message: "Token must be a symbol (USDC, ETH, AAPLc) or a 0x address." };
  }
  const trimmed = input.trim();
  const known = findKnownTradeToken(trimmed);
  if (known) {
    return {
      ok: true,
      token: {
        address: checksumOrAsGiven(known.address),
        symbol: known.symbol,
        name: known.name,
        decimals: known.decimals,
        kind: known.kind,
        verified: true,
      },
    };
  }
  if (isAddress(trimmed, { strict: false }) || isNativeEthSentinel(trimmed)) {
    const address = checksumOrAsGiven(trimmed);
    const kind: TradeTokenKind = isNativeEthSentinel(trimmed) ? "native" : "erc20";
    return {
      ok: true,
      token: {
        address,
        symbol: `${address.slice(0, 6)}…${address.slice(-4)}`,
        name: "Token metadata pending",
        // Placeholder for synchronous intent parsing ONLY. The async swap
        // resolver must replace this before any amount conversion or quote.
        decimals: 18,
        kind,
        verified: false,
      },
    };
  }
  return {
    ok: false,
    message: /^0x/i.test(trimmed)
      ? "Invalid token address. Use 0x followed by exactly 40 hexadecimal characters."
      : "No unique catalog match. Provide the exact Base token contract. Refusing to invent a contract.",
  };
}

export function isTokenizedStockToken(token: TradeTokenRef): boolean {
  return token.kind === "b20-tokenized-stock";
}

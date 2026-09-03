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
    decimals: 18,
    kind: "b20-tokenized-stock" as const,
  })),
];

function checksumOrAsGiven(address: string): Address {
  try {
    return getAddress(address);
  } catch {
    return address as Address;
  }
}

export function findKnownTradeToken(input: string): KnownTradeToken | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const alias = trimmed.toLowerCase();
  const byAlias = KNOWN_TRADE_TOKENS.find((token) =>
    token.aliases.includes(alias),
  );
  if (byAlias) return byAlias;
  if (!isAddress(trimmed) && !isNativeEthSentinel(trimmed)) return null;
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
  if (isAddress(trimmed) || isNativeEthSentinel(trimmed)) {
    const address = checksumOrAsGiven(trimmed);
    const kind: TradeTokenKind = isNativeEthSentinel(trimmed) ? "native" : "erc20";
    return {
      ok: true,
      token: {
        address,
        symbol: `${address.slice(0, 6)}…${address.slice(-4)}`,
        name: "Unknown token",
        decimals: 18,
        kind,
        verified: false,
      },
    };
  }
  return {
    ok: false,
    message: `"${trimmed}" is not a known Base token in this app and is not a 0x address. Refusing to invent a contract.`,
  };
}

export function isTokenizedStockToken(token: TradeTokenRef): boolean {
  return token.kind === "b20-tokenized-stock";
}

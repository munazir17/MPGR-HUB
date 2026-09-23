"use client";

// lib/trade/instant-swap.ts
//
// The tape → agent fast path.
//
// "Prepare swap USDC → <token>" on an asset-detail sheet must not wait
// for a chat round trip, and must not make the user retype anything. This
// module turns a tape symbol into the SAME proposal the agent's
// prepare_swap tool would produce, by calling the existing session-bound
// quote route — no new swap architecture, no new signing path:
//
//   POST /api/trade/stocks/quote  { symbol, side: "BUY", amount: "10" }   (B20)
//   POST /api/trade/quote         { fromToken: "USDC", toToken: "<sym>",  (rest)
//                                   amount: "10" }
//
// — the same two routes (and therefore the same swap engines) the agent's
// prepare_swap tool uses, so the one-tap path and the chat path produce
// the identical proposal. Both routes bind the taker to the authenticated
// session wallet, refuse anything outside lib/markets/base-pairs.ts, and
// never sign. The returned proposal is handed to the existing trade
// confirmation modal.
//
// Duplicate-click safety: identical requests inside INSTANT_SWAP_TTL_MS
// share one in-flight promise / cached proposal, so a double tap or a
// chat turn asking for the same pair cannot produce two upstream quotes
// (and cannot burn the route's 15 requests/minute budget).

import { findBasePair } from "@/lib/markets/base-pairs";
import type { TradeProposal } from "@/lib/trade/trade-types";

/** Default size for a one-tap prepare from the tape (USDC in). */
export const INSTANT_SWAP_AMOUNT_USDC = "10";
const INSTANT_SWAP_TTL_MS = 8_000;

export type InstantSwapResult =
  | { ok: true; proposal: TradeProposal }
  | { ok: false; code: string; message: string };

interface CacheEntry {
  at: number;
  value: Promise<InstantSwapResult>;
}

const cache = new Map<string, CacheEntry>();

/** Test/dev helper — clears the short-lived quote cache. */
export function resetInstantSwapCache(): void {
  cache.clear();
}

export function buildInstantSwapPrompt(symbol: string, amount = INSTANT_SWAP_AMOUNT_USDC): string {
  return `Prepare a swap of ${amount} USDC to ${symbol} on Base. Show minOut, route, price impact and fees — I will sign in my wallet.`;
}

async function requestProposal(
  symbol: string,
  amount: string,
  isB20: boolean,
  signal?: AbortSignal,
): Promise<InstantSwapResult> {
  const response = await fetch(isB20 ? "/api/trade/stocks/quote" : "/api/trade/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    cache: "no-store",
    signal,
    body: JSON.stringify(
      isB20
        ? { symbol, side: "BUY", amount }
        : { fromToken: "USDC", toToken: symbol, amount },
    ),
  });
  const payload = (await response.json().catch(() => null)) as
    | { proposal?: TradeProposal; error?: string; code?: string }
    | null;

  if (!response.ok || !payload?.proposal) {
    return {
      ok: false,
      code: payload?.code ?? `HTTP_${response.status}`,
      message:
        payload?.error ?? "No live Base swap quote is available for that pair right now.",
    };
  }
  return { ok: true, proposal: payload.proposal };
}

/**
 * Fetches (or reuses) a USDC → symbol proposal for the connected session
 * wallet. `symbol` must be an allowlisted Coinbase asset / B20 ticker —
 * anything else is refused before a request is made.
 */
export async function fetchInstantSwapProposal(options: {
  symbol: string;
  amount?: string;
  signal?: AbortSignal;
}): Promise<InstantSwapResult> {
  const symbol = options.symbol.trim();
  const amount = options.amount?.trim() || INSTANT_SWAP_AMOUNT_USDC;

  const pair = findBasePair(symbol);
  if (!pair) {
    return {
      ok: false,
      code: "UNSUPPORTED_ASSET",
      message: `${symbol} is not an official Coinbase wrapped asset, native USDC, or Coinbase Tokenized Stock (B20) on Base.`,
    };
  }
  if (pair.kind === "stable") {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "USDC → USDC is not a swap. Pick a Coinbase asset or tokenized stock.",
    };
  }
  if (!pair.live) {
    return {
      ok: false,
      code: "UNSUPPORTED_ASSET",
      message: `${pair.symbol} is published by Coinbase but not live on Base's official list yet — it has no issued supply or price feed, so nothing can be prepared.`,
    };
  }

  const key = `${pair.symbol}:${amount}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < INSTANT_SWAP_TTL_MS) {
    // A caller that arrives with its own abort signal must not cancel the
    // shared request for everyone else.
    return cached.value;
  }

  const value = requestProposal(pair.symbol, amount, pair.kind === "b20-stock", options.signal);
  cache.set(key, { at: Date.now(), value });
  try {
    const result = await value;
    if (!result.ok) cache.delete(key);
    return result;
  } catch (error) {
    cache.delete(key);
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, code: "ABORTED", message: "Quote request cancelled." };
    }
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: "Could not reach the Base swap quote endpoint.",
    };
  }
}

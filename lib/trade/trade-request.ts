// lib/trade/trade-request.ts
//
// Shared request parsing for /api/trade/* and the agent tools.

import { isAddress } from "viem";

import {
  TRADE_DEFAULT_SLIPPAGE_BPS,
  clampSlippageBps,
} from "./trade-config";
import { parseAtomicAmount, parseHumanTokenAmount } from "./trade-format";
import { resolveTradeToken, type ResolveTradeTokenResult } from "./trade-tokens";
import { resolveSwapToken } from "./trade-token-resolution";
import type { TradeError, TradeTokenRef } from "./trade-types";

export interface ParsedTradeSwapRequest {
  from: TradeTokenRef;
  to: TradeTokenRef;
  fromAmount: string;
  taker: string;
  slippageBps: number;
}

export type ParseTradeSwapResult =
  | { ok: true; value: ParsedTradeSwapRequest }
  | { ok: false; error: TradeError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveFromAmount(raw: Record<string, unknown>, decimals: number): bigint | null {
  if (raw.amount != null && String(raw.amount).trim() !== "") {
    return parseHumanTokenAmount(raw.amount, decimals);
  }
  const fromAmount = raw.fromAmount;
  if (fromAmount == null) return null;
  // Wire contract: amount = human units; fromAmount = atomic units.
  // Never guess from digit count (80000 atomic USDC is 0.08, not 80,000).
  return parseAtomicAmount(fromAmount);
}

export async function parseTradeSwapRequest(
  raw: unknown,
  options?: { requireTaker?: boolean },
): Promise<ParseTradeSwapResult> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Request body must be a JSON object." } };
  }

  const [from, to] = await Promise.all([
    resolveSwapToken(raw.fromToken ?? raw.from),
    resolveSwapToken(raw.toToken ?? raw.to),
  ]);
  if (!from.ok) return { ok: false, error: from.error };
  if (!to.ok) return { ok: false, error: to.error };
  if (from.token.address.toLowerCase() === to.token.address.toLowerCase()) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Sell token and buy token must be different." } };
  }

  const fromAmount = resolveFromAmount(raw, from.token.decimals);
  if (fromAmount === null) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Provide amount in token units (e.g. \"10\" or \"$10\") or fromAmount as an atomic integer string.",
      },
    };
  }

  const slippageBps =
    raw.slippageBps === undefined || raw.slippageBps === null
      ? TRADE_DEFAULT_SLIPPAGE_BPS
      : clampSlippageBps(raw.slippageBps);
  if (slippageBps === null) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "slippageBps must be an integer from 1 to 500 (0.01% to 5%).",
      },
    };
  }

  const taker = typeof raw.taker === "string" ? raw.taker.trim() : "";
  const requireTaker = options?.requireTaker !== false;
  if (requireTaker && !isAddress(taker)) {
    return {
      ok: false,
      error: {
        code: "WALLET_REQUIRED",
        message: "taker must be the connected wallet address on Base.",
      },
    };
  }

  return {
    ok: true,
    value: {
      from: from.token,
      to: to.token,
      fromAmount: fromAmount.toString(),
      taker,
      slippageBps,
    },
  };
}

export function describeResolveFailure(result: Extract<ResolveTradeTokenResult, { ok: false }>): string {
  return result.message;
}

/**
 * Canonical tool-argument hydration. Converts a human `amount` / "$10"
 * into atomic `fromAmount` using the resolved from-token decimals, and
 * fills `taker` from the connected wallet. Must run BEFORE schema
 * validation so `fromAmount` is present when the tool requires it.
 */
/**
 * Sync, best-effort hydration for the pre-validation stage (runs
 * ahead of JSON-schema validation, in code paths that must stay
 * synchronous — see the comment on parseTradeSwapRequest above for
 * why B20 decimals cannot be resolved here).
 *
 * For ordinary crypto (ETH/WETH/USDC/MPGR/any known token) this
 * computes `fromAmount` exactly as before — those decimals are fixed,
 * known values, not guesses, so doing the conversion synchronously
 * here is safe.
 *
 * For a B20 tokenized stock on either side, this deliberately does
 * NOT compute `fromAmount` — it leaves the human `amount` field
 * as-is and does not touch it. The schema does not require
 * `fromAmount` (only fromToken/toToken), so this passes validation,
 * and the actual atomic conversion happens later, safely, in the
 * real API route's async `parseTradeSwapRequest`, which verifies the
 * token's decimals on-chain before doing any amount math. Producing
 * a "best guess" fromAmount here for a B20 token would be exactly
 * the unverified-decimals mistake this whole file exists to avoid.
 */
export function hydrateTradeSwapArguments(
  raw: Record<string, unknown>,
  walletAddress?: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  if (!(typeof next.taker === "string" && next.taker.trim()) && typeof walletAddress === "string" && walletAddress.trim()) {
    next.taker = walletAddress.trim();
  }

  const from = resolveTradeToken(next.fromToken ?? next.from);
  const to = resolveTradeToken(next.toToken ?? next.to);
  if (!from.ok || !to.ok) return next;

  const needsAsyncDecimals =
    from.token.kind === "b20-tokenized-stock" ||
    to.token.kind === "b20-tokenized-stock" ||
    (from.token.kind === "erc20" && from.token.verified === false) ||
    (to.token.kind === "erc20" && to.token.verified === false);
  if (needsAsyncDecimals) {
    // Normalize symbols/taker only — leave amount/fromAmount untouched
    // for the real (async, on-chain-verified) parse to handle.
    return {
      ...next,
      fromToken: /^0x/i.test(String(next.fromToken ?? next.from)) || !from.token.verified ? from.token.address : from.token.symbol,
      toToken: /^0x/i.test(String(next.toToken ?? next.to)) || !to.token.verified ? to.token.address : to.token.symbol,
      taker: (typeof next.taker === "string" && next.taker.trim()) || undefined,
    };
  }

  const fromAmount = resolveFromAmount(next, from.token.decimals);
  if (fromAmount === null) return next;
  const slippageBps =
    next.slippageBps === undefined || next.slippageBps === null
      ? TRADE_DEFAULT_SLIPPAGE_BPS
      : clampSlippageBps(next.slippageBps);

  return {
    fromToken: /^0x/i.test(String(next.fromToken ?? next.from)) || !from.token.verified ? from.token.address : from.token.symbol,
    toToken: /^0x/i.test(String(next.toToken ?? next.to)) || !to.token.verified ? to.token.address : to.token.symbol,
    fromAmount: fromAmount.toString(),
    taker: (typeof next.taker === "string" && next.taker.trim()) || undefined,
    slippageBps: slippageBps ?? TRADE_DEFAULT_SLIPPAGE_BPS,
  };
}

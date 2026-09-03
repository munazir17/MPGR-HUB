// lib/trade/trade-request.ts
//
// Shared request parsing for /api/trade/* and the agent tools.

import { isAddress } from "viem";

import {
  TRADE_DEFAULT_SLIPPAGE_BPS,
  clampSlippageBps,
} from "./trade-config";
import { parseAtomicAmount } from "./trade-format";
import { resolveTradeToken, type ResolveTradeTokenResult } from "./trade-tokens";
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

export function parseTradeSwapRequest(
  raw: unknown,
  options?: { requireTaker?: boolean },
): ParseTradeSwapResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Request body must be a JSON object." } };
  }

  const from = resolveTradeToken(raw.fromToken ?? raw.from);
  const to = resolveTradeToken(raw.toToken ?? raw.to);
  if (!from.ok) {
    return { ok: false, error: { code: "UNSUPPORTED_ASSET", message: from.message } };
  }
  if (!to.ok) {
    return { ok: false, error: { code: "UNSUPPORTED_ASSET", message: to.message } };
  }
  if (from.token.address.toLowerCase() === to.token.address.toLowerCase()) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Sell token and buy token must be different." },
    };
  }

  const fromAmount = parseAtomicAmount(raw.fromAmount);
  if (fromAmount === null) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "fromAmount must be a positive integer string in atomic units (e.g. 1000000 for 1 USDC).",
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

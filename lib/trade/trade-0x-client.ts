import "server-only";

// lib/trade/trade-0x-client.ts
//
// Direct 0x Swap API v2 (AllowanceHolder) on Base.
// Docs:
//   https://docs.0x.org/api-reference/api-overview
//   GET https://api.0x.org/swap/allowance-holder/price
//   GET https://api.0x.org/swap/allowance-holder/quote
// Headers: 0x-api-key, 0x-version: v2
//
// Used ONLY as a fallback when Coinbase CDP Trade API rejects a token
// (B20 allowlist) or reports no liquidity. Does not replace
// trade-cdp-client.ts for ETH/WETH/USDC/MPGR.

import { isAddress } from "viem";

import {
  TRADE_CHAIN_ID,
  TRADE_DEFAULT_SLIPPAGE_BPS,
  ZERO_EX_API_HOST,
  ZERO_EX_PRICE_PATH,
  ZERO_EX_QUOTE_PATH,
  ZERO_EX_REQUEST_TIMEOUT_MS,
} from "./trade-config";
import type {
  CdpPermit2,
  CdpSwapIssues,
  CdpSwapPrice,
  CdpSwapQuote,
  CdpSwapTransaction,
  TradeError,
} from "./trade-types";

export interface ZeroExSwapRequest {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  taker: string;
  slippageBps?: number;
}

export type ZeroExResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TradeError };

function readZeroExApiKey(): string | null {
  const key =
    process.env.ZERO_EX_API_KEY?.trim() ||
    process.env.ZEROX_API_KEY?.trim() ||
    process.env.OX_API_KEY?.trim() ||
    null;
  return key && key.length > 0 ? key : null;
}

export function hasZeroExApiKey(): boolean {
  return readZeroExApiKey() !== null;
}

function credentialsMissing(): TradeError {
  return {
    code: "CREDENTIALS_MISSING",
    message:
      "0x Swap API key is not configured (ZERO_EX_API_KEY), so the Base DEX fallback cannot run.",
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeLogBody(body: unknown): string {
  try {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return (text ?? "").slice(0, 500);
  } catch {
    return "<unserializable body>";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error);
  }
}

function parseIssues(raw: unknown): CdpSwapIssues {
  const empty: CdpSwapIssues = {
    allowance: null,
    balance: null,
    simulationIncomplete: false,
  };
  if (!isPlainObject(raw)) return empty;
  const allowance = isPlainObject(raw.allowance)
    ? {
        currentAllowance:
          asString(raw.allowance.actual) ??
          asString(raw.allowance.currentAllowance) ??
          "0",
        spender: asString(raw.allowance.spender) ?? "",
      }
    : null;
  const balance = isPlainObject(raw.balance)
    ? {
        token: asString(raw.balance.token) ?? "",
        currentBalance:
          asString(raw.balance.actual) ??
          asString(raw.balance.currentBalance) ??
          "0",
        requiredBalance:
          asString(raw.balance.expected) ??
          asString(raw.balance.requiredBalance) ??
          "0",
      }
    : null;
  return {
    allowance: allowance && allowance.spender ? allowance : null,
    balance: balance && balance.token ? balance : null,
    simulationIncomplete: raw.simulationIncomplete === true,
  };
}

function parseFees(raw: unknown): CdpSwapPrice["fees"] {
  if (!isPlainObject(raw)) return undefined;
  const gasSource = isPlainObject(raw.gasFee) ? raw.gasFee : isPlainObject(raw.gas) ? raw.gas : null;
  const gas = gasSource
    ? {
        amount: asString(gasSource.amount) ?? "0",
        token: asString(gasSource.token) ?? "",
      }
    : undefined;
  return { gasFee: gas };
}

function parseTransaction(raw: unknown): CdpSwapTransaction | null {
  if (!isPlainObject(raw)) return null;
  const to = asString(raw.to);
  const data = asString(raw.data);
  const value = asString(raw.value) ?? "0";
  if (!to || !data || !isAddress(to)) return null;
  return {
    to,
    data: data as CdpSwapTransaction["data"],
    gas: asString(raw.gas) ?? undefined,
    gasPrice: asString(raw.gasPrice) ?? undefined,
    value,
  };
}

function parsePermit2(raw: unknown): CdpPermit2 | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.eip712)) return null;
  const eip712 = raw.eip712;
  if (typeof eip712.primaryType !== "string") return null;
  if (!isPlainObject(eip712.types) || !isPlainObject(eip712.message)) return null;
  return {
    hash: (asString(raw.hash) as CdpPermit2["hash"]) ?? undefined,
    eip712: {
      domain: isPlainObject(eip712.domain) ? eip712.domain : {},
      types: eip712.types as CdpPermit2["eip712"]["types"],
      primaryType: eip712.primaryType,
      message: eip712.message,
    },
  };
}

function parsePrice(body: unknown): CdpSwapPrice | null {
  if (!isPlainObject(body)) return null;
  const fromToken = asString(body.sellToken) ?? asString(body.fromToken);
  const toToken = asString(body.buyToken) ?? asString(body.toToken);
  const fromAmount = asString(body.sellAmount) ?? asString(body.fromAmount);
  const toAmount = asString(body.buyAmount) ?? asString(body.toAmount);
  const minToAmount = asString(body.minBuyAmount) ?? asString(body.minToAmount) ?? toAmount;
  const liquidityAvailable =
    body.liquidityAvailable === false ? false : Boolean(toAmount && fromAmount);

  if (!liquidityAvailable) {
    if (!fromToken || !toToken || !fromAmount) return null;
    return {
      liquidityAvailable: false,
      fromToken,
      toToken,
      fromAmount,
      toAmount: toAmount ?? "0",
      minToAmount: minToAmount ?? "0",
      fees: parseFees(body.fees),
      issues: parseIssues(body.issues),
    };
  }
  if (!fromToken || !toToken || !fromAmount || !toAmount || !minToAmount) return null;
  return {
    liquidityAvailable: true,
    fromToken,
    toToken,
    fromAmount,
    toAmount,
    minToAmount,
    fees: parseFees(body.fees),
    issues: parseIssues(body.issues),
  };
}

function parseQuote(body: unknown): CdpSwapQuote | null {
  const price = parsePrice(body);
  if (!price) return null;
  const record = body as Record<string, unknown>;
  return {
    ...price,
    blockNumber: asString(record.blockNumber) ?? undefined,
    transaction: parseTransaction(record.transaction),
    permit2: parsePermit2(record.permit2),
  };
}

function sanitizeZeroExError(status: number, body: unknown): TradeError {
  console.error("[0x-swap] upstream_error", { status, body: safeLogBody(body) });
  const messageFromBody = isPlainObject(body)
    ? asString(body.reason) ??
      asString(body.error) ??
      asString(body.message) ??
      asString(body.errorMessage)
    : null;
  if (status === 401 || status === 403) {
    return {
      code: "CREDENTIALS_MISSING",
      message: "0x rejected the Swap API key.",
    };
  }
  if (status === 429) {
    return {
      code: "PROVIDER_ERROR",
      message: "0x Swap API rate-limited this request. Retry in a moment.",
    };
  }
  const clipped =
    messageFromBody && messageFromBody.length < 180
      ? messageFromBody
      : "0x Swap API could not return a quote for this pair.";
  return { code: "PROVIDER_ERROR", message: clipped };
}

async function zeroExFetch(
  path: string,
  params: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const apiKey = readZeroExApiKey();
  if (!apiKey) {
    throw Object.assign(new Error("missing 0x key"), { tradeError: credentialsMissing() });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZERO_EX_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${ZERO_EX_API_HOST}${path}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "0x-api-key": apiKey,
        "0x-version": "v2",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function buildParams(request: ZeroExSwapRequest): URLSearchParams {
  return new URLSearchParams({
    chainId: String(TRADE_CHAIN_ID),
    sellToken: request.fromToken,
    buyToken: request.toToken,
    sellAmount: request.fromAmount,
    taker: request.taker,
    slippageBps: String(request.slippageBps ?? TRADE_DEFAULT_SLIPPAGE_BPS),
  });
}

export async function getZeroExSwapPrice(
  request: ZeroExSwapRequest,
): Promise<ZeroExResult<CdpSwapPrice>> {
  if (!hasZeroExApiKey()) {
    return { ok: false, error: credentialsMissing() };
  }
  try {
    const { status, body } = await zeroExFetch(ZERO_EX_PRICE_PATH, buildParams(request));
    if (status < 200 || status >= 300) {
      return { ok: false, error: sanitizeZeroExError(status, body) };
    }
    const parsed = parsePrice(body);
    if (!parsed) {
      console.error("[0x-swap] unparseable_price_payload", { status, body: safeLogBody(body) });
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "0x returned a price payload this app could not use.",
        },
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    if (error && typeof error === "object" && "tradeError" in error) {
      return { ok: false, error: (error as { tradeError: TradeError }).tradeError };
    }
    console.error("[0x-swap] price_fetch_failed", { message: errorMessage(error) });
    return {
      ok: false,
      error: { code: "PROVIDER_ERROR", message: "Could not reach 0x Swap API for a price." },
    };
  }
}

export async function createZeroExSwapQuote(
  request: ZeroExSwapRequest,
): Promise<ZeroExResult<CdpSwapQuote>> {
  if (!hasZeroExApiKey()) {
    return { ok: false, error: credentialsMissing() };
  }
  try {
    const { status, body } = await zeroExFetch(ZERO_EX_QUOTE_PATH, buildParams(request));
    if (status < 200 || status >= 300) {
      return { ok: false, error: sanitizeZeroExError(status, body) };
    }
    const parsed = parseQuote(body);
    if (!parsed) {
      console.error("[0x-swap] unparseable_quote_payload", { status, body: safeLogBody(body) });
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "0x returned a quote payload this app could not use.",
        },
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    if (error && typeof error === "object" && "tradeError" in error) {
      return { ok: false, error: (error as { tradeError: TradeError }).tradeError };
    }
    console.error("[0x-swap] quote_fetch_failed", { message: errorMessage(error) });
    return {
      ok: false,
      error: { code: "PROVIDER_ERROR", message: "Could not reach 0x Swap API for a swap quote." },
    };
  }
}

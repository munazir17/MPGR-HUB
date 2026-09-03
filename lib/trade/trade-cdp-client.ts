import "server-only";

// lib/trade/trade-cdp-client.ts
//
// Server-only Coinbase CDP Trade API client (EVM Swaps on Base).
//
//   GET  /platform/v2/evm/swaps  → getSwapPrice  (estimate, no reservation)
//   POST /platform/v2/evm/swaps  → createSwapQuote (unsigned tx + Permit2)
//
// Docs:
//   https://docs.cdp.coinbase.com/trade-api/quickstart
//   https://docs.cdp.coinbase.com/api-reference/v2/rest-api/evm-swaps/create-swap-quote
//
// BYO wallet: this client NEVER signs or broadcasts. It returns the
// quote payload for the user's connected wallet to sign via wagmi.

import { isAddress } from "viem";

import {
  CDP_TRADE_API_HOST,
  CDP_TRADE_API_BASE_PATH,
  CDP_TRADE_API_URL,
  TRADE_DEFAULT_SLIPPAGE_BPS,
  TRADE_NETWORK,
  TRADE_PRICE_TIMEOUT_MS,
  TRADE_QUOTE_TIMEOUT_MS,
} from "./trade-config";
import { generateCdpJwt } from "./trade-jwt";
import type {
  CdpPermit2,
  CdpSwapIssues,
  CdpSwapPrice,
  CdpSwapQuote,
  CdpSwapTransaction,
  TradeError,
} from "./trade-types";

export interface TradeCdpRequest {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  taker: string;
  slippageBps?: number;
}

export type TradeCdpResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TradeError };

function readCdpApiCredentials(): { apiKeyId: string; apiKeySecret: string } | null {
  const apiKeyId = process.env.CDP_API_KEY_ID?.trim();
  const apiKeySecret = process.env.CDP_API_KEY_SECRET?.trim();
  if (!apiKeyId || !apiKeySecret) return null;
  return { apiKeyId, apiKeySecret };
}

export function hasTradeApiCredentials(): boolean {
  return readCdpApiCredentials() !== null;
}

function credentialsMissing(): TradeError {
  return {
    code: "CREDENTIALS_MISSING",
    message:
      "Coinbase CDP Trade API credentials are not configured on the server, so live prices and swap quotes cannot be fetched.",
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
        currentAllowance: asString(raw.allowance.currentAllowance) ?? "0",
        spender: asString(raw.allowance.spender) ?? "",
      }
    : null;
  const balance = isPlainObject(raw.balance)
    ? {
        token: asString(raw.balance.token) ?? "",
        currentBalance: asString(raw.balance.currentBalance) ?? "0",
        requiredBalance: asString(raw.balance.requiredBalance) ?? "0",
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
  const gas = isPlainObject(raw.gasFee)
    ? {
        amount: asString(raw.gasFee.amount) ?? "0",
        token: asString(raw.gasFee.token) ?? "",
      }
    : undefined;
  const protocol = isPlainObject(raw.protocolFee)
    ? {
        amount: asString(raw.protocolFee.amount) ?? "0",
        token: asString(raw.protocolFee.token) ?? "",
      }
    : undefined;
  return { gasFee: gas, protocolFee: protocol };
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
  const fromToken = asString(body.fromToken);
  const toToken = asString(body.toToken);
  const fromAmount = asString(body.fromAmount);
  const toAmount = asString(body.toAmount);
  const minToAmount = asString(body.minToAmount);
  if (!fromToken || !toToken || !fromAmount || !toAmount || !minToAmount) {
    return null;
  }
  return {
    liquidityAvailable: body.liquidityAvailable === true,
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

function sanitizeCdpError(status: number, body: unknown): TradeError {
  const messageFromBody =
    isPlainObject(body) && typeof body.errorMessage === "string"
      ? body.errorMessage
      : isPlainObject(body) && typeof body.error === "string"
        ? body.error
        : isPlainObject(body) && typeof body.message === "string"
          ? body.message
          : null;
  if (status === 401 || status === 403) {
    return {
      code: "CREDENTIALS_MISSING",
      message: "Coinbase CDP rejected the Trade API credentials.",
    };
  }
  if (status === 429) {
    return {
      code: "PROVIDER_ERROR",
      message: "Coinbase CDP Trade API rate-limited this request. Retry in a moment.",
    };
  }
  const clipped =
    messageFromBody && messageFromBody.length < 180
      ? messageFromBody
      : "Coinbase CDP Trade API could not return a quote for this pair.";
  return { code: "PROVIDER_ERROR", message: clipped };
}

async function cdpFetch(
  method: "GET" | "POST",
  url: string,
  timeoutMs: number,
  jsonBody?: unknown,
): Promise<{ status: number; body: unknown }> {
  const creds = readCdpApiCredentials();
  if (!creds) {
    throw Object.assign(new Error("missing credentials"), { tradeError: credentialsMissing() });
  }

  const jwt = generateCdpJwt({
    apiKeyId: creds.apiKeyId,
    apiKeySecret: creds.apiKeySecret,
    requestMethod: method,
    requestHost: CDP_TRADE_API_HOST,
    requestPath: CDP_TRADE_API_BASE_PATH,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function getCdpSwapPrice(
  request: TradeCdpRequest,
): Promise<TradeCdpResult<CdpSwapPrice>> {
  if (!hasTradeApiCredentials()) {
    return { ok: false, error: credentialsMissing() };
  }

  const slippageBps = request.slippageBps ?? TRADE_DEFAULT_SLIPPAGE_BPS;
  const params = new URLSearchParams({
    network: TRADE_NETWORK,
    fromToken: request.fromToken,
    toToken: request.toToken,
    fromAmount: request.fromAmount,
    taker: request.taker,
    slippageBps: String(slippageBps),
  });

  try {
    const { status, body } = await cdpFetch(
      "GET",
      `${CDP_TRADE_API_URL}?${params.toString()}`,
      TRADE_PRICE_TIMEOUT_MS,
    );
    if (status < 200 || status >= 300) {
      return { ok: false, error: sanitizeCdpError(status, body) };
    }
    const parsed = parsePrice(body);
    if (!parsed) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "Coinbase CDP returned a price payload this app could not use.",
        },
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    if (error && typeof error === "object" && "tradeError" in error) {
      return { ok: false, error: (error as { tradeError: TradeError }).tradeError };
    }
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "AbortError" || name === "TimeoutError") {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "Coinbase CDP Trade API timed out while fetching a price.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: "Could not reach Coinbase CDP Trade API for a price.",
      },
    };
  }
}

export async function createCdpSwapQuote(
  request: TradeCdpRequest,
): Promise<TradeCdpResult<CdpSwapQuote>> {
  if (!hasTradeApiCredentials()) {
    return { ok: false, error: credentialsMissing() };
  }

  const slippageBps = request.slippageBps ?? TRADE_DEFAULT_SLIPPAGE_BPS;
  const payload = {
    network: TRADE_NETWORK,
    fromToken: request.fromToken,
    toToken: request.toToken,
    fromAmount: request.fromAmount,
    taker: request.taker,
    slippageBps,
  };

  try {
    const { status, body } = await cdpFetch(
      "POST",
      CDP_TRADE_API_URL,
      TRADE_QUOTE_TIMEOUT_MS,
      payload,
    );
    if (status < 200 || status >= 300) {
      return { ok: false, error: sanitizeCdpError(status, body) };
    }
    const parsed = parseQuote(body);
    if (!parsed) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "Coinbase CDP returned a quote payload this app could not use.",
        },
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    if (error && typeof error === "object" && "tradeError" in error) {
      return { ok: false, error: (error as { tradeError: TradeError }).tradeError };
    }
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "AbortError" || name === "TimeoutError") {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          message: "Coinbase CDP Trade API timed out while creating a swap quote.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: "Could not reach Coinbase CDP Trade API for a swap quote.",
      },
    };
  }
}

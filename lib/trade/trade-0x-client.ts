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

import { isAddress, zeroAddress } from "viem";

import {
  NATIVE_ETH_SENTINEL,
  TRADE_CHAIN_ID,
  TRADE_DEFAULT_SLIPPAGE_BPS,
  ZERO_EX_API_HOST,
  ZERO_EX_PRICE_PATH,
  ZERO_EX_QUOTE_PATH,
  ZERO_EX_REQUEST_TIMEOUT_MS,
} from "./trade-config";
import type {
  CdpPermit2,
  CdpSwapFee,
  CdpSwapIssues,
  CdpSwapPrice,
  CdpSwapQuote,
  CdpSwapTransaction,
  TradeError,
} from "./trade-types";

/**
 * Native 0x fee configuration. When supplied, 0x embeds the fee in the
 * swap transaction it generates, so the app never sends a separate fee.
 */
export interface ZeroExNativeFee {
  /** Validated fee-recipient wallet. */
  recipient: string;
  /** Fee in basis points (25 = 0.25%). */
  bps: number;
}

export interface ZeroExSwapRequest {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  taker: string;
  slippageBps?: number;
  /**
   * Optional native fee. Applied ONLY when the SELL token is a real
   * ERC-20 contract address — see `zeroExNativeFeeEligible`.
   */
  agentFee?: ZeroExNativeFee | null;
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
  const protocolSource = isPlainObject(raw.protocolFee) ? raw.protocolFee : null;
  const protocolFee = protocolSource
    ? {
        amount: asString(protocolSource.amount) ?? "0",
        token: asString(protocolSource.token) ?? "",
      }
    : undefined;
  return { gasFee: gas, protocolFee, integratorFee: parseIntegratorFee(raw) };
}

/**
 * 0x reports our integrator fee as `fees.integratorFee.amount` (in
 * sellToken base units) whenever `swapFeeRecipient`/`swapFeeBps`/
 * `swapFeeToken` were accepted. A newer multi-fee response shape
 * (`integratorFees[]`) is tolerated by summing, so a provider-side
 * format change degrades to "fee reported, possibly split" instead of
 * silently reading as "no fee".
 */
function parseIntegratorFee(raw: Record<string, unknown>): CdpSwapFee | undefined {
  const single = isPlainObject(raw.integratorFee) ? raw.integratorFee : null;
  if (single) {
    const amount = asString(single.amount);
    const token = asString(single.token);
    // A non-numeric amount is not something we can display as "25 bps of
    // the sell amount" — report no provider fee so the app collects it
    // itself, rather than quoting a number we cannot stand behind.
    if (amount && token && /^\d+$/.test(amount)) return { amount, token };
    return undefined;
  }
  if (Array.isArray(raw.integratorFees)) {
    let total = 0n;
    let token: string | null = null;
    let ok = false;
    for (const entry of raw.integratorFees) {
      if (!isPlainObject(entry)) continue;
      const amount = asString(entry.amount);
      const entryToken = asString(entry.token);
      if (!amount || !entryToken || !/^\d+$/.test(amount)) continue;
      try {
        total += BigInt(amount);
      } catch {
        continue;
      }
      token = entryToken;
      ok = true;
    }
    return ok && token ? { amount: total.toString(), token } : undefined;
  }
  return undefined;
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

/**
 * Can the 0x native fee be used for this request?
 *
 * `swapFeeToken` MUST be a contract address equal to `buyToken` or
 * `sellToken`. Our fee is denominated in the SELL token (0.25% of
 * fromAmount), so the native fee is only faithful when the sell token is
 * a real ERC-20:
 *
 *   - SELL is an ERC-20 (USDC, WETH, MPGR, B20, …) → eligible; the fee is
 *     taken in the sell token, exactly matching the app's own
 *     floor(fromAmount * 25 / 10_000) invariant.
 *   - SELL is the native-ETH sentinel → NOT eligible. The only legal
 *     `swapFeeToken` would then be the BUY token, which turns the fee
 *     into a buy-side/output fee — a different economic model. 0x also
 *     rejects the sentinel as a fee token. Falls back to the app's own
 *     collection.
 *
 * Fail-closed in every other respect: no fee config, no recipient, a
 * non-contract sell token, or a fee outside 0x's 0–1000 bps range all
 * mean "no native fee" — the app's existing collection path is used.
 */
export function zeroExNativeFeeEligible(request: ZeroExSwapRequest): boolean {
  const fee = request.agentFee;
  if (!fee) return false;
  if (!fee.recipient || !isAddress(fee.recipient)) return false;
  if (fee.recipient.toLowerCase() === zeroAddress.toLowerCase()) return false;
  if (!Number.isInteger(fee.bps) || fee.bps <= 0 || fee.bps > 1_000) return false;
  const sellToken = request.fromToken;
  if (!sellToken || !isAddress(sellToken)) return false;
  if (sellToken.toLowerCase() === NATIVE_ETH_SENTINEL.toLowerCase()) return false;
  // The buy token must also be a contract address for 0x to accept a
  // swap at all; if it is the native sentinel the fee token stays the
  // sell token, which is still valid.
  return true;
}

function buildParams(request: ZeroExSwapRequest): URLSearchParams {
  const params = new URLSearchParams({
    chainId: String(TRADE_CHAIN_ID),
    sellToken: request.fromToken,
    buyToken: request.toToken,
    sellAmount: request.fromAmount,
    taker: request.taker,
    slippageBps: String(request.slippageBps ?? TRADE_DEFAULT_SLIPPAGE_BPS),
  });
  if (zeroExNativeFeeEligible(request) && request.agentFee) {
    params.set("swapFeeRecipient", request.agentFee.recipient);
    params.set("swapFeeBps", String(request.agentFee.bps));
    // Always the SELL token: keeps the fee at exactly 25 bps of
    // fromAmount in the sell token, never a buy-side/output fee.
    params.set("swapFeeToken", request.fromToken);
  }
  return params;
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

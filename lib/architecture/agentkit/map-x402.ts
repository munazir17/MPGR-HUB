// lib/architecture/agentkit/map-x402.ts
//
// Maps Coinbase AgentKit x402 action JSON into the existing MPGR
// discovery/proposal shapes. Amount, asset, payTo, and scheme are
// copied from AgentKit's 402 payload — never invented. The only
// rewrite is network alias normalization onto the app's CAIP-2 Base
// identifier so the existing parser can accept "base" / "base-mainnet"
// the same way it already accepts "eip155:8453".

import { X402_SUPPORTED_NETWORK } from "@/lib/x402/x402-config";

const BASE_NETWORK_ALIASES = new Set([
  "base",
  "base-mainnet",
  "eip155:8453",
  X402_SUPPORTED_NETWORK,
]);

export interface AgentKitHttpSuccess {
  success: true;
  url: string;
  method: string;
  status: number;
  data?: unknown;
}

export interface AgentKitPaymentOption {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  maxAmountRequired?: unknown;
  amount?: unknown;
  payTo?: unknown;
  resource?: unknown;
  description?: unknown;
  mimeType?: unknown;
  maxTimeoutSeconds?: unknown;
  extra?: unknown;
}

export interface AgentKitHttp402 {
  status: "error_402_payment_required";
  acceptablePaymentOptions?: AgentKitPaymentOption[];
  discoveryInfo?: Record<string, unknown>;
  nextSteps?: unknown;
}

export interface MappedX402Discovery {
  status: number;
  body: unknown | null;
  contentType: string | null;
  finalUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentKitJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { error: true, message: "AgentKit returned a non-JSON result." };
  }
}

/**
 * Wallet-detail actions return plaintext. x402 actions return JSON.
 * Only parse when the payload is actually JSON so a successful
 * get_wallet_details result is not turned into { error: true }.
 */
export function parseAgentKitResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return raw;
  }
  return parseAgentKitJson(raw);
}

export function isAgentKitHttpSuccess(
  value: unknown,
): value is AgentKitHttpSuccess {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.url === "string" &&
    typeof value.status === "number"
  );
}

export function isAgentKitHttp402(value: unknown): value is AgentKitHttp402 {
  return isRecord(value) && value.status === "error_402_payment_required";
}

/**
 * Some AgentKit/CDP versions do not wrap a 402 in the
 * `error_402_payment_required` envelope at all — they instead return the
 * resource server's x402 body verbatim: `{ x402Version, accepts: [...] }`.
 * This is a *successful* discovery, not an error and not "unreachable".
 * Recognize it explicitly instead of falling through to status 0.
 */
export interface AgentKitRawX402 {
  x402Version: number;
  accepts: AgentKitPaymentOption[];
}

export function isAgentKitRawX402(value: unknown): value is AgentKitRawX402 {
  return (
    isRecord(value) &&
    typeof value.x402Version === "number" &&
    Array.isArray(value.accepts)
  );
}

export function isAgentKitErrorPayload(
  value: unknown,
): value is { error: true; message?: string; details?: string } {
  return isRecord(value) && value.error === true;
}

export function normalizeBaseNetwork(network: unknown): string {
  if (typeof network !== "string") return "";
  const trimmed = network.trim();
  if (BASE_NETWORK_ALIASES.has(trimmed) || BASE_NETWORK_ALIASES.has(trimmed.toLowerCase())) {
    return X402_SUPPORTED_NETWORK;
  }
  return trimmed;
}

function copyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Rebuilds an x402 Payment Required body from AgentKit's 402 payload.
 * Payment amounts / recipients / assets are taken from the options
 * AgentKit already extracted from the resource server.
 */
export function agentKit402ToPaymentRequiredBody(
  payload: AgentKitHttp402,
  resourceUrl: string,
): Record<string, unknown> {
  const options = Array.isArray(payload.acceptablePaymentOptions)
    ? payload.acceptablePaymentOptions
    : [];

  const accepts = options.map((option) => {
    const amount =
      copyString(option.maxAmountRequired) ?? copyString(option.amount);

    const mapped: Record<string, unknown> = {
      scheme: copyString(option.scheme) ?? "exact",
      network: normalizeBaseNetwork(option.network),
      asset: copyString(option.asset) ?? "",
      maxAmountRequired: amount ?? "",
      payTo: copyString(option.payTo) ?? "",
      resource: copyString(option.resource) ?? resourceUrl,
    };

    const description = copyString(option.description);
    if (description) mapped.description = description;

    const mimeType = copyString(option.mimeType);
    if (mimeType) mapped.mimeType = mimeType;

    if (
      typeof option.maxTimeoutSeconds === "number" &&
      Number.isFinite(option.maxTimeoutSeconds)
    ) {
      mapped.maxTimeoutSeconds = option.maxTimeoutSeconds;
    }

    if (isRecord(option.extra)) {
      mapped.extra = option.extra;
    }

    return mapped;
  });

  return {
    x402Version: 1,
    accepts,
    ...(payload.discoveryInfo ? { extra: payload.discoveryInfo } : {}),
  };
}

/**
 * Normalizes network aliases inside an already-shaped raw x402 body
 * (`{ x402Version, accepts }`) without altering any other field. Amount,
 * asset, payTo, scheme, resource, etc. are passed through untouched —
 * only the network identifier is rewritten onto the app's CAIP-2 form.
 */
export function normalizeRawX402Body(
  payload: AgentKitRawX402,
): Record<string, unknown> {
  const accepts = payload.accepts.map((option) => {
    if (!isRecord(option)) return option;
    return {
      ...option,
      network: normalizeBaseNetwork(option.network),
    };
  });

  return {
    ...payload,
    accepts,
  };
}

export function mapAgentKitHttpResult(
  parsed: unknown,
  requestedUrl: string,
): MappedX402Discovery {
  if (isAgentKitHttp402(parsed)) {
    return {
      status: 402,
      body: agentKit402ToPaymentRequiredBody(parsed, requestedUrl),
      contentType: "application/json",
      finalUrl: requestedUrl,
    };
  }

  if (isAgentKitRawX402(parsed)) {
    return {
      status: 402,
      body: normalizeRawX402Body(parsed),
      contentType: "application/json",
      finalUrl: requestedUrl,
    };
  }

  if (isAgentKitHttpSuccess(parsed)) {
    return {
      status: parsed.status,
      body: null,
      contentType: null,
      finalUrl: parsed.url || requestedUrl,
    };
  }

  return {
    status: 0,
    body: parsed,
    contentType: "application/json",
    finalUrl: requestedUrl,
  };
}

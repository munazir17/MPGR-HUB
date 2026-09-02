// lib/x402/x402-submit.ts
//
// Server-side paid-resource submission bound to a Redis-confirmed
// proposal. The browser sends only { registrationId, xPayment }.
// Authoritative resource / asset / payTo / amount / domain come from
// the confirmed record — never from client-supplied requirement fields.
//
// Ordering:
//   claim (owner token) → verify → paid GET → consume(owner token)
// A successful upstream response is returned only after consume succeeds.
// If consume fails, this module does not report the payment as finalized.

import {
  type Hex,
  getAddress,
  isAddress,
  recoverTypedDataAddress,
  verifyTypedData,
} from "viem";

import { X402_CHAIN_ID, X402_SUPPORTED_NETWORK, normalizeX402Network } from "./x402-config";
import { assertPublicHttpsUrl } from "./x402-discover";
import {
  claimConfirmedProposal,
  consumeConfirmedProposal,
  X402_PAID_GET_TIMEOUT_MS,
  X402_PROCESSING_LEASE_SECONDS,
  type ConfirmedX402Proposal,
} from "./x402-proposal-store";
import type { X402ExactEvmAuthorization, X402PaymentPayload } from "./x402-types";

export const X402_SUBMIT_MAX_PAYMENT_HEADER_CHARS = 16_384;
export const X402_SUBMIT_MAX_RESPONSE_BYTES = 1_000_000;

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface X402SubmitSuccess {
  ok: true;
  status: number;
  paymentResponse: string | null;
  body: unknown | null;
}

export interface X402SubmitFailure {
  ok: false;
  httpStatus: number;
  code:
    | "INVALID_INPUT"
    | "UNSUPPORTED_SCHEME"
    | "UNSUPPORTED_NETWORK"
    | "UNSUPPORTED_ASSET"
    | "INVALID_AMOUNT"
    | "INVALID_PAY_TO"
    | "REQUIREMENT_CHANGED"
    | "SUBMISSION_FAILED";
  message: string;
}

export type X402SubmitResult = X402SubmitSuccess | X402SubmitFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUintString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function isBytes32Hex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isSignatureHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && value.length >= 132;
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function fail(
  code: X402SubmitFailure["code"],
  message: string,
  httpStatus = 400,
): X402SubmitFailure {
  return { ok: false, httpStatus, code, message };
}

export function decodeXPaymentHeader(raw: unknown): X402PaymentPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > X402_SUBMIT_MAX_PAYMENT_HEADER_CHARS) return null;

  try {
    const decodedJson =
      typeof atob === "function" ? atob(raw) : Buffer.from(raw, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(decodedJson);
    if (!isPlainObject(parsed)) return null;
    if (parsed.scheme !== "exact") return null;
    if (typeof parsed.network !== "string") return null;
    if (
      typeof parsed.x402Version !== "number" ||
      !Number.isInteger(parsed.x402Version) ||
      parsed.x402Version < 1
    ) {
      return null;
    }
    if (!isPlainObject(parsed.payload)) return null;
    const payload = parsed.payload;
    if (typeof payload.signature !== "string" || payload.signature.length === 0) return null;
    if (!isPlainObject(payload.authorization)) return null;
    const auth = payload.authorization;
    if (
      typeof auth.from !== "string" ||
      typeof auth.to !== "string" ||
      typeof auth.value !== "string" ||
      typeof auth.validAfter !== "string" ||
      typeof auth.validBefore !== "string" ||
      typeof auth.nonce !== "string"
    ) {
      return null;
    }
    if (!isAddress(auth.from) || !isAddress(auth.to)) return null;
    if (!isUintString(auth.value) || !isUintString(auth.validAfter) || !isUintString(auth.validBefore)) {
      return null;
    }
    if (!isBytes32Hex(auth.nonce)) return null;

    return {
      x402Version: parsed.x402Version,
      scheme: "exact",
      network: parsed.network,
      payload: {
        signature: payload.signature,
        authorization: {
          from: auth.from,
          to: auth.to,
          value: auth.value,
          validAfter: auth.validAfter,
          validBefore: auth.validBefore,
          nonce: auth.nonce,
        },
      },
    };
  } catch {
    return null;
  }
}

export function parseSubmitBody(
  rawBody: unknown,
): { ok: true; registrationId: string; xPayment: string } | X402SubmitFailure {
  if (!isPlainObject(rawBody)) {
    return fail("INVALID_INPUT", "Submit body must be a JSON object.");
  }
  const registrationId = rawBody.registrationId;
  const xPayment = rawBody.xPayment;
  if (typeof registrationId !== "string" || registrationId.length < 8) {
    return fail("INVALID_INPUT", "A payment registration is required.");
  }
  if (typeof xPayment !== "string" || xPayment.length === 0) {
    return fail("INVALID_INPUT", "A signed payment header is required.");
  }
  if (xPayment.length > X402_SUBMIT_MAX_PAYMENT_HEADER_CHARS) {
    return fail("INVALID_INPUT", "The signed payment header is not usable.");
  }
  return { ok: true, registrationId, xPayment };
}

async function verifyAgainstStoredRecord(
  stored: ConfirmedX402Proposal,
  authorization: X402ExactEvmAuthorization,
  signature: string,
  signedNetwork: string,
): Promise<X402SubmitFailure | { ok: true }> {
  if (normalizeX402Network(signedNetwork) !== stored.network) {
    return fail("REQUIREMENT_CHANGED", "The signed payment does not match the confirmed requirement.");
  }
  if (!addressesEqual(authorization.to, stored.payTo)) {
    return fail("REQUIREMENT_CHANGED", "The signed payment does not match the confirmed requirement.");
  }
  try {
    if (BigInt(authorization.value) !== BigInt(stored.maxAmountRequired)) {
      return fail("REQUIREMENT_CHANGED", "The signed payment does not match the confirmed requirement.");
    }
  } catch {
    return fail("INVALID_AMOUNT", "The payment amount is not valid.");
  }

  if (!isSignatureHex(signature) || !isBytes32Hex(authorization.nonce)) {
    return fail("INVALID_INPUT", "The signed payment header is not usable.");
  }

  let validAfter: bigint;
  let validBefore: bigint;
  let value: bigint;
  try {
    validAfter = BigInt(authorization.validAfter);
    validBefore = BigInt(authorization.validBefore);
    value = BigInt(authorization.value);
  } catch {
    return fail("INVALID_AMOUNT", "The payment amount is not valid.");
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (validAfter > nowSeconds) {
    return fail("INVALID_INPUT", "This payment authorization is not valid yet.");
  }
  if (validBefore <= nowSeconds) {
    return fail("INVALID_INPUT", "This payment authorization has expired.");
  }

  const domain = {
    name: stored.eip712Name,
    version: stored.eip712Version,
    chainId: X402_CHAIN_ID,
    verifyingContract: getAddress(stored.asset),
  };
  const payer = getAddress(authorization.from);
  const message = {
    from: payer,
    to: getAddress(authorization.to),
    value,
    validAfter,
    validBefore,
    nonce: authorization.nonce as Hex,
  };

  try {
    const matchesPayer = await verifyTypedData({
      address: payer,
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature: signature as Hex,
    });
    if (!matchesPayer) {
      return fail("REQUIREMENT_CHANGED", "The signed payment does not match the confirmed requirement.");
    }
    const recovered = await recoverTypedDataAddress({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature: signature as Hex,
    });
    if (!addressesEqual(recovered, authorization.from)) {
      return fail("REQUIREMENT_CHANGED", "The signed payment does not match the confirmed requirement.");
    }
  } catch {
    return fail("REQUIREMENT_CHANGED", "The signed payment does not match the confirmed requirement.");
  }

  if (stored.network !== X402_SUPPORTED_NETWORK) {
    return fail("UNSUPPORTED_NETWORK", "Only Base Mainnet payments can be submitted.");
  }

  return { ok: true };
}

function sanitizeUpstreamBody(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > 8_192 ? null : value;
  }
  if (!isPlainObject(value) && !Array.isArray(value)) return null;
  const json = JSON.stringify(value);
  if (json.length > 8_192) return null;
  if (/x-payment|private key|seed phrase|secret/i.test(json)) return null;
  return value;
}

async function readBoundedBody(response: Response): Promise<unknown | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > X402_SUBMIT_MAX_RESPONSE_BYTES) return null;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > X402_SUBMIT_MAX_RESPONSE_BYTES) return null;
  if (buffer.byteLength === 0) return null;
  const text = new TextDecoder().decode(buffer);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return sanitizeUpstreamBody(text);
  try {
    return sanitizeUpstreamBody(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function paidGetTimeoutMs(): number {
  const leaseBudgetMs = Math.max(1_000, (X402_PROCESSING_LEASE_SECONDS - 5) * 1000);
  return Math.min(X402_PAID_GET_TIMEOUT_MS, leaseBudgetMs);
}

function paidGetSignal(): AbortSignal {
  const ms = paidGetTimeoutMs();
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

function mapStoreFailure(code: string, message: string): X402SubmitFailure {
  if (code === "NOT_FOUND") return fail("INVALID_INPUT", message);
  if (code === "CONSUMED" || code === "BUSY" || code === "STALE_CLAIM") {
    return fail("SUBMISSION_FAILED", message, 409);
  }
  return fail("SUBMISSION_FAILED", message, 503);
}

export async function submitBoundX402Payment(rawBody: unknown): Promise<X402SubmitResult> {
  const parsedBody = parseSubmitBody(rawBody);
  if (!parsedBody.ok) return parsedBody;

  const decoded = decodeXPaymentHeader(parsedBody.xPayment);
  if (!decoded) {
    return fail("INVALID_INPUT", "The signed payment header is not usable.");
  }

  const claimed = await claimConfirmedProposal(parsedBody.registrationId);
  if (!claimed.ok) {
    return mapStoreFailure(claimed.code, claimed.message);
  }

  const stored = claimed.record;
  const verified = await verifyAgainstStoredRecord(
    stored,
    decoded.payload.authorization,
    decoded.payload.signature,
    decoded.network,
  );
  if (!verified.ok) {
    return verified;
  }

  let resourceUrl: URL;
  try {
    resourceUrl = assertPublicHttpsUrl(stored.resource);
  } catch {
    return fail("INVALID_INPUT", "The resource URL is not valid.");
  }

  let response: Response;
  try {
    response = await fetch(resourceUrl, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: paidGetSignal(),
      headers: {
        Accept: "application/json",
        "X-PAYMENT": parsedBody.xPayment,
      },
    });
  } catch (error) {
    console.error("x402 submit: upstream_fetch_failed", { host: resourceUrl.hostname });
    if (isAbortError(error)) {
      return fail(
        "SUBMISSION_FAILED",
        "The resource server did not respond before the payment submission timed out.",
        504,
      );
    }
    return fail(
      "SUBMISSION_FAILED",
      "Could not reach the resource server to submit this payment.",
      502,
    );
  }

  const consumed = await consumeConfirmedProposal(
    parsedBody.registrationId,
    claimed.claimToken,
  );
  if (!consumed.ok) {
    console.error("x402 submit: consume_failed", {
      host: resourceUrl.hostname,
      code: consumed.code,
    });
    return mapStoreFailure(
      consumed.code,
      "The payment request reached the resource, but this registration could not be finalized. It was not marked settled.",
    );
  }

  const paymentResponse =
    response.headers.get("X-PAYMENT-RESPONSE") ?? response.headers.get("x-payment-response");

  let body: unknown | null = null;
  try {
    body = await readBoundedBody(response);
  } catch {
    body = null;
  }

  return {
    ok: true,
    status: response.status,
    paymentResponse,
    body,
  };
}

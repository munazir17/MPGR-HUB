// lib/x402/x402-parse.ts
//
// P3 — parses and validates a 402 response body from an untrusted
// third-party resource server into the app's internal
// X402PaymentRequirements shape.
//
// Supports both:
//   - x402 v1: maxAmountRequired + top-level resource
//   - x402 v2: amount + resource.url and/or extra.resource
//
// IMPORTANT:
// The rest of MPGR HUB intentionally keeps its existing internal
// X402PaymentRequirements shape. This parser is the compatibility
// boundary between protocol wire formats and that internal shape.
//
// This module does NOT:
//   - fetch resources
//   - send payment headers
//   - sign anything
//   - submit anything
//   - build a proposal
//
// It only validates and normalizes an already-fetched 402 JSON body.
//
// Security posture:
// Every field coming from the resource server is treated as untrusted.
// Unsupported networks/assets/schemes are rejected. Amounts must be
// positive integer atomic-unit strings. Payment recipient and asset must
// be valid EVM addresses. EIP-712 domain resolution must succeed before
// an option is considered usable downstream.

import { isAddress } from "viem";

import {
  X402_SUPPORTED_NETWORK,
  X402_SUPPORTED_SCHEMES,
  normalizeX402Network,
  resolveEip712Domain,
} from "./x402-config";

import type {
  X402Error,
  X402PaymentRequirements,
} from "./x402-types";

export interface ParsedX402Requirement {
  requirement: X402PaymentRequirements;

  /**
   * Precomputed during parsing so downstream layers do not have to
   * re-resolve the EIP-712 domain against a possibly changed or
   * partially-validated requirement.
   */
  eip712Domain: ReturnType<typeof resolveEip712Domain>;
}

export type X402ParseResult =
  | {
      ok: true;
      x402Version: number;
      requirements: ParsedX402Requirement[];
    }
  | {
      ok: false;
      error: X402Error;
    };

function err(
  code: X402Error["code"],
  message: string,
): X402ParseResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Protocol amounts are atomic-unit integers.
 *
 * Examples:
 *   "1"
 *   "10000"
 *   "1000000"
 *
 * Reject:
 *   ""
 *   "0"
 *   "00"
 *   "01"
 *   "-1"
 *   "1.5"
 *   "1e6"
 *   numbers
 */
function isPositiveIntegerString(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    /^[0-9]+$/.test(value) &&
    value !== "0" &&
    !value.startsWith("00")
  );
}

/**
 * Extracts an x402 v2 amount.
 *
 * v1:
 *   maxAmountRequired
 *
 * v2:
 *   amount
 *
 * Internally everything remains maxAmountRequired so the existing
 * proposal/execution code does not need to know which wire version
 * produced the requirement.
 */
function getNormalizedAmount(
  raw: Record<string, unknown>,
): string | null {
  const v1Amount = raw.maxAmountRequired;

  if (isPositiveIntegerString(v1Amount)) {
    return v1Amount;
  }

  const v2Amount = raw.amount;

  if (isPositiveIntegerString(v2Amount)) {
    return v2Amount;
  }

  return null;
}

/**
 * Resolves the resource URL across x402 wire formats.
 *
 * v1:
 *   {
 *     resource: "https://..."
 *   }
 *
 * v2 may expose:
 *   {
 *     resource: {
 *       url: "https://..."
 *     }
 *   }
 *
 * Some real-world x402 v2 providers additionally place the resource
 * inside `extra.resource`, so that form is accepted as a compatibility
 * fallback.
 */
function getNormalizedResource(
  raw: Record<string, unknown>,
): string | null {
  const resource = raw.resource;

  if (typeof resource === "string" && resource.length > 0) {
    return resource;
  }

  if (isPlainObject(resource)) {
    const url = resource.url;

    if (typeof url === "string" && url.length > 0) {
      return url;
    }
  }

  const extra = raw.extra;

  if (isPlainObject(extra)) {
    const extraResource = extra.resource;

    if (
      typeof extraResource === "string" &&
      extraResource.length > 0
    ) {
      return extraResource;
    }

    if (isPlainObject(extraResource)) {
      const url = extraResource.url;

      if (typeof url === "string" && url.length > 0) {
        return url;
      }
    }
  }

  return null;
}

/**
 * Validates one payment requirement.
 *
 * Invalid/unsupported entries are filtered out rather than causing the
 * entire 402 response to fail. If every entry is invalid, the caller
 * returns NO_ACCEPTABLE_REQUIREMENT.
 */
function validateRequirement(
  raw: unknown,
): ParsedX402Requirement | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  const {
    scheme,
    network,
    payTo,
    asset,
    description,
    mimeType,
    maxTimeoutSeconds,
    extra,
  } = raw;

  if (
    typeof scheme !== "string" ||
    !(X402_SUPPORTED_SCHEMES as readonly string[]).includes(
      scheme,
    )
  ) {
    return null;
  }

  const normalizedNetwork = normalizeX402Network(network);

  if (normalizedNetwork !== X402_SUPPORTED_NETWORK) {
    return null;
  }

  const maxAmountRequired = getNormalizedAmount(raw);

  if (!maxAmountRequired) {
    return null;
  }

  const resource = getNormalizedResource(raw);

  if (!resource) {
    return null;
  }

  if (
    typeof payTo !== "string" ||
    !isAddress(payTo)
  ) {
    return null;
  }

  if (
    typeof asset !== "string" ||
    !isAddress(asset)
  ) {
    return null;
  }

  if (
    description !== undefined &&
    typeof description !== "string"
  ) {
    return null;
  }

  if (
    mimeType !== undefined &&
    typeof mimeType !== "string"
  ) {
    return null;
  }

  if (
    maxTimeoutSeconds !== undefined &&
    (
      typeof maxTimeoutSeconds !== "number" ||
      !Number.isFinite(maxTimeoutSeconds) ||
      maxTimeoutSeconds <= 0
    )
  ) {
    return null;
  }

  if (
    extra !== undefined &&
    !isPlainObject(extra)
  ) {
    return null;
  }

  /**
   * resolveEip712Domain() is deliberately called only after the
   * requirement's critical fields have been validated.
   *
   * This also ensures an unsupported/unknown asset cannot become a
   * usable payment option merely because it looks like an address.
   */
  const eip712Domain = resolveEip712Domain(
    asset,
    extra as Record<string, unknown> | undefined,
  );

  if (!eip712Domain) {
    return null;
  }

  const requirement: X402PaymentRequirements = {
    scheme:
      scheme as X402PaymentRequirements["scheme"],

    network: normalizedNetwork,

    /**
     * Exact string the resource advertised. Used only when building
     * the outgoing PAYMENT-SIGNATURE / X-PAYMENT payload so v2 PayAI
     * (`eip155:8453`) and v1 Coinbase (`base`) both round-trip.
     */
    wireNetwork:
      typeof network === "string" && network.trim().length > 0
        ? network.trim()
        : normalizedNetwork,

    /**
     * Internal compatibility field.
     *
     * v1 maxAmountRequired and v2 amount both arrive here.
     */
    maxAmountRequired,

    /**
     * Internal compatibility field.
     *
     * v1 resource string, v2 resource.url, and provider
     * extra.resource all normalize here.
     */
    resource,

    payTo,

    asset,

    ...(description !== undefined
      ? { description }
      : {}),

    ...(mimeType !== undefined
      ? { mimeType }
      : {}),

    ...(maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds }
      : {}),

    ...(extra !== undefined
      ? {
          extra:
            extra as Record<string, unknown>,
        }
      : {}),
  };

  return {
    requirement,
    eip712Domain,
  };
}

/**
 * Parses a 402 response body.
 *
 * `rawBody` is the direct result of response.json() from the discovery
 * layer and must therefore be considered completely untrusted.
 */
export function parseX402PaymentRequired(
  rawBody: unknown,
): X402ParseResult {
  if (!isPlainObject(rawBody)) {
    return err(
      "MALFORMED_RESPONSE",
      "The 402 response body was not a JSON object.",
    );
  }

  const {
    x402Version,
    accepts,
  } = rawBody;

  if (
    typeof x402Version !== "number" ||
    !Number.isInteger(x402Version) ||
    x402Version < 1
  ) {
    return err(
      "MALFORMED_RESPONSE",
      "The 402 response body is missing a valid x402Version.",
    );
  }

  if (
    !Array.isArray(accepts) ||
    accepts.length === 0
  ) {
    return err(
      "MALFORMED_RESPONSE",
      "The 402 response body has no `accepts` payment requirements.",
    );
  }

  const requirements = accepts
    .map(validateRequirement)
    .filter(
      (
        requirement,
      ): requirement is ParsedX402Requirement =>
        requirement !== null,
    );

  if (requirements.length === 0) {
    return err(
      "NO_ACCEPTABLE_REQUIREMENT",
      `This resource does not offer a payment option this app supports (scheme "exact", network "${X402_SUPPORTED_NETWORK}", a recognized asset).`,
    );
  }

  return {
    ok: true,
    x402Version,
    requirements,
  };
}

// lib/x402/x402-parse.ts
//
// P3 — parses and validates a 402 response body (untrusted, arbitrary
// JSON from a third-party resource server) into typed
// X402PaymentRequirements. Mirrors buildAgentActionContract()'s own
// posture in agent-action-contract.ts: every field is treated as
// `unknown` until it's individually validated; nothing is assumed to
// already be the right shape.
//
// This module does NOT fetch anything and does NOT build a proposal —
// see x402-proposal.ts for that. It only answers "is this a
// well-formed, acceptable-to-this-app payment requirement", rejecting:
//   - a malformed/non-object response body
//   - an empty or missing `accepts` array
//   - every entry whose scheme/network/asset this app doesn't support
//   - a non-positive or non-integer maxAmountRequired
//   - a payTo that isn't a plausible address

import { isAddress } from "viem";

import { X402_SUPPORTED_NETWORK, X402_SUPPORTED_SCHEMES, resolveEip712Domain } from "./x402-config";
import type { X402Error, X402PaymentRequirements } from "./x402-types";

export interface ParsedX402Requirement {
  requirement: X402PaymentRequirements;
  /** Precomputed here (not re-derived later) so downstream layers never re-run asset-domain resolution against a possibly-stale requirement — see x402-proposal.ts. */
  eip712Domain: ReturnType<typeof resolveEip712Domain>;
}

export type X402ParseResult =
  | { ok: true; x402Version: number; requirements: ParsedX402Requirement[] }
  | { ok: false; error: X402Error };

function err(code: X402Error["code"], message: string): X402ParseResult {
  return { ok: false, error: { code, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Positive-integer decimal string, matching how the protocol wire-encodes atomic-unit amounts (never a float). */
function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value) && value !== "0" && !value.startsWith("00");
}

/**
 * Validates one `accepts[]` entry. Returns null (not a thrown error) for
 * a structurally-invalid or unsupported entry — the caller filters these
 * out rather than failing the whole response for one bad option, unless
 * every option turns out invalid (see parseX402PaymentRequired below).
 */
function validateRequirement(raw: unknown): ParsedX402Requirement | null {
  if (!isPlainObject(raw)) return null;

  const { scheme, network, maxAmountRequired, resource, payTo, asset, description, mimeType, maxTimeoutSeconds, extra } = raw;

  if (typeof scheme !== "string" || !(X402_SUPPORTED_SCHEMES as readonly string[]).includes(scheme)) return null;
  if (typeof network !== "string" || network !== X402_SUPPORTED_NETWORK) return null;
  if (!isPositiveIntegerString(maxAmountRequired)) return null;
  if (typeof resource !== "string" || resource.length === 0) return null;
  if (typeof payTo !== "string" || !isAddress(payTo)) return null;
  if (typeof asset !== "string" || !isAddress(asset)) return null;
  if (description !== undefined && typeof description !== "string") return null;
  if (mimeType !== undefined && typeof mimeType !== "string") return null;
  if (maxTimeoutSeconds !== undefined && (typeof maxTimeoutSeconds !== "number" || maxTimeoutSeconds <= 0)) return null;
  if (extra !== undefined && !isPlainObject(extra)) return null;

  const eip712Domain = resolveEip712Domain(asset, extra as Record<string, unknown> | undefined);
  // An asset this app can't sign an EIP-3009 authorization for (no
  // requirement-supplied domain, not in the known registry) is not a
  // usable option — filtered out here rather than surfaced as a
  // half-usable requirement downstream.
  if (!eip712Domain) return null;

  const requirement: X402PaymentRequirements = {
    scheme: scheme as X402PaymentRequirements["scheme"],
    network,
    maxAmountRequired,
    resource,
    payTo,
    asset,
    ...(description !== undefined ? { description } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds } : {}),
    ...(extra !== undefined ? { extra: extra as Record<string, unknown> } : {}),
  };

  return { requirement, eip712Domain };
}

/**
 * Parses a 402 response body. `rawBody` is whatever `await
 * response.json()` produced — completely untrusted.
 */
export function parseX402PaymentRequired(rawBody: unknown): X402ParseResult {
  if (!isPlainObject(rawBody)) {
    return err("MALFORMED_RESPONSE", "The 402 response body was not a JSON object.");
  }

  const { x402Version, accepts } = rawBody;

  if (typeof x402Version !== "number" || !Number.isInteger(x402Version) || x402Version < 1) {
    return err("MALFORMED_RESPONSE", "The 402 response body is missing a valid x402Version.");
  }

  if (!Array.isArray(accepts) || accepts.length === 0) {
    return err("MALFORMED_RESPONSE", "The 402 response body has no `accepts` payment requirements.");
  }

  const requirements = accepts.map(validateRequirement).filter((r): r is ParsedX402Requirement => r !== null);

  if (requirements.length === 0) {
    return err(
      "NO_ACCEPTABLE_REQUIREMENT",
      `This resource does not offer a payment option this app supports (scheme "exact", network "${X402_SUPPORTED_NETWORK}", a recognized asset).`
    );
  }

  return { ok: true, x402Version, requirements };
}

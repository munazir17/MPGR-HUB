// app/api/x402/register/route.ts
//
// Registers a confirmed x402 payment requirement BEFORE signing.
//
// POST /api/x402/register
//   → SSRF + mainnet/exact/allowlist checks
//   → unauthenticated GET of the resource (no X-PAYMENT)
//   → persist server-observed terms in Redis
//   → return registrationId
//
// Never signs. Never attaches X-PAYMENT. Never logs secrets.

import { isAddress } from "viem";
import { NextResponse } from "next/server";

import {
  KNOWN_X402_ASSET_DOMAINS,
  X402_SUPPORTED_NETWORK,
  X402_SUPPORTED_SCHEMES,
  normalizeX402Network,
} from "@/lib/x402/x402-config";
import {
  assertPublicHttpsUrl,
  discoverX402Resource,
  X402DiscoveryError,
} from "@/lib/x402/x402-discover";
import { parseX402PaymentRequired } from "@/lib/x402/x402-parse";
import { buildDeterministicProposalId } from "@/lib/x402/x402-proposal";
import {
  computeRegistrationTtlSeconds,
  createConfirmedProposal,
  type ConfirmedX402Proposal,
} from "@/lib/x402/x402-proposal-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function jsonError(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value) && value !== "0";
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_INPUT", "Invalid JSON request body.");
  }

  if (!isPlainObject(body) || !isPlainObject(body.requirement)) {
    return jsonError(400, "INVALID_INPUT", "A payment requirement is required.");
  }

  const requirement = body.requirement;
  const resource = requirement.resource;
  const scheme = requirement.scheme;
  const network = requirement.network;
  const asset = requirement.asset;
  const maxAmountRequired = requirement.maxAmountRequired;
  const payTo = requirement.payTo;
  const maxTimeoutSeconds = requirement.maxTimeoutSeconds;

  if (typeof resource !== "string") {
    return jsonError(400, "INVALID_INPUT", "A resource URL is required.");
  }

  let resourceUrl: URL;
  try {
    resourceUrl = assertPublicHttpsUrl(resource);
  } catch (error) {
    if (error instanceof X402DiscoveryError) {
      return jsonError(400, "INVALID_INPUT", "That resource host is not allowed.");
    }
    return jsonError(400, "INVALID_INPUT", "The resource URL is not valid.");
  }

  if (
    typeof scheme !== "string" ||
    !(X402_SUPPORTED_SCHEMES as readonly string[]).includes(scheme)
  ) {
    return jsonError(400, "UNSUPPORTED_SCHEME", 'Only the x402 "exact" scheme is supported.');
  }

  if (normalizeX402Network(network) !== X402_SUPPORTED_NETWORK) {
    return jsonError(400, "UNSUPPORTED_NETWORK", "Only Base Mainnet payments can be registered.");
  }

  if (typeof asset !== "string" || !isAddress(asset) || !KNOWN_X402_ASSET_DOMAINS[asset.toLowerCase()]) {
    return jsonError(400, "UNSUPPORTED_ASSET", "This payment asset is not recognized.");
  }

  if (!isPositiveIntegerString(maxAmountRequired)) {
    return jsonError(400, "INVALID_AMOUNT", "The payment amount is not valid.");
  }

  if (typeof payTo !== "string" || !isAddress(payTo)) {
    return jsonError(400, "INVALID_PAY_TO", "The payment recipient is not valid.");
  }

  let discovered;
  try {
    discovered = await discoverX402Resource(resourceUrl.href);
  } catch (error) {
    if (error instanceof X402DiscoveryError) {
      const status = error.code === "BLOCKED_HOST" || error.code === "INVALID_URL" ? 400 : 502;
      return jsonError(status, error.code, "Could not re-check that resource.");
    }
    return jsonError(502, "RESOURCE_FETCH_FAILED", "Could not re-check that resource.");
  }

  if (discovered.status !== 402) {
    return jsonError(400, "REQUIREMENT_CHANGED", "That resource is not currently requesting payment.");
  }

  const parsed = parseX402PaymentRequired(discovered.body);
  if (!parsed.ok) {
    return jsonError(400, "REQUIREMENT_CHANGED", parsed.error.message);
  }

  const observed = parsed.requirements.find((entry) => {
    const req = entry.requirement;
    return (
      req.scheme === "exact" &&
      normalizeX402Network(req.network) === X402_SUPPORTED_NETWORK &&
      addressesEqual(req.asset, asset) &&
      addressesEqual(req.payTo, payTo) &&
      req.maxAmountRequired === maxAmountRequired &&
      (req.resource === resourceUrl.href || req.resource === resource)
    );
  });

  if (!observed) {
    return jsonError(
      400,
      "REQUIREMENT_CHANGED",
      "The resource no longer matches the confirmed payment requirement.",
    );
  }

  const domain = observed.eip712Domain;
  if (!domain) {
    return jsonError(400, "UNSUPPORTED_ASSET", "This payment asset is not recognized.");
  }

  let storedResourceUrl: URL;
  try {
    storedResourceUrl = assertPublicHttpsUrl(observed.requirement.resource);
  } catch {
    storedResourceUrl = resourceUrl;
  }

  const ttlSeconds = computeRegistrationTtlSeconds(
    typeof maxTimeoutSeconds === "number"
      ? maxTimeoutSeconds
      : observed.requirement.maxTimeoutSeconds,
  );

  const now = new Date();
  const registrationId = crypto.randomUUID();
  const record: ConfirmedX402Proposal = {
    registrationId,
    proposalId: buildDeterministicProposalId({
      resource: storedResourceUrl.href,
      asset: observed.requirement.asset,
      payTo: observed.requirement.payTo,
      maxAmountRequired: observed.requirement.maxAmountRequired,
    }),
    resource: storedResourceUrl.href,
    scheme: "exact",
    network: X402_SUPPORTED_NETWORK,
    x402Version: parsed.x402Version,
    wireNetwork:
      observed.requirement.wireNetwork ?? X402_SUPPORTED_NETWORK,
    asset: observed.requirement.asset,
    maxAmountRequired: observed.requirement.maxAmountRequired,
    payTo: observed.requirement.payTo,
    maxTimeoutSeconds: observed.requirement.maxTimeoutSeconds,
    eip712Name: domain.domain.name,
    eip712Version: domain.domain.version,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    status: "pending",
  };

  const stored = await createConfirmedProposal(record, ttlSeconds);
  if (!stored.ok) {
    const status = stored.code === "UNAVAILABLE" ? 503 : 409;
    return jsonError(status, stored.code, stored.message);
  }

  return NextResponse.json(
    {
      registrationId: stored.record.registrationId,
      proposalId: stored.record.proposalId,
      expiresAt: stored.record.expiresAt,
      eip712Name: stored.record.eip712Name,
      eip712Version: stored.record.eip712Version,
      x402Version: stored.record.x402Version,
      wireNetwork: stored.record.wireNetwork,
    },
    { status: 200, headers: NO_STORE },
  );
}


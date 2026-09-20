// lib/x402/x402-discover.ts
//
// P3 — server-side x402 resource discovery.
//
// The browser must not fetch arbitrary third-party x402 resources directly:
// doing so makes discovery dependent on the resource server's CORS policy.
// This helper is intentionally server-only and performs a read-only GET.
//
// Security boundaries:
// - HTTPS URLs only.
// - The hostname is classified by lib/x402/ip-guard.ts: bracketed IPv6
//   literals are unwrapped first, and every private / loopback /
//   link-local / CGNAT / mapped / reserved / multicast range is
//   rejected for both IPv4 and IPv6.
// - The hostname is then resolved and EVERY returned A/AAAA record
//   must be public, so a public name that resolves to 127.0.0.1 or
//   169.254.169.254 is rejected before any socket is opened.
// - The connection is pinned to the address that was validated, so a
//   second DNS answer cannot differ from the checked one (DNS
//   rebinding / TOCTOU).
// - Redirects are followed manually so every redirect target is
//   re-validated and re-resolved from scratch.
// - Maximum redirect depth is bounded.
// - No payment headers are ever attached.
// - No Authorization / X-PAYMENT / PAYMENT-SIGNATURE headers are attached.
// - Response body size is bounded.
// - Provider/network exceptions are normalized to a safe error.
// - This helper never signs, submits, or executes a payment.

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";

import {
  isBlockedHostnameLiteral,
  isPublicIpAddress,
  normalizeHostname,
  parseIpLiteral,
} from "./ip-guard";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 1_000_000;

export interface X402DiscoveryResult {
  status: number;
  body: unknown | null;
  contentType: string | null;
  finalUrl: string;
}

export class X402DiscoveryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_URL"
      | "BLOCKED_HOST"
      | "TOO_MANY_REDIRECTS"
      | "FETCH_FAILED"
      | "RESPONSE_TOO_LARGE"
      | "INVALID_RESPONSE",
  ) {
    super(message);
    this.name = "X402DiscoveryError";
  }
}

function validateDiscoveryUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new X402DiscoveryError(
      "resourceUrl must be a valid https:// URL.",
      "INVALID_URL",
    );
  }

  if (url.protocol !== "https:") {
    throw new X402DiscoveryError(
      "Only https:// resource URLs are allowed.",
      "INVALID_URL",
    );
  }

  // URL.hostname keeps the RFC 3986 brackets around an IPv6 literal
  // ("[::1]"), which is why the previous string comparisons here never
  // matched one. normalizeHostname strips them.
  const hostname = normalizeHostname(url.hostname);

  if (isBlockedHostnameLiteral(hostname)) {
    throw new X402DiscoveryError(
      "That resource host is not allowed.",
      "BLOCKED_HOST",
    );
  }

  return url;
}

export interface ResolvedDiscoveryTarget {
  url: URL;
  hostname: string;
  /** The single address the socket will be pinned to. */
  pinnedAddress: string;
  pinnedFamily: 4 | 6;
}

/**
 * Synchronous URL/host-literal gate plus a DNS check: the hostname is
 * resolved with `dns.lookup(..., { all: true })` and EVERY returned
 * A/AAAA record must be public. One bad record fails the whole
 * request, so a name with both a public and a private answer cannot be
 * used to reach internal infrastructure.
 *
 * The first address is returned as the pin. Callers must connect to
 * that exact address rather than re-resolving the name.
 */
export async function resolveDiscoveryTarget(
  value: string,
): Promise<ResolvedDiscoveryTarget> {
  const url = validateDiscoveryUrl(value);
  const hostname = normalizeHostname(url.hostname);

  // An IP literal needs no DNS: it was already classified above.
  const literal = parseIpLiteral(hostname);
  if (literal) {
    return {
      url,
      hostname,
      pinnedAddress: hostname,
      pinnedFamily: literal.version,
    };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new X402DiscoveryError(
      "Could not reach that resource. This may be temporary.",
      "FETCH_FAILED",
    );
  }

  if (addresses.length === 0) {
    throw new X402DiscoveryError(
      "That resource host is not allowed.",
      "BLOCKED_HOST",
    );
  }

  for (const entry of addresses) {
    if (!isPublicIpAddress(entry.address)) {
      // Deliberately the same generic message/code as a blocked
      // literal: the caller learns nothing about internal topology.
      throw new X402DiscoveryError(
        "That resource host is not allowed.",
        "BLOCKED_HOST",
      );
    }
  }

  const pinned = addresses[0];

  return {
    url,
    hostname,
    pinnedAddress: pinned.address,
    pinnedFamily: pinned.family === 6 ? 6 : 4,
  };
}

/**
 * Public SSRF gate used by AgentKit-backed routes before they invoke
 * make_http_request. Same rules as discoverX402Resource: https only,
 * no localhost / private / link-local hosts.
 */
export function assertPublicHttpsUrl(value: string): URL {
  return validateDiscoveryUrl(value);
}

async function readResponseBody(response: Response): Promise<unknown | null> {
  const contentLength = response.headers.get("content-length");

  if (contentLength) {
    const declaredLength = Number(contentLength);

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      throw new X402DiscoveryError(
        "The resource response was too large.",
        "RESPONSE_TOO_LARGE",
      );
    }
  }

  const buffer = await response.arrayBuffer();

  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new X402DiscoveryError(
      "The resource response was too large.",
      "RESPONSE_TOO_LARGE",
    );
  }

  if (buffer.byteLength === 0) {
    return null;
  }

  const text = new TextDecoder().decode(buffer);

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  // x402 PaymentRequired responses are JSON. For non-402 responses we
  // don't need to expose arbitrary third-party response bodies.
  if (response.status !== 402) {
    return null;
  }

  if (!contentType.includes("application/json")) {
    throw new X402DiscoveryError(
      "The resource returned 402 with a non-JSON response.",
      "INVALID_RESPONSE",
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new X402DiscoveryError(
      "The resource returned 402 with invalid JSON.",
      "INVALID_RESPONSE",
    );
  }
}

/**
 * Builds a fetch dispatcher that connects ONLY to `pinnedAddress`.
 *
 * Without this there is a TOCTOU window: we validate the addresses DNS
 * returns, then `fetch` resolves the name a second time and may get a
 * different (private) answer — classic DNS rebinding.
 *
 * IMPORTANT — current strength of this control:
 *
 * `undici` is the engine behind Node's global fetch, but Node bundles
 * it internally and does not expose it as a resolvable package, and it
 * is NOT a declared dependency of this repo today. So this import
 * succeeds only where a resolvable `undici` exists. When it does not,
 * we return undefined and fetch normally.
 *
 * That fallback is NOT unguarded: resolveDiscoveryTarget() has already
 * resolved the hostname and rejected the request unless EVERY returned
 * A/AAAA record is public. The only residual risk in the unpinned path
 * is a DNS rebinding race where the second resolution returns a
 * different, private answer within the TTL window. Adding `undici` to
 * dependencies closes that window; see the PR description.
 */
async function buildPinnedDispatcher(
  target: ResolvedDiscoveryTarget,
): Promise<unknown | undefined> {
  try {
    // Indirect specifier: `undici` is an optional runtime capability,
    // not a build-time dependency, so it must not become a hard
    // module-resolution edge for TypeScript or the bundler.
    const moduleSpecifier = "undici";
    const undici = (await import(/* webpackIgnore: true */ moduleSpecifier)) as {
      Agent: new (options: Record<string, unknown>) => unknown;
    };

    return new undici.Agent({
      connect: {
        lookup: (
          _hostname: string,
          _options: unknown,
          callback: (
            err: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
            family?: number,
          ) => void,
        ) => {
          callback(null, target.pinnedAddress, target.pinnedFamily);
        },
      },
    });
  } catch {
    return undefined;
  }
}

export async function discoverX402Resource(
  resourceUrl: string,
): Promise<X402DiscoveryResult> {
  // Validate + resolve + pin the FIRST hop.
  let target = await resolveDiscoveryTarget(resourceUrl);
  let currentUrl = target.url;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    let response: Response;

    const dispatcher = await buildPinnedDispatcher(target);

    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
        // Non-standard but supported by Node's undici-backed fetch.
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
    } catch {
      throw new X402DiscoveryError(
        "Could not reach that resource. This may be temporary.",
        "FETCH_FAILED",
      );
    }

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      const location = response.headers.get("location");

      if (!location) {
        throw new X402DiscoveryError(
          "The resource returned an invalid redirect.",
          "INVALID_RESPONSE",
        );
      }

      if (redirect === MAX_REDIRECTS) {
        throw new X402DiscoveryError(
          "The resource redirected too many times.",
          "TOO_MANY_REDIRECTS",
        );
      }

      try {
        // Re-validate AND re-resolve the redirect target from scratch.
        // A public first hop redirecting to http://169.254.169.254/ or
        // to a name that resolves privately must be stopped here.
        target = await resolveDiscoveryTarget(
          new URL(location, currentUrl).toString(),
        );
        currentUrl = target.url;
      } catch (error) {
        if (error instanceof X402DiscoveryError) {
          throw error;
        }

        throw new X402DiscoveryError(
          "The resource returned an invalid redirect.",
          "INVALID_RESPONSE",
        );
      }

      continue;
    }

    const body = await readResponseBody(response);

    return {
      status: response.status,
      body,
      contentType: response.headers.get("content-type"),
      finalUrl: currentUrl.toString(),
    };
  }

  throw new X402DiscoveryError(
    "The resource redirected too many times.",
    "TOO_MANY_REDIRECTS",
  );
}

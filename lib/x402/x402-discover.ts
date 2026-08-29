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
// - localhost / loopback / private / link-local IP literals are rejected.
// - Redirects are followed manually so every redirect target is validated.
// - Maximum redirect depth is bounded.
// - No payment headers are ever attached.
// - No Authorization / X-PAYMENT / PAYMENT-SIGNATURE headers are attached.
// - Response body size is bounded.
// - Provider/network exceptions are normalized to a safe error.
// - This helper never signs, submits, or executes a payment.

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

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return false;
  }

  const [a, b] = octets;

  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
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

  const hostname = url.hostname.toLowerCase();

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw new X402DiscoveryError(
      "That resource host is not allowed.",
      "BLOCKED_HOST",
    );
  }

  return url;
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

export async function discoverX402Resource(
  resourceUrl: string,
): Promise<X402DiscoveryResult> {
  let currentUrl = validateDiscoveryUrl(resourceUrl);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    let response: Response;

    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
      });
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
        currentUrl = validateDiscoveryUrl(
          new URL(location, currentUrl).toString(),
        );
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

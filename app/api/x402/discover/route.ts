// app/api/x402/discover/route.ts
//
// Same-origin server-side x402 discovery.
//
// Onchain path:
//   POST /api/x402/discover
//     → Coinbase AgentKit make_http_request (read-only)
//     → Base-gated x402 402 payload
//
// This route remains discovery-only:
// - no wallet access
// - no signing
// - no X-PAYMENT
// - no payment submission
// - no Authorization header forwarding
//
// SSRF checks from x402-discover.ts still run before AgentKit is
// invoked. The existing x402_discover_resource / x402_prepare_payment
// tools keep this URL as their backend.
//
// AgentKit is loaded with a native dynamic import() INSIDE POST's
// try/catch. A static import would evaluate @coinbase/agentkit →
// @coinbase/cdp-sdk CJS jwt.js → require("jose") at module init,
// which throws ERR_REQUIRE_ESM on Vercel before this handler (and
// the native fallback) can run. The lazy import makes that failure
// catchable and equivalent to PROVIDER_ERROR.

import { NextResponse } from "next/server";
import { readJsonBody, requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";

import {
  assertPublicHttpsUrl,
  discoverX402Resource,
  X402DiscoveryError,
  type X402DiscoveryResult,
} from "@/lib/x402/x402-discover";

function discoveryResponse(result: X402DiscoveryResult, requestId: string) {
  return withRequestId(
    NextResponse.json(
      {
        status: result.status,
        body: result.body,
        contentType: result.contentType,
        finalUrl: result.finalUrl,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    ),
    requestId,
  );
}

function discoveryErrorResponse(error: X402DiscoveryError, requestId: string) {
  const status =
    error.code === "INVALID_URL" || error.code === "BLOCKED_HOST" ? 400 : 502;

  return withRequestId(
    NextResponse.json(
      { error: error.message, code: error.code },
      { status, headers: { "Cache-Control": "no-store" } },
    ),
    requestId,
  );
}

/**
 * Fallback discovery, used ONLY when AgentKit did not represent the
 * resource's response in a recognized shape (neither a plain HTTP
 * success nor a 402 payload we understand) or reported its own
 * provider-level error. This is still a read-only GET through the
 * same SSRF-gated discoverX402Resource() used elsewhere — it does not
 * bypass any security boundary, it does not attach payment headers,
 * and it never signs or submits anything. It exists so that an
 * AgentKit wire-shape gap does not get reported to the user as
 * "resource unreachable" when the resource is, in fact, reachable.
 */
async function fallbackNativeDiscovery(resourceUrl: string, requestId: string) {
  try {
    const result = await discoverX402Resource(resourceUrl);
    return discoveryResponse(result, requestId);
  } catch (error) {
    if (error instanceof X402DiscoveryError) {
      return discoveryErrorResponse(error, requestId);
    }
    return withRequestId(
      NextResponse.json(
        {
          error: "Could not reach that resource. This may be temporary.",
          code: "FETCH_FAILED",
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      ),
      requestId,
    );
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DiscoverRequestBody {
  resourceUrl?: unknown;
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = parsedBody.value as DiscoverRequestBody;

  if (typeof body.resourceUrl !== "string") {
    return withRequestId(
      NextResponse.json(
        {
          error: "resourceUrl must be a string.",
        },
        { status: 400 },
      ),
      requestId,
    );
  }

  try {
    assertPublicHttpsUrl(body.resourceUrl);

    const {
      invokeAgentKitAction,
      isAgentKitErrorPayload,
      mapAgentKitHttpResult,
    } = await import("@/lib/architecture/agentkit");

    const invoked = await invokeAgentKitAction({
      actionName: "make_http_request",
      args: {
        url: body.resourceUrl,
        method: "GET",
      },
    });

    if (!invoked.ok) {
      // ACTION_DENIED / INVALID_INPUT / ACTION_UNKNOWN are policy or
      // config problems, not "is the resource reachable" problems —
      // falling back would not help and could mask a real
      // misconfiguration, so those are still returned directly.
      // PROVIDER_ERROR is the ambiguous case: AgentKit itself failed,
      // which may mean the resource is genuinely down, or may mean
      // AgentKit choked on interpreting a 402. Only that case falls
      // back to a direct read-only GET.
      if (invoked.code !== "PROVIDER_ERROR") {
        const status =
          invoked.code === "INVALID_INPUT"
            ? 400
            : invoked.code === "ACTION_DENIED"
              ? 403
              : 502;
        return withRequestId(
          NextResponse.json(
            { error: invoked.error, code: invoked.code },
            { status, headers: { "Cache-Control": "no-store" } },
          ),
          requestId,
        );
      }

      return fallbackNativeDiscovery(body.resourceUrl, requestId);
    }

    if (isAgentKitErrorPayload(invoked.result)) {
      // AgentKit wrapped the call in its own error envelope. This is
      // still ambiguous between "resource is actually down" and
      // "AgentKit couldn't represent this response" — fall back to a
      // direct read-only GET rather than reporting unreachable.
      return fallbackNativeDiscovery(body.resourceUrl, requestId);
    }

    const mapped = mapAgentKitHttpResult(invoked.result, body.resourceUrl);

    if (mapped.status === 0) {
      // Neither a recognized success nor a recognized 402 shape.
      // Confirm directly instead of assuming the resource is down.
      return fallbackNativeDiscovery(body.resourceUrl, requestId);
    }

    return discoveryResponse(mapped, requestId);
  } catch (error) {
    if (error instanceof X402DiscoveryError) {
      return discoveryErrorResponse(error, requestId);
    }

    // Includes AgentKit/CDP module-load failures (ERR_REQUIRE_ESM
    // from cdp-sdk CJS require("jose")) and any throw from
    // invokeAgentKitAction. Same handling as PROVIDER_ERROR: a
    // read-only native GET, never payment.
    return fallbackNativeDiscovery(body.resourceUrl, requestId);
  }
}

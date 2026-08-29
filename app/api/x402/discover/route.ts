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

import { NextResponse } from "next/server";

import {
  invokeAgentKitAction,
  isAgentKitErrorPayload,
  mapAgentKitHttpResult,
} from "@/lib/architecture/agentkit";
import {
  assertPublicHttpsUrl,
  X402DiscoveryError,
} from "@/lib/x402/x402-discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DiscoverRequestBody {
  resourceUrl?: unknown;
}

export async function POST(request: Request) {
  let body: DiscoverRequestBody;

  try {
    body = (await request.json()) as DiscoverRequestBody;
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON request body.",
      },
      { status: 400 },
    );
  }

  if (typeof body.resourceUrl !== "string") {
    return NextResponse.json(
      {
        error: "resourceUrl must be a string.",
      },
      { status: 400 },
    );
  }

  try {
    assertPublicHttpsUrl(body.resourceUrl);

    const invoked = await invokeAgentKitAction({
      actionName: "make_http_request",
      args: {
        url: body.resourceUrl,
        method: "GET",
      },
    });

    if (!invoked.ok) {
      const status =
        invoked.code === "INVALID_INPUT"
          ? 400
          : invoked.code === "ACTION_DENIED"
            ? 403
            : 502;

      return NextResponse.json(
        {
          error: invoked.error,
          code: invoked.code,
        },
        {
          status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    if (isAgentKitErrorPayload(invoked.result)) {
      return NextResponse.json(
        {
          error:
            typeof invoked.result.message === "string"
              ? invoked.result.message
              : "Could not reach that resource. This may be temporary.",
          code: "FETCH_FAILED",
        },
        {
          status: 502,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const mapped = mapAgentKitHttpResult(
      invoked.result,
      body.resourceUrl,
    );

    if (mapped.status === 0) {
      return NextResponse.json(
        {
          error: "Could not reach that resource. This may be temporary.",
          code: "FETCH_FAILED",
        },
        {
          status: 502,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    return NextResponse.json(
      {
        status: mapped.status,
        body: mapped.body,
        contentType: mapped.contentType,
        finalUrl: mapped.finalUrl,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof X402DiscoveryError) {
      const status =
        error.code === "INVALID_URL" || error.code === "BLOCKED_HOST"
          ? 400
          : 502;

      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        {
          status,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    return NextResponse.json(
      {
        error: "Could not reach that resource. This may be temporary.",
        code: "FETCH_FAILED",
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}

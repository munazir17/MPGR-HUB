// app/api/x402/discover/route.ts
//
// P3 — same-origin server-side x402 discovery endpoint.
//
// Browser:
//   POST /api/x402/discover
//
// Server:
//   GET https://third-party-resource
//
// This exists specifically so x402 discovery does not depend on the
// third-party resource's CORS policy.
//
// This route is discovery-only:
// - no wallet access
// - no signing
// - no X-PAYMENT
// - no payment submission
// - no Authorization header forwarding
//
// The downstream agent tool remains `mode: "read"`.

import { NextResponse } from "next/server";

import {
  discoverX402Resource,
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
    const result = await discoverX402Resource(body.resourceUrl);

    return NextResponse.json(
      {
        status: result.status,
        body: result.body,
        contentType: result.contentType,
        finalUrl: result.finalUrl,
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

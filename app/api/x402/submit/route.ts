// app/api/x402/submit/route.ts
//
// Same-origin server-side x402 paid-resource submission.
//
// Browser path:
//   wallet signs EIP-712 authorization
//     → POST /api/x402/submit { xPayment, requirement }
//     → this route attaches X-PAYMENT and GETs the bound resource
//
// This route:
// - never signs
// - never invents a payment
// - never calls make_http_request_with_x402
// - never logs the X-PAYMENT value
// - rejects Base Sepolia and unbound/mismatched requirements
//
// It is not a generic URL proxy. The resource is taken only from the
// confirmed requirement after scheme/network/asset/amount/payTo checks
// against the signed header.

import { NextResponse } from "next/server";

import { submitBoundX402Payment } from "@/lib/x402/x402-submit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body.", code: "INVALID_INPUT" },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await submitBoundX402Payment(body);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: result.httpStatus, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      status: result.status,
      paymentResponse: result.paymentResponse,
      body: result.body,
    },
    { status: 200, headers: NO_STORE },
  );
}

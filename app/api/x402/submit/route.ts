// app/api/x402/submit/route.ts
//
// Same-origin paid submission.
// Accepts only { registrationId, xPayment }.
// Resource and payment terms are loaded from the Redis-confirmed record.

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

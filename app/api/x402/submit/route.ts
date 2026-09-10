// app/api/x402/submit/route.ts
//
// Same-origin paid submission.
// Accepts only { registrationId, xPayment }.
// Resource and payment terms are loaded from the Redis-confirmed record.

import { NextResponse } from "next/server";
import { protectApiRequest, readJsonBody, withRequestId } from "@/lib/api/request-guard";

import { submitBoundX402Payment } from "@/lib/x402/x402-submit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const guard = await protectApiRequest(request, "x402-submit", 20, 60);
  const requestId = guard.requestId;
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), guard.requestId);
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body: unknown = parsedBody.value;

  const result = await submitBoundX402Payment(body);

  if (!result.ok) {
    return json(
      { error: result.message, code: result.code },
      { status: result.httpStatus, headers: NO_STORE },
    );
  }

  return json(
    {
      status: result.status,
      paymentResponse: result.paymentResponse,
      body: result.body,
    },
    { status: 200, headers: NO_STORE },
  );
}

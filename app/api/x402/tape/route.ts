// app/api/x402/tape/route.ts
//
// GET /api/x402/tape — the ONE real x402 paid endpoint.
//
//   Unpaid          → 402 + standard x402 payment requirements
//                     (USDC on Base, 0.02 by default via
//                     X402_TAPE_PRICE_USDC_RAW, network eip155:8453,
//                     description "MPGR / Base Stocks live tape snapshot")
//   Paid + verified → 200 with the exact /api/market/tape body plus
//                     { paid: true, paymentTx } and the base64
//                     X-PAYMENT-RESPONSE settlement header
//   Bad payment     → 402 (fail closed, reason in body.error)
//   Facilitator down→ 503 (no free tape, no lost payment)
//
// Open to unauthenticated agents — that is the point of x402. The
// payment itself is the auth. Payment verification + settlement live in
// lib/x402/x402-tape-resource.ts.

import { NextResponse } from "next/server";

import { getTapeSnapshot, tapeCacheTtlSeconds } from "@/lib/markets/tape";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import {
  buildTapePaymentRequiredBody,
  buildTapePaymentRequirement,
  processTapeXPayment,
  tapeResourceUrl,
  x402TapePayTo,
} from "@/lib/x402/x402-tape-resource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Paid endpoint: agents retry with a payment header, so the budget is
// tighter than the free tape but still allows the 402 → pay → 200 loop.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

function paymentHeaderFrom(request: Request): string | null {
  return (
    request.headers.get("x-payment") ??
    request.headers.get("payment-signature") ??
    request.headers.get("x-payment-signature")
  );
}

function paymentRequiredResponse(
  request: Request,
  status: 402,
  reason?: string,
): NextResponse {
  const payTo = x402TapePayTo();
  // payTo is checked by the caller before this is reachable.
  const body = buildTapePaymentRequiredBody(
    tapeResourceUrl(request),
    payTo!,
    reason,
  );
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body), "utf-8").toString("base64"),
    },
  });
}

export async function GET(request: Request) {
  const rate = await checkRateLimit(
    `${clientIpFromRequest(request)}:x402-tape`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const payTo = x402TapePayTo();
  if (!payTo) {
    // Fail closed: without a recipient we cannot sell the tape, and we
    // will not serve it for free either.
    return NextResponse.json(
      {
        error: "The paid tape endpoint is not configured (missing X402_TAPE_PAY_TO).",
        code: "X402_TAPE_UNCONFIGURED",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const xPayment = paymentHeaderFrom(request);
  if (!xPayment) {
    return paymentRequiredResponse(request, 402);
  }

  const requirement = buildTapePaymentRequirement(tapeResourceUrl(request), payTo);
  const result = await processTapeXPayment(xPayment, requirement);

  if (!result.ok) {
    if (result.code === "FACILITATOR_UNAVAILABLE") {
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return paymentRequiredResponse(request, 402, result.message);
  }

  try {
    const snapshot = await getTapeSnapshot();
    const ttl = tapeCacheTtlSeconds();
    return NextResponse.json(
      { ...snapshot, paid: true, paymentTx: result.settlement.transaction ?? null },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "X-PAYMENT-RESPONSE": result.paymentResponseHeader,
          "X-TAPE-CACHE-SECONDS": String(ttl),
        },
      },
    );
  } catch {
    // Payment settled but the resource failed — surface 502 with the
    // settlement header so the payer can see the tx and request support.
    return NextResponse.json(
      { error: "Live tape is temporarily unavailable.", code: "TAPE_UNAVAILABLE" },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
          "X-PAYMENT-RESPONSE": result.paymentResponseHeader,
        },
      },
    );
  }
}

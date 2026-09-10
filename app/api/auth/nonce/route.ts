import { NextResponse } from "next/server";
import { enforceRateLimit, requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { issueNonce } from "@/lib/auth/nonce";
import { NONCE_COOKIE, NONCE_TTL_SECONDS, getAppOrigin } from "@/lib/auth/config";
import { SUPPORTED_CHAIN_ID } from "@/lib/auth/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const rateError = await enforceRateLimit(request, "auth-nonce", 20, 60);
  if (rateError) return withRequestId(rateError, requestId);

  try {
    const value = await issueNonce();
    const origin = getAppOrigin(request.url);
    const response = NextResponse.json({
      nonce: value.nonce,
      issuedAt: value.issuedAt,
      expirationTime: value.expirationTime,
      chainId: SUPPORTED_CHAIN_ID,
      origin,
    });
    response.cookies.set(NONCE_COOKIE, value.nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: NONCE_TTL_SECONDS,
    });
    return withRequestId(response, requestId);
  } catch (error) {
    console.error("GET /api/auth/nonce failed", error);
    return withRequestId(
      NextResponse.json({ error: "Unable to issue authentication nonce." }, { status: 503 }),
      requestId,
    );
  }
}

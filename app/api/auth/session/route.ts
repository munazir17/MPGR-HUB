import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";

// Read-only session check. This performs no signature verification and
// mutates nothing — it only reports whether the request's existing
// httpOnly session cookie (minted by /api/auth/verify) is still valid.
// It exists so the client can ask "is this wallet already signed in?"
// before ever prompting for a new SIWE signature. The server-signed
// session cookie remains the sole source of truth: this route can only
// ever confirm a session that /api/auth/verify already created, never
// create or extend one itself.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const session = await authenticateRequest(request);
  const body = session
    ? {
        authenticated: true as const,
        wallet: session.wallet,
        expiresAt: new Date(session.expiresAt * 1000).toISOString(),
      }
    : { authenticated: false as const };
  return withRequestId(
    NextResponse.json(body, { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }),
    requestId
  );
}

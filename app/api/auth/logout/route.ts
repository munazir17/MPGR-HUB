import { NextResponse } from "next/server";
import { SESSION_COOKIE, getAuthCookieAttributes } from "@/lib/auth/config";
import { getSessionFromRequest } from "@/lib/auth/session";
import { revokeSession } from "@/lib/auth/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Logout revokes the server-side session record (Task 6) so the cookie
// value stops working everywhere, then clears the browser cookie. Revocation
// is best-effort from the caller's point of view: the cookie is cleared
// even if Redis is unreachable, and a cookie without a live record is
// already rejected by authenticateRequest.
export async function POST(request: Request) {
  const session = getSessionFromRequest(request);
  if (session) {
    try {
      await revokeSession(session);
    } catch (error) {
      console.error("POST /api/auth/logout could not revoke session", error);
    }
  }
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE, "", { ...getAuthCookieAttributes(), maxAge: 0 });
  return response;
}

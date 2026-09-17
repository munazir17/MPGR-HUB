import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { readCookieValue } from "@/lib/api/cookies";
import {
  enforceRateLimit,
  requestIdFromRequest,
  verifyTrustedOrigin,
  withRequestId,
} from "@/lib/api/request-guard";
import {
  AGENT_VISITOR_COOKIE,
  AGENT_VISITOR_COOKIE_MAX_AGE_SECONDS,
  getAgentVisitorCount,
  isAgentVisitorId,
  recordAgentVisitor,
} from "@/lib/agent/agent-visitor-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

function cookieAttrs() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: AGENT_VISITOR_COOKIE_MAX_AGE_SECONDS,
  };
}

function jsonCount(count: number | null): NextResponse {
  if (count === null) {
    return NextResponse.json({ error: "Visitor count is unavailable." }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ count }, { headers: NO_STORE });
}

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const count = await getAgentVisitorCount();
  return withRequestId(jsonCount(count), requestId);
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const rateError = await enforceRateLimit(request, "agent-visitors", 10, 60);
  if (rateError) return withRequestId(rateError, requestId);

  const session = getSessionFromRequest(request);
  const existingCookie = readCookieValue(request.headers.get("cookie") ?? "", AGENT_VISITOR_COOKIE);
  let visitorCookie = existingCookie && isAgentVisitorId(existingCookie) ? existingCookie : null;
  if (!visitorCookie) visitorCookie = crypto.randomUUID();

  const identity = session?.wallet ? `wallet:${session.wallet.toLowerCase()}` : `anon:${visitorCookie}`;
  const count = await recordAgentVisitor(identity);
  const response = jsonCount(count);
  if (count !== null) {
    response.cookies.set(AGENT_VISITOR_COOKIE, visitorCookie, cookieAttrs());
  }
  return withRequestId(response, requestId);
}

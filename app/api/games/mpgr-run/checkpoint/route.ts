import { NextResponse } from "next/server";
import { protectApiRequest, readJsonBody, withRequestId } from "@/lib/api/request-guard";
import type { Address } from "viem";
import { getSessionFromRequest } from "@/lib/auth/session";
import { recordGameHeartbeat } from "@/lib/games/mpgr-run/server-session";
import { MPGR_RUN_GAME_ID } from "@/lib/games/mpgr-run/run-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await protectApiRequest(request, "game-checkpoint", 30, 60);
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), guard.requestId);
  const auth = getSessionFromRequest(request);
  if (!auth) return json({ error: "Authentication required" }, { status: 401 });
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, guard.requestId);
  const body = parsedBody.value;
  const sessionId = body && typeof body === "object" ? (body as { sessionId?: unknown }).sessionId : null;
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 128) {
    return json({ error: "Invalid game session" }, { status: 400 });
  }
  const session = await recordGameHeartbeat(sessionId, auth.wallet as Address, MPGR_RUN_GAME_ID);
  if (!session) return json({ error: "Invalid or expired game session" }, { status: 401 });
  return json({ ok: true, expiresAt: session.expiresAt }, { headers: { "Cache-Control": "no-store" } });
}

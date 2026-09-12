import { NextResponse } from "next/server";
import { protectApiRequest, withRequestId } from "@/lib/api/request-guard";
import type { Address } from "viem";
import { getSessionFromRequest } from "@/lib/auth/session";
import { createServerGameSession, TooManyActiveSessionsError } from "@/lib/games/mpgr-run/server-session";
import { MPGR_RUN_GAME_ID } from "@/lib/games/mpgr-run/run-config";
import { randomUUID } from "node:crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const guard = await protectApiRequest(request, "game-session", 10, 60);
  const requestId = guard.requestId;
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), guard.requestId);
  const auth = getSessionFromRequest(request);
  if (!auth) return json({ error: "Authentication required" }, { status: 401 });
  const sessionId = randomUUID();
  try {
    const session = await createServerGameSession(auth.wallet as Address, MPGR_RUN_GAME_ID, sessionId);
    return json({
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      seed: session.seed,
      protocolVersion: session.protocolVersion,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TooManyActiveSessionsError) {
      return json({ error: "Too many active game sessions. Finish or let an existing run expire first." }, { status: 429 });
    }
    throw error;
  }
}

import { NextResponse } from "next/server";
import { protectApiRequest, readJsonBody, withRequestId } from "@/lib/api/request-guard";
import type { Address } from "viem";
import { getSessionFromRequest } from "@/lib/auth/session";
import { awardServerXP } from "@/lib/rewards/xp-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["WALLET_CONNECTED", "DAILY_CHECK_IN"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const session = getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const guard = await protectApiRequest(request, "xp", 30, 60);
  const requestId = guard.requestId;
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), guard.requestId);
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body: unknown = parsedBody.value;
  if (!body || typeof body !== "object") return json({ error: "Invalid request" }, { status: 400 });
  const value = body as Record<string, unknown>;
  const action = value.action;
  if (typeof action !== "string" || !ALLOWED.has(action)) return json({ error: "Unsupported XP event" }, { status: 400 });
  const eventId = action === "WALLET_CONNECTED" ? "wallet-connected" : `daily-check-in:${new Date().toISOString().slice(0, 10)}`;
  if (action === "DAILY_CHECK_IN" && !DATE_RE.test(eventId.slice(-10))) return json({ error: "Invalid date" }, { status: 400 });
  const result = await awardServerXP(session.wallet as Address, action as "WALLET_CONNECTED" | "DAILY_CHECK_IN", eventId);
  return json(result, { headers: { "Cache-Control": "no-store" } });
}

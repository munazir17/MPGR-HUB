import { NextResponse } from "next/server";
import { protectApiRequest, readJsonBody, requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import type { Address } from "viem";
import { getSessionFromRequest } from "@/lib/auth/session";
import { awardServerXP, getServerWalletStanding } from "@/lib/rewards/xp-ledger";
import { referralStore } from "@/lib/referral/referral-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["WALLET_CONNECTED", "DAILY_CHECK_IN"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const session = getSessionFromRequest(request);
  if (!session) {
    return withRequestId(NextResponse.json({ error: "Authentication required" }, { status: 401, headers: NO_STORE }), requestId);
  }
  const standing = await getServerWalletStanding(session.wallet as Address);
  const referrals = await referralStore.getReferralCount(session.wallet);
  return withRequestId(
    NextResponse.json(
      {
        wallet: session.wallet.toLowerCase(),
        xp: standing?.xp ?? 0,
        seasonPoints: standing?.seasonPoints ?? 0,
        rank: standing?.rank ?? null,
        referrals,
        source: "server-ledger",
      },
      { headers: NO_STORE },
    ),
    requestId,
  );
}

export async function POST(request: Request) {
  const session = getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: NO_STORE });
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
  const standing = await getServerWalletStanding(session.wallet as Address);
  return json(
    {
      ...result,
      rank: standing?.rank ?? null,
      source: "server-ledger",
    },
    { headers: NO_STORE },
  );
}

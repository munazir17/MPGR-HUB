// app/api/referral/route.ts
//
// Persistent, server-side referral attribution (see
// lib/referral/referral-store.ts). Extends the existing REFERRAL_SUCCESS
// XP action / referralCount field already defined in lib/xp-engine.ts —
// this route is the missing piece that actually records who referred
// whom, server-side, so the count can't be reset by clearing the
// browser and can't be inflated by reconnecting the same wallet.
//
// GET  ?wallet=0x...              -> { count: number }
// POST { referrer, referred }     -> registers the referral once, idempotently
//
// Runs on Node (not Edge) since it uses @upstash/redis.

import { NextResponse } from "next/server";
import { protectApiRequest, readJsonBody, withRequestId } from "@/lib/api/request-guard";
import { referralStore } from "@/lib/referral/referral-store";
import { getSessionFromRequest } from "@/lib/auth/session";
import { awardServerXP } from "@/lib/rewards/xp-ledger";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: Request) {
  const session = getSessionFromRequest(request);
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");

  if (!wallet || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  if (!session || session.wallet.toLowerCase() !== wallet.toLowerCase()) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  try {
    const count = await referralStore.getReferralCount(wallet);
    return NextResponse.json({ count });
  } catch (error) {
    console.error("GET /api/referral failed:", error);
    return NextResponse.json({ error: "Failed to load referral count" }, { status: 500 });
  }
}

interface ReferralRequestBody {
  referrer: string;
  referred: string;
}

function isValidShape(value: unknown): value is ReferralRequestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.referrer === "string" && typeof body.referred === "string";
}

export async function POST(request: Request) {
  const guard = await protectApiRequest(request, "referral", 20, 60);
  const requestId = guard.requestId;
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), guard.requestId);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isValidShape(body)) {
    return json(
      { error: "Body must be { referrer: 0x-address, referred: 0x-address }" },
      { status: 400 }
    );
  }

  const session = getSessionFromRequest(request);
  if (!session) return json({ error: "Authentication required" }, { status: 401 });
  if (session.wallet.toLowerCase() !== body.referred.toLowerCase()) return json({ error: "Referred wallet must match authenticated wallet" }, { status: 403 });

  try {
    const result = await referralStore.registerReferral(body.referrer, session.wallet);
    if (result.status === "registered") {
      try { await awardServerXP(body.referrer as `0x${string}`, "REFERRAL_SUCCESS", `referral:${session.wallet.toLowerCase()}`); }
      catch (error) { console.error("Referral XP ledger update failed", error); }
    }
    return json(result);
  } catch (error) {
    console.error("POST /api/referral failed:", error);
    return json({ error: "Failed to register referral" }, { status: 500 });
  }
}

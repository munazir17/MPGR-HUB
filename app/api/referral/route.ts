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
import { referralStore } from "@/lib/referral/referral-store";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet");

  if (!wallet || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isValidShape(body)) {
    return NextResponse.json(
      { error: "Body must be { referrer: 0x-address, referred: 0x-address }" },
      { status: 400 }
    );
  }

  try {
    const result = await referralStore.registerReferral(body.referrer, body.referred);
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/referral failed:", error);
    return NextResponse.json({ error: "Failed to register referral" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getRankedWallets, getServerWalletStanding, getRankedWalletCount } from "@/lib/rewards/xp-ledger";
import { referralStore } from "@/lib/referral/referral-store";
import { getSessionFromRequest } from "@/lib/auth/session";
import type { Address } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
const headers = { "Cache-Control": "no-store, no-cache, must-revalidate" };
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const walletParam = searchParams.get("wallet");
  if (walletParam && !ADDRESS_RE.test(walletParam)) return NextResponse.json({ error: "Invalid wallet address" }, { status: 400, headers });
  const session = getSessionFromRequest(request);
  if (walletParam && (!session || session.wallet.toLowerCase() !== walletParam.toLowerCase())) {
    return NextResponse.json({ error: "Authentication required for wallet standing" }, { status: 401, headers });
  }
  try {
    const ranked = await getRankedWallets(50);
    const top = await Promise.all(ranked.map(async (entry, index) => ({ wallet: entry.wallet, rank: index + 1, xp: entry.xp, seasonPoints: entry.seasonPoints, referrals: await referralStore.getReferralCount(entry.wallet) })));
    let me = null;
    if (walletParam) {
      const standing = await getServerWalletStanding(walletParam as Address);
      if (standing) me = { ...standing, referrals: await referralStore.getReferralCount(walletParam) };
    }
    const totalRanked = await getRankedWalletCount();
    return NextResponse.json({ top, me, totalRanked }, { headers });
  } catch (error) {
    console.error("GET /api/leaderboard failed", error);
    return NextResponse.json({ error: "Failed to load leaderboard" }, { status: 500, headers });
  }
}

export async function POST() {
  return NextResponse.json({ error: "Leaderboard writes are server-owned; use verified XP events." }, { status: 410, headers });
}

import { NextResponse } from "next/server";
import { reconcileSettlement } from "@/lib/reward-allocation/settlement-reconciliation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function authorized(request: Request) { const secret = process.env.CRON_SECRET; return !!secret && request.headers.get("authorization") === `Bearer ${secret}`; }
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const weekKey = new URL(request.url).searchParams.get("week");
  if (!weekKey || !/^\d{4}-W\d{2}$/.test(weekKey)) return NextResponse.json({ error: "Invalid week" }, { status: 400 });
  try { return NextResponse.json(await reconcileSettlement(weekKey), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { console.error("Settlement reconciliation failed", error); return NextResponse.json({ error: "Settlement reconciliation failed" }, { status: 500 }); }
}

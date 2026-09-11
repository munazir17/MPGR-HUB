import { NextResponse } from "next/server";
import { reconcileSettlement } from "@/lib/reward-allocation/settlement-reconciliation";
import { getPreviousWeekKey } from "@/lib/reward-allocation/settlement-engine";
import { requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!authorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const weekKey = new URL(request.url).searchParams.get("week");
  if (!weekKey || !/^\d{4}-W\d{2}$/.test(weekKey)) return json({ error: "Invalid week" }, { status: 400 });
  try {
    return json(await reconcileSettlement(weekKey), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Settlement reconciliation failed", error);
    return json({ error: "Settlement reconciliation failed" }, { status: 500 });
  }
}

// GET is what Vercel Cron invokes (Vercel Cron sends GET, not POST — the
// POST handler above is unreachable by a cron schedule). Same auth, same
// validation, same underlying reconcileSettlement() call as POST — this
// is still confirmation-only: reconcileSettlement() only inspects
// on-chain vault state for an already-"allocating" settlement and never
// originates a payment (it never calls allocateRewardsBatch). The only
// difference from POST is that an omitted `week` defaults to the
// previous ISO week, via the same getPreviousWeekKey() helper the
// settlement route itself uses, instead of requiring the caller to pass
// one — which is what lets this be put on an unattended cron schedule.
export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!authorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const requestedWeek = new URL(request.url).searchParams.get("week");
  const weekKey = requestedWeek ?? getPreviousWeekKey(new Date());
  if (!/^\d{4}-W\d{2}$/.test(weekKey)) return json({ error: "Invalid week" }, { status: 400 });
  try {
    return json(await reconcileSettlement(weekKey), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Settlement reconciliation failed", error);
    return json({ error: "Settlement reconciliation failed" }, { status: 500 });
  }
}

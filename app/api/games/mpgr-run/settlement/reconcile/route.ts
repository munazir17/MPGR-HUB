import { NextResponse } from "next/server";
import { reconcileSettlement } from "@/lib/reward-allocation/settlement-reconciliation";
import { getPreviousWeekKey } from "@/lib/reward-allocation/settlement-engine";
import { requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { kvAllocationStore } from "@/lib/reward-allocation/kv-allocation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long a settlement may sit in "allocating" (i.e. reconciliation ran
// and still couldn't confirm every payable reward on-chain) before this
// route treats it as stuck and surfaces an alert, rather than silently
// reporting "reconciled: true, confirmed: 0" forever. Ops-tunable via
// env. See docs/SETTLEMENT_RECOVERY_RUNBOOK.md for the manual recovery
// procedure — this route deliberately does not attempt one itself (see
// the "Known limitation" note in settlement/route.ts: auto-retrying an
// "allocating" settlement risks a double on-chain allocation).
const STUCK_ALLOCATING_THRESHOLD_MS = Number(
  process.env.SETTLEMENT_STUCK_THRESHOLD_MS ?? 2 * 60 * 60 * 1000 // 2 hours
);

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

async function reconcileAndCheckStuck(weekKey: string) {
  const result = await reconcileSettlement(weekKey);
  const settlement = await kvAllocationStore.getWeeklySettlement(weekKey);

  if (settlement?.status === "allocating") {
    const ageMs = Date.now() - new Date(settlement.updatedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= STUCK_ALLOCATING_THRESHOLD_MS) {
      // Deliberately a single, distinct, grep-able error-level line so
      // any log-based alerting (Vercel log drains, Sentry, Datadog,
      // etc.) can match on "SETTLEMENT_STUCK_ALLOCATING" and page
      // someone. This does not retry or auto-recover anything.
      console.error("SETTLEMENT_STUCK_ALLOCATING", {
        weekKey,
        ageMs,
        thresholdMs: STUCK_ALLOCATING_THRESHOLD_MS,
        runbook: "docs/SETTLEMENT_RECOVERY_RUNBOOK.md",
      });
      return {
        ...result,
        alert: true,
        staleForMs: ageMs,
        runbook: "docs/SETTLEMENT_RECOVERY_RUNBOOK.md",
      };
    }
  }

  return { ...result, alert: false };
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!authorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const weekKey = new URL(request.url).searchParams.get("week");
  if (!weekKey || !/^\d{4}-W\d{2}$/.test(weekKey)) return json({ error: "Invalid week" }, { status: 400 });
  try {
    return json(await reconcileAndCheckStuck(weekKey), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Settlement reconciliation failed", error);
    return json({ error: "Settlement reconciliation failed" }, { status: 500 });
  }
}

// GET is what Vercel Cron invokes (Vercel Cron sends GET, not POST — the
// POST handler above is unreachable by a cron schedule). Same auth, same
// validation, same underlying reconcileAndCheckStuck() call as POST —
// this is still confirmation-only: reconcileSettlement() only inspects
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
    return json(await reconcileAndCheckStuck(weekKey), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Settlement reconciliation failed", error);
    return json({ error: "Settlement reconciliation failed" }, { status: 500 });
  }
}

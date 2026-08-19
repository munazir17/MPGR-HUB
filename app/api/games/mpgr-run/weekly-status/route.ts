// app/api/games/mpgr-run/weekly-status/route.ts
//
// Game Rewards Module — read-only weekly competitive status for a
// wallet. Backs the "Weekly Game Rewards" panel (see section 26 of the
// master handoff prompt): runs this week, best score, eligibility, and
// — once a week has been settled — the actual on-chain-confirmed
// allocation. Never returns a guaranteed/estimated MPGR figure for an
// unsettled week; allocatedAmountRaw/rewardId/allocationTxHash are only
// non-null once allocationStatus is "allocated".

import { NextResponse } from "next/server";
import type { Address } from "viem";
import { kvAllocationStore } from "@/lib/reward-allocation/kv-allocation-store";
import { getWeekKey } from "@/lib/reward-allocation/settlement-engine";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const wallet = url.searchParams.get("wallet");

  if (!wallet || !ADDRESS_RE.test(wallet)) {
    return NextResponse.json({ error: "Query param 'wallet' must be a valid 0x address." }, { status: 400 });
  }

  const weekKey = getWeekKey(new Date());
  const record = await kvAllocationStore.getPlayerWeekRecord(wallet.toLowerCase() as Address, weekKey);

  if (!record) {
    return NextResponse.json({
      weekKey,
      validRunCount: 0,
      bestScore: 0,
      eligibilityStatus: "pending" as const,
      allocationStatus: "none" as const,
      allocatedAmountRaw: null,
      rewardId: null,
      allocationTxHash: null,
    });
  }

  return NextResponse.json({
    weekKey,
    validRunCount: record.validRunCount,
    bestScore: record.bestScore,
    eligibilityStatus: record.eligibilityStatus,
    allocationStatus: record.allocationStatus,
    allocatedAmountRaw: record.allocationStatus === "allocated" ? record.allocatedAmountRaw?.toString() ?? null : null,
    rewardId: record.allocationStatus === "allocated" ? record.rewardId?.toString() ?? null : null,
    allocationTxHash: record.allocationStatus === "allocated" ? record.allocationTxHash : null,
  });
}

// app/api/games/mpgr-run/settlement/route.ts
//
// Game Rewards Module — weekly competitive settlement. Protected: only
// callable with the correct CRON_SECRET bearer token, which is exactly
// what Vercel Cron sends automatically when CRON_SECRET is configured
// (see vercel.json + docs/GAME_REWARDS_SETUP.md). Not reachable from the
// client app.
//
// Idempotent by construction: WeeklySettlement.status is only ever
// advanced via CAS (upsertWeeklySettlement's expectedStatus), so a
// second concurrent/retried invocation for the same week either no-ops
// (status already past where it would act) or safely resumes. See the
// "Known limitation" note near the bottom for the one gap this does NOT
// fully close (a crash between broadcasting the allocation tx and
// persisting its result).

import { NextResponse } from "next/server";
import type { Address } from "viem";
import { kvAllocationStore } from "@/lib/reward-allocation/kv-allocation-store";
import type { PlayerWeekRecord, WeeklySettlement } from "@/lib/reward-allocation/allocation-types";
import {
  computeAllocations,
  computeRawWeight,
  computeWeeklyPool,
  getPreviousWeekKey,
  getWeekBounds,
  remainingGamesBudget,
} from "@/lib/reward-allocation/settlement-engine";
import { vaultSeasonLookup } from "@/lib/reward-allocation/reward-vault-season-mapping";
import { rewardVaultAdminClient } from "@/lib/reward-vault/reward-vault-admin-client";

export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // never allow an unconfigured endpoint to run
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

async function runSettlement(weekKeyOverride?: string) {
  const weekKey = weekKeyOverride ?? getPreviousWeekKey(new Date());
  const { weekStart, weekEnd } = getWeekBounds(weekKey);

  const existing = await kvAllocationStore.getWeeklySettlement(weekKey);

  if (existing && (existing.status === "finalized" || existing.status === "aborted")) {
    return { weekKey, status: existing.status, alreadyDone: true, settlement: existing };
  }
  if (existing && (existing.status === "allocating")) {
    // A previous invocation is (or was) mid-flight. Do not attempt a
    // second on-chain call — see the "Known limitation" note below.
    return {
      weekKey,
      status: existing.status,
      alreadyDone: false,
      settlement: existing,
      note: "Settlement is already in the 'allocating' state. Manually verify on-chain state via getUserRewardIds before retrying, to avoid a possible double allocation.",
    };
  }

  // --- 1/2. identify + freeze the week --------------------------------
  let settlement: WeeklySettlement =
    existing ??
    (await kvAllocationStore.upsertWeeklySettlement(
      {
        seasonId: null,
        weekKey,
        status: "closed",
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        eligiblePlayerCount: 0,
        weeklyPoolRaw: null,
        totalAllocatedRaw: null,
        rewardIds: [],
        allocationTxHashes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      undefined
    ));

  if (settlement.status === "open") {
    settlement = await kvAllocationStore.upsertWeeklySettlement(
      { ...settlement, status: "closed", updatedAt: new Date().toISOString() },
      "open"
    );
  }

  if (settlement.status !== "closed" && settlement.status !== "computed") {
    return { weekKey, status: settlement.status, alreadyDone: false, settlement };
  }

  // --- 4. load eligible players ------------------------------------------
  const eligiblePlayers = await kvAllocationStore.listEligiblePlayersForWeek(weekKey);

  if (eligiblePlayers.length === 0) {
    const finalized = await kvAllocationStore.upsertWeeklySettlement(
      {
        ...settlement,
        status: "finalized",
        eligiblePlayerCount: 0,
        weeklyPoolRaw: 0n,
        totalAllocatedRaw: 0n,
        updatedAt: new Date().toISOString(),
      },
      settlement.status
    );
    return { weekKey, status: "finalized", alreadyDone: false, settlement: finalized, reason: "No eligible players this week." };
  }

  // --- 5. resolve + verify vault season -----------------------------------
  const seasonLookup = await vaultSeasonLookup.resolveActiveVaultSeasonId();
  if (!seasonLookup || !seasonLookup.exists || seasonLookup.finalized) {
    const aborted = await kvAllocationStore.upsertWeeklySettlement(
      { ...settlement, status: "aborted", updatedAt: new Date().toISOString() },
      settlement.status
    );
    return {
      weekKey,
      status: "aborted",
      alreadyDone: false,
      settlement: aborted,
      reason: seasonLookup
        ? `Vault season ${seasonLookup.seasonId} ${seasonLookup.finalized ? "is already finalized" : "does not exist"}.`
        : "Could not resolve a candidate vault season.",
      requiredManualAction: seasonLookup && !seasonLookup.exists
        ? `Vault owner must call createSeason(${seasonLookup.seasonId}, <startTimeSeconds>, <endTimeSeconds>) on ${process.env.NEXT_PUBLIC_REWARD_VAULT_ADDRESS ?? "the deployed MPGRRewardVault"} before settlement can allocate.`
        : undefined,
    };
  }
  const seasonId = seasonLookup.seasonId;

  // --- 6/7/8. weights, pool, per-player amounts --------------------------
  const rawWeights = eligiblePlayers.map((p) => ({ wallet: p.wallet, rawWeight: computeRawWeight(p) }));

  const [ledgerTotal, availableBalance] = await Promise.all([
    kvAllocationStore.getTreasuryLedgerTotal("GAME"),
    rewardVaultAdminClient.getAvailableBalance(),
  ]);
  const remainingBudget = remainingGamesBudget(ledgerTotal);
  const weeklyPoolRaw = computeWeeklyPool(remainingBudget, availableBalance);

  const allocations = computeAllocations(rawWeights, weeklyPoolRaw);
  const totalAllocatedRaw = allocations.reduce((sum, a) => sum + a.amountRaw, 0n);

  // --- 9. invariants -------------------------------------------------------
  if (totalAllocatedRaw > weeklyPoolRaw || totalAllocatedRaw > remainingBudget || totalAllocatedRaw > availableBalance) {
    const aborted = await kvAllocationStore.upsertWeeklySettlement(
      { ...settlement, status: "aborted", updatedAt: new Date().toISOString() },
      settlement.status
    );
    return { weekKey, status: "aborted", alreadyDone: false, settlement: aborted, reason: "Computed allocation failed a budget invariant check." };
  }

  const payable = allocations.filter((a) => a.amountRaw > 0n);

  // --- 11. persist "computed" ------------------------------------------
  settlement = await kvAllocationStore.upsertWeeklySettlement(
    {
      ...settlement,
      seasonId,
      status: "computed",
      eligiblePlayerCount: eligiblePlayers.length,
      weeklyPoolRaw,
      totalAllocatedRaw,
      updatedAt: new Date().toISOString(),
    },
    settlement.status
  );

  const weightByWallet = new Map(allocations.map((a) => [a.wallet, a] as const));
  await Promise.all(
    eligiblePlayers.map((p) => {
      const alloc = weightByWallet.get(p.wallet);
      const updated: PlayerWeekRecord = {
        ...p,
        seasonId,
        weight: alloc?.normalizedWeight ?? 0,
        allocatedAmountRaw: alloc?.amountRaw ?? 0n,
        allocationStatus: (alloc?.amountRaw ?? 0n) > 0n ? "pending" : p.allocationStatus,
      };
      return kvAllocationStore.upsertPlayerWeekRecord(updated, p.allocationStatus);
    })
  );

  if (payable.length === 0) {
    const finalized = await kvAllocationStore.upsertWeeklySettlement(
      { ...settlement, status: "finalized", updatedAt: new Date().toISOString() },
      "computed"
    );
    return { weekKey, status: "finalized", alreadyDone: false, settlement: finalized, reason: "No player cleared the minimum meaningful allocation." };
  }

  // --- 12. verify signer authorization ------------------------------------
  const authorized = await rewardVaultAdminClient.verifyRewardManagerAuthorized();
  if (!authorized) {
    const aborted = await kvAllocationStore.upsertWeeklySettlement(
      { ...settlement, status: "aborted", updatedAt: new Date().toISOString() },
      "computed"
    );
    return {
      weekKey,
      status: "aborted",
      alreadyDone: false,
      settlement: aborted,
      reason: "Configured signer is not an authorized rewardManager on the vault.",
      requiredManualAction: `Vault owner must call setRewardManager(${rewardVaultAdminClient.getSignerAddress()}, true).`,
    };
  }

  // --- 12/13. allocate on-chain --------------------------------------------
  settlement = await kvAllocationStore.upsertWeeklySettlement(
    { ...settlement, status: "allocating", updatedAt: new Date().toISOString() },
    "computed"
  );

  const users = payable.map((a) => a.wallet as Address);
  const amounts = payable.map((a) => a.amountRaw);
  const rewardTypes = payable.map(() => 0); // RewardType.GAME

  let allocateResult;
  try {
    allocateResult = await rewardVaultAdminClient.allocateRewardsBatch(seasonId, users, amounts, rewardTypes);
  } catch (err) {
    // Leave status "allocating" — see the Known limitation note. Do NOT
    // mark aborted (a partial/unknown on-chain outcome must never be
    // silently discarded), do NOT retry automatically within this
    // invocation.
    return {
      weekKey,
      status: "allocating",
      alreadyDone: false,
      settlement,
      error: err instanceof Error ? err.message : String(err),
      note: "allocateRewardsBatch did not confirm successfully. Manually verify on-chain state before the next cron run retries.",
    };
  }

  // --- 14/15/16. persist confirmed results --------------------------------
  await Promise.all(
    payable.map((a, i) =>
      kvAllocationStore.upsertPlayerWeekRecord(
        {
          ...eligiblePlayers.find((p) => p.wallet === a.wallet)!,
          seasonId,
          weight: a.normalizedWeight,
          allocatedAmountRaw: a.amountRaw,
          allocationStatus: "allocated",
          rewardId: allocateResult.rewardIds[i],
          allocationTxHash: allocateResult.txHash,
        },
        "pending"
      )
    )
  );

  await kvAllocationStore.recordTreasuryLedgerEntry("GAME", totalAllocatedRaw);

  const finalized = await kvAllocationStore.upsertWeeklySettlement(
    {
      ...settlement,
      status: "finalized",
      rewardIds: allocateResult.rewardIds,
      allocationTxHashes: [allocateResult.txHash],
      updatedAt: new Date().toISOString(),
    },
    "allocating"
  );

  return { weekKey, status: "finalized", alreadyDone: false, settlement: finalized };
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const url = new URL(request.url);
  const weekKeyOverride = url.searchParams.get("weekKey") ?? undefined;
  try {
    const outcome = await runSettlement(weekKeyOverride);
    return NextResponse.json(serializable(outcome));
  } catch (err) {
    console.error("Weekly settlement failed", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}

// bigint -> string for JSON response bodies.
function serializable<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

// --- Known limitation ------------------------------------------------------
//
// Between "allocating" being persisted and allocateRewardsBatch's
// receipt being confirmed, a hard crash / function timeout can leave a
// settlement stuck in "allocating" with an unknown real-world outcome
// (transaction may have landed, may not have). This route deliberately
// does NOT auto-retry an "allocating" settlement (see the check at the
// top of runSettlement) — auto-retrying here risks a double allocation,
// which is strictly worse than a paused settlement. Recovery is a manual
// step: check getUserRewardIds(wallet) / getReward(rewardId) for the
// affected wallets against what PlayerWeekRecord.allocatedAmountRaw
// expected, then either mark the settlement "finalized" (if the batch
// did land) or reset it to "computed" (if it did not) before the next
// cron invocation. This is a genuine, disclosed gap — true exactly-once
// delivery across an arbitrary crash requires either a durable
// transactional outbox or idempotent on-chain replay protection the
// vault contract itself doesn't provide (allocateRewardsBatch has no
// idempotency key), and building either is beyond what this task's
// existing infrastructure (no queue, no DB beyond KV) supports today.

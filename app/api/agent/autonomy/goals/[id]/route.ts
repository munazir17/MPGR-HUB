import { isLiveAutonomyPair } from "@/lib/autonomy/chat-draft";
// app/api/agent/autonomy/goals/[id]/route.ts
//
// Per-goal user control (spec §18): inspect, pause, resume, edit limits,
// cancel — plus the full audit trail for the goal. Every mutation is a CAS
// through the goal state machine; invalid transitions are refused with 409.

import { autonomyStatus } from "@/lib/autonomy";
import { readAutonomousEmergencySwitch } from "@/lib/autonomy/emergency-switch";
import { findLiveSlotBoundToGoal, serverSlotToLike } from "@/lib/autonomy/draft-activation";
import { validateNewSlotAgainstPolicy } from "@/lib/autonomy/delegated-authorization";
import { NextResponse } from "next/server";

import { verifyTrustedOrigin, readJsonBody, requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { isAutonomousAgentEnabled, AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { publicActionRecord, publicAuditEvent, publicGoal, requireWallet, system } from "@/lib/autonomy/api-helpers";
import { parseBaseUnits } from "@/lib/autonomy/policy-engine";
import type { GoalStatus } from "@/lib/autonomy/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUIDish = /^[a-z0-9_]{4,80}$/i;

type RouteContext = { params: Promise<{ id: string }> };

async function loadOwnedGoal(request: Request, id: string) {
  const auth = await requireWallet(request);
  if (!auth) return { error: "AUTH_REQUIRED" as const };
  const goal = await system().store.getGoal(id);
  if (!goal || goal.wallet.toLowerCase() !== auth.wallet.toLowerCase()) return { error: "GOAL_NOT_FOUND" as const };
  return { auth, goal };
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!isAutonomousAgentEnabled()) return json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const { id } = await context.params;
  if (!UUIDish.test(id)) return json({ error: "Invalid goal id.", code: "INVALID_GOAL_ID" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const loaded = await loadOwnedGoal(request, id);
  if ("error" in loaded) {
    return json(
      { error: loaded.error === "AUTH_REQUIRED" ? "Authentication required" : "Goal not found.", code: loaded.error },
      { status: loaded.error === "AUTH_REQUIRED" ? 401 : 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const store = system().store;
    const [audit, records] = await Promise.all([store.listAudit(id), store.listActionRecords(id)]);
    return json(
      { goal: publicGoal(loaded.goal), audit: audit.map(publicAuditEvent), actions: records.map(publicActionRecord) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return json({ error: "Goal store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!isAutonomousAgentEnabled()) return json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const { id } = await context.params;
  if (!UUIDish.test(id)) return json({ error: "Invalid goal id.", code: "INVALID_GOAL_ID" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const loaded = await loadOwnedGoal(request, id);
  if ("error" in loaded) {
    return json(
      { error: loaded.error === "AUTH_REQUIRED" ? "Authentication required" : "Goal not found.", code: loaded.error },
      { status: loaded.error === "AUTH_REQUIRED" ? 401 : 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (loaded.goal.pendingExecution) {
    return json(
      { error: "A transaction is being verified for this goal — it cannot change until verification completes.", code: "VERIFICATION_IN_PROGRESS" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = (parsedBody.value && typeof parsedBody.value === "object" ? parsedBody.value : {}) as Record<string, unknown>;
  const action = body.action;

  const store = system().store;
  const now = new Date();
  const nowIso = now.toISOString();
  const auditType = { PAUSE: "GOAL_PAUSED", RESUME: "GOAL_RESUMED", CANCEL: "GOAL_CANCELLED" } as const;

  try {
    if (action === "activate" || action === "resume") {
      // A session/policy grant is NOT token permission. Only persisted,
      // live slots for this exact goal may make a draft runnable.
      const readiness = autonomyStatus();
      if (!readiness.executionAvailable || readiness.emergencyDisabled || !(await readAutonomousEmergencySwitch()).allowed) {
        return json({ error: "Execution readiness is not confirmed; goal remains inactive.", code: "EXECUTION_NOT_READY" }, { status: 503 });
      }
      const goal = loaded.goal;
      const policy = await store.getPolicy(goal.policyId);
      if (!policy || (policy.chainId === 8453 && !isLiveAutonomyPair(policy.sellToken, policy.buyToken)) || readiness.delegated.chainId !== policy.chainId || (policy.chainId === 8453 && readiness.productionGate !== true) || policy.wallet.toLowerCase() !== loaded.auth.wallet.toLowerCase() ||
          !(new Date(goal.expiresAt).getTime() > now.getTime())) {
        return json({ error: "Goal or policy has expired or is unavailable.", code: "AUTHORIZATION_REQUIRED" }, { status: 409 });
      }
      const saved = await system().slots.listSlots(loaded.auth.wallet.toLowerCase(), policy.id);
      const valid = saved.filter((slot) => slot.goalId === id && !validateNewSlotAgainstPolicy(slot, policy));
      const coverage = findLiveSlotBoundToGoal([{ ...policy, revokedAt: policy.revokedAt ?? null }], valid.map(serverSlotToLike), { id, ...goal.trade }, now);
      if (!coverage) return json({ error: "A live authorization bound to this goal is required.", code: "AUTHORIZATION_REQUIRED" }, { status: 409 });
      // Retrying a confirmed activation does not create another goal.
      if (action === "activate" && goal.status === "ACTIVE") return json({ goal: publicGoal(goal) }, { headers: { "Cache-Control": "no-store" } });
      const updated = await store.transitionGoal(id, loaded.auth.wallet.toLowerCase(), action === "activate" ? ["DRAFT"] : ["PAUSED"], goal.updatedAt,
        { status: "ACTIVE", updatedAt: nowIso, nextEvaluationAt: nowIso, lastAction: action });
      if (!updated) return json({ error: "Goal state changed; reload before retrying.", code: "INVALID_TRANSITION" }, { status: 409 });
      await store.appendAudit({ at: nowIso, type: "GOAL_RESUMED", goalId: id, wallet: loaded.auth.wallet, data: { action } }, AUTONOMY_LIMITS.maxAuditEventsPerGoal);
      return json({ goal: publicGoal(updated) }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "pause" || action === "cancel") {
      const to: GoalStatus = action === "pause" ? "PAUSED" : "CANCELLED";
      const from: readonly GoalStatus[] =
        action === "pause" ? ["ACTIVE", "WAITING"] : ["ACTIVE", "WAITING", "PAUSED", "DRAFT"];
      const updated = await store.transitionGoal(id, loaded.auth.wallet.toLowerCase(), from, loaded.goal.updatedAt, {
        status: to,
        updatedAt: nowIso,
        nextEvaluationAt: loaded.goal.nextEvaluationAt,
        lastAction: action,
      });
      if (!updated) return json({ error: "Goal state does not allow this action.", code: "INVALID_TRANSITION" }, { status: 409, headers: { "Cache-Control": "no-store" } });
      await store.appendAudit({ at: nowIso, type: auditType[action.toUpperCase() as keyof typeof auditType], goalId: id, wallet: loaded.auth.wallet }, AUTONOMY_LIMITS.maxAuditEventsPerGoal);
      return json({ goal: publicGoal(updated) }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "limits") {
      // Editable while not executing: cooldown floor, trade cap (still
      // bounded by the policy), maxTrades. Pair/tokens are NOT editable —
      // they derive from the authorization policy.
      const patch: { cooldownSeconds?: number; maxTrades?: number | null; updatedAt: string } = { updatedAt: nowIso };
      if (body.cooldownSeconds !== undefined) {
        const raw = Number(body.cooldownSeconds);
        if (!Number.isFinite(raw)) return json({ error: "cooldownSeconds must be a number.", code: "INVALID_INPUT" }, { status: 400, headers: { "Cache-Control": "no-store" } });
        patch.cooldownSeconds = Math.min(Math.max(Math.floor(raw), AUTONOMY_LIMITS.minCooldownSeconds), AUTONOMY_LIMITS.maxCooldownSeconds);
      }
      if (body.maxTrades !== undefined) {
        if (body.maxTrades === null) patch.maxTrades = null;
        else if (typeof body.maxTrades === "number" && Number.isInteger(body.maxTrades) && body.maxTrades > 0 && body.maxTrades <= 1000) patch.maxTrades = body.maxTrades;
        else return json({ error: "maxTrades must be a positive integer or null.", code: "INVALID_INPUT" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      if (body.sellAmount !== undefined) {
        return json({ error: "Changing the per-trade amount requires cancelling and recreating the goal with the same policy.", code: "AMOUNT_FIXED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      void parseBaseUnits; // keep import surface honest for future amount edits behind a policy bump
      const updated = await store.transitionGoal(id, loaded.auth.wallet.toLowerCase(), ["ACTIVE", "WAITING", "PAUSED"], loaded.goal.updatedAt, patch);
      if (!updated) return json({ error: "Goal state does not allow editing right now.", code: "INVALID_TRANSITION" }, { status: 409, headers: { "Cache-Control": "no-store" } });
      await store.appendAudit({ at: nowIso, type: "GOAL_UPDATED", goalId: id, wallet: loaded.auth.wallet, data: { action: "limits" } }, AUTONOMY_LIMITS.maxAuditEventsPerGoal);
      return json({ goal: publicGoal(updated) }, { headers: { "Cache-Control": "no-store" } });
    }

    return json({ error: "Unknown action.", code: "INVALID_ACTION" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  } catch {
    return json({ error: "Goal store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!isAutonomousAgentEnabled()) return json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const { id } = await context.params;
  if (!UUIDish.test(id)) return json({ error: "Invalid goal id.", code: "INVALID_GOAL_ID" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const loaded = await loadOwnedGoal(request, id);
  if ("error" in loaded) {
    return json(
      { error: loaded.error === "AUTH_REQUIRED" ? "Authentication required" : "Goal not found.", code: loaded.error },
      { status: loaded.error === "AUTH_REQUIRED" ? 401 : 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (loaded.goal.pendingExecution) {
    return json(
      { error: "A transaction is being verified for this goal — it cannot be cancelled until verification completes.", code: "VERIFICATION_IN_PROGRESS" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const nowIso = new Date().toISOString();
    const updated = await system().store.transitionGoal(
      id,
      loaded.auth.wallet.toLowerCase(),
      ["ACTIVE", "WAITING", "PAUSED", "DRAFT"],
      loaded.goal.updatedAt,
      { status: "CANCELLED", updatedAt: nowIso, lastAction: "cancelled by user" },
    );
    if (!updated) return json({ error: "Goal state does not allow cancellation.", code: "INVALID_TRANSITION" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    await system().store.appendAudit({ at: nowIso, type: "GOAL_CANCELLED", goalId: id, wallet: loaded.auth.wallet }, AUTONOMY_LIMITS.maxAuditEventsPerGoal);
    return json({ goal: publicGoal(updated) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return json({ error: "Goal store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

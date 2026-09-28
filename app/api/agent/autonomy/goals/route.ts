// app/api/agent/autonomy/goals/route.ts
//
// Autonomous goals (spec §8/§18). Session-scoped: a wallet sees and
// controls ONLY its own goals.
//
// GET   list goals (+ recent action records for execution history)
// POST  create a goal bound to an EXISTING authorized policy. The goal's
//       trade pair comes from the POLICY (never from the request), the
//       condition is normalized deterministically, and the goal starts
//       ACTIVE only while the policy is live — otherwise DRAFT.

import { NextResponse } from "next/server";
import { getAddress } from "viem";

import { BASE_MAINNET_CHAIN_ID, MPGR_EXECUTOR_DEPLOYMENTS } from "@/lib/executor/executor-config";
import { verifyTrustedOrigin, readJsonBody, requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { checkRateLimit } from "@/lib/trade/trade-rate-limit";
import { isAutonomousAgentEnabled, AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { normalizeCondition, parseBaseUnits } from "@/lib/autonomy/policy-engine";
import { publicActionRecord, publicGoal, publicPolicy, requireWallet, system } from "@/lib/autonomy/api-helpers";
import { AUTONOMY_CHAIN_ID, type AgentGoal, type AutonomyPolicy } from "@/lib/autonomy/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

const UUIDish = /^[a-z0-9_]{4,80}$/i;

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!isAutonomousAgentEnabled()) return json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const auth = await requireWallet(request);
  if (!auth) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  try {
    const store = system().store;
    const goals = await store.listGoals(auth.wallet.toLowerCase());
    const withHistory = await Promise.all(
      goals.map(async (goal) => {
        const records = await store.listActionRecords(goal.id);
        return { ...publicGoal(goal), recentActions: records.slice(-5).map(publicActionRecord) };
      }),
    );
    return json(
      {
        goals: withHistory.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return json({ error: "Goal store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!isAutonomousAgentEnabled()) return json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const auth = await requireWallet(request);
  if (!auth) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const rate = await checkRateLimit(`${auth.wallet.toLowerCase()}:autonomy-goal`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return json({ error: "Too many requests. Please slow down.", code: "RATE_LIMITED" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) } });
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = (parsedBody.value && typeof parsedBody.value === "object" ? parsedBody.value : {}) as Record<string, unknown>;

  const policyId = typeof body.policyId === "string" && UUIDish.test(body.policyId) ? body.policyId : null;
  if (!policyId) return json({ error: "A policyId from an authorized policy is required.", code: "POLICY_REQUIRED" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const now = new Date();
  const condition = normalizeCondition(body.condition);
  if (!condition.ok) {
    return json({ error: "Invalid trigger condition.", code: "INVALID_CONDITION", details: condition.errors }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const store = system().store;
    const policy: AutonomyPolicy | null = await store.getPolicy(policyId);
    if (!policy || policy.wallet.toLowerCase() !== auth.wallet.toLowerCase()) {
      return json({ error: "Policy not found.", code: "POLICY_NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    // Trade spec derives from the POLICY (pair), not from the request —
    // a goal can never trade a pair its authorization does not cover.
    const sellAmountRaw = parseBaseUnits(body.sellAmount, sellDecimalsFor(policy));
    if (sellAmountRaw === null) {
      return json({ error: "sellAmount must be a positive decimal string (spend per trade).", code: "INVALID_AMOUNT" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (BigInt(sellAmountRaw) > BigInt(policy.maxPerTradeRaw)) {
      return json({ error: "Per-trade amount exceeds the authorized policy limit.", code: "OVER_PER_TRADE_LIMIT" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    const cooldownRaw = typeof body.cooldownSeconds === "number" ? Math.floor(body.cooldownSeconds) : Number.parseInt(String(body.cooldownSeconds ?? ""), 10);
    const cooldownSeconds = Number.isFinite(cooldownRaw)
      ? Math.min(Math.max(cooldownRaw, AUTONOMY_LIMITS.minCooldownSeconds), AUTONOMY_LIMITS.maxCooldownSeconds)
      : AUTONOMY_LIMITS.minCooldownSeconds;

    const maxTrades = typeof body.maxTrades === "number" && Number.isInteger(body.maxTrades) && body.maxTrades > 0 && body.maxTrades <= 1000 ? body.maxTrades : undefined;

    const requestedExpiry = typeof body.expiresAt === "string" ? new Date(body.expiresAt) : null;
    const policyExpiry = new Date(policy.expiresAt);
    const defaultExpiry = new Date(Math.min(now.getTime() + AUTONOMY_LIMITS.maxPolicyTtlDays * 86_400_000, policyExpiry.getTime()));
    const expiresAt = requestedExpiry && !Number.isNaN(requestedExpiry.getTime())
      ? new Date(Math.min(requestedExpiry.getTime(), policyExpiry.getTime()))
      : defaultExpiry;

    const policyLive = policy.enabled && !policy.revokedAt && policyExpiry.getTime() > now.getTime();
    const sellDecimals = tokenDecimals(policy.sellToken);
    const buyDecimals = tokenDecimals(policy.buyToken);
    const goal: AgentGoal = {
      id: "",
      wallet: getAddress(auth.wallet.toLowerCase()),
      policyId: policy.id,
      type: "conditional_swap",
      description:
        typeof body.description === "string" && body.description.trim().length > 0 && body.description.length <= 200
          ? body.description.trim()
          : `${condition.value.kind === "price_below" ? "Buy" : "Sell"} when price ${condition.value.kind === "price_below" ? "<=" : ">="} ${condition.value.threshold}`,
      status: policyLive ? "ACTIVE" : "DRAFT",
      condition: condition.value,
      trade: {
        sellToken: policy.sellToken,
        buyToken: policy.buyToken,
        sellAmountRaw,
        slippageBps: policy.maxSlippageBps,
        sellDecimals,
        buyDecimals,
      },
      cooldownSeconds,
      maxTrades,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nextEvaluationAt: now.toISOString(),
      lastAction: null,
      lastResult: null,
      pendingExecution: null,
      stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
    };

    if ((await store.countNonTerminalGoals(auth.wallet.toLowerCase())) >= AUTONOMY_LIMITS.maxGoalsPerWallet) {
      return json({ error: "Goal limit reached for this wallet.", code: "GOAL_LIMIT_REACHED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    const created = await store.createGoal(goal);
    await store.appendAudit(
      { at: now.toISOString(), type: "GOAL_CREATED", goalId: created.id, policyId: policy.id, wallet: auth.wallet, data: { condition: created.condition.kind, threshold: created.condition.threshold, sellAmountRaw } },
      AUTONOMY_LIMITS.maxAuditEventsPerGoal,
    );
    return json({ goal: publicGoal(created), policy: publicPolicy(policy) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return json({ error: "Goal store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

function sellDecimalsFor(policy: AutonomyPolicy): number {
  // The policy was normalized through resolveExecutorToken, which knows the
  // decimals; re-derive them here so user input parsing is decimal-correct.
  return tokenDecimals(policy.sellToken);
}

function tokenDecimals(address: string): number {
  const token = MPGR_EXECUTOR_DEPLOYMENTS[BASE_MAINNET_CHAIN_ID]?.tokens.find(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  );
  return token?.decimals ?? 18;
}

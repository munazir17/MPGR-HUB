// app/api/agent/autonomy/policy/route.ts
//
// Autonomous authorization policies (spec §5/§6/§18). ALL endpoints require
// a live SIWE session — a policy is a spending authorization and can only
// ever be created by the authenticated wallet itself, with an explicit
// `authorized: true` confirmation in the body (nothing is implied).
//
// POST   create + authorize (server-side normalization; LLM/client values
//        are re-validated by the deterministic policy engine)
// GET    list the wallet's policies (public view)
// DELETE revoke (?id=) — revocation takes effect on the NEXT evaluation;
//        goals keep their history but can never execute again.

import { NextResponse } from "next/server";

import { verifyTrustedOrigin, readJsonBody, requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { isAutonomousAgentEnabled, AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { normalizePolicyInput } from "@/lib/autonomy/policy-engine";
import {
  authorizationRef,
  executorRouteExists,
  parsePolicyChainId,
  policyChainLabel,
  publicPolicy,
  requireWallet,
  resolveExecutorToken,
  system,
} from "@/lib/autonomy/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!isAutonomousAgentEnabled()) return json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const auth = await requireWallet(request);
  if (!auth) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  try {
    const policies = await system().store.listPolicies(auth.wallet.toLowerCase());
    return json({ policies: policies.map(publicPolicy) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return json({ error: "Authorization store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
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
  const rate = await checkRateLimit(`${auth.wallet.toLowerCase()}:autonomy-policy`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return json({ error: "Too many requests. Please slow down.", code: "RATE_LIMITED" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) } });
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = (parsedBody.value && typeof parsedBody.value === "object" ? parsedBody.value : {}) as Record<string, unknown>;

  // Explicit, opt-in authorization — never implied by chat or UI state.
  if (body.authorized !== true) {
    return json({ error: "Autonomous trading requires your explicit authorization.", code: "AUTHORIZATION_NOT_GRANTED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  // CHAIN (audit MC-1 remediation). Explicit, validated, and defaulted to Base
  // mainnet so existing clients are byte-for-byte unaffected. The chosen chain
  // is bound into the signed `policyHash` (its canonical tuple carries
  // `uint256 chainId`) and into the EIP-712 domain the user signs, so a user's
  // authorization is cryptographically chain-specific — a mainnet policy can
  // never be redeemed by a Sepolia slot or vice versa.
  const chain = parsePolicyChainId(body.chainId);
  if (!chain.ok) {
    return json({ error: "Invalid chain.", code: "INVALID_POLICY", details: [chain.message] }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const now = new Date();
  const normalized = normalizePolicyInput({
    wallet: auth.wallet,
    chainId: chain.chainId,
    // Resolve tokens against THIS chain's executor allowlist only.
    resolveToken: (raw: unknown) => resolveExecutorToken(raw, chain.chainId),
    sellToken: body.sellToken,
    buyToken: body.buyToken,
    maxPerTrade: body.maxPerTrade,
    maxDaily: body.maxDaily,
    maxSlippageBps: body.maxSlippageBps,
    maxActionsPerDay: body.maxActionsPerDay,
    ttlDays: body.ttlDays,
    now,
    authorizationRef: authorizationRef(auth.session.sessionId, auth.wallet),
  });
  if (!normalized.ok) {
    return json({ error: "Invalid authorization limits.", code: "INVALID_POLICY", details: normalized.errors }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!executorRouteExists(normalized.value.sellToken, normalized.value.buyToken, chain.chainId)) {
    return json(
      {
        error: `This pair has no MPGR Executor route on ${policyChainLabel(chain.chainId)} — autonomous policies are limited to executor-routable pairs.`,
        code: "NO_EXECUTOR_ROUTE",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const store = system().store;
    const existing = await store.listPolicies(auth.wallet.toLowerCase());
    if (existing.length >= AUTONOMY_LIMITS.maxPoliciesPerWallet) {
      return json({ error: "Policy limit reached for this wallet.", code: "POLICY_LIMIT_REACHED" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const policy = await store.createPolicy(normalized.value);
    await store.appendAudit(
      { at: now.toISOString(), type: "POLICY_CREATED", policyId: policy.id, wallet: auth.wallet, data: { expiresAt: policy.expiresAt, maxPerTradeRaw: policy.maxPerTradeRaw, maxDailyRaw: policy.maxDailyRaw } },
      AUTONOMY_LIMITS.maxAuditEventsPerGoal,
    );
    return json({ policy: publicPolicy(policy) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return json({ error: "Authorization store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function DELETE(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  if (!isAutonomousAgentEnabled()) return json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const auth = await requireWallet(request);
  if (!auth) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (!/^[a-z0-9_]{4,80}$/i.test(id)) return json({ error: "Invalid policy id.", code: "INVALID_POLICY_ID" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  try {
    const store = system().store;
    const revoked = await store.revokePolicy(id, auth.wallet.toLowerCase(), new Date().toISOString());
    if (!revoked) return json({ error: "Policy not found or already revoked.", code: "POLICY_NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    await store.appendAudit(
      { at: new Date().toISOString(), type: "POLICY_REVOKED", policyId: revoked.id, wallet: auth.wallet },
      AUTONOMY_LIMITS.maxAuditEventsPerGoal,
    );
    return json({ policy: publicPolicy(revoked) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return json({ error: "Authorization store unavailable", code: "AUTONOMY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

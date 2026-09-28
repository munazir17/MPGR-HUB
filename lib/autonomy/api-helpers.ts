import "server-only";

// lib/autonomy/api-helpers.ts
//
// Shared plumbing for the additive /api/agent/autonomy/* routes:
// session-scoped identity (the EXISTING SIWE session store), token
// resolution against the executor registry (the EXISTING compile-time
// config — nothing hardcoded here), public view mappers, and the
// non-secret authorization reference binding a policy to the session
// that created it.

import { createHash } from "node:crypto";
import type { Address } from "viem";

import { authenticateRequest } from "@/lib/auth/session-store";
import type { AuthSession } from "@/lib/auth/session";
import {
  BASE_MAINNET_CHAIN_ID,
  findExecutorRoute,
  MPGR_EXECUTOR_DEPLOYMENTS,
} from "@/lib/executor/executor-config";
import type { AgentGoal, AutonomyAuditEvent, AutonomyPolicy, GoalActionRecord } from "./types";
import type { AutonomySystem } from "./index";
import { getAutonomySystem } from "./index";

export interface AuthenticatedWallet {
  wallet: Address;
  session: AuthSession;
}

/** Every autonomy route requires a live SIWE session (fail-closed). */
export async function requireWallet(request: Request): Promise<AuthenticatedWallet | null> {
  const session = await authenticateRequest(request);
  if (!session) return null;
  return { wallet: session.wallet as Address, session };
}

/**
 * Token resolution for POLICY normalization: only executor-allowlisted
 * mainnet tokens with an executor route between them are eligible — an
 * autonomous policy can never point at a pair the MPGR Executor (and its
 * in-transaction 25 bps fee) does not support.
 */
export function resolveExecutorToken(raw: unknown): { ok: true; address: Address; decimals: number; symbol: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 64) {
    return { ok: false, message: "provide a token symbol or Base contract address." };
  }
  const deployment = MPGR_EXECUTOR_DEPLOYMENTS[BASE_MAINNET_CHAIN_ID];
  if (!deployment) return { ok: false, message: "the Base executor is not configured." };
  const needle = raw.trim();
  const token =
    deployment.tokens.find((t) => t.address.toLowerCase() === needle.toLowerCase()) ??
    deployment.tokens.find((t) => t.symbol.toLowerCase() === needle.toLowerCase() && !t.testnet);
  if (!token) {
    return { ok: false, message: "token is not on the MPGR Executor allowlist for Base — autonomous policies are restricted to executor-routable pairs." };
  }
  return { ok: true, address: token.address, decimals: token.decimals, symbol: token.symbol };
}

/** The pair must have a registered executor route (Uniswap V3 / Slipstream). */
export function executorRouteExists(sell: Address, buy: Address): boolean {
  const deployment = MPGR_EXECUTOR_DEPLOYMENTS[BASE_MAINNET_CHAIN_ID];
  if (!deployment) return false;
  return findExecutorRoute(deployment, sell, buy) !== undefined;
}

/**
 * Non-secret audit reference binding a policy grant to the SIWE session
 * that created it: `${sessionId}:${sha256(sessionId:wallet)[:16]}`. The
 * digest makes the raw session id non-enumerable in audit exports; the
 * reference is proof-of-authorization provenance, never a credential.
 */
export function authorizationRef(sessionId: string, wallet: string): string {
  const digest = createHash("sha256").update(`${sessionId}:${wallet.toLowerCase()}`).digest("hex").slice(0, 16);
  return `${sessionId}:${digest}`;
}

// ---------------------------------------------------------------------------
// Public (client-safe) views — no internal-only fields, no raw MCP payloads.
// ---------------------------------------------------------------------------

export function publicPolicy(policy: AutonomyPolicy) {
  return {
    id: policy.id,
    chainId: policy.chainId,
    actions: policy.actions,
    sellToken: policy.sellToken,
    buyToken: policy.buyToken,
    maxPerTradeRaw: policy.maxPerTradeRaw,
    maxDailyRaw: policy.maxDailyRaw,
    maxSlippageBps: policy.maxSlippageBps,
    maxActionsPerDay: policy.maxActionsPerDay,
    enabled: policy.enabled,
    createdAt: policy.createdAt,
    expiresAt: policy.expiresAt,
    authorizedAt: policy.authorizedAt,
    revokedAt: policy.revokedAt ?? null,
  };
}

export function publicGoal(goal: AgentGoal) {
  return {
    id: goal.id,
    policyId: goal.policyId,
    type: goal.type,
    description: goal.description,
    status: goal.status,
    condition: goal.condition,
    trade: goal.trade,
    cooldownSeconds: goal.cooldownSeconds,
    maxTrades: goal.maxTrades ?? null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    expiresAt: goal.expiresAt,
    nextEvaluationAt: goal.nextEvaluationAt,
    lastEvaluationAt: goal.lastEvaluationAt ?? null,
    lastAction: goal.lastAction ?? null,
    lastResult: goal.lastResult ?? null,
    pendingTxHash: goal.pendingExecution?.txHash ?? null,
    stats: goal.stats,
  };
}

export function publicActionRecord(record: GoalActionRecord) {
  return {
    idempotencyKey: record.idempotencyKey,
    goalId: record.goalId,
    status: record.status,
    outcome: record.outcome,
    verified: record.verified,
    txHash: record.txHash ?? null,
    failureCode: record.failureCode ?? null,
    message: record.message ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function publicAuditEvent(event: AutonomyAuditEvent) {
  return {
    seq: event.seq ?? null,
    at: event.at,
    type: event.type,
    goalId: event.goalId ?? null,
    policyId: event.policyId ?? null,
    data: event.data ?? null,
  };
}

/** Lazy accessor so route modules stay tree-shakeable and test-friendly. */
export function system(): AutonomySystem {
  return getAutonomySystem();
}

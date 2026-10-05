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
  BASE_SEPOLIA_CHAIN_ID,
  findExecutorRoute,
  MPGR_EXECUTOR_DEPLOYMENTS,
  type ExecutorChainId,
  type ExecutorDeployment,
} from "@/lib/executor/executor-config";
import {
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  delegatedExecutorAddressFor,
  delegatedExecutorDeploymentFor,
  isDelegatedChainId,
} from "@/lib/executor/delegated-executor";
import { AUTONOMY_CHAIN_ID, isSupportedPolicyChainId, type SupportedPolicyChainId } from "./types";
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
 * The token/route registry an autonomous policy on `chainId` must resolve
 * against.
 *
 *   8453  Base mainnet — the deployed v1 MPGR Executor registry. This is the
 *         SAME allowlist and route set the delegated mainnet executor mirrors
 *         (see mainnetDelegatedExecutorDeployment), so a policy that resolves
 *         here is exactly a policy the delegated contract can execute.
 *   84532 Base Sepolia — the DELEGATED executor's own registry (tUSD/tSTOCK/
 *         WETH), NOT the v1 Sepolia registry: each Sepolia deploy mints fresh
 *         test tokens, and cross-wiring two contracts is rejected by the quote
 *         path (PHASE 5 finding F-9).
 *
 * Returns null for anything else — fail closed, never a silent default.
 */
export function policyRegistryFor(chainId: number): ExecutorDeployment | null {
  if (chainId === BASE_MAINNET_CHAIN_ID) return MPGR_EXECUTOR_DEPLOYMENTS[BASE_MAINNET_CHAIN_ID] ?? null;
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT;
  return null;
}

/** Human label for a policy chain, used in user-facing refusal messages. */
export function policyChainLabel(chainId: number): string {
  return chainId === BASE_MAINNET_CHAIN_ID ? "Base" : chainId === BASE_SEPOLIA_CHAIN_ID ? "Base Sepolia" : `chain ${chainId}`;
}

/**
 * Token resolution for POLICY normalization: only executor-allowlisted tokens
 * for the POLICY'S OWN CHAIN, with a registered route between them, are
 * eligible — an autonomous policy can never point at a pair the MPGR Executor
 * (and its in-transaction 25 bps fee) does not support.
 *
 * `chainId` defaults to Base mainnet, preserving the previous behaviour for
 * every existing caller and test.
 */
export function resolveExecutorToken(
  raw: unknown,
  chainId: SupportedPolicyChainId = AUTONOMY_CHAIN_ID,
): { ok: true; address: Address; decimals: number; symbol: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 64) {
    return { ok: false, message: "provide a token symbol or contract address." };
  }
  if (!isSupportedPolicyChainId(chainId)) return { ok: false, message: "unsupported chain for autonomous policies." };
  const deployment = policyRegistryFor(chainId);
  if (!deployment) return { ok: false, message: `the ${policyChainLabel(chainId)} executor is not configured.` };
  const needle = raw.trim();
  const token =
    deployment.tokens.find((t) => t.address.toLowerCase() === needle.toLowerCase()) ??
    deployment.tokens.find((t) => t.symbol.toLowerCase() === needle.toLowerCase() && !t.testnet);
  if (!token) {
    return {
      ok: false,
      message: `token is not on the MPGR Executor allowlist for ${policyChainLabel(chainId)} — autonomous policies are restricted to executor-routable pairs.`,
    };
  }
  return { ok: true, address: token.address, decimals: token.decimals, symbol: token.symbol };
}

/** The pair must have a registered executor route (Uniswap V3 / Slipstream) on that chain. */
export function executorRouteExists(sell: Address, buy: Address, chainId: SupportedPolicyChainId = AUTONOMY_CHAIN_ID): boolean {
  const deployment = policyRegistryFor(chainId);
  if (!deployment) return false;
  return findExecutorRoute(deployment, sell, buy) !== null;
}

/** Token decimals for a chain's allowlist (18 fallback matches prior behaviour). */
export function executorTokenDecimals(address: string, chainId: SupportedPolicyChainId = AUTONOMY_CHAIN_ID): number {
  const deployment = policyRegistryFor(chainId);
  const token = deployment?.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
  return token?.decimals ?? 18;
}

/**
 * Parse + validate the chain a new policy targets. Omitted => Base mainnet
 * (the historical default). Returned as a discriminated result so the caller
 * can build the correct token resolver BEFORE normalization, while
 * `normalizePolicyInput` still re-validates the same value independently.
 */
export function parsePolicyChainId(raw: unknown): { ok: true; chainId: SupportedPolicyChainId } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, chainId: AUTONOMY_CHAIN_ID };
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(parsed) || !isSupportedPolicyChainId(parsed)) {
    return { ok: false, message: "chainId must be 8453 (Base) or 84532 (Base Sepolia)." };
  }
  return { ok: true, chainId: parsed };
}

/**
 * Whether delegated (witness-authorized) execution is even addressable on a
 * chain: the chain must be delegated-capable AND an executor must be pinned.
 * Base Sepolia always is; Base mainnet only once the operator has pinned
 * MPGR_MAINNET_DELEGATED_EXECUTOR. Used to refuse authorization slots early
 * with an honest reason instead of letting them be signed against a contract
 * that does not exist.
 */
export function delegatedExecutionConfigured(chainId: number): boolean {
  if (!isDelegatedChainId(chainId)) return false;
  return delegatedExecutorAddressFor(chainId) !== null && delegatedExecutorDeploymentFor(chainId as ExecutorChainId) !== null;
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

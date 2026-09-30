// lib/autonomy/types.ts
//
// Phase 3 — Autonomous Agent Runtime. ADDITIVE typed models only.
//
// This module introduces NO new event bus, task queue, memory system,
// wallet system, or scheduler. It reuses the seams that already exist:
//
//   events        -> lib/architecture/core/event-bus.ts (AgentEventMap)
//   queue         -> lib/architecture/core/task-queue.ts
//   performance   -> lib/architecture/core/performance-monitor.ts
//   memory        -> lib/architecture/memory/* (untouched; see below)
//   trading       -> lib/mcp/* (quote/prepare/status/verify — the ONLY path)
//   persistence   -> lib/api/redis.ts (authorization state must be server-side)
//
// WHY goals/policies are NOT in the client-side memory system: an
// autonomous policy authorizes spending real funds. It must live in
// server-side durable storage, validated against an authenticated
// session, exactly like x402 proposal state — never in localStorage.
//
// HARD SAFETY RULES encoded by these types:
//   * Amounts are base-unit decimal STRINGS (bigint math, never floats).
//   * A policy can only ever authorize the action type "swap" on Base
//     mainnet (8453), scoped to ONE sell/buy token pair.
//   * No type in this file can hold a private key, seed phrase, or
//     signing credential. `authorizationRef` is a non-secret reference
//     (session id + digest) for audit, never key material.

import type { Address } from "viem";

/** Base mainnet is the only chain autonomous policies may ever target. */
export const AUTONOMY_CHAIN_ID = 8453 as const;
export type AutonomyChainId = typeof AUTONOMY_CHAIN_ID;

/**
 * Phase 2 delegated execution (ADDITIVE): the ONLY chain the delegated
 * Permit2-witness adapter executes on is Base Sepolia. Assisted/manual
 * trading and the default runtime chain (Base mainnet) are untouched.
 */
export const DELEGATED_EXECUTION_CHAIN_ID = 84532 as const;
export const DELEGATED_ADAPTER_ID = "delegated-permit2-sepolia";

/** Only "swap" exists today. Other kinds are future extension points (spec §11). */
export const AUTONOMY_ACTION_TYPES = ["swap"] as const;
export type AutonomyActionType = (typeof AUTONOMY_ACTION_TYPES)[number];

/** Scheduling scale for deterministic threshold math (price comparisons). */
export const AUTONOMY_THRESHOLD_SCALE = 10n ** 18n;

// ---------------------------------------------------------------------------
// Failure taxonomy (spec §16) — deterministic, persisted, user-presentable.
// ---------------------------------------------------------------------------

export const AUTONOMY_FAILURE_CODES = [
  "QUOTE_FAILED",
  "NO_LIQUIDITY",
  "POLICY_REJECTED",
  "AUTHORIZATION_MISSING",
  "APPROVAL_REQUIRED",
  "USER_REJECTED",
  "TX_REVERTED",
  "RPC_ERROR",
  "VERIFICATION_FAILED",
  "TIMEOUT",
  // Runtime-internal refinements (mapped from MCP/runtime state):
  "MCP_DISABLED",
  "EXECUTOR_PAUSED",
  "QUOTE_STALE",
  "TOKEN_NOT_ALLOWED",
  "EXECUTION_UNAVAILABLE",
  "DUPLICATE_PREVENTED",
  "INVALID_CONDITION",
] as const;
export type AutonomyFailureCode = (typeof AUTONOMY_FAILURE_CODES)[number];

/** Codes where retrying later is meaningful (bounded by scheduler backoff). */
export const RETRYABLE_FAILURE_CODES: readonly AutonomyFailureCode[] = [
  "QUOTE_FAILED",
  "RPC_ERROR",
  "TIMEOUT",
  "EXECUTOR_PAUSED",
  "MCP_DISABLED",
  "EXECUTION_UNAVAILABLE",
];

/**
 * Codes that must NEVER be retried after an uncertain broadcast — the
 * transaction MIGHT have landed. Re-entry requires the verification pass
 * (or a human), never a blind re-submit (spec §16).
 */
export const UNCERTAIN_BROADCAST_CODES: readonly AutonomyFailureCode[] = [
  "TX_REVERTED",
  "VERIFICATION_FAILED",
  "TIMEOUT",
];

// ---------------------------------------------------------------------------
// Policy model (spec §5) — deterministic guardrails, validated server-side.
// ---------------------------------------------------------------------------

export interface AutonomyPolicy {
  id: string;
  /** Lowercase wallet that authorized this policy. */
  wallet: Address;
  chainId: AutonomyChainId | typeof DELEGATED_EXECUTION_CHAIN_ID;
  /** Always exactly ["swap"] today — validated, never extended by input. */
  actions: readonly AutonomyActionType[];
  /** The ONLY sell token this policy allows (executor-allowlisted address). */
  sellToken: Address;
  /** The ONLY buy token this policy allows. */
  buyToken: Address;
  /** Max sell amount per trade, sell-token base units (decimal string). */
  maxPerTradeRaw: string;
  /** Max cumulative sell amount per UTC day, sell-token base units. */
  maxDailyRaw: string;
  /** Max accepted slippage for autonomous swaps (bps, 1..500). */
  maxSlippageBps: number;
  /** Max autonomous actions per UTC day (all statuses that submit a tx). */
  maxActionsPerDay: number;
  enabled: boolean;
  createdAt: string;
  /** RFC3339 UTC. Policies always expire — there is no perpetual grant. */
  expiresAt: string;
  /** When the user explicitly authorized (POST from an authenticated session). */
  authorizedAt: string;
  /**
   * Non-secret audit reference binding this grant to the SIWE session that
   * created it: `${sessionId}:${sha256(sessionId + wallet)[:16]}`. Never key
   * material — see docs/AUTONOMOUS_AGENT.md.
   */
  authorizationRef: string;
  revokedAt?: string;
}

export function isPolicyRevoked(policy: AutonomyPolicy): boolean {
  return typeof policy.revokedAt === "string" && policy.revokedAt.length > 0;
}

// ---------------------------------------------------------------------------
// Goal model (spec §8).
// ---------------------------------------------------------------------------

export const GOAL_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "WAITING",
  "EXECUTING",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type GoalKind = "conditional_swap";

/**
 * Deterministic condition. `threshold` is a decimal string of buy-token
 * units per one sell-token unit (e.g. "2.50" = buy token costs 2.50 USDC).
 * Evaluated with bigint math — the LLM never evaluates conditions.
 */
export interface GoalCondition {
  kind: "price_below" | "price_above";
  threshold: string;
}

export interface GoalTradeSpec {
  sellToken: Address;
  buyToken: Address;
  /** Fixed sell amount per triggered trade, sell-token base units. */
  sellAmountRaw: string;
  slippageBps: number;
  /** Decimals snapshots from the executor registry at goal creation. */
  sellDecimals: number;
  buyDecimals: number;
}

/** A trade that was broadcast and is awaiting on-chain confirmation. */
export interface PendingExecution {
  txHash: string;
  quoteId: string;
  idempotencyKey: string;
  submittedAt: string;
  verifyAttempts: number;
  expectedBuyAmountRaw: string;
  minBuyAmountRaw: string;
  /**
   * Phase 2 delegated path ONLY: the broadcaster that submitted the tx.
   * When set, verification requires tx.from == expectedSender AND the
   * SwapExecuted event's taker == the goal wallet (scoped — the default
   * tx.from == taker check is unchanged for every other path).
   */
  expectedSender?: string;
}

export interface GoalResultSummary {
  at: string;
  outcome: "CONDITION_NOT_MET" | "POLICY_REJECTED" | "AUTHORIZATION_MISSING" | "TRADE_EXECUTED" | "FAILED" | "VERIFIED" | "WAITING_VERIFICATION" | "EXPIRED";
  code?: AutonomyFailureCode | null;
  message: string;
}

export interface AgentGoal {
  id: string;
  /** Lowercase wallet that owns this goal. */
  wallet: Address;
  policyId: string;
  type: GoalKind;
  /** Human description (e.g. "Buy AAPLc when price falls below 200 USDC"). */
  description: string;
  status: GoalStatus;
  condition: GoalCondition;
  trade: GoalTradeSpec;
  /** Minimum seconds between evaluations AND between triggered trades. */
  cooldownSeconds: number;
  /** Stop after this many successful verified trades (optional). */
  maxTrades?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  nextEvaluationAt: string;
  lastEvaluationAt?: string;
  lastAction?: string | null;
  lastResult?: GoalResultSummary | null;
  pendingExecution?: PendingExecution | null;
  stats: {
    evaluations: number;
    triggered: number;
    verified: number;
    consecutiveFailures: number;
  };
}

// ---------------------------------------------------------------------------
// State machine (spec §8: invalid transitions are rejected, never coerced).
// ---------------------------------------------------------------------------

export const GOAL_TERMINAL_STATUSES: readonly GoalStatus[] = ["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"];

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return GOAL_TERMINAL_STATUSES.includes(status);
}

/**
 * Allowed transitions. EXECUTING deliberately cannot reach PAUSED/CANCELLED:
 * a trade already broadcast must run its verification pass to a terminal
 * verdict before the goal can change again (no losing a pending tx).
 */
export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  DRAFT: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["WAITING", "EXECUTING", "PAUSED", "COMPLETED", "FAILED", "EXPIRED", "CANCELLED"],
  WAITING: ["ACTIVE", "EXECUTING", "PAUSED", "COMPLETED", "FAILED", "EXPIRED", "CANCELLED"],
  EXECUTING: ["ACTIVE", "WAITING", "COMPLETED", "FAILED", "EXPIRED"],
  PAUSED: ["ACTIVE", "EXPIRED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Action / execution records (spec §15/§17).
// ---------------------------------------------------------------------------

export type ExecutionOutcome =
  | "VERIFIED"
  | "FAILED"
  | "UNCERTAIN";

export interface GoalActionRecord {
  /** Idempotency key: `${goalId}:${slot}` — one execution per evaluation slot. */
  idempotencyKey: string;
  goalId: string;
  wallet: Address;
  policyId: string;
  quoteId: string;
  /** Sell amount actually requested, base units. */
  sellAmountRaw: string;
  slippageBps: number;
  status: "SUBMITTED" | "CONFIRMED" | "REVERTED" | "UNCERTAIN" | "FAILED";
  outcome: ExecutionOutcome | "PENDING_VERIFICATION";
  txHash?: string;
  blockNumber?: string;
  expectedBuyAmountRaw?: string;
  minBuyAmountRaw?: string;
  actualBuyAmountRaw?: string;
  feeAmountRaw?: string;
  verified: boolean;
  failureCode?: AutonomyFailureCode | null;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Audit trail (spec §21) — additive events on the EXISTING AgentEventBus.
// Payloads are plain serializable data and never contain secrets.
// ---------------------------------------------------------------------------

export const AUTONOMY_AUDIT_EVENT_TYPES = [
  "GOAL_CREATED",
  "GOAL_UPDATED",
  "GOAL_PAUSED",
  "GOAL_RESUMED",
  "GOAL_CANCELLED",
  "GOAL_EXPIRED",
  "GOAL_COMPLETED",
  "GOAL_FAILED",
  "CONDITION_CHECKED",
  "CONDITION_MET",
  "POLICY_CREATED",
  "POLICY_REVOKED",
  "POLICY_CHECKED",
  "POLICY_APPROVED",
  "POLICY_REJECTED",
  "QUOTE_CREATED",
  "QUOTE_STALE",
  "TRADE_PREPARED",
  "AUTHORIZATION_CHECKED",
  "TRANSACTION_SUBMITTED",
  "TRANSACTION_CONFIRMED",
  "EXECUTION_VERIFIED",
  "EXECUTION_FAILED",
  "VERIFICATION_PENDING",
  "VERIFICATION_FAILED",
  "DUPLICATE_PREVENTED",
  // Phase 2 delegated control plane (Base Sepolia authorization slots)
  "DELEGATED_AUTHORIZATION_CREATED",
  "DELEGATED_AUTHORIZATION_REVOKED",
] as const;
export type AutonomyAuditEventType = (typeof AUTONOMY_AUDIT_EVENT_TYPES)[number];

export interface AutonomyAuditEvent {
  /** Monotonic per-goal sequence (store-assigned), for ordered display. */
  seq?: number;
  at: string;
  type: AutonomyAuditEventType;
  goalId?: string;
  policyId?: string;
  wallet: Address;
  /** Small serializable detail (codes, hashes, amounts) — never secrets. */
  data?: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// Policy evaluation (spec §5) — deterministic verdicts.
// ---------------------------------------------------------------------------

export type PolicyRejectionCode = Extract<
  AutonomyFailureCode,
  "POLICY_REJECTED" | "TOKEN_NOT_ALLOWED" | "QUOTE_STALE" | "INVALID_CONDITION"
>;

export interface PolicyRejection {
  code: PolicyRejectionCode;
  rule:
    | "POLICY_NOT_FOUND"
    | "POLICY_DISABLED"
    | "POLICY_REVOKED"
    | "POLICY_EXPIRED"
    | "CHAIN_MISMATCH"
    | "ACTION_NOT_PERMITTED"
    | "SELL_TOKEN_MISMATCH"
    | "BUY_TOKEN_MISMATCH"
    | "OVER_PER_TRADE_LIMIT"
    | "OVER_DAILY_LIMIT"
    | "OVER_SLIPPAGE_LIMIT"
    | "OVER_ACTION_RATE"
    | "GOAL_EXPIRED";
  message: string;
}

export interface SpendContext {
  /** Sell-token base units already spent today (UTC) under this policy. */
  dailySpendRaw: string;
  /** Actions already submitted today (UTC) under this policy. */
  actionsToday: number;
}

export type PolicyDecision =
  | { allowed: true; policy: AutonomyPolicy }
  | { allowed: false; rejection: PolicyRejection };

// ---------------------------------------------------------------------------
// Authorization boundary (spec §6) — the adapter contract is the ONLY seam
// through which an autonomous action can reach a signature. The production
// default refuses everything; see execution-adapter.ts.
// ---------------------------------------------------------------------------

export interface AuthorizationVerdict {
  authorized: boolean;
  /** Machine reason when not authorized (audited, never a secret). */
  reason?: string;
}

/**
 * An UNSIGNED, prepared swap exactly as MCP's mpgr_prepare_trade produced
 * it — approval tx (if needed) plus the unsigned executor swap calldata.
 * No signature, no key material, no provider: a future delegation adapter
 * would translate these steps into operations signed by a mechanism the
 * USER controls (e.g. a session-key smart-account module with its own
 * on-chain limits). This type structurally CANNOT carry a private key.
 */
export interface DelegatedSwapRequest {
  goalId: string;
  policyId: string;
  wallet: Address;
  chainId: number;
  quoteId: string;
  sellToken: Address;
  buyToken: Address;
  sellAmountRaw: string;
  expectedBuyAmountRaw: string;
  minBuyAmountRaw: string;
  slippageBps: number;
  idempotencyKey: string;
  /** Unsigned steps from mpgr_prepare_trade (approval + swap). */
  steps: Array<Record<string, unknown>>;
  /** The unsigned swap transaction request, when present. */
  transactionRequest: Record<string, unknown> | null;
}

export type DelegatedSwapResult =
  | { ok: true; txHash: string }
  | { ok: false; code: AutonomyFailureCode; message: string };

export interface AutonomousExecutionAdapter {
  /** Stable id, persisted on action records for audit (e.g. "none"). */
  readonly id: string;
  /** True when this adapter can actually delegate signatures today. */
  readonly canDelegate: boolean;
  checkAuthorization(wallet: Address, policy: AutonomyPolicy): Promise<AuthorizationVerdict> | AuthorizationVerdict;
  /**
   * Execute a POLICY-APPROVED, fully validated, prepared swap. Implementations
   * MUST refuse anything that would bypass deterministic policy validation —
   * the runtime only calls this after every check has passed.
   */
  executeSwap(request: DelegatedSwapRequest): Promise<DelegatedSwapResult>;
}

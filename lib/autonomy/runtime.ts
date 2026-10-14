// lib/autonomy/runtime.ts
//
// THE AUTONOMOUS RUNTIME LOOP (spec §3/§9). One evaluation of one goal:
//
//   OBSERVE      fresh MCP quote for the goal's exact pair/amount
//   UNDERSTAND   deterministic condition check (bigint math — no LLM)
//   PLAN         fixed trade from the goal (LLM never plans here)
//   POLICY CHECK deterministic policy engine (spec §5) + daily caps
//   ACT          authorization check -> MCP prepare -> adapter execute
//   VERIFY       MCP status + verification, honest verdicts only (spec §15)
//   REMEMBER     CAS goal writes + audit trail + daily ledger (spec §7/§21)
//   CONTINUE     next evaluation time with bounded backoff, or WAIT
//
// SAFETY PROPERTIES (each enforced in code below, each unit-tested):
//   * feature flag / emergency disable gate EVERY execution (verification
//     of an already-broadcast tx stays available — it is read-only);
//   * a goal is only ever touched while its evaluation lease is held
//     (duplicate ticks collapse — spec §10/§17);
//   * one execution per evaluation slot via an idempotency key claimed
//     SET-NX before any broadcast;
//   * quotes must be fresh at broadcast time — stale => QUOTE_STALE, no tx;
//   * every state move is a CAS through the goal state machine;
//   * uncertain broadcasts are terminal (FAILED), never re-submitted;
//   * the LLM appears NOWHERE in this file — there is nothing to prompt.

import type { Address } from "viem";

import type { Logger, PerformanceMonitor } from "@/lib/architecture/core/types";
import { delegatedActionId, delegatedExecutorAddressFor, isDelegatedChainId } from "@/lib/executor/delegated-executor";

import { AUTONOMY_EXECUTION_BUDGET_SECONDS, AUTONOMY_LIMITS, AUTONOMY_MIN_EXECUTION_BUDGET_SECONDS } from "./config";
import { AUTONOMY_CHAIN_ID, DELEGATED_EXECUTION_CHAIN_ID, isDelegatedAdapterId, type DelegatedSwapRequest } from "./types";
import { evaluateCondition, evaluatePolicyAgainstAction } from "./policy-engine";
import { executionKeyForSlot, utcDayKey } from "./idempotency";
import {
  isStuckExecuting,
  isTerminalGoalStatus,
  STUCK_EXECUTION_REAP_SECONDS,
  type AgentGoal,
  type AutonomyFailureCode,
  type AutonomyPolicy,
  type GoalActionRecord,
  type GoalStatus,
  type SpendReservationRelease,
  type SpendReservationState,
} from "./types";
import { isInfrastructureOutageCode, isPreBroadcastRefusalCode } from "./types";
import type { AutonomyAuditSink } from "./audit";
import { auditEvent } from "./audit";
import type { McpGateway, QuotedSwap } from "./mcp-gateway";
import type { AutonomyStore } from "./store";
import { verifyExecution } from "./verify";
import type { AutonomousExecutionAdapter, DelegatedExecutionStage, DelegatedSwapResult } from "./types";
import { delegatedBroadcasterAddressFor } from "@/lib/delegated/delegated-broadcaster";

/**
 * The chain the runtime operates on for THIS adapter.
 *
 * The adapter DECLARES its chain (`adapter.chainId`), which is what makes a
 * Base mainnet delegated adapter expressible at all: the previous
 * `adapter.id === DELEGATED_ADAPTER_ID ? 84532 : 8453` mapping had no way to
 * say "delegated, on mainnet". The legacy id-based mapping is kept as the
 * fallback so adapters that predate the field (including every test adapter)
 * behave exactly as before.
 */
function executionChainId(adapter: AutonomousExecutionAdapter): number {
  if (typeof adapter.chainId === "number") return adapter.chainId;
  return isDelegatedAdapterId(adapter.id) ? DELEGATED_EXECUTION_CHAIN_ID : AUTONOMY_CHAIN_ID;
}

/** The operator broadcaster that will send for THIS adapter's chain, if any. */
function expectedSenderFor(adapter: AutonomousExecutionAdapter): Address | undefined {
  if (!isDelegatedAdapterId(adapter.id)) return undefined;
  return delegatedBroadcasterAddressFor(executionChainId(adapter)) ?? undefined;
}

export interface AutonomyRuntimeDeps {
  store: AutonomyStore;
  gateway: McpGateway;
  adapter: AutonomousExecutionAdapter;
  audit: AutonomyAuditSink;
  logger: Logger;
  performanceMonitor: PerformanceMonitor;
  now: () => Date;
}

export interface EvaluateOptions {
  /** Lease token (supplied by the scheduler; direct callers get a fresh one). */
  leaseToken?: string;
  /**
   * When the tick invocation started. The post-EXECUTING budget ends
   * AUTONOMY_EXECUTION_BUDGET_SECONDS after this instant. Defaults to the start of
   * this evaluation (direct callers).
   */
  tickStartedAt?: Date;
}

/** Result of the post-EXECUTING steps that run under the budget. They return a step and write no goal state. */
type BroadcastStep =
  | { kind: "PREPARE_REFUSED"; code: AutonomyFailureCode; message: string }
  | { kind: "STATE_UNREADABLE" }
  | { kind: "GOAL_CLOSED"; status: GoalStatus | null }
  | { kind: "ATTEMPT_NOT_RECORDED" }
  | { kind: "SWITCH_REFUSED"; message: string }
  | { kind: "BUDGET_ENDED" }
  | { kind: "ADAPTER_THREW"; stage: DelegatedExecutionStage | null }
  | { kind: "ADAPTER_RESULT"; result: DelegatedSwapResult };

type UnbroadcastStep = Exclude<BroadcastStep, { kind: "ADAPTER_RESULT" }>;

interface BroadcastProgress {
  /** Set synchronously just before the adapter is invoked. */
  adapterInvoked: boolean;
  /** Set by the caller when it stops waiting; the work must then never start the adapter. */
  abandoned: boolean;
  /**
   * Latest in-flight stage reported by the adapter/broadcaster
   * (verifyOnChain | estimate | send). Read when the budget ends so the
   * persisted error names the stage that was actually hanging.
   */
  stage: DelegatedExecutionStage | null;
}

interface BroadcastContext {
  goal: AgentGoal;
  policy: AutonomyPolicy;
  dayKey: string;
  idempotencyKey: string;
  quote: QuotedSwap;
  slippageBps: number;
  budgetEndsAtMs: number;
  progress: BroadcastProgress;
  now: Date;
}

/** `timedOut` once the budget's end is reached; never rejects because of lateness. */
type BudgetOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

function untilDeadline<T>(work: Promise<T>, remainingMs: number): Promise<BudgetOutcome<T>> {
  return new Promise<BudgetOutcome<T>>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, remainingMs));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Operator-facing text for a budget that ended before the broadcast returned
 * a hash. The in-flight stage (verifyOnChain | estimate | send, when known)
 * is named so the operator can see WHICH RPC step hung; an adapter that was
 * invoked but reported no stage is in its first stage, verifyOnChain.
 */
function budgetEndedAdapterInvoked(stage: DelegatedExecutionStage | null): string {
  return `RPC timeout: the execution budget ended before the broadcast returned a transaction hash (in-flight stage: ${stage ?? "verifyOnChain"}). The broadcast outcome is UNKNOWN — the spend reservation is kept (AMBIGUOUS), never released. The authorization slot is consumed only if a hash was returned; check it before any retry.`;
}
function budgetEndedBeforeBroadcast(stage: DelegatedExecutionStage | null): string {
  return `RPC timeout: the execution budget ended before the broadcast was sent (in-flight stage: ${stage ?? "prepare"}). Nothing was broadcast by this attempt. The spend reservation stays counted and the authorization slot was not consumed.`;
}

/**
 * Goal statuses an in-flight broadcast may write into. The goal is never
 * EXECUTING while the adapter is working — only once a hash has come back.
 */
const OPEN_GOAL_STATUSES: readonly GoalStatus[] = ["ACTIVE", "WAITING"];

type GoalTransitionPatch = Parameters<AutonomyStore["transitionGoal"]>[4];

/**
 * Upper bound, in ms, for each Redis call on the broadcast path that can be
 * skipped or failed safely: the state re-read, the attempt marker, the
 * reservation writes and the failure write. A hung Upstash must not eat the
 * tick. The hash write is NOT bounded — see recordSubmittedGoal.
 */
export const BROADCAST_STORE_BUDGET_MS = 3_000;

type Bounded<T> = { ok: true; value: T } | { ok: false; reason: "TIMEOUT" | "ERROR" };

/**
 * Runs one store call with a hard upper bound. A timeout or an error resolves
 * (never rejects) so the caller can fail closed. The abandoned call is not
 * cancelled; its late result is ignored.
 */
function bounded<T>(label: string, work: () => Promise<T>, budgetMs: number = BROADCAST_STORE_BUDGET_MS): Promise<Bounded<T>> {
  return new Promise<Bounded<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[autonomy] ${label} did not answer within ${budgetMs} ms — continuing without it (fail closed)`);
      resolve({ ok: false, reason: "TIMEOUT" });
    }, budgetMs);
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.error(`[autonomy] ${label} failed — continuing without it (fail closed)`);
        resolve({ ok: false, reason: "ERROR" });
      },
    );
  });
}

/** Appends the in-flight stage to a persisted error, so the record names the step that failed. */
function withStage(message: string, stage: string | null): string {
  return stage ? `${message} [stage: ${stage}]` : message;
}

export type EvaluationResult =
  | { kind: "SKIPPED"; reason: "NOT_FOUND" | "DISABLED" | "LEASE_BUSY" | "STATE_CHANGED"; message: string }
  | { kind: "CONDITION_NOT_MET"; price: string; nextEvaluationAt: string; message: string }
  | { kind: "PARKED"; failureCode: AutonomyFailureCode | null; message: string; nextEvaluationAt: string }
  | { kind: "DUPLICATE_PREVENTED"; message: string }
  | { kind: "VERIFICATION_PENDING"; txHash: string; nextEvaluationAt: string; message: string }
  | { kind: "VERIFIED"; txHash: string; message: string }
  | { kind: "EXECUTION_SUBMITTED"; txHash: string; message: string }
  | { kind: "EXECUTION_FAILED"; failureCode: AutonomyFailureCode; message: string }
  | { kind: "UNCERTAIN"; txHash: string; message: string }
  | { kind: "STUCK_EXECUTION_REAPED"; message: string }
  | { kind: "UNRESOLVED_BROADCAST"; message: string }
  | { kind: "GOAL_CLOSED"; status: GoalStatus; message: string };

/**
 * Message written when a goal is reaped out of a crashed EXECUTING state. It
 * states the one thing the runtime can prove: no transaction hash was ever
 * recorded for that attempt, so nothing was broadcast on the runtime's own
 * path and no retry was made. (A crash AFTER the attempt marker — an
 * unrecorded broadcast is then possible — is not claimable either way, which
 * is exactly why the spend reservation stays counted in that case.)
 */
const STUCK_EXECUTION_MESSAGE =
  "Execution attempt ended with no transaction recorded — nothing was broadcast and no automatic retry was made.";

/** Failure code reported for a reaped, never-submitted execution attempt. */
const STUCK_EXECUTION_CODE: AutonomyFailureCode = "EXECUTION_UNAVAILABLE";

/**
 * Written when an evaluation slot already holds an execution claim but no
 * transaction hash was recorded: an earlier tick was interrupted after the claim
 * or the attempt marker. The message is the operator-facing contract, so it
 * states the outcome as UNKNOWN and says what happens next. TIMEOUT is used
 * because the interrupted tick ran out of its time budget.
 */
const UNRESOLVED_BROADCAST_CODE: AutonomyFailureCode = "TIMEOUT";
const UNRESOLVED_BROADCAST_MESSAGE =
  "Broadcast outcome UNKNOWN: an earlier attempt for this evaluation slot was interrupted after its execution claim or attempt marker was written, and no transaction hash was recorded. Nothing will be retried automatically and no new evaluation slot is opened. A human must reconcile this goal — check the broadcaster wallet's on-chain transactions before taking any action.";

const NON_EVALUABLE: readonly GoalStatus[] = ["DRAFT", "PAUSED", "COMPLETED", "FAILED", "EXPIRED", "CANCELLED", "EXECUTING"];

export class AutonomyRuntime {
  constructor(private readonly deps: AutonomyRuntimeDeps) {}

  /**
   * Evaluates one goal once. Never throws for expected domain conditions —
   * failures become goal state + audit events. Unexpected store errors
   * propagate to the scheduler, which counts them against the tick budget.
   */
  async evaluateGoal(goalId: string, options: EvaluateOptions = {}): Promise<EvaluationResult> {
    return this.deps.performanceMonitor.time("autonomy.evaluateGoal", async () => {
      const now = this.deps.now();
      const goal = await this.deps.store.getGoal(goalId);
      if (!goal) return { kind: "SKIPPED", reason: "NOT_FOUND", message: "Goal not found." };

      // A broadcast awaiting verification is ALWAYS verifiable — reading a
      // receipt is safe regardless of flags, and honest state matters most.
      if (goal.pendingExecution) {
        return this.verifyPending(goal);
      }

      // CRASH RECOVERY — an EXECUTING goal with no pending execution and no
      // progress for STUCK_EXECUTION_REAP_SECONDS. The current runtime never
      // writes that state (EXECUTING is written together with the tx hash), so
      // this only closes goals left behind by older builds that wrote EXECUTING
      // before the broadcast. A goal that is ACTIVE or WAITING is never reaped
      // here. This runs BEFORE the feature-flag gate on purpose: the reap never
      // quotes, signs or broadcasts — it only closes a state that can no longer
      // make progress.
      if (isStuckExecuting(goal, now)) {
        return this.reapStuckExecution(goal, now);
      }

      // UNRESOLVED BROADCAST — an open goal whose current slot already holds an
      // execution claim with no transaction hash: an earlier tick was interrupted
      // after the claim or the attempt marker. Closed here, before any quote, so
      // the adapter is never reached again and no new slot is opened.
      const unresolved = await this.closeIfUnresolvedBroadcast(goal, now);
      if (unresolved) return unresolved;

      if (!isAutonomousRuntimeEnabled()) {
        return { kind: "SKIPPED", reason: "DISABLED", message: "Autonomous runtime is disabled." };
      }
      if (NON_EVALUABLE.includes(goal.status)) {
        return { kind: "SKIPPED", reason: "STATE_CHANGED", message: `Goal status ${goal.status} is not evaluatable.` };
      }

      const leaseToken = options.leaseToken ?? `rt-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
      const leased = await this.deps.store.tryAcquireGoalLease(goal.id, leaseToken, AUTONOMY_LIMITS.evaluationLeaseSeconds);
      if (!leased) {
        return { kind: "SKIPPED", reason: "LEASE_BUSY", message: "Another evaluation holds this goal's lease." };
      }
      try {
        return await this.evaluateUnderLease(goal, leaseToken, now, options.tickStartedAt ?? now);
      } finally {
        await this.deps.store.releaseGoalLease(goal.id, leaseToken);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Verification pass (goal.pendingExecution present)
  // -------------------------------------------------------------------------

  private async verifyPending(goal: AgentGoal): Promise<EvaluationResult> {
    const now = this.deps.now();
    const pending = goal.pendingExecution!;
    const attempts = pending.verifyAttempts;

    const verdict = await verifyExecution(this.deps.gateway, {
      chainId: executionChainId(this.deps.adapter),
      quoteId: pending.quoteId,
      txHash: pending.txHash,
      expectedBuyAmountRaw: pending.expectedBuyAmountRaw,
      minBuyAmountRaw: pending.minBuyAmountRaw,
      attemptsSoFar: attempts,
      expectedSender: pending.expectedSender,
      // Delegated path: the executor binds the event intentId to the signed
      // witness actionId (delegatedActionId(goalId)).
      // Keyed off the ADAPTER, not the chain: 8453 is now also a delegated
      // chain, but a non-delegated (assisted/test) adapter running on 8453 must
      // not be held to the delegated intentId event.
      ...(isDelegatedAdapterId(this.deps.adapter.id)
        ? { expectedIntentId: delegatedActionId(goal.id) }
        : {}),
    });

    if (verdict.outcome === "PENDING_VERIFICATION") {
      const nextAttempts = attempts + 1;
      const timedOut = nextAttempts >= AUTONOMY_LIMITS.maxVerificationAttempts;
      const updatedAt = now.toISOString();
      const nextEval = new Date(now.getTime() + AUTONOMY_LIMITS.verificationRetrySeconds * 1000).toISOString();
      const updated = await this.deps.store.transitionGoal(goal.id, goal.wallet, ["EXECUTING"], goal.updatedAt, {
        status: timedOut ? "FAILED" : "EXECUTING",
        pendingExecution: timedOut ? null : { ...pending, verifyAttempts: nextAttempts },
        lastEvaluationAt: updatedAt,
        updatedAt,
        nextEvaluationAt: timedOut ? updatedAt : nextEval,
        lastResult: timedOut
          ? { at: updatedAt, outcome: "FAILED", code: "TIMEOUT", message: "Verification attempt budget exhausted — marked UNCERTAIN. No automatic retry was made." }
          : { at: updatedAt, outcome: "WAITING_VERIFICATION", code: "RPC_ERROR", message: verdict.message },
        stats: {
          ...goal.stats,
          consecutiveFailures: timedOut ? goal.stats.consecutiveFailures + 1 : goal.stats.consecutiveFailures,
        },
      });
      await this.audit(goal.wallet, timedOut ? "VERIFICATION_FAILED" : "VERIFICATION_PENDING", now, goal.id, goal.policyId, {
        txHash: pending.txHash,
        attempts: nextAttempts,
      });
      if (timedOut) {
        await this.recordAction(goal, pending.idempotencyKey, pending, {
          status: "UNCERTAIN",
          outcome: "UNCERTAIN",
          verified: false,
          failureCode: "TIMEOUT",
          message: verdict.message,
        }, now);
        return { kind: "UNCERTAIN", txHash: pending.txHash, message: verdict.message };
      }
      return { kind: "VERIFICATION_PENDING", txHash: pending.txHash, nextEvaluationAt: nextEval, message: verdict.message };
    }

    if (verdict.outcome === "VERIFIED") {
      return this.completeVerified(goal, pending, verdict, now);
    }

    if (verdict.outcome === "UNCERTAIN") {
      // Spec §16/§15: an uncertain broadcast is terminal for this goal —
      // NEVER re-submitted automatically. It requires human reconciliation.
      const updatedAt = now.toISOString();
      await this.deps.store.transitionGoal(goal.id, goal.wallet, ["EXECUTING"], goal.updatedAt, {
        status: "FAILED",
        pendingExecution: null,
        lastEvaluationAt: updatedAt,
        updatedAt,
        nextEvaluationAt: updatedAt,
        lastAction: "broadcast uncertain — not retried",
        lastResult: { at: updatedAt, outcome: "FAILED", code: "TIMEOUT", message: verdict.message },
        stats: { ...goal.stats, consecutiveFailures: goal.stats.consecutiveFailures + 1 },
      });
      await this.audit(goal.wallet, "VERIFICATION_FAILED", now, goal.id, goal.policyId, { txHash: pending.txHash, code: "TIMEOUT" });
      await this.recordAction(goal, pending.idempotencyKey, pending, {
        status: "UNCERTAIN",
        outcome: "UNCERTAIN",
        verified: false,
        failureCode: "TIMEOUT",
        message: verdict.message,
      }, now);
      await this.audit(goal.wallet, "GOAL_FAILED", now, goal.id, goal.policyId, { reason: "UNCERTAIN_BROADCAST" });
      return { kind: "UNCERTAIN", txHash: pending.txHash, message: verdict.message };
    }

    // FAILED (reverted or verification mismatch) — honest failure, never a
    // blind retry. The goal returns to WAITING with backoff so the next slot
    // re-runs the full check pipeline; consecutive failures bound this.
    const updatedAt = now.toISOString();
    const failures = goal.stats.consecutiveFailures + 1;
    const shouldFail = failures >= AUTONOMY_LIMITS.maxConsecutiveFailures;
    const nextEval = this.backoff(failures, now);
    const updated = await this.deps.store.transitionGoal(goal.id, goal.wallet, ["EXECUTING"], goal.updatedAt, {
      status: shouldFail ? "FAILED" : "WAITING",
      pendingExecution: null,
      lastEvaluationAt: updatedAt,
      updatedAt,
      nextEvaluationAt: shouldFail ? updatedAt : nextEval,
      lastAction: `execution failed: ${verdict.code}`,
      lastResult: { at: updatedAt, outcome: "FAILED", code: verdict.code === "TX_REVERTED" ? "TX_REVERTED" : "VERIFICATION_FAILED", message: verdict.message },
      stats: { ...goal.stats, consecutiveFailures: failures },
    });
    await this.audit(goal.wallet, "EXECUTION_FAILED", now, goal.id, goal.policyId, { txHash: pending.txHash, code: verdict.code });
    await this.recordAction(goal, pending.idempotencyKey, pending, {
      status: verdict.code === "TX_REVERTED" ? "REVERTED" : "FAILED",
      outcome: verdict.code === "TX_REVERTED" ? "FAILED" : "UNCERTAIN",
      verified: false,
      failureCode: verdict.code === "TX_REVERTED" ? "TX_REVERTED" : "VERIFICATION_FAILED",
      message: verdict.message,
      actualBuyAmountRaw: verdict.actualBuyAmountRaw,
      feeAmountRaw: verdict.feeAmountRaw,
      blockNumber: verdict.blockNumber,
    }, now);
    if (shouldFail) {
      await this.audit(goal.wallet, "GOAL_FAILED", now, goal.id, goal.policyId, { reason: "MAX_CONSECUTIVE_FAILURES" });
    }
    return { kind: "EXECUTION_FAILED", failureCode: verdict.code === "TX_REVERTED" ? "TX_REVERTED" : "VERIFICATION_FAILED", message: verdict.message };
  }

  private async completeVerified(
    goal: AgentGoal,
    pending: NonNullable<AgentGoal["pendingExecution"]>,
    verdict: Awaited<ReturnType<typeof verifyExecution>>,
    now: Date,
  ): Promise<EvaluationResult> {
    const updatedAt = now.toISOString();
    const reachedLimit = typeof goal.maxTrades === "number" && goal.stats.verified + 1 >= goal.maxTrades;
    const nextEval = new Date(now.getTime() + goal.cooldownSeconds * 1000).toISOString();
    const updated = await this.deps.store.transitionGoal(goal.id, goal.wallet, ["EXECUTING"], goal.updatedAt, {
      status: reachedLimit ? "COMPLETED" : "WAITING",
      pendingExecution: null,
      lastEvaluationAt: updatedAt,
      updatedAt,
      nextEvaluationAt: reachedLimit ? updatedAt : nextEval,
      lastAction: "swap executed and verified",
      lastResult: { at: updatedAt, outcome: "VERIFIED", code: null, message: verdict.message },
      stats: { ...goal.stats, verified: goal.stats.verified + 1, consecutiveFailures: 0, triggered: goal.stats.triggered },
    });
    await this.audit(goal.wallet, "TRANSACTION_CONFIRMED", now, goal.id, goal.policyId, { txHash: pending.txHash, blockNumber: verdict.blockNumber ?? null });
    await this.audit(goal.wallet, "EXECUTION_VERIFIED", now, goal.id, goal.policyId, {
      txHash: pending.txHash,
      actualBuyAmountRaw: verdict.actualBuyAmountRaw ?? null,
      feeAmountRaw: verdict.feeAmountRaw ?? null,
    });
    if (reachedLimit) await this.audit(goal.wallet, "GOAL_COMPLETED", now, goal.id, goal.policyId, { reason: "MAX_TRADES_REACHED" });
    if (updated) {
      await this.recordAction(goal, pending.idempotencyKey, pending, {
        status: "CONFIRMED",
        outcome: "VERIFIED",
        verified: true,
        message: verdict.message,
        actualBuyAmountRaw: verdict.actualBuyAmountRaw,
        feeAmountRaw: verdict.feeAmountRaw,
        blockNumber: verdict.blockNumber,
      }, now);
    }
    return { kind: "VERIFIED", txHash: pending.txHash, message: verdict.message };
  }

  // -------------------------------------------------------------------------
  // Stuck-execution reap (crash recovery)
  // -------------------------------------------------------------------------

  /**
   * Close out an EXECUTING goal that never recorded a transaction.
   *
   * Legacy goals only: builds before the hash-first ordering wrote EXECUTING
   * before the execution adapter, so a tick that died in that window left the
   * goal unreachable (see `isStuckExecuting`). The current ACT path never writes
   * EXECUTING without a hash, and a goal that is not EXECUTING is never reaped.
   * This pass:
   *
   *   1. takes the per-goal evaluation lease, so a tick that is still alive
   *      is never reaped underneath (returns SKIPPED/LEASE_BUSY instead);
   *   2. CAS EXECUTING -> FAILED, re-checked under the lease;
   *   3. releases the daily-spend reservation with reason UNATTEMPTED — the
   *      store refuses that release for anything other than RESERVED, so an
   *      ATTEMPTING (attempt marker already set) reservation keeps the spend
   *      counted, which is the only safe answer when an unrecorded broadcast
   *      remains possible;
   *   4. audits + records the attempt as FAILED with NO tx hash.
   *
   * It never invents a tx hash, never re-quotes and never retries the swap —
   * a retry would need a fresh evaluation on a fresh slot, and after this
   * pass the goal is terminal anyway.
   */
  private async reapStuckExecution(goal: AgentGoal, now: Date): Promise<EvaluationResult> {
    const leaseToken = `reap-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    const leased = await this.deps.store.tryAcquireGoalLease(goal.id, leaseToken, AUTONOMY_LIMITS.evaluationLeaseSeconds);
    if (!leased) {
      return { kind: "SKIPPED", reason: "LEASE_BUSY", message: "Another evaluation holds this goal's lease." };
    }
    try {
      // Re-read under the lease: a concurrent pass may have moved the goal.
      const current = await this.deps.store.getGoal(goal.id);
      if (!current) return { kind: "SKIPPED", reason: "NOT_FOUND", message: "Goal not found." };
      if (!isStuckExecuting(current, now)) {
        return { kind: "SKIPPED", reason: "STATE_CHANGED", message: "Goal state changed during evaluation." };
      }

      const updatedAt = now.toISOString();
      const reaped = await this.deps.store.transitionGoal(goal.id, goal.wallet, ["EXECUTING"], current.updatedAt, {
        status: "FAILED",
        pendingExecution: null,
        lastEvaluationAt: updatedAt,
        updatedAt,
        nextEvaluationAt: updatedAt,
        lastAction: `stuck execution reaped after ${STUCK_EXECUTION_REAP_SECONDS}s without a transaction`,
        lastResult: { at: updatedAt, outcome: "FAILED", code: STUCK_EXECUTION_CODE, message: STUCK_EXECUTION_MESSAGE },
        stats: { ...current.stats, consecutiveFailures: current.stats.consecutiveFailures + 1 },
      });
      if (!reaped) {
        return { kind: "SKIPPED", reason: "STATE_CHANGED", message: "Goal state changed during evaluation." };
      }

      // The reservation was taken on the UTC day of the interrupted tick and
      // is keyed by the SAME execution id the ACT path derived from this
      // goal's slot. UNATTEMPTED is state-enforced: RESERVED only.
      const attemptedAt = new Date(current.lastEvaluationAt ?? current.updatedAt);
      const dayKey = utcDayKey(Number.isFinite(attemptedAt.getTime()) ? attemptedAt : now);
      const executionId = executionKeyForSlot(current.id, current.nextEvaluationAt);
      const released = await this.releaseReservation(current.policyId, dayKey, executionId, { reason: "UNATTEMPTED" }, now);

      await this.audit(current.wallet, "EXECUTION_FAILED", now, current.id, current.policyId, {
        code: STUCK_EXECUTION_CODE,
        stuck: true,
        reapAfterSeconds: STUCK_EXECUTION_REAP_SECONDS,
        // false => the attempt marker was already set: a broadcast remains
        // possible and the spend deliberately stays counted.
        reservationReleased: released !== null,
      });
      await this.audit(current.wallet, "GOAL_FAILED", now, current.id, current.policyId, { reason: "STUCK_EXECUTION", code: STUCK_EXECUTION_CODE });
      await this.recordAction(current, executionId, null, {
        status: "FAILED",
        outcome: "FAILED",
        verified: false,
        failureCode: STUCK_EXECUTION_CODE,
        message: STUCK_EXECUTION_MESSAGE,
      }, now);

      return { kind: "STUCK_EXECUTION_REAPED", message: STUCK_EXECUTION_MESSAGE };
    } finally {
      await this.deps.store.releaseGoalLease(goal.id, leaseToken);
    }
  }

  /**
   * UNRESOLVED BROADCAST, step 1 (runs on every open goal's tick, before any
   * quote or flag gate). Read-only unless the claim is present. A claim on the
   * current slot is only ever taken by a tick about to broadcast, so a claim
   * with no hash on the goal means that tick was interrupted. Under the goal
   * lease, the goal is re-read and the claim re-checked, then the goal is closed.
   * A live tick holding the lease is never closed underneath: the check returns
   * LEASE_BUSY and the goal is left as it is.
   */
  private async closeIfUnresolvedBroadcast(goal: AgentGoal, now: Date): Promise<EvaluationResult | null> {
    if (!OPEN_GOAL_STATUSES.includes(goal.status)) return null;
    if (!(await this.deps.store.hasExecutionClaim(executionKeyForSlot(goal.id, goal.nextEvaluationAt)))) return null;

    const leaseToken = `unresolved-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    const leased = await this.deps.store.tryAcquireGoalLease(goal.id, leaseToken, AUTONOMY_LIMITS.evaluationLeaseSeconds);
    if (!leased) {
      return { kind: "SKIPPED", reason: "LEASE_BUSY", message: "Another evaluation holds this goal's lease." };
    }
    try {
      const current = await this.deps.store.getGoal(goal.id);
      if (!current || !OPEN_GOAL_STATUSES.includes(current.status) || current.pendingExecution) {
        return { kind: "SKIPPED", reason: "STATE_CHANGED", message: "Goal state changed during evaluation." };
      }
      const idempotencyKey = executionKeyForSlot(current.id, current.nextEvaluationAt);
      if (!(await this.deps.store.hasExecutionClaim(idempotencyKey))) return null;
      return await this.closeUnresolvedBroadcast(current, idempotencyKey, now);
    } finally {
      await this.deps.store.releaseGoalLease(goal.id, leaseToken);
    }
  }

  /**
   * UNRESOLVED BROADCAST, step 2 — close the goal. The outcome is UNKNOWN: the
   * interrupted tick may have broadcast, so nothing is retried, the adapter is
   * never called, no new evaluation slot is opened, and the spend reservation
   * stays counted (never released here). If a hash is in the action history for
   * this slot, the message names it and says it was not verified automatically.
   * A transaction hash stored on the goal (pendingExecution) is never closed
   * here: that goal is verified by the verification pass instead.
   */
  private async closeUnresolvedBroadcast(goal: AgentGoal, idempotencyKey: string, now: Date): Promise<EvaluationResult> {
    const updatedAt = now.toISOString();
    const records = await this.deps.store.listActionRecords(goal.id);
    const recordedHash = records.find((r) => r.idempotencyKey === idempotencyKey && r.txHash)?.txHash ?? null;
    const message = recordedHash
      ? `${UNRESOLVED_BROADCAST_MESSAGE} Transaction ${recordedHash} is recorded for this slot in the action history; the goal was not set to verify it, so confirm that transaction on-chain.`
      : UNRESOLVED_BROADCAST_MESSAGE;

    const written = await this.deps.store.transitionGoal(goal.id, goal.wallet, OPEN_GOAL_STATUSES, goal.updatedAt, {
      status: "FAILED",
      lastEvaluationAt: updatedAt,
      updatedAt,
      nextEvaluationAt: updatedAt,
      lastAction: "broadcast outcome unknown — manual reconciliation required",
      lastResult: { at: updatedAt, outcome: "FAILED", code: UNRESOLVED_BROADCAST_CODE, message },
      stats: { ...goal.stats, consecutiveFailures: goal.stats.consecutiveFailures + 1 },
    });
    if (!written) {
      return { kind: "SKIPPED", reason: "STATE_CHANGED", message: "Goal state changed during evaluation." };
    }

    console.error(`[autonomy] goal ${goal.id}: broadcast outcome UNKNOWN for slot ${idempotencyKey} — goal closed for manual reconciliation`);
    await this.audit(goal.wallet, "EXECUTION_FAILED", now, goal.id, goal.policyId, {
      code: UNRESOLVED_BROADCAST_CODE,
      unresolved: true,
      txHashRecorded: recordedHash !== null,
    });
    await this.audit(goal.wallet, "GOAL_FAILED", now, goal.id, goal.policyId, { reason: "UNRESOLVED_BROADCAST", code: UNRESOLVED_BROADCAST_CODE });
    // recordAction replaces the record for this key, so the hash is carried over.
    await this.recordAction(goal, idempotencyKey, null, {
      status: "FAILED",
      outcome: "FAILED",
      verified: false,
      failureCode: UNRESOLVED_BROADCAST_CODE,
      message,
      ...(recordedHash ? { txHash: recordedHash } : {}),
    }, now);
    return { kind: "UNRESOLVED_BROADCAST", message };
  }

  // -------------------------------------------------------------------------
  // Standard evaluation pass
  // -------------------------------------------------------------------------

  private async evaluateUnderLease(goal: AgentGoal, _leaseToken: string, now: Date, budgetAnchor: Date): Promise<EvaluationResult> {
    const updatedAt = now.toISOString();

    // Expiry is deterministic housekeeping — works even while paused-ish states.
    if (new Date(goal.expiresAt).getTime() <= now.getTime()) {
      await this.transitionOrLog(goal, goal.updatedAt, { status: "EXPIRED", updatedAt, lastResult: { at: updatedAt, outcome: "EXPIRED", code: null, message: "Goal expired." } }, now, "GOAL_EXPIRED");
      return { kind: "GOAL_CLOSED", status: "EXPIRED", message: "Goal expired." };
    }

    const policy = await this.deps.store.getPolicy(goal.policyId);
    const switchAtTick = await readAutonomousEmergencySwitch();
    if (!switchAtTick.allowed) {
      logEmergencySwitchDecision(this.deps.logger, switchAtTick, { goalId: goal.id, phase: "tick" });
    }
    const emergency = !switchAtTick.allowed;

    // OBSERVE — fresh quote for the exact goal trade. Taker is the goal's
    // own wallet; slippage clamped to the policy cap when a policy exists.
    const slippageBps = policy ? Math.min(goal.trade.slippageBps, policy.maxSlippageBps) : goal.trade.slippageBps;
    // Phase 3: when execution targets the delegated executor (Base Sepolia
    // 84532), quote its OWN route registry (run-fresh token allowlist) —
    // never the v1 registry. Any other chain keeps the default quote path.
    const quoteChainId = executionChainId(this.deps.adapter);
    const quoteOutcome = await this.deps.gateway.quote({
      chainId: quoteChainId,
      taker: goal.wallet,
      sellToken: goal.trade.sellToken,
      buyToken: goal.trade.buyToken,
      sellAmount: goal.trade.sellAmountRaw,
      slippageBps,
      // Delegated adapters quote against THAT chain's pinned executor. Keyed off
      // the ADAPTER (not the chain), because 8453 is now also a delegated chain
      // and an assisted adapter on 8453 must keep quoting the v1 registry. On
      // mainnet the executor is operator-supplied, so an unpinned chain yields
      // no `executor` and the quote path fails closed instead of silently
      // quoting the v1 registry (which the delegated contract cannot execute
      // against — PHASE 5 finding F-9).
      ...(isDelegatedAdapterId(this.deps.adapter.id) && isDelegatedChainId(quoteChainId) && delegatedExecutorAddressFor(quoteChainId)
        ? { executor: delegatedExecutorAddressFor(quoteChainId) }
        : {}),
    });

    if (!quoteOutcome.ok) {
      return this.parkWithFailure(goal, quoteOutcome.failure.code, quoteOutcome.failure.message, now, { conditionChecked: false });
    }
    const quote = quoteOutcome.data;
    await this.audit(goal.wallet, "QUOTE_CREATED", now, goal.id, goal.policyId, {
      quoteId: quote.quoteId,
      expectedBuyAmountRaw: quote.expectedBuyAmountRaw,
      minBuyAmountRaw: quote.minBuyAmountRaw,
    });

    // UNDERSTAND — deterministic condition check (no LLM anywhere).
    const condition = evaluateCondition(
      goal.condition,
      quote.sellAmountRaw,
      quote.expectedBuyAmountRaw,
      goal.trade.sellDecimals,
      goal.trade.buyDecimals,
    );
    if ("error" in condition) {
      return this.parkWithFailure(goal, "INVALID_CONDITION", "Goal condition could not be evaluated against live quote data.", now, { conditionChecked: true });
    }
    await this.audit(goal.wallet, "CONDITION_CHECKED", now, goal.id, goal.policyId, {
      kind: goal.condition.kind,
      threshold: goal.condition.threshold,
      price: condition.price,
      met: condition.met,
    });

    if (!condition.met) {
      const nextEval = new Date(now.getTime() + goal.cooldownSeconds * 1000).toISOString();
      await this.deps.store.transitionGoal(goal.id, goal.wallet, ["ACTIVE", "WAITING"], goal.updatedAt, {
        status: "WAITING",
        lastEvaluationAt: updatedAt,
        updatedAt,
        nextEvaluationAt: nextEval,
        lastResult: { at: updatedAt, outcome: "CONDITION_NOT_MET", code: null, message: `Condition not met (price ${condition.price} vs ${goal.condition.threshold}).` },
        stats: { ...goal.stats, evaluations: goal.stats.evaluations + 1, consecutiveFailures: 0 },
      });
      return { kind: "CONDITION_NOT_MET", price: condition.price, nextEvaluationAt: nextEval, message: "Condition not met — waiting." };
    }

    await this.audit(goal.wallet, "CONDITION_MET", now, goal.id, goal.policyId, { price: condition.price, threshold: goal.condition.threshold });

    // POLICY CHECK — deterministic gate (spec §5). Runs BEFORE any
    // prepare/authorization work; the daily spend reservation is taken
    // atomically right before broadcast so the caps cannot be raced between
    // goals. The ledger read below is only the fast-path pre-check — the
    // reservation script re-checks both caps atomically and is authoritative.
    const dayKey = utcDayKey(now);
    let spend: { dailySpendRaw: string; actionsToday: number } = { dailySpendRaw: "0", actionsToday: 0 };
    if (policy) {
      const ledger = await this.deps.store.getDayLedger(policy.id, dayKey);
      if (ledger.status !== "OK") {
        // Malformed legacy CSV or a fenced ledger whose total is unknown:
        // NEVER fall back to zero — fail closed and let a human reconcile.
        return this.parkWithFailure(
          goal,
          "EXECUTION_UNAVAILABLE",
          ledger.status === "MALFORMED_LEGACY"
            ? "Daily spend ledger contains malformed legacy data — nothing was broadcast. Manual reconciliation required (see docs/AUTONOMY-DAILY-SPEND-RESERVATIONS.md)."
            : "Daily spend ledger is fenced but its totals are unknown — nothing was broadcast. Manual reconciliation required (see docs/AUTONOMY-DAILY-SPEND-RESERVATIONS.md).",
          now,
          { conditionChecked: true },
        );
      }
      spend = { dailySpendRaw: ledger.spendRaw, actionsToday: ledger.actions };
    }
    const decision = evaluatePolicyAgainstAction(
      policy,
      goal,
      {
        action: "swap",
        chainId: executionChainId(this.deps.adapter),
        sellToken: goal.trade.sellToken,
        buyToken: goal.trade.buyToken,
        sellAmountRaw: goal.trade.sellAmountRaw,
        slippageBps,
      },
      spend,
      now,
    );
    if (!decision.allowed) {
      await this.audit(goal.wallet, "POLICY_REJECTED", now, goal.id, goal.policyId, { rule: decision.rejection.rule });
      return this.park(goal, "POLICY_REJECTED", `Policy rejected: ${decision.rejection.message}`, now, decision.rejection.rule);
    }
    await this.audit(goal.wallet, "POLICY_APPROVED", now, goal.id, goal.policyId, { policyId: policy?.id ?? null });

    // AUTHORIZATION — the non-custodial boundary (spec §6). Emergency
    // disable short-circuits here too.
    const authorization = emergency
      ? { authorized: false as const, reason: "EMERGENCY_DISABLE" }
      : await this.deps.adapter.checkAuthorization(goal.wallet, decision.policy);
    await this.audit(goal.wallet, "AUTHORIZATION_CHECKED", now, goal.id, goal.policyId, { authorized: authorization.authorized, reason: authorization.reason ?? null });
    if (!authorization.authorized) {
      return this.park(
        goal,
        emergency ? "EXECUTION_UNAVAILABLE" : "AUTHORIZATION_MISSING",
        emergency
          ? "Autonomous execution is globally disabled by the operator. Nothing was signed or sent."
          : `No valid autonomous authorization (${authorization.reason ?? "unauthorized"}). Review and authorize this goal to enable execution — until then it keeps observing.`,
        now,
      );
    }

    // ACT — idempotency claim, spend reservation, budget gate, then prepare,
    // attempt marker and execute under the broadcast budget. The goal is NOT
    // written to EXECUTING until the adapter returns a transaction hash.
    // Same derivation the stuck-execution reap uses — see executionKeyForSlot.
    const budgetEndsAtMs = budgetAnchor.getTime() + AUTONOMY_EXECUTION_BUDGET_SECONDS * 1000;
    const idempotencyKey = executionKeyForSlot(goal.id, goal.nextEvaluationAt);
    const claimed = await this.deps.store.claimExecution(idempotencyKey, AUTONOMY_LIMITS.executionGuardSeconds);
    if (!claimed) {
      // The slot was claimed by an attempt that recorded no hash. The early check
      // in evaluateGoal normally closes this first; this is the same outcome.
      await this.audit(goal.wallet, "DUPLICATE_PREVENTED", now, goal.id, goal.policyId, { idempotencyKey });
      return this.closeUnresolvedBroadcast(goal, idempotencyKey, now);
    }

    // ATOMIC daily spend reservation: both caps (maxDailyRaw and
    // maxActionsPerDay) are enforced inside one Redis script against the
    // policy-day totals — concurrent goals sharing this policy can never
    // jointly exceed them (the old read-then-append ledger only capped the
    // action COUNT and raced the spend SUM across goals). Idempotent per
    // execution id: retries and duplicate execution ids never double-count.
    const reservation = await this.deps.store.reserveDailySpend({
      policyId: decision.policy.id,
      dayKey,
      execId: idempotencyKey,
      amountRaw: goal.trade.sellAmountRaw,
      maxDailyRaw: decision.policy.maxDailyRaw,
      maxActions: decision.policy.maxActionsPerDay,
    });
    if (!reservation.ok) {
      if (reservation.reason === "OVER_BUDGET") {
        return this.park(goal, "POLICY_REJECTED", "This trade would exceed the daily spend limit authorized by the policy.", now, "OVER_DAILY_LIMIT");
      }
      if (reservation.reason === "OVER_ACTIONS") {
        return this.park(goal, "POLICY_REJECTED", "Daily action limit for this policy has been reached.", now, "OVER_ACTION_RATE");
      }
      // MALFORMED_LEGACY / LEDGER_UNAVAILABLE / BAD_AMOUNT — fail closed.
      return this.parkWithFailure(
        goal,
        "EXECUTION_UNAVAILABLE",
        "Daily spend reservation refused (ledger unavailable or malformed) — nothing was broadcast. Manual reconciliation required (see docs/AUTONOMY-DAILY-SPEND-RESERVATIONS.md).",
        now,
        { conditionChecked: true },
      );
    }
    if (reservation.state !== "RESERVED") {
      // The same execution id already reached (or passed) an attempt — this
      // is a duplicate retry. NEVER invoke the adapter again; the reservation
      // keeps whatever state the winner left it in (never double-counted).
      // An attempt marker (or a commit) already exists for this execution id, and
      // this tick holds the claim, so the earlier attempt recorded no hash here.
      await this.audit(goal.wallet, "DUPLICATE_PREVENTED", now, goal.id, goal.policyId, { idempotencyKey, reservationState: reservation.state });
      return this.closeUnresolvedBroadcast(goal, idempotencyKey, now);
    }

    // Quote freshness at broadcast time (spec §13 — never execute stale data).
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (!Number.isFinite(quote.quoteExpiresAt) || quote.quoteExpiresAt <= nowSeconds) {
      await this.releaseReservation(decision.policy.id, dayKey, idempotencyKey, { reason: "PRE_BROADCAST_REFUSAL", code: "QUOTE_STALE" }, now);
      return this.parkWithFailure(goal, "QUOTE_STALE", "Quote expired before execution could start — nothing was broadcast.", now, { conditionChecked: true });
    }

    // TIME BUDGET GATE — before the broadcast. With too little of the tick's
    // budget left, nothing can be broadcast safely: nothing was sent, so the
    // reservation is released as UNATTEMPTED (the verified path), the claim is
    // dropped, and the goal is retried on a later tick. RPC_ERROR is an
    // infrastructure code, so this is not a trade-failure strike.
    if (budgetEndsAtMs - this.deps.now().getTime() < AUTONOMY_MIN_EXECUTION_BUDGET_SECONDS * 1000) {
      await this.releaseReservation(decision.policy.id, dayKey, idempotencyKey, { reason: "UNATTEMPTED" }, now);
      await this.deps.store.releaseExecution(idempotencyKey);
      return this.parkWithFailure(
        goal,
        "RPC_ERROR",
        "This tick's time budget was nearly used up before execution could start — nothing was broadcast. The goal is retried on a later tick.",
        now,
        { conditionChecked: true },
      );
    }

    // NO GOAL WRITE BEFORE THE BROADCAST RESULT. The goal stays ACTIVE/WAITING
    // while the swap is in flight. EXECUTING (+ pendingExecution) is written only
    // once the adapter has returned a transaction hash — see recordSubmittedGoal.
    // A tick killed anywhere before that point leaves an ACTIVE/WAITING goal that
    // the scheduler can still select. Its claim on this slot is what the next tick
    // sees, and closeIfUnresolvedBroadcast closes the goal as UNKNOWN. The
    // stuck-execution reap only closes a goal that IS EXECUTING, so it never
    // touches this one.

    // POST-BUDGET WORK, UNDER THE TICK BUDGET. From prepare to the adapter's
    // result runs under one deadline (AUTONOMY_EXECUTION_BUDGET_SECONDS after the
    // tick started). The work RETURNS a step and writes no goal state. Every
    // failure is persisted below with its real reason and the in-flight stage.
    const progress: BroadcastProgress = { adapterInvoked: false, abandoned: false, stage: null };
    const work = this.runBroadcastSteps({
      goal,
      policy: decision.policy,
      dayKey,
      idempotencyKey,
      quote,
      slippageBps,
      budgetEndsAtMs,
      progress,
      now,
    });
    const outcome = await untilDeadline(work, budgetEndsAtMs - this.deps.now().getTime());
    if (outcome.timedOut) {
      // Stop the abandoned work from ever starting the adapter, then record what
      // actually happened: a broadcast may already be in flight.
      progress.abandoned = true;
      void work
        .then((late) => this.recordLateBroadcast(goal, late, { quote, idempotencyKey }))
        .catch((error: unknown) => {
          void error;
          console.error(`[autonomy] goal ${goal.id}: a late broadcast result could not be recorded — reconcile this goal`);
        });
      return this.failBudgetEnded(goal, idempotencyKey, decision.policy.id, dayKey, progress.adapterInvoked, progress.stage);
    }
    const step = outcome.value;
    if (step.kind !== "ADAPTER_RESULT") {
      return this.closeUnbroadcastStep(step, {
        goal,
        policyId: decision.policy.id,
        dayKey,
        idempotencyKey,
        now,
      });
    }
    const result = step.result;

    if (!result.ok) {
      // Clean adapter refusal: only an explicit verified pre-broadcast code
      // frees the reservation. RPC_ERROR / TIMEOUT / anything unknown keeps
      // it AMBIGUOUS — the transaction may have been broadcast.
      if (isPreBroadcastRefusalCode(result.code)) {
        await this.releaseForFailure(decision.policy.id, dayKey, idempotencyKey, result.code, now);
      } else {
        await this.markReservationAmbiguous(decision.policy.id, dayKey, idempotencyKey, now);
      }
      return this.failAfterClaim(goal, idempotencyKey, result.code, withStage(result.message, progress.stage), now, progress.stage);
    }

    // TRANSACTION SUBMITTED — a hash came back, so the spend is consumed
    // (conservative: it stays counted even if the receipt later shows a revert).
    // Only now does the goal move to EXECUTING, and only with that hash.
    await this.commitReservation(decision.policy.id, dayKey, idempotencyKey, now);
    const submittedAt = now.toISOString();
    await this.recordSubmittedGoal(goal, result.txHash, {
      status: "EXECUTING",
      updatedAt: submittedAt,
      lastEvaluationAt: submittedAt,
      nextEvaluationAt: new Date(now.getTime() + AUTONOMY_LIMITS.verificationRetrySeconds * 1000).toISOString(),
      pendingExecution: {
        txHash: result.txHash,
        quoteId: quote.quoteId,
        idempotencyKey,
        submittedAt,
        verifyAttempts: 0,
        expectedBuyAmountRaw: quote.expectedBuyAmountRaw,
        minBuyAmountRaw: quote.minBuyAmountRaw,
        expectedSender: expectedSenderFor(this.deps.adapter),
      },
      lastAction: `transaction submitted ${result.txHash}`,
      lastResult: { at: submittedAt, outcome: "WAITING_VERIFICATION", code: null, message: "Transaction submitted — verifying receipt before reporting any result." },
      stats: { ...goal.stats, evaluations: goal.stats.evaluations + 1, triggered: goal.stats.triggered + 1 },
    });
    await this.audit(goal.wallet, "TRANSACTION_SUBMITTED", now, goal.id, goal.policyId, { txHash: result.txHash, idempotencyKey });
    await this.recordAction(goal, idempotencyKey, null, {
      status: "SUBMITTED",
      outcome: "PENDING_VERIFICATION",
      verified: false,
      message: "Submitted — awaiting receipt verification.",
      txHash: result.txHash,
    }, now, quote);

    return {
      kind: "EXECUTION_SUBMITTED",
      txHash: result.txHash,
      message: "Transaction submitted; verification scheduled.",
    };
  }

  // -------------------------------------------------------------------------
  // Post-budget broadcast work (see AUTONOMY_EXECUTION_BUDGET_SECONDS)
  // -------------------------------------------------------------------------

  /**
   * Prepare → goal re-read → attempt marker → emergency-switch re-read → adapter.
   * Returns a step and writes no goal state, so when the budget ends the caller
   * can record the outcome without racing this work.
   */
  private async runBroadcastSteps(ctx: BroadcastContext): Promise<BroadcastStep> {
    const { goal, policy, dayKey, idempotencyKey, quote, slippageBps, budgetEndsAtMs, progress, now } = ctx;

    // TRADE PREPARED — through MCP, unsigned only (spec §12). On the
    // DELEGATED path (Phase 2/5, Base Sepolia) the v1 intent build does NOT
    // apply: its token registry is the v1 executor's, so building a v1
    // intent would wrongly reject delegated-allowlisted tokens (PHASE 5
    // finding F-9). There, preparation IS the adapter's own signed slot
    // re-validation (witness actionId/policyHash/minOut vs the live quote),
    // and the adapter constructs the broadcast calldata itself.
    const delegatedPath = isDelegatedAdapterId(this.deps.adapter.id);
    let preparedSteps: DelegatedSwapRequest["steps"] = [];
    let preparedTransactionRequest: DelegatedSwapRequest["transactionRequest"] = null;
    if (delegatedPath) {
      await this.audit(goal.wallet, "TRADE_PREPARED", now, goal.id, goal.policyId, { quoteId: quote.quoteId, steps: 0, delegated: true });
    } else {
      const prepared = await this.deps.gateway.prepare({ quoteId: quote.quoteId, authorization: "APPROVAL" });
      if (!prepared.ok) {
        // Prepare is strictly pre-broadcast (unsigned calldata only). The adapter
        // is never invoked on this path.
        return { kind: "PREPARE_REFUSED", code: prepared.failure.code, message: prepared.failure.message };
      }
      preparedSteps = prepared.data.steps;
      preparedTransactionRequest = prepared.data.transactionRequest;
      await this.audit(goal.wallet, "TRADE_PREPARED", now, goal.id, goal.policyId, { quoteId: quote.quoteId, steps: prepared.data.steps.length });
    }

    // GOAL STILL OPEN — the goal is not EXECUTING during the broadcast, so a
    // pause or cancel that landed during prepare is caught here, before the
    // attempt marker. That is the last point where the reservation can still be
    // released as UNATTEMPTED. The read is bounded: a hung store fails closed.
    const live = await bounded("goal state re-read", () => this.deps.store.getGoal(goal.id));
    if (!live.ok) return { kind: "STATE_UNREADABLE" };
    if (!live.value || !OPEN_GOAL_STATUSES.includes(live.value.status)) {
      return { kind: "GOAL_CLOSED", status: live.value?.status ?? null };
    }

    // ATTEMPT MARKER — persisted BEFORE the execution adapter is invoked.
    // Once this is visible a crash may have broadcast: the reservation is
    // never released automatically after this point. Bounded: a timeout is
    // treated as "not recorded", so the adapter is NOT invoked (fail closed).
    const marker = await bounded("spend attempt marker", () => this.deps.store.markSpendAttempt(policy.id, dayKey, idempotencyKey));
    const attemptState: SpendReservationState | null = marker.ok ? marker.value : null;
    if (attemptState !== "ATTEMPTING") {
      // Missing/Redis failure/lost response (or a state that is no longer
      // safely attemptable): DO NOT invoke the adapter (fail closed).
      return { kind: "ATTEMPT_NOT_RECORDED" };
    }

    // Re-read the KV emergency switch immediately before the adapter can
    // proceed so a disable between tick-start and broadcast is honoured.
    const switchAtBoundary = await readAutonomousEmergencySwitch();
    if (!switchAtBoundary.allowed) {
      logEmergencySwitchDecision(this.deps.logger, switchAtBoundary, { goalId: goal.id, phase: "execution-boundary" });
      return {
        kind: "SWITCH_REFUSED",
        message: `Autonomous execution refused by emergency switch (${switchAtBoundary.reason}). Nothing was broadcast.`,
      };
    }

    // Never start the adapter after the budget ended or after the caller gave
    // up. Checked synchronously right before the call.
    if (progress.abandoned || this.deps.now().getTime() >= budgetEndsAtMs) {
      return { kind: "BUDGET_ENDED" };
    }

    // EXECUTE — only the adapter can reach a signature (spec §6). It is
    // called with UNSIGNED data and after every deterministic check passed.
    progress.adapterInvoked = true;
    let result: DelegatedSwapResult;
    try {
      result = await this.deps.adapter.executeSwap({
        goalId: goal.id,
        policyId: policy.id,
        wallet: goal.wallet,
        chainId: executionChainId(this.deps.adapter),
        quoteId: quote.quoteId,
        sellToken: goal.trade.sellToken,
        buyToken: goal.trade.buyToken,
        sellAmountRaw: goal.trade.sellAmountRaw,
        expectedBuyAmountRaw: quote.expectedBuyAmountRaw,
        minBuyAmountRaw: quote.minBuyAmountRaw,
        slippageBps,
        idempotencyKey,
        steps: preparedSteps,
        transactionRequest: preparedTransactionRequest,
        // Stage reports are synchronous and best-effort. Once the caller has
        // stopped waiting (abandoned), a late report must not rewrite the
        // stage that was in flight when the budget ended.
        onStage: (stage) => {
          if (!progress.abandoned) progress.stage = stage;
        },
      });
    } catch (error) {
      // UNKNOWN error: the broadcast MAY have happened. The caller marks the
      // reservation AMBIGUOUS (spend stays counted) and never releases it.
      void error;
      return { kind: "ADAPTER_THREW", stage: progress.stage };
    }
    return { kind: "ADAPTER_RESULT", result };
  }

  /** Persists the real outcome for a step that did not reach a broadcast result. */
  private async closeUnbroadcastStep(
    step: UnbroadcastStep,
    c: { goal: AgentGoal; policyId: string; dayKey: string; idempotencyKey: string; now: Date },
  ): Promise<EvaluationResult> {
    switch (step.kind) {
      case "PREPARE_REFUSED":
        // A whitelisted verified-pre-broadcast refusal frees the reservation;
        // anything unknown keeps it counted (never released automatically).
        await this.releaseForFailure(c.policyId, c.dayKey, c.idempotencyKey, step.code, c.now);
        return this.failAfterClaim(c.goal, c.idempotencyKey, step.code, withStage(step.message, "prepare"), c.now, "prepare");
      case "GOAL_CLOSED":
        // Paused, cancelled or otherwise closed during prepare. Nothing was
        // attempted (no marker, no adapter), so the reservation is provably
        // UNATTEMPTED and the claim is dropped: the slot is not consumed.
        this.deps.logger.warn("Goal closed during prepare — nothing was broadcast", { goalId: c.goal.id, status: step.status });
        await this.releaseUnattempted(c);
        return { kind: "SKIPPED", reason: "STATE_CHANGED", message: "Goal state changed during evaluation." };
      case "STATE_UNREADABLE":
        // The state re-read failed or timed out before the marker: nothing was
        // attempted, so the reservation and claim are released as UNATTEMPTED.
        await this.releaseUnattempted(c);
        return this.failAfterClaim(
          c.goal,
          c.idempotencyKey,
          "RPC_ERROR",
          "Goal state could not be re-read before the broadcast — nothing was broadcast. The goal is retried on a later tick.",
          c.now,
          "goal-reread",
        );
      case "ATTEMPT_NOT_RECORDED":
        // The reservation is left as-is (it counts against the day — conservative)
        // and is recoverable later via the verified UNATTEMPTED path once a
        // human confirms nothing was sent.
        this.deps.logger.error("Spend attempt marker could not be persisted — adapter NOT invoked", { goalId: c.goal.id });
        return this.failAfterClaim(
          c.goal,
          c.idempotencyKey,
          "RPC_ERROR",
          "Spend attempt marker could not be persisted — the execution adapter was NOT invoked. The reservation stays reserved (recoverable as UNATTEMPTED).",
          c.now,
          "attempt-marker",
        );
      case "SWITCH_REFUSED":
        return this.controlPlaneRefuseAfterClaim(c.goal, c.idempotencyKey, "EXECUTION_UNAVAILABLE", step.message, c.now, "execution-boundary");
      case "ADAPTER_THREW":
        this.deps.logger.error("Autonomous execution adapter threw", { goalId: c.goal.id, stage: step.stage ?? "unknown" });
        await this.markReservationAmbiguous(c.policyId, c.dayKey, c.idempotencyKey, c.now);
        return this.failAfterClaim(
          c.goal,
          c.idempotencyKey,
          "EXECUTION_UNAVAILABLE",
          withStage(
            "Execution adapter failed unexpectedly — the broadcast outcome is UNKNOWN. The spend reservation is kept (AMBIGUOUS), never released.",
            step.stage,
          ),
          c.now,
          step.stage,
        );
      case "BUDGET_ENDED":
        return this.failBudgetEnded(c.goal, c.idempotencyKey, c.policyId, c.dayKey, false, null);
    }
  }

  /**
   * Nothing was attempted (no attempt marker, adapter never invoked): release the
   * reservation as UNATTEMPTED and drop the execution claim. Both are bounded.
   */
  private async releaseUnattempted(c: { policyId: string; dayKey: string; idempotencyKey: string; now: Date }): Promise<void> {
    await this.releaseReservation(c.policyId, c.dayKey, c.idempotencyKey, { reason: "UNATTEMPTED" }, c.now);
    await bounded("execution claim release", () => this.deps.store.releaseExecution(c.idempotencyKey));
  }

  /**
   * The budget ended before a broadcast result. Nothing is released: the spend
   * stays counted. The adapter may still be in flight, so the outcome is
   * UNKNOWN unless it was never invoked.
   */
  private async failBudgetEnded(
    goal: AgentGoal,
    idempotencyKey: string,
    policyId: string,
    dayKey: string,
    adapterInvoked: boolean,
    stage: DelegatedExecutionStage | null,
  ): Promise<EvaluationResult> {
    const at = this.deps.now();
    await this.markReservationAmbiguous(policyId, dayKey, idempotencyKey, at);
    return this.failAfterClaim(
      goal,
      idempotencyKey,
      "RPC_ERROR",
      adapterInvoked ? budgetEndedAdapterInvoked(stage) : budgetEndedBeforeBroadcast(stage),
      at,
      stage ?? (adapterInvoked ? "verifyOnChain" : "prepare"),
    );
  }

  /**
   * A broadcast that returned a hash AFTER the budget ended. The tick has already
   * persisted the timeout (WAITING, RPC_ERROR) and the adapter has recorded the
   * hash on the authorization slot. The transaction is real, so it is recorded
   * now: the goal moves to EXECUTING with that hash, verification decides the
   * outcome, and the action record is updated. A late FAILURE is not re-written —
   * the timeout already reported it honestly. Not budget-bounded, for the same
   * reason as recordSubmittedGoal.
   */
  private async recordLateBroadcast(
    goal: AgentGoal,
    step: BroadcastStep,
    c: { quote: QuotedSwap; idempotencyKey: string },
  ): Promise<void> {
    if (step.kind !== "ADAPTER_RESULT" || !step.result.ok) return;
    const txHash = step.result.txHash;
    this.deps.logger.error("Broadcast returned a transaction hash after the execution budget ended — recording it on the goal", {
      goalId: goal.id,
      txHash,
    });
    const current = await this.deps.store.getGoal(goal.id);
    if (!current) {
      console.error(`[autonomy] goal ${goal.id} not found: late transaction ${txHash} is recorded on the authorization slot only — reconcile`);
      return;
    }
    const now = this.deps.now();
    const submittedAt = now.toISOString();
    await this.recordSubmittedGoal(current, txHash, {
      status: "EXECUTING",
      updatedAt: submittedAt,
      lastEvaluationAt: submittedAt,
      nextEvaluationAt: new Date(now.getTime() + AUTONOMY_LIMITS.verificationRetrySeconds * 1000).toISOString(),
      pendingExecution: {
        txHash,
        quoteId: c.quote.quoteId,
        idempotencyKey: c.idempotencyKey,
        submittedAt,
        verifyAttempts: 0,
        expectedBuyAmountRaw: c.quote.expectedBuyAmountRaw,
        minBuyAmountRaw: c.quote.minBuyAmountRaw,
        expectedSender: expectedSenderFor(this.deps.adapter),
      },
      lastAction: `transaction submitted ${txHash} (after the tick budget)`,
      lastResult: {
        at: submittedAt,
        outcome: "WAITING_VERIFICATION",
        code: null,
        message: "Transaction submitted after the tick budget ended — verifying receipt before reporting any result.",
      },
      stats: { ...current.stats, triggered: current.stats.triggered + 1 },
    });
    await this.audit(goal.wallet, "TRANSACTION_SUBMITTED", now, goal.id, goal.policyId, { txHash, idempotencyKey: c.idempotencyKey, late: true });
    await this.recordAction(goal, c.idempotencyKey, null, {
      status: "SUBMITTED",
      outcome: "PENDING_VERIFICATION",
      verified: false,
      message: "Submitted after the tick budget ended — awaiting receipt verification.",
      txHash,
    }, now, c.quote);
  }

  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Release a spend reservation for a VERIFIED reason only. Failures here are
   * logged and swallowed: a missed release keeps the spend counted (safe).
   * Returns the resulting state, or null when the store refused the release
   * (including "not in a releasable state" — e.g. UNATTEMPTED once the
   * attempt marker is set), the call failed, or it did not answer in time.
   */
  private async releaseReservation(
    policyId: string,
    dayKey: string,
    execId: string,
    release: SpendReservationRelease,
    now: Date,
  ): Promise<SpendReservationState | null> {
    void now;
    const outcome = await bounded("spend reservation release", () => this.deps.store.releaseDailySpend(policyId, dayKey, execId, release));
    if (outcome.ok) return outcome.value;
    this.deps.logger.error("Spend reservation release failed — spend stays counted (conservative)", { execId });
    return null;
  }

  /**
   * Release for a clean failure code ONLY when it is an explicit verified
   * pre-broadcast refusal; otherwise leave the reservation exactly as it is
   * (counted) — unknown errors are never released automatically.
   */
  private async releaseForFailure(
    policyId: string,
    dayKey: string,
    execId: string,
    code: AutonomyFailureCode,
    now: Date,
  ): Promise<void> {
    if (isPreBroadcastRefusalCode(code)) {
      await this.releaseReservation(policyId, dayKey, execId, { reason: "PRE_BROADCAST_REFUSAL", code }, now);
    }
  }

  /**
   * Unknown/ambiguous outcome (thrown error, RPC_ERROR, timeout): the
   * reservation is marked AMBIGUOUS — spend STAYS counted, never released.
   */
  private async markReservationAmbiguous(policyId: string, dayKey: string, execId: string, now: Date): Promise<void> {
    void now;
    const outcome = await bounded("spend reservation mark", () => this.deps.store.markSpendAmbiguous(policyId, dayKey, execId));
    if (!outcome.ok) {
      this.deps.logger.error("Spend reservation could not be marked AMBIGUOUS — it stays counted in its prior state", { execId });
    }
  }

  /** Consume the reservation (successful or reverted execution). */
  private async commitReservation(policyId: string, dayKey: string, execId: string, now: Date): Promise<void> {
    void now;
    const outcome = await bounded("spend reservation commit", () => this.deps.store.commitDailySpend(policyId, dayKey, execId));
    if (!outcome.ok) {
      // A lost commit response leaves the reservation ATTEMPTING — it still
      // counts against the day (conservative); recovery marks it AMBIGUOUS.
      this.deps.logger.error("Spend reservation commit failed — spend stays counted (conservative)", { execId });
    }
  }

  /**
   * Moves the goal to EXECUTING with the broadcast hash. Called ONLY with a hash
   * in hand. Deliberately NOT budget-bounded: this is the one write that must not
   * be abandoned, because the transaction exists. A CAS miss while the goal is
   * still open (a field edit moved updatedAt) is retried once against the fresh
   * updatedAt. A goal the user closed mid-flight keeps its status; the caller still
   * writes the action record and audit event, and the hash is logged here.
   */
  private async recordSubmittedGoal(goal: AgentGoal, txHash: string, patch: GoalTransitionPatch): Promise<void> {
    try {
      let written = await this.deps.store.transitionGoal(goal.id, goal.wallet, OPEN_GOAL_STATUSES, goal.updatedAt, patch);
      if (!written) {
        const current = await this.deps.store.getGoal(goal.id);
        if (current && OPEN_GOAL_STATUSES.includes(current.status)) {
          written = await this.deps.store.transitionGoal(goal.id, goal.wallet, OPEN_GOAL_STATUSES, current.updatedAt, patch);
        }
      }
      if (written) return;
    } catch (error) {
      void error;
    }
    console.error(
      `[autonomy] goal ${goal.id}: broadcast returned transaction ${txHash} but the goal could not be moved to EXECUTING — the hash is recorded on the authorization slot and the action record; reconcile this goal`,
    );
  }

  private backoff(failures: number, now: Date): string {
    const seconds = Math.min(
      AUTONOMY_LIMITS.backoffBaseSeconds * 2 ** Math.max(0, failures - 1),
      AUTONOMY_LIMITS.maxBackoffSeconds,
    );
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }

  private async park(
    goal: AgentGoal,
    code: AutonomyFailureCode | null,
    message: string,
    now: Date,
    rule?: string,
    outcome: "POLICY_REJECTED" | "AUTHORIZATION_MISSING" | "FAILED" = rule ? "POLICY_REJECTED" : "AUTHORIZATION_MISSING",
  ): Promise<EvaluationResult> {
    const updatedAt = now.toISOString();
    const nextEval = new Date(now.getTime() + goal.cooldownSeconds * 1000).toISOString();
    await this.deps.store.transitionGoal(goal.id, goal.wallet, ["ACTIVE", "WAITING"], goal.updatedAt, {
      status: "WAITING",
      lastEvaluationAt: updatedAt,
      updatedAt,
      nextEvaluationAt: nextEval,
      lastResult: { at: updatedAt, outcome, code: code, message },
      stats: { ...goal.stats, evaluations: goal.stats.evaluations + 1 },
    });
    return { kind: "PARKED", failureCode: code, message, nextEvaluationAt: nextEval };
  }

  private async parkWithFailure(
    goal: AgentGoal,
    code: AutonomyFailureCode,
    message: string,
    now: Date,
    _ctx: { conditionChecked: boolean },
  ): Promise<EvaluationResult> {
    const updatedAt = now.toISOString();
    // Switch refusals and infrastructure outages are NOT trade failures:
    // they never increment the trade-failure counter and never permanently
    // fail an active goal (the goal keeps observing until recovery).
    const infra = isInfrastructureOutageCode(code);
    const failures = infra ? goal.stats.consecutiveFailures : goal.stats.consecutiveFailures + 1;
    const shouldFail = !infra && failures >= AUTONOMY_LIMITS.maxConsecutiveFailures;
    const nextEval = this.backoff(failures, now);
    await this.deps.store.transitionGoal(goal.id, goal.wallet, ["ACTIVE", "WAITING"], goal.updatedAt, {
      status: shouldFail ? "FAILED" : "WAITING",
      lastEvaluationAt: updatedAt,
      updatedAt,
      nextEvaluationAt: shouldFail ? updatedAt : nextEval,
      lastAction: `evaluation failed: ${code}`,
      lastResult: { at: updatedAt, outcome: "FAILED", code, message },
      stats: { ...goal.stats, evaluations: goal.stats.evaluations + 1, consecutiveFailures: failures },
    });
    if (shouldFail) {
      await this.audit(goal.wallet, "GOAL_FAILED", now, goal.id, goal.policyId, { reason: "MAX_CONSECUTIVE_FAILURES", code });
    }
    return { kind: "PARKED", failureCode: code, message, nextEvaluationAt: shouldFail ? updatedAt : nextEval };
  }

  /**
   * Control-plane refusal AFTER an idempotency/daily-spend claim but BEFORE
   * broadcast. Not a trade failure: consecutiveFailures are unchanged, the
   * goal is not permanently FAILED, and the daily-spend reservation is left
   * in place (over-count is safe; reversing after a possible attempt is not).
   * To prevent unsafe retries from executing the same operation twice, the
   * execution key is not released.
   */
  private async controlPlaneRefuseAfterClaim(
    goal: AgentGoal,
    idempotencyKey: string,
    code: AutonomyFailureCode,
    message: string,
    now: Date,
    stage: string,
  ): Promise<EvaluationResult> {
    console.error(`[autonomy] goal ${goal.id} refused at stage ${stage} (${code}) — nothing was broadcast`);
    const updatedAt = now.toISOString();
    void idempotencyKey;
    await bounded("goal control-plane write", () =>
      this.deps.store.transitionGoal(goal.id, goal.wallet, OPEN_GOAL_STATUSES, goal.updatedAt, {
        status: "WAITING",
        lastEvaluationAt: updatedAt,
        updatedAt,
        nextEvaluationAt: new Date(now.getTime() + goal.cooldownSeconds * 1000).toISOString(),
        lastAction: `control-plane refusal: ${code}`,
        lastResult: { at: updatedAt, outcome: "AUTHORIZATION_MISSING", code, message },
        stats: { ...goal.stats, evaluations: goal.stats.evaluations + 1 },
      }),
    );
    await this.audit(goal.wallet, "AUTHORIZATION_CHECKED", now, goal.id, goal.policyId, {
      authorized: false,
      reason: "EMERGENCY_SWITCH",
      controlPlane: true,
    });
    return { kind: "PARKED", failureCode: code, message, nextEvaluationAt: new Date(now.getTime() + goal.cooldownSeconds * 1000).toISOString() };
  }

  /**
   * Failure AFTER the idempotency claim — the slot is consumed. The goal is still
   * ACTIVE/WAITING here (no EXECUTING write precedes a broadcast), so the failure
   * is CASed from those statuses. The stage is logged FIRST, before any Redis call,
   * so it is recorded even when the store is hung or failing. The goal write is
   * bounded to BROADCAST_STORE_BUDGET_MS.
   */
  private async failAfterClaim(
    goal: AgentGoal,
    idempotencyKey: string,
    code: AutonomyFailureCode,
    message: string,
    now: Date,
    stage: string | null = null,
  ): Promise<EvaluationResult> {
    console.error(`[autonomy] goal ${goal.id} execution failed at stage ${stage ?? "unknown"} (${code}): ${message}`);
    const updatedAt = now.toISOString();
    // The spend reservation is handled by the caller (released only for
    // verified pre-broadcast refusals, committed/AMBIGUOUS otherwise) —
    // over-counting is safe, under-counting is not. Switch/infrastructure
    // codes never increment the trade-failure counter and never fail the goal.
    const infra = isInfrastructureOutageCode(code);
    const failures = infra ? goal.stats.consecutiveFailures : goal.stats.consecutiveFailures + 1;
    const shouldFail = !infra && (failures >= AUTONOMY_LIMITS.maxConsecutiveFailures || isTerminalFailureCode(code));
    const write = await bounded("goal failure write", () =>
      this.deps.store.transitionGoal(goal.id, goal.wallet, OPEN_GOAL_STATUSES, goal.updatedAt, {
        status: shouldFail ? "FAILED" : "WAITING",
        lastEvaluationAt: updatedAt,
        updatedAt,
        nextEvaluationAt: shouldFail ? updatedAt : this.backoff(failures, now),
        lastAction: `execution failed: ${code}`,
        lastResult: { at: updatedAt, outcome: "FAILED", code, message },
        stats: { ...goal.stats, consecutiveFailures: failures },
      }),
    );
    if (!write.ok || write.value === null) {
      console.error(`[autonomy] goal ${goal.id}: failure ${code} was not recorded on the goal — it stays open until the next tick decides`);
    }
    await this.audit(goal.wallet, "EXECUTION_FAILED", now, goal.id, goal.policyId, { code });
    await this.recordAction(goal, idempotencyKey, null, {
      status: "FAILED",
      outcome: "FAILED",
      verified: false,
      failureCode: code,
      message,
    }, now);
    if (shouldFail) {
      await this.audit(goal.wallet, "GOAL_FAILED", now, goal.id, goal.policyId, { reason: "EXECUTION_FAILURE", code });
    }
    return { kind: "EXECUTION_FAILED", failureCode: code, message };
  }

  private async transitionOrLog(
    goal: AgentGoal,
    expectedUpdatedAt: string,
    patch: Parameters<AutonomyStore["transitionGoal"]>[4],
    now: Date,
    auditType: Parameters<AutonomyAuditSink["record"]>[0]["type"],
  ): Promise<void> {
    const updated = await this.deps.store.transitionGoal(goal.id, goal.wallet, ["ACTIVE", "WAITING", "PAUSED", "EXECUTING"], expectedUpdatedAt, patch);
    if (updated) {
      await this.audit(goal.wallet, auditType, now, goal.id, goal.policyId);
    }
  }

  private async audit(
    wallet: string,
    type: Parameters<AutonomyAuditSink["record"]>[0]["type"],
    now: Date,
    goalId: string,
    policyId: string | null | undefined,
    data?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    try {
      await this.deps.audit.record(auditEvent(wallet, type, now, { goalId, policyId: policyId ?? undefined, data }));
    } catch (error) {
      // Audit persistence must never break the evaluation; the event bus
      // emission already happened inside the sink for in-memory consumers.
      this.deps.logger.error("Autonomy audit persistence failed", { goalId, type });
      void error;
    }
  }

  private async recordAction(
    goal: AgentGoal,
    idempotencyKey: string,
    pending: NonNullable<AgentGoal["pendingExecution"]> | null,
    patch: {
      status: GoalActionRecord["status"];
      outcome: GoalActionRecord["outcome"];
      verified: boolean;
      failureCode?: AutonomyFailureCode | null;
      message?: string;
      txHash?: string;
      actualBuyAmountRaw?: string;
      feeAmountRaw?: string;
      blockNumber?: string;
    },
    now: Date,
    quote?: { quoteId: string; expectedBuyAmountRaw: string; minBuyAmountRaw: string },
  ): Promise<void> {
    const record: GoalActionRecord = {
      idempotencyKey,
      goalId: goal.id,
      wallet: goal.wallet,
      policyId: goal.policyId,
      quoteId: pending?.quoteId ?? quote?.quoteId ?? "",
      sellAmountRaw: goal.trade.sellAmountRaw,
      slippageBps: goal.trade.slippageBps,
      status: patch.status,
      outcome: patch.outcome,
      txHash: patch.txHash ?? pending?.txHash,
      blockNumber: patch.blockNumber,
      expectedBuyAmountRaw: pending?.expectedBuyAmountRaw ?? quote?.expectedBuyAmountRaw,
      minBuyAmountRaw: pending?.minBuyAmountRaw ?? quote?.minBuyAmountRaw,
      actualBuyAmountRaw: patch.actualBuyAmountRaw,
      feeAmountRaw: patch.feeAmountRaw,
      verified: patch.verified,
      failureCode: patch.failureCode ?? null,
      message: patch.message,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    try {
      await this.deps.store.saveActionRecord(record, AUTONOMY_LIMITS.maxAuditEventsPerGoal);
    } catch (error) {
      this.deps.logger.error("Autonomy action record persistence failed", { goalId: goal.id });
      void error;
    }
  }
}

/** Terminal failures: retrying cannot help (the user must act). */
function isTerminalFailureCode(code: AutonomyFailureCode): boolean {
  return code === "POLICY_REJECTED" || code === "USER_REJECTED" || code === "TOKEN_NOT_ALLOWED" || code === "INVALID_CONDITION";
}

// --- flag indirection (keeps the runtime import-light for tests) -----------
import { isAutonomousAgentEnabled } from "./config";
import { logEmergencySwitchDecision, readAutonomousEmergencySwitch } from "./emergency-switch";
function isAutonomousRuntimeEnabled(): boolean {
  return isAutonomousAgentEnabled();
}

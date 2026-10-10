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

import { AUTONOMY_LIMITS } from "./config";
import { AUTONOMY_CHAIN_ID, DELEGATED_EXECUTION_CHAIN_ID, isDelegatedAdapterId, type DelegatedSwapRequest } from "./types";
import { evaluateCondition, evaluatePolicyAgainstAction } from "./policy-engine";
import { utcDayKey } from "./idempotency";
import { isTerminalGoalStatus, type AgentGoal, type AutonomyFailureCode, type GoalActionRecord, type GoalStatus, type SpendReservationRelease, type SpendReservationState } from "./types";
import { isInfrastructureOutageCode, isPreBroadcastRefusalCode } from "./types";
import type { AutonomyAuditSink } from "./audit";
import { auditEvent } from "./audit";
import type { McpGateway } from "./mcp-gateway";
import type { AutonomyStore } from "./store";
import { verifyExecution } from "./verify";
import type { AutonomousExecutionAdapter } from "./types";
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
  | { kind: "GOAL_CLOSED"; status: GoalStatus; message: string };

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
        return await this.evaluateUnderLease(goal, leaseToken, now);
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
  // Standard evaluation pass
  // -------------------------------------------------------------------------

  private async evaluateUnderLease(goal: AgentGoal, _leaseToken: string, now: Date): Promise<EvaluationResult> {
    const updatedAt = now.toISOString();

    // Expiry is deterministic housekeeping — works even while paused-ish states.
    if (new Date(goal.expiresAt).getTime() <= now.getTime()) {
      await this.transitionOrLog(goal, goal.updatedAt, { status: "EXPIRED", updatedAt, lastResult: { at: updatedAt, outcome: "EXPIRED", code: null, message: "Goal expired." } }, now, "GOAL_EXPIRED");
      return { kind: "GOAL_CLOSED", status: "EXPIRED", message: "Goal expired." };
    }

    const policy = await this.deps.store.getPolicy(goal.policyId);
    const emergency = isAutonomousExecutionEmergencyDisabled();

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

    // ACT — idempotency claim, spend reservation, CAS to EXECUTING, prepare,
    // attempt marker, execute.
    const slotKey = `${goal.id}:${goal.nextEvaluationAt}`;
    const idempotencyKey = `exec-${slotKey}`;
    const claimed = await this.deps.store.claimExecution(idempotencyKey, AUTONOMY_LIMITS.executionGuardSeconds);
    if (!claimed) {
      await this.audit(goal.wallet, "DUPLICATE_PREVENTED", now, goal.id, goal.policyId, { idempotencyKey });
      // Advance past the consumed slot so the goal cannot livelock on it.
      await this.park(goal, "DUPLICATE_PREVENTED", "This evaluation slot already produced an execution — duplicate prevented.", now, undefined, "FAILED");
      return { kind: "DUPLICATE_PREVENTED", message: "This evaluation slot already produced an execution — duplicate prevented." };
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
      await this.audit(goal.wallet, "DUPLICATE_PREVENTED", now, goal.id, goal.policyId, { idempotencyKey, reservationState: reservation.state });
      await this.park(goal, "DUPLICATE_PREVENTED", "This execution id already produced an attempt — duplicate prevented.", now, undefined, "FAILED");
      return { kind: "DUPLICATE_PREVENTED", message: "This execution id already produced an attempt — duplicate prevented." };
    }

    // Quote freshness at broadcast time (spec §13 — never execute stale data).
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (!Number.isFinite(quote.quoteExpiresAt) || quote.quoteExpiresAt <= nowSeconds) {
      await this.releaseReservation(decision.policy.id, dayKey, idempotencyKey, { reason: "PRE_BROADCAST_REFUSAL", code: "QUOTE_STALE" }, now);
      return this.parkWithFailure(goal, "QUOTE_STALE", "Quote expired before execution could start — nothing was broadcast.", now, { conditionChecked: true });
    }

    const executing = await this.deps.store.transitionGoal(goal.id, goal.wallet, ["ACTIVE", "WAITING"], goal.updatedAt, {
      status: "EXECUTING",
      lastEvaluationAt: updatedAt,
      updatedAt,
      lastAction: "executing authorized swap",
      lastResult: { at: updatedAt, outcome: "TRADE_EXECUTED", code: null, message: "Authorization verified — submitting transaction." },
    });
    if (!executing) {
      // State changed under us; drop the claims — the winner owns the slot.
      // The reservation is provably unattempted (the adapter was never
      // invoked and the attempt marker was never set) — the one verified
      // UNATTEMPTED release path.
      await this.releaseReservation(decision.policy.id, dayKey, idempotencyKey, { reason: "UNATTEMPTED" }, now);
      await this.deps.store.releaseExecution(idempotencyKey);
      return { kind: "SKIPPED", reason: "STATE_CHANGED", message: "Goal state changed during evaluation." };
    }

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
        // Prepare is strictly pre-broadcast (unsigned calldata only). A
        // whitelisted verified-pre-broadcast refusal frees the reservation;
        // anything unknown keeps it counted (conservative — never released
        // automatically). Either way the adapter was never invoked.
        await this.releaseForFailure(decision.policy.id, dayKey, idempotencyKey, prepared.failure.code, now);
        return this.failAfterClaim(executing, idempotencyKey, prepared.failure.code, prepared.failure.message, now);
      }
      preparedSteps = prepared.data.steps;
      preparedTransactionRequest = prepared.data.transactionRequest;
      await this.audit(goal.wallet, "TRADE_PREPARED", now, goal.id, goal.policyId, { quoteId: quote.quoteId, steps: prepared.data.steps.length });
    }

    // ATTEMPT MARKER — persisted BEFORE the execution adapter is invoked.
    // Once this is visible a crash may have broadcast: the reservation is
    // never released automatically after this point.
    let attemptState: SpendReservationState | null = null;
    try {
      attemptState = await this.deps.store.markSpendAttempt(decision.policy.id, dayKey, idempotencyKey);
    } catch (error) {
      void error;
    }
    if (attemptState !== "ATTEMPTING") {
      // Missing/Redis failure/lost response (or a state that is no longer
      // safely attemptable): DO NOT invoke the adapter (fail closed). The
      // reservation is left as-is (it counts against the day — conservative)
      // and is recoverable later via the verified UNATTEMPTED path once a
      // human confirms nothing was sent.
      this.deps.logger.error("Spend attempt marker could not be persisted — adapter NOT invoked", { goalId: goal.id });
      return this.failAfterClaim(
        executing,
        idempotencyKey,
        "RPC_ERROR",
        "Spend attempt marker could not be persisted — the execution adapter was NOT invoked. The reservation stays reserved (recoverable as UNATTEMPTED).",
        now,
      );
    }

    // EXECUTE — only the adapter can reach a signature (spec §6). It is
    // called with UNSIGNED data and after every deterministic check passed.
    let result;
    try {
      result = await this.deps.adapter.executeSwap({
        goalId: goal.id,
        policyId: decision.policy.id,
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
      });
    } catch (error) {
      // UNKNOWN error: the broadcast MAY have happened. The reservation is
      // marked AMBIGUOUS (spend stays counted) and never released.
      this.deps.logger.error("Autonomous execution adapter threw", { goalId: goal.id });
      await this.markReservationAmbiguous(decision.policy.id, dayKey, idempotencyKey, now);
      return this.failAfterClaim(executing, idempotencyKey, "EXECUTION_UNAVAILABLE", "Execution adapter failed unexpectedly — the broadcast outcome is UNKNOWN. The spend reservation is kept (AMBIGUOUS), never released.", now);
    }

    if (!result.ok) {
      // Clean adapter refusal: only an explicit verified pre-broadcast code
      // frees the reservation. RPC_ERROR / TIMEOUT / anything unknown keeps
      // it AMBIGUOUS — the transaction may have been broadcast.
      if (isPreBroadcastRefusalCode(result.code)) {
        await this.releaseForFailure(decision.policy.id, dayKey, idempotencyKey, result.code, now);
      } else {
        await this.markReservationAmbiguous(decision.policy.id, dayKey, idempotencyKey, now);
      }
      return this.failAfterClaim(executing, idempotencyKey, result.code, result.message, now);
    }

    // TRANSACTION SUBMITTED — the spend is consumed (conservative: it stays
    // counted even if the receipt later shows a revert). Enter the
    // verification state.
    await this.commitReservation(decision.policy.id, dayKey, idempotencyKey, now);
    const submittedAt = now.toISOString();
    await this.deps.store.transitionGoal(goal.id, goal.wallet, ["EXECUTING"], executing.updatedAt, {
      status: "EXECUTING",
      updatedAt: submittedAt,
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
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Release a spend reservation for a VERIFIED reason only. Failures here are
   * logged and swallowed: a missed release keeps the spend counted (safe).
   */
  private async releaseReservation(
    policyId: string,
    dayKey: string,
    execId: string,
    release: SpendReservationRelease,
    now: Date,
  ): Promise<void> {
    try {
      await this.deps.store.releaseDailySpend(policyId, dayKey, execId, release);
    } catch (error) {
      void error;
      this.deps.logger.error("Spend reservation release failed — spend stays counted (conservative)", { execId });
    }
    void now;
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
    try {
      await this.deps.store.markSpendAmbiguous(policyId, dayKey, execId);
    } catch (error) {
      void error;
      this.deps.logger.error("Spend reservation could not be marked AMBIGUOUS — it stays counted in its prior state", { execId });
    }
    void now;
  }

  /** Consume the reservation (successful or reverted execution). */
  private async commitReservation(policyId: string, dayKey: string, execId: string, now: Date): Promise<void> {
    try {
      await this.deps.store.commitDailySpend(policyId, dayKey, execId);
    } catch (error) {
      void error;
      // A lost commit response leaves the reservation ATTEMPTING — it still
      // counts against the day (conservative); recovery marks it AMBIGUOUS.
      this.deps.logger.error("Spend reservation commit failed — spend stays counted (conservative)", { execId });
    }
    void now;
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

  /** Failure AFTER the idempotency claim — the slot is consumed. */
  private async failAfterClaim(
    executingGoal: AgentGoal,
    idempotencyKey: string,
    code: AutonomyFailureCode,
    message: string,
    now: Date,
  ): Promise<EvaluationResult> {
    const updatedAt = now.toISOString();
    // The spend reservation is handled by the caller (released only for
    // verified pre-broadcast refusals, committed/AMBIGUOUS otherwise) —
    // over-counting is safe, under-counting is not. Switch/infrastructure
    // codes never increment the trade-failure counter and never fail the goal.
    const infra = isInfrastructureOutageCode(code);
    const failures = infra ? executingGoal.stats.consecutiveFailures : executingGoal.stats.consecutiveFailures + 1;
    const shouldFail = !infra && (failures >= AUTONOMY_LIMITS.maxConsecutiveFailures || isTerminalFailureCode(code));
    const cas = await this.deps.store.transitionGoal(executingGoal.id, executingGoal.wallet, ["EXECUTING"], executingGoal.updatedAt, {
      status: shouldFail ? "FAILED" : "WAITING",
      lastEvaluationAt: updatedAt,
      updatedAt,
      nextEvaluationAt: shouldFail ? updatedAt : this.backoff(failures, now),
      lastAction: `execution failed: ${code}`,
      lastResult: { at: updatedAt, outcome: "FAILED", code, message },
      stats: { ...executingGoal.stats, consecutiveFailures: failures },
    });
    void cas;
    await this.audit(executingGoal.wallet, "EXECUTION_FAILED", now, executingGoal.id, executingGoal.policyId, { code });
    await this.recordAction(executingGoal, idempotencyKey, null, {
      status: "FAILED",
      outcome: "FAILED",
      verified: false,
      failureCode: code,
      message,
    }, now);
    if (shouldFail) {
      await this.audit(executingGoal.wallet, "GOAL_FAILED", now, executingGoal.id, executingGoal.policyId, { reason: "EXECUTION_FAILURE", code });
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
import { isAutonomousAgentEnabled, isAutonomousExecutionEmergencyDisabled } from "./config";
function isAutonomousRuntimeEnabled(): boolean {
  return isAutonomousAgentEnabled();
}

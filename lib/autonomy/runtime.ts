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

import type { Logger, PerformanceMonitor } from "@/lib/architecture/core/types";
import { DELEGATED_EXECUTOR_ADDRESS, delegatedActionId } from "@/lib/executor/delegated-executor";

import { AUTONOMY_LIMITS } from "./config";
import { DELEGATED_ADAPTER_ID, DELEGATED_EXECUTION_CHAIN_ID, type DelegatedSwapRequest } from "./types";
import { evaluateCondition, evaluatePolicyAgainstAction } from "./policy-engine";
import { utcDayKey } from "./idempotency";
import { isTerminalGoalStatus, type AgentGoal, type AutonomyFailureCode, type GoalActionRecord, type GoalStatus } from "./types";
import type { AutonomyAuditSink } from "./audit";
import { auditEvent } from "./audit";
import type { McpGateway } from "./mcp-gateway";
import type { AutonomyStore } from "./store";
import { verifyExecution } from "./verify";
import type { AutonomousExecutionAdapter } from "./types";
import { delegatedBroadcasterAddress } from "@/lib/delegated/delegated-broadcaster";

/** The chain the runtime operates on for THIS adapter (delegated = 84532). */
function executionChainId(adapter: AutonomousExecutionAdapter): number {
  return adapter.id === DELEGATED_ADAPTER_ID ? DELEGATED_EXECUTION_CHAIN_ID : 8453;
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
      ...(executionChainId(this.deps.adapter) === DELEGATED_EXECUTION_CHAIN_ID
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
      ...(quoteChainId === DELEGATED_EXECUTION_CHAIN_ID ? { executor: DELEGATED_EXECUTOR_ADDRESS } : {}),
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
    // prepare/authorization work; the daily ledger is claimed atomically
    // right before broadcast so the caps cannot be raced between goals.
    const dayKey = utcDayKey(now);
    const spend = policy
      ? {
          dailySpendRaw: await this.deps.store.getDailySpendRaw(policy.id, dayKey),
          actionsToday: await this.deps.store.getDailyActions(policy.id, dayKey),
        }
      : { dailySpendRaw: "0", actionsToday: 0 };
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

    // ACT — idempotency claim, ledger claim, CAS to EXECUTING, prepare, execute.
    const slotKey = `${goal.id}:${goal.nextEvaluationAt}`;
    const idempotencyKey = `exec-${slotKey}`;
    const claimed = await this.deps.store.claimExecution(idempotencyKey, AUTONOMY_LIMITS.executionGuardSeconds);
    if (!claimed) {
      await this.audit(goal.wallet, "DUPLICATE_PREVENTED", now, goal.id, goal.policyId, { idempotencyKey });
      // Advance past the consumed slot so the goal cannot livelock on it.
      await this.park(goal, "DUPLICATE_PREVENTED", "This evaluation slot already produced an execution — duplicate prevented.", now, undefined, "FAILED");
      return { kind: "DUPLICATE_PREVENTED", message: "This evaluation slot already produced an execution — duplicate prevented." };
    }

    // Atomic daily cap claim (append-capped ledger). Null => cap reached.
    const ledger = await this.deps.store.tryRecordDailyAction(decision.policy.id, dayKey, goal.trade.sellAmountRaw, decision.policy.maxActionsPerDay);
    if (ledger === null) {
      return this.park(goal, "POLICY_REJECTED", "Daily action limit for this policy has been reached.", now, "OVER_ACTION_RATE");
    }

    // Quote freshness at broadcast time (spec §13 — never execute stale data).
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (!Number.isFinite(quote.quoteExpiresAt) || quote.quoteExpiresAt <= nowSeconds) {
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
    const delegatedPath = this.deps.adapter.id === DELEGATED_ADAPTER_ID;
    let preparedSteps: DelegatedSwapRequest["steps"] = [];
    let preparedTransactionRequest: DelegatedSwapRequest["transactionRequest"] = null;
    if (delegatedPath) {
      await this.audit(goal.wallet, "TRADE_PREPARED", now, goal.id, goal.policyId, { quoteId: quote.quoteId, steps: 0, delegated: true });
    } else {
      const prepared = await this.deps.gateway.prepare({ quoteId: quote.quoteId, authorization: "APPROVAL" });
      if (!prepared.ok) {
        return this.failAfterClaim(executing, idempotencyKey, prepared.failure.code, prepared.failure.message, now);
      }
      preparedSteps = prepared.data.steps;
      preparedTransactionRequest = prepared.data.transactionRequest;
      await this.audit(goal.wallet, "TRADE_PREPARED", now, goal.id, goal.policyId, { quoteId: quote.quoteId, steps: prepared.data.steps.length });
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
      this.deps.logger.error("Autonomous execution adapter threw", { goalId: goal.id });
      return this.failAfterClaim(executing, idempotencyKey, "EXECUTION_UNAVAILABLE", "Execution adapter failed unexpectedly. Nothing was confirmed.", now);
    }

    if (!result.ok) {
      return this.failAfterClaim(executing, idempotencyKey, result.code, result.message, now);
    }

    // TRANSACTION SUBMITTED — enter the verification state.
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
        expectedSender: this.deps.adapter.id === DELEGATED_ADAPTER_ID ? delegatedBroadcasterAddress() ?? undefined : undefined,
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
    const failures = goal.stats.consecutiveFailures + 1;
    const shouldFail = failures >= AUTONOMY_LIMITS.maxConsecutiveFailures;
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
    // The daily-ledger entry stays (conservative: a failed attempt consumes
    // one action slot — over-counting is safe, under-counting is not).
    const failures = executingGoal.stats.consecutiveFailures + 1;
    const shouldFail = failures >= AUTONOMY_LIMITS.maxConsecutiveFailures || isTerminalFailureCode(code);
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

// lib/autonomy/config.ts
//
// Feature flag + hard limits for the Autonomous Agent Runtime (spec §23).
//
// ROLLOUT CONTRACT:
//   MPGR_AUTONOMOUS_AGENT_ENABLED  (default: false)
//     Master switch. When unset/false the runtime is inert: no API route
//     creates goals, no tick evaluates anything, the UI renders nothing,
//     and every existing assisted behaviour is byte-for-byte unchanged.
//
//   MPGR_AUTONOMOUS_EMERGENCY_DISABLE (default: false)
//     Additional env restrictor. True => no autonomous transaction may
//     execute. It CANNOT enable execution when the KV switch
//     (mpgrhub:autonomy:switch) is missing, disabled, or unreadable.
//     Manual (assisted, user-signed) trading is unaffected.
//
//   AUTONOMOUS_PRODUCTION_ENABLED (default: false)
//     EXPLICIT PRODUCTION GATE for autonomous execution on BASE MAINNET
//     (8453). Fail-closed: missing, empty, "false", or any value other than
//     the exact string "true" (case-insensitive) keeps every mainnet
//     delegated execution refused with reason PRODUCTION_GATE_DISABLED —
//     goals stay watch-only. Enforced at BOTH the mainnet
//     DelegatedExecutionAdapter (checkOperational, so checkAuthorization /
//     checkStatic / executeSwap all refuse) AND the MCP delegateSwap
//     broadcast chokepoint, so no code path can reach a mainnet delegated
//     broadcast without it. Base Sepolia (84532) testnet execution is NOT
//     gated by this flag (it has no production value to protect). This flag
//     can never sign anything and never enables execution on its own: every
//     other gate (feature flag, emergency stop, pinned+verified executor,
//     broadcaster, policy, user-signed slot, posture) still applies.
//
// None of these flags can sign anything. Even with all of them on, execution
// additionally requires a live authorization verdict from the installed
// AutonomousExecutionAdapter — see execution-adapter.ts.

function envFlag(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

/** Env var name of the explicit mainnet production gate (exported for tests/pins). */
export const AUTONOMOUS_PRODUCTION_GATE_ENV = "AUTONOMOUS_PRODUCTION_ENABLED";

export function isAutonomousAgentEnabled(): boolean {
  return envFlag("MPGR_AUTONOMOUS_AGENT_ENABLED");
}

/**
 * Explicit PRODUCTION gate for autonomous execution on Base mainnet (8453).
 * Default false; fail-closed on missing/false/malformed. Only the exact
 * string "true" (case-insensitive, trimmed) opens the gate — the operator
 * must set it deliberately in the deployment env (Vercel), and it is never
 * inferred from any other flag.
 */
export function isAutonomousProductionEnabled(): boolean {
  return envFlag(AUTONOMOUS_PRODUCTION_GATE_ENV);
}

/**
 * Env-only emergency restrictor. Prefer `readAutonomousEmergencySwitch()`
 * at the execution boundary — that path is fail-closed on KV.
 */
export function isAutonomousExecutionEmergencyDisabled(): boolean {
  return envFlag("MPGR_AUTONOMOUS_EMERGENCY_DISABLE");
}

/**
 * TICK TIME BUDGET (Base mainnet broadcast fix).
 *
 * `app/api/agent/autonomy/tick/route.ts` runs with `maxDuration` =
 * AUTONOMY_TICK_MAX_DURATION_SECONDS. Once a goal writes EXECUTING, the platform
 * can kill the invocation at any moment. A kill there leaves the goal EXECUTING
 * with no transaction recorded, which the stuck-execution reap then closes —
 * that is the crash path, not a normal result of a slow RPC.
 *
 * So all post-EXECUTING work (attempt marker, prepare, KV switch re-read,
 * adapter/broadcast) must END by tickStart + AUTONOMY_EXECUTION_BUDGET_SECONDS,
 * which leaves AUTONOMY_TICK_PERSIST_RESERVE_SECONDS for writing the real
 * outcome. The budget is anchored at the TICK start (not the EXECUTING write),
 * so no goal in any scheduler batch can outlive the tick.
 *
 * tick route maxDuration is a literal in the route file (Next.js segment config);
 * lib/autonomy/__tests__/post-executing-budget.test.ts pins the two together.
 */
export const AUTONOMY_TICK_MAX_DURATION_SECONDS = 120;
/** Seconds kept free at the end of a tick to persist a failure after the budget ends. */
export const AUTONOMY_TICK_PERSIST_RESERVE_SECONDS = 10;
/** Hard end of post-EXECUTING work, in seconds after the tick started. */
export const AUTONOMY_EXECUTION_BUDGET_SECONDS = AUTONOMY_TICK_MAX_DURATION_SECONDS - AUTONOMY_TICK_PERSIST_RESERVE_SECONDS;
/**
 * A goal whose budget has less than this left is refused BEFORE it writes
 * EXECUTING or claims anything — nothing is broadcast and no state changes.
 */
export const AUTONOMY_MIN_EXECUTION_BUDGET_SECONDS = 30;

export const AUTONOMY_LIMITS = {
  /** Max active (non-terminal) goals per wallet. */
  maxGoalsPerWallet: 10,
  /** Floor for goal.cooldownSeconds — no uncontrolled high-frequency polling. */
  minCooldownSeconds: 60,
  /** Ceiling for cooldown (also caps backoff growth). */
  maxCooldownSeconds: 86_400,
  /** Max goals evaluated per tick invocation (whole runtime). */
  maxEvaluationsPerTick: 20,
  /** Max due goals per wallet per tick. */
  maxEvaluationsPerWalletPerTick: 5,
  /** Concurrent goal evaluations within one tick. */
  maxConcurrentEvaluations: 3,
  /** Bounded retries: after this many consecutive failures a goal is FAILED. */
  maxConsecutiveFailures: 5,
  /** Exponential backoff cap. */
  maxBackoffSeconds: 3_600,
  /** Backoff base. */
  backoffBaseSeconds: 60,
  /** Lease held while a goal is being evaluated (prevents double-tick). */
  evaluationLeaseSeconds: 120,
  /** Lease held while an execution idempotency key is claimed. */
  executionGuardSeconds: 86_400,
  /** Max policies per wallet (incl. revoked — bounded storage). */
  maxPoliciesPerWallet: 20,
  /** A policy grant can never outlive this many days. */
  maxPolicyTtlDays: 30,
  /** Bounded verification attempts per broadcast before UNCERTAIN/FAILED. */
  maxVerificationAttempts: 10,
  /** Min seconds between verification passes on a pending execution. */
  verificationRetrySeconds: 30,
  /** After this long without a receipt the execution is UNCERTAIN, not retried. */
  verificationTimeoutSeconds: 900,
  /** Bounded audit trail per goal. */
  maxAuditEventsPerGoal: 100,
  /** Absolute ceiling on a single autonomous trade, sell-token human units. */
  maxPerTradeHuman: "10000",
  /** Absolute ceiling on daily spend, sell-token human units. */
  maxDailyHuman: "100000",
} as const;

/** Slippage bounds mirror the existing MCP tool constraints. */
export const AUTONOMY_SLIPPAGE_BOUNDS = { minBps: 1, maxBps: 500, defaultBps: 100 } as const;

/** Runtime limits surfaced to the UI (public, non-secret). */
export function publicAutonomyLimits() {
  return {
    maxGoalsPerWallet: AUTONOMY_LIMITS.maxGoalsPerWallet,
    minCooldownSeconds: AUTONOMY_LIMITS.minCooldownSeconds,
    maxPolicyTtlDays: AUTONOMY_LIMITS.maxPolicyTtlDays,
    maxPerTradeHuman: AUTONOMY_LIMITS.maxPerTradeHuman,
    maxDailyHuman: AUTONOMY_LIMITS.maxDailyHuman,
    maxSlippageBps: AUTONOMY_SLIPPAGE_BOUNDS.maxBps,
  };
}

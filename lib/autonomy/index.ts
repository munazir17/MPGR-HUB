import "server-only";

// lib/autonomy/index.ts
//
// Composition root for the Autonomous Agent Runtime — the ONE place the
// additive module is wired together, following the same pattern as
// lib/architecture/ai/agent-ai-service-instance.ts and
// lib/architecture/tools/agent-tool-runtime-instance.ts:
//
//   store   -> RedisAutonomyStore (production; fail-closed without Redis)
//   gateway -> McpTradeGateway.production() (the EXISTING MCP trade service)
//   adapter -> getAutonomousExecutionAdapter() (refuses everything today)
//   audit   -> BusAuditSink over the EXISTING agentEventBus + perf monitor
//   runtime -> AutonomyRuntime
//   scheduler -> AutonomyScheduler
//
// Nothing in here runs on a schedule by itself and nothing here can sign.

import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { agentPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import { logger as coreLogger } from "@/lib/architecture/core/logger";

import { BusAuditSink } from "./audit";
import { isAutonomousAgentEnabled, isAutonomousProductionEnabled } from "./config";
import { DelegatedExecutionAdapter } from "./delegated-execution-adapter";
import { RedisDelegatedAuthorizationStore } from "./delegated-redis-store";
import type { DelegatedAuthorizationStore } from "./delegated-authorization";
import {
  installAutonomousExecutionAdapter,
  getAutonomousExecutionAdapter,
  peekInstalledAutonomousExecutionAdapter,
} from "./execution-adapter";
import { isDelegatedAdapterId, MAINNET_DELEGATED_ADAPTER_ID, type AutonomousExecutionAdapter } from "./types";
import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@/lib/executor/executor-config";
import { delegatedExecutorAddressFor, walletSigningSupported } from "@/lib/executor/delegated-executor";
import { McpTradeGateway, type McpGateway } from "./mcp-gateway";
import { AutonomyRuntime } from "./runtime";
import { AutonomyScheduler } from "./scheduler";
import { RedisAutonomyStore } from "./redis-store";
import type { AutonomyStore } from "./store";
import { publicAutonomyLimits } from "./config";

export interface AutonomySystem {
  store: AutonomyStore;
  /** Delegated authorization slots (chain-bound control plane). */
  slots: DelegatedAuthorizationStore;
  gateway: McpGateway;
  runtime: AutonomyRuntime;
  scheduler: AutonomyScheduler;
  /**
   * The installed delegated adapter, when one is configured. OPTIONAL so that
   * hand-built systems (tests) remain valid without it; absent means "no
   * delegated adapter", which is exactly the pre-remediation default.
   */
  delegatedAdapter?: DelegatedExecutionAdapter | null;
}

/**
 * Build the delegated adapter SELECTED BY ENV, on the chain that env implies.
 *
 * With MPGR_AUTONOMOUS_EXECUTION_ADAPTER unset (or set to "none") NOTHING is
 * installed, every path resolves to the default no-delegation adapter, and
 * assisted/manual trading is byte-for-byte unchanged. Setting it to
 * "delegated-permit2-mainnet" installs the Base mainnet adapter; to
 * "delegated-permit2-sepolia" the Base Sepolia one. The registry refuses a
 * configured id that does not match the installed one, so the chain can never
 * be selected and wired inconsistently.
 */
function buildDelegatedAdapter(deps: {
  store: AutonomyStore;
  slots: DelegatedAuthorizationStore;
  gateway: McpGateway;
}): DelegatedExecutionAdapter | null {
  const configured = process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER?.trim();
  if (!configured || !isDelegatedAdapterId(configured)) return null;
  const chainId = configured === MAINNET_DELEGATED_ADAPTER_ID ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
  return new DelegatedExecutionAdapter({
    slots: deps.slots,
    gateway: deps.gateway,
    getPolicy: (policyId) => deps.store.getPolicy(policyId),
    chainId,
  });
}

/**
 * Idempotent, synchronous installation of the configured delegated adapter.
 *
 * This is the ONE installation path, shared by build() (the server bootstrap
 * behind the tick/goals/policy routes) and autonomyStatus() (the public,
 * read-only config endpoint). It exists because of the "null configuration"
 * incident: the config route renders status WITHOUT ever building the
 * system, and on Vercel every route is its own serverless function with its
 * own module state — so an adapter installed by the tick function is
 * invisible to the config function, getAutonomousExecutionAdapter() threw
 * "configured but not installed", and the status try/catch silently rendered
 * chainId/executor as null and executionAvailable as false.
 *
 * Properties:
 *  - no-op when no delegated adapter is configured (env unset / "none" /
 *    unknown id — the registry getter keeps resolving/throwing fail-closed
 *    on its own);
 *  - no-op when the configured adapter is ALREADY installed: no duplicate
 *    registration, no singleton drift. A MISMATCHED installation is left
 *    untouched so the getter keeps throwing fail-closed;
 *  - otherwise constructs the adapter for the configured chain (with the
 *    given deps, or freshly built lazy production deps) and installs it.
 *
 * Side-effect-free by construction: it only reads env and constructs lazy
 * clients (Redis stores, MCP gateway, broadcaster accounts). It never signs,
 * never builds a transaction, never broadcasts and never awaits — so the
 * read-only status endpoint cannot be turned into an execution path. It also
 * does NOT warm the on-chain posture (that stays with build()/the tick route
 * via bootstrapAutonomyPosture), so rendering status performs no RPC at all
 * while the production gate is off — the mandated configuration.
 */
export function ensureAutonomousExecutionAdapterInstalled(deps?: {
  store: AutonomyStore;
  slots: DelegatedAuthorizationStore;
  gateway: McpGateway;
}): DelegatedExecutionAdapter | null {
  const configured = process.env.MPGR_AUTONOMOUS_EXECUTION_ADAPTER?.trim();
  if (!configured || !isDelegatedAdapterId(configured)) return null;
  const installed = peekInstalledAutonomousExecutionAdapter();
  if (installed) {
    // The registry only ever accepts delegated adapter ids (installAutonomous
    // ExecutionAdapter throws otherwise), so an installed adapter whose id
    // matches the configured delegated id IS a DelegatedExecutionAdapter; the
    // registry's storage type just does not encode that invariant.
    return installed.id === configured ? (installed as DelegatedExecutionAdapter) : null;
  }
  const adapter = buildDelegatedAdapter(
    deps ?? {
      store: new RedisAutonomyStore(),
      slots: new RedisDelegatedAuthorizationStore(),
      gateway: McpTradeGateway.productionWithDelegation(),
    },
  );
  if (!adapter) return null;
  installAutonomousExecutionAdapter(adapter);
  return adapter;
}

function build(): AutonomySystem {
  const store = new RedisAutonomyStore();
  const slots = new RedisDelegatedAuthorizationStore();
  const gateway = McpTradeGateway.productionWithDelegation();
  // Server bootstrap: the delegated adapter is installed ONLY here and via the
  // idempotent ensureAutonomousExecutionAdapterInstalled() shared with the
  // read-only status path — server-side, and only for the chain the operator
  // selected. Repeated initialization never duplicates the registration.
  const delegatedAdapter = ensureAutonomousExecutionAdapterInstalled({ store, slots, gateway });
  const audit = new BusAuditSink(store, agentEventBus, agentPerformanceMonitor);
  const runtime = new AutonomyRuntime({
    store,
    gateway,
    adapter: getAutonomousExecutionAdapter(),
    audit,
    logger: coreLogger,
    performanceMonitor: agentPerformanceMonitor,
    now: () => new Date(),
  });
  const scheduler = new AutonomyScheduler(store, runtime, coreLogger, agentPerformanceMonitor);
  const system: AutonomySystem = { store, slots, gateway, runtime, scheduler, delegatedAdapter };
  // MC-3 FIX: warm the on-chain posture EAGERLY at composition time instead of
  // waiting for an execution attempt that can never come. Fire-and-forget and
  // single-flight; a failure leaves the adapter refused, never optimistic.
  void bootstrapAutonomyPosture(system).catch(() => {
    /* posture stays cold => checkStatic() keeps reporting ONCHAIN_CHECK_PENDING */
  });
  return system;
}

/**
 * Prove (or re-prove) the installed adapter's on-chain posture.
 *
 * Awaitable so the scheduler tick can warm a cold server BEFORE evaluating,
 * which is what turns the first tick on a fresh instance from "parked with
 * ONCHAIN_CHECK_PENDING" into a real evaluation. Safe to call on every tick:
 * single-flight and TTL-cached. Never throws and never enables execution on its
 * own — it only records a verified or refused verdict.
 */
export async function bootstrapAutonomyPosture(target?: AutonomySystem): Promise<void> {
  const system = target ?? getAutonomySystem();
  const adapter = system.delegatedAdapter;
  if (!adapter) return;
  if (!isAutonomousAgentEnabled()) return;
  await adapter.bootstrapPosture();
}

let system: AutonomySystem | null = null;

export function getAutonomySystem(): AutonomySystem {
  if (!system) system = build();
  return system;
}

/**
 * One-per-instance guard so a persistent adapter misconfiguration is logged
 * loudly once instead of being silently swallowed on every status poll.
 */
let statusAdapterFailureLogged = false;

/** Public status for the config endpoint / UI gating (no secrets). */
export function autonomyStatus() {
  // Resolve the INSTALLED adapter exactly once. The ensure call is what makes
  // a cold serverless instance report the adapter the operator configured
  // instead of a swallowed null (the "null configuration" incident): the
  // config route never builds the system, and module state is per serverless
  // function. The ensure is synchronous and performs no I/O beyond
  // constructing lazy clients — no signing, no approval, no transaction
  // construction, no broadcast, and no RPC while the production gate is off.
  let adapter: AutonomousExecutionAdapter | null = null;
  let adapterResolutionFailed = false;
  try {
    ensureAutonomousExecutionAdapterInstalled();
    adapter = getAutonomousExecutionAdapter();
  } catch {
    // Fail-closed: a configured-but-unresolvable adapter (unknown id, or a
    // mismatch with whatever IS installed) renders as an explicit unavailable
    // state. Do not log the raw error: it can contain arbitrary environment
    // input, and status diagnostics must never echo environment values.
    adapterResolutionFailed = true;
  }
  if (adapterResolutionFailed && !statusAdapterFailureLogged) {
    statusAdapterFailureLogged = true;
    coreLogger.warn("autonomy status: delegated execution adapter is not resolvable; reporting unavailable (fail-closed)", {
      code: "ADAPTER_NOT_RESOLVABLE",
    });
  }
  const chainId = adapter && typeof adapter.chainId === "number" ? adapter.chainId : null;
  return {
    enabled: isAutonomousAgentEnabled(),
    emergencyDisabled: process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE?.trim().toLowerCase() === "true",
    /**
     * The explicit Base-mainnet production gate (AUTONOMOUS_PRODUCTION_ENABLED).
     * A public, non-secret boolean: false means every mainnet delegated
     * execution refuses with PRODUCTION_GATE_DISABLED regardless of any other
     * configuration, and the UI can say so honestly.
     */
    productionGate: isAutonomousProductionEnabled(),
    /**
     * Truthful availability: true only when the INSTALLED adapter's full
     * static posture (feature flag, emergency stop, production gate,
     * pinned executor, broadcaster, proven on-chain posture) passes. Never
     * inferred from the mere existence of an environment variable.
     */
    executionAvailable: (() => {
      if (!adapter) return false;
      try {
        return adapter.canDelegate;
      } catch {
        return false;
      }
    })(),
    /**
     * Per-chain delegated capability, so the UI can tell the user HONESTLY
     * whether a goal they authorize on a given chain could ever execute, and
     * which contract their signature will name as spender. These are deployed
     * public contract addresses, not secrets; the operator key never appears.
     *
     * `chainId`/`executor` are read from the INSTALLED adapter (after the
     * idempotent ensure above), so they reflect the actual runtime wiring —
     * never a hardcoded expectation. `executor: null` means no delegated
     * executor is pinned for that chain, so the UI must not offer to sign
     * slots for it (the server refuses too).
     */
    delegated: {
      chainId,
      executor: chainId !== null ? delegatedExecutorAddressFor(chainId) : null,
      walletSigningSupported: walletSigningSupported(),
    },
    limits: publicAutonomyLimits(),
  };
}

export { isAutonomousAgentEnabled };

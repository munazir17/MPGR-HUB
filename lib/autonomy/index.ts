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
import { isAutonomousAgentEnabled } from "./config";
import { DelegatedExecutionAdapter } from "./delegated-execution-adapter";
import { RedisDelegatedAuthorizationStore } from "./delegated-redis-store";
import type { DelegatedAuthorizationStore } from "./delegated-authorization";
import { installAutonomousExecutionAdapter, getAutonomousExecutionAdapter } from "./execution-adapter";
import { isDelegatedAdapterId, MAINNET_DELEGATED_ADAPTER_ID } from "./types";
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

function build(): AutonomySystem {
  const store = new RedisAutonomyStore();
  const slots = new RedisDelegatedAuthorizationStore();
  const gateway = McpTradeGateway.productionWithDelegation();
  // Server bootstrap: the delegated adapter is installed ONLY here,
  // server-side, and only for the chain the operator selected.
  const delegatedAdapter = buildDelegatedAdapter({ store, slots, gateway });
  if (delegatedAdapter) installAutonomousExecutionAdapter(delegatedAdapter);
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

/** Public status for the config endpoint / UI gating (no secrets). */
export function autonomyStatus() {
  return {
    enabled: isAutonomousAgentEnabled(),
    emergencyDisabled: process.env.MPGR_AUTONOMOUS_EMERGENCY_DISABLE?.trim().toLowerCase() === "true",
    executionAvailable: (() => {
      try {
        return getAutonomousExecutionAdapter().canDelegate;
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
     * `executor: null` means no delegated executor is pinned for that chain, so
     * the UI must not offer to sign slots for it (the server refuses too).
     */
    delegated: {
      chainId: (() => {
        try {
          const adapter = getAutonomousExecutionAdapter();
          return typeof adapter.chainId === "number" ? adapter.chainId : null;
        } catch {
          return null;
        }
      })(),
      executor: (() => {
        try {
          const adapter = getAutonomousExecutionAdapter();
          return typeof adapter.chainId === "number" ? delegatedExecutorAddressFor(adapter.chainId) : null;
        } catch {
          return null;
        }
      })(),
      walletSigningSupported: walletSigningSupported(),
    },
    limits: publicAutonomyLimits(),
  };
}

export { isAutonomousAgentEnabled };

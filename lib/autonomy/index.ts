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
import { McpTradeGateway, type McpGateway } from "./mcp-gateway";
import { AutonomyRuntime } from "./runtime";
import { AutonomyScheduler } from "./scheduler";
import { RedisAutonomyStore } from "./redis-store";
import type { AutonomyStore } from "./store";
import { publicAutonomyLimits } from "./config";

export interface AutonomySystem {
  store: AutonomyStore;
  /** Delegated authorization slots (Base Sepolia control plane). */
  slots: DelegatedAuthorizationStore;
  gateway: McpGateway;
  runtime: AutonomyRuntime;
  scheduler: AutonomyScheduler;
}

function build(): AutonomySystem {
  const store = new RedisAutonomyStore();
  const slots = new RedisDelegatedAuthorizationStore();
  const gateway = McpTradeGateway.productionWithDelegation();
  // Server bootstrap (Phase 2): the delegated adapter is installed ONLY
  // here, server-side. getAutonomousExecutionAdapter() still refuses
  // unless MPGR_AUTONOMOUS_EXECUTION_ADAPTER=delegated-permit2-sepolia is
  // configured; with the env unset every path resolves to the default
  // "none" adapter and assisted/manual trading is byte-for-byte unchanged.
  installAutonomousExecutionAdapter(
    new DelegatedExecutionAdapter({
      slots,
      gateway,
      getPolicy: (policyId) => store.getPolicy(policyId),
    }),
  );
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
  return { store, slots, gateway, runtime, scheduler };
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
    /** Always false today — no delegation adapter ships (see execution-adapter.ts). */
    executionAvailable: (() => {
      try {
        return getAutonomousExecutionAdapter().canDelegate;
      } catch {
        return false;
      }
    })(),
    limits: publicAutonomyLimits(),
  };
}

export { isAutonomousAgentEnabled };

// lib/architecture/tools/agent-tool-runtime-instance.ts
//
// P0.1 — composition root for AgentToolRuntime, mirroring
// lib/architecture/ai/agent-ai-service-instance.ts: every cross-cutting
// dependency (EventBus, Logger, PerformanceMonitor) is wired up HERE,
// once, from the exact same shared singletons every other AI-stack
// module already uses (agentEventBus, logger, agentPerformanceMonitor) —
// not a second set of instances. Swapping any one of them later means
// editing this file only.
//
// Nothing calls getAgentToolRuntime() yet in P0.1 — no route, hook, or
// AIProvider is wired to it. It exists, fully constructed and ready, for
// P0.2+ to start calling without any changes to this file.

import { AgentToolRuntime } from "./agent-tool-runtime";
import { getAgentToolRegistry } from "./agent-tool-registry-instance";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { logger } from "@/lib/architecture/core/logger";
import { agentPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";

// Side-effect import — registers the five P0.1 placeholder tools into
// getAgentToolRegistry()'s instance. Without this import, the registry
// stays empty at runtime, exactly like lib/agent-commands/commands.ts's
// equivalent registration import in agent-ai-service-instance.ts.
import "./tool-definitions";

export const agentToolRuntime = new AgentToolRuntime(
  getAgentToolRegistry(),
  agentEventBus,
  logger,
  agentPerformanceMonitor
);

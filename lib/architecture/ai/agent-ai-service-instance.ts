import { AgentAIService } from "./agent-ai-service";
import { agentEventBus } from "../core/event-bus";
import { logger } from "../core/logger";
import { agentPerformanceMonitor } from "../core/performance-monitor";
import { agentTaskQueue } from "../core/task-queue";

// Phase 3A.6 — side-effect import only: registers every SlashCommand
// (lib/agent-commands/commands.ts) into the shared agentCommandRegistry.
// This file is already the single composition root for the AI Service
// Layer (see below), so it's the correct, existing place to trigger
// command registration too — no new file, no new wiring pattern. Without
// this import, commands.ts's module-level registration loop never runs
// and agentCommandRegistry stays empty at runtime.
import "@/lib/agent-commands/commands";

// P0.1 — side-effect import only: registers the five placeholder
// AgentTools (lib/architecture/tools/tool-definitions.ts) into the
// shared AgentToolRegistry returned by
// lib/architecture/tools/agent-tool-registry-instance.ts's
// getAgentToolRegistry(). This file is already the single composition
// root the AI Service Layer imports at startup, so it's the correct,
// existing place to trigger tool registration too — same pattern as the
// commands import directly above. Without this import, the registry
// stays empty at runtime and every tool lookup in
// lib/architecture/tools/agent-tool-runtime.ts fails with
// TOOL_NOT_FOUND.
import "@/lib/architecture/tools/tool-definitions";

// Phase 3A.5 — the single composition root for the AI Service Layer
// (objective 9, dependency injection). Every dependency AgentAIService
// needs (EventBus, Logger, PerformanceMonitor, TaskQueue) is wired up
// HERE, once. hooks/useAgentChat.ts imports the finished `agentAIService`
// instance and never constructs one itself or reaches for a concrete
// dependency directly.
//
// Swapping any one piece (a different EventBus implementation, a real
// telemetry Logger, a Hybrid/Persistent memory setup via
// lib/architecture/memory/memory-provider-registry.ts) means editing this
// file only — no changes ripple into hooks/useAgentChat.ts or any UI
// component.
export const agentAIService = new AgentAIService({
  eventBus: agentEventBus,
  logger,
  performanceMonitor: agentPerformanceMonitor,
  taskQueue: agentTaskQueue,
});

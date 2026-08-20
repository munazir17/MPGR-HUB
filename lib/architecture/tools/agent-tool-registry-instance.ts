// lib/architecture/tools/agent-tool-registry-instance.ts
//
// P0.1 — composition root for the AgentToolRegistry dependency,
// mirroring lib/architecture/memory/memory-provider-registry.ts and
// lib/architecture/ai/ai-provider-registry.ts exactly: one module-level
// instance, a getter, and (for parity with those two, and to make
// resetting state between tests easy) a setter.
//
// tool-definitions.ts registers the five P0.1 placeholder tools into
// this exact instance via a side-effect import — see that file and
// lib/architecture/ai/agent-ai-service-instance.ts, which triggers it.

import { AgentToolRegistry } from "./agent-tool-registry";

let activeRegistry: AgentToolRegistry = new AgentToolRegistry();

export function getAgentToolRegistry(): AgentToolRegistry {
  return activeRegistry;
}

/** Mainly for tests — swaps in a fresh, empty registry so one test's registrations can't leak into another's. */
export function setAgentToolRegistry(registry: AgentToolRegistry): void {
  activeRegistry = registry;
}

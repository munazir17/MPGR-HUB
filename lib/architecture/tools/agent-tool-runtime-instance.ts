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

// P2 addendum — registers yield_opportunities / yield_estimator /
// yield_comparison (lib/architecture/tools/p2-tool-definitions.ts) into
// this exact same production registry instance, the same way the P0.2
// import above does. Before this line, p2-tool-definitions.ts was only
// ever imported by its own unit test, so its side-effect registration
// never ran outside that test file and these three tools never actually
// existed in the registry AgentToolRuntime/agentToolRuntime reads from —
// confirmed by inspection (no other production file imported this
// module). This is the only change required to make the P2 tools
// reachable through getAgentToolRegistry()/agentToolRuntime; the tool
// definitions themselves are untouched.
import "./p2-tool-definitions";

// P3 addendum — registers x402_discover_resource / x402_prepare_payment
// (lib/architecture/tools/x402-tool-definitions.ts) into this exact same
// production registry instance, the same way the P2 import above does.
// Both are read/prepare mode only — see that file's header comment for
// why signing/submission is never reachable through this registry.
import "./x402-tool-definitions";

// AgentKit addendum — registers the client-facing read wrappers for the
// server-only Coinbase AgentKit onchain layer. Write/auto-pay AgentKit
// actions are not registered here and are denied by the server allowlist.
import "./agentkit-tool-definitions";

// P4 addendum — registers trade_get_price / trade_prepare_swap /
// tokenized_stock_research. Read/prepare only; signing stays behind
// the Confirm & Swap UI, same as x402.
import "./trade-tool-definitions";

export const agentToolRuntime = new AgentToolRuntime(
  getAgentToolRegistry(),
  agentEventBus,
  logger,
  agentPerformanceMonitor
);

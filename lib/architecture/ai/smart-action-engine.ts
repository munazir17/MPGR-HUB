import { agentEventBus } from "../core/event-bus";
import { logger } from "../core/logger";
import { getNavigateTarget } from "@/lib/agent-actions";
import type { AgentIntent } from "@/lib/agent-intelligence";
import { agentAIService } from "./agent-ai-service-instance";
import { recordAction } from "@/lib/agent-commands/action-history";

// Phase 3D — Smart Actions & AI Automation. The Action Engine.
//
// Single entry point for turning an assistant reply's `intent` into a
// real in-app side effect, parallel to (not a replacement for)
// lib/agent-commands/action-executor.ts, which does the equivalent job
// for slash commands. hooks/useAgentChat.ts calls this once, right after
// every AI-generated reply (sendMessage / retryLastMessage /
// regenerateLastMessage) — never from inside lib/agent-engine.ts or any
// AIProvider, so this stays entirely a UI-layer concern with no coupling
// back into the provider chain.
//
// SAFETY — this function can only ever navigate somewhere in a small,
// fixed, compile-time-checked whitelist:
//   intent -> lib/agent-actions.ts's getNavigateTarget(intent) -> route
// An intent that isn't one of the six open_* intents (including any
// intent an AI provider hallucinated that somehow slipped past
// lib/architecture/ai/ai-provider-guardrails.ts's AGENT_INTENTS check)
// simply yields `undefined` here, and executeSmartAction is a no-op. The
// AI never supplies a route string directly, only an intent name that's
// already been validated against a closed union — "malformed AI output"
// and "invalid navigation" are structurally impossible to reach this
// far, not just guarded against with an if-check.
//
// NEVER CRASHES — the actual navigation call is wrapped in try/catch;
// any failure is logged and emitted as a failed smart_action_executed
// event, never thrown back to the caller. hooks/useAgentChat.ts does not
// need its own try/catch around this call.
//
// PERFORMANCE — the one non-essential side effect (recording this
// action into lib/agent-commands/action-history.ts's shared history) is
// enqueued onto the existing background Task Queue
// (lib/architecture/core/task-queue.ts, via agentAIService's already-
// wired enqueueBackgroundTask — the exact same path
// hooks/useAgentChat.ts already uses for memory.cleanup) rather than
// awaited, so it can never delay the navigate() call itself or block the
// UI thread.
//
// DIAGNOSTICS — every attempt (success or failure) is both logged via
// the shared Logger and emitted as a `smart_action_executed` event on
// the shared EventBus (lib/architecture/core/types.ts), carrying intent,
// selected action, target, execution duration, and any error — exactly
// the fields Phase 3D's diagnostics requirement asks for, using the
// existing cross-cutting infrastructure rather than a new logging path.

export interface SmartActionOutcome {
  executed: boolean;
  target?: string;
}

export function executeSmartAction(
  address: string,
  intent: AgentIntent | undefined,
  navigate: (href: string) => void
): SmartActionOutcome {
  const target = getNavigateTarget(intent);
  if (!target || !intent) {
    return { executed: false };
  }

  const start = Date.now();

  try {
    navigate(target);
    const durationMs = Date.now() - start;

    logger.debug("Smart action executed", { address, intent, target, durationMs });
    agentEventBus.emit("smart_action_executed", {
      address,
      intent,
      action: "navigate",
      target,
      durationMs,
      success: true,
    });

    // Background-only, never awaited — see PERFORMANCE note above.
    agentAIService.enqueueBackgroundTask("actionHistory.recordSmartAction", () =>
      recordAction(
        address,
        intent,
        { kind: "navigate", href: target, text: `Opened ${target}` },
        { success: true, durationMs, category: "navigation" }
      )
    );

    return { executed: true, target };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);

    logger.error("Smart action failed", { address, intent, target, error: message });
    agentEventBus.emit("smart_action_executed", {
      address,
      intent,
      action: "navigate",
      target,
      durationMs,
      success: false,
      error: message,
    });

    agentAIService.enqueueBackgroundTask("actionHistory.recordSmartAction", () =>
      recordAction(
        address,
        intent,
        { kind: "navigate", href: target, text: `Failed to open ${target}` },
        { success: false, durationMs, category: "navigation" }
      )
    );

    return { executed: false };
  }
}

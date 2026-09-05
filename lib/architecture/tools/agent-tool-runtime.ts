// lib/architecture/tools/agent-tool-runtime.ts
//
// P0.1 — the Agent Tool Runtime. This is the ONLY path anything (a
// future LLM tool-calling loop, a slash command, a UI action) should
// use to run a registered tool. It is the security boundary the spec
// describes:
//
//   caller requests tool id
//         v
//   Registry lookup       -- tool must already be registered; nothing is
//         v                  ever invented from a string the LLM produced
//   Mode gate              -- "execute" tools are unconditionally refused
//         v                  here, in code, in P0.1 — see below
//   Wallet requirement
//         v
//   Schema validation
//         v
//   Permission check
//         v
//   tool.execute() (instrumented, never throws past this boundary)
//
// HARD SAFETY RULE (spec section 8): EXECUTE mode is never directly
// controlled by the LLM. P0.1 does not implement transaction execution,
// simulation, or the confirmation flow those tools will eventually need
// — so rather than build a half-finished gate that *could* be
// misconfigured into allowing an execute tool through, this runtime
// refuses every "execute"-mode tool unconditionally, on every call, with
// no override, no permission flag, and no confirmationMode value that
// changes the outcome. A future phase that actually implements
// validation + simulation + confirmation + wallet signature replaces
// this refusal with a real gate — it does not loosen this file, it
// replaces this one `if` block with the real flow.
//
// Style: a class taking its cross-cutting dependencies via constructor
// injection (EventBus, Logger, PerformanceMonitor, AgentToolRegistry),
// exactly like every AIProvider decorator in lib/architecture/ai/
// (GuardrailAIProvider, DiagnosticsAIProvider, CircuitBreakerAIProvider)
// and AgentAIService itself.

import type {
  EventBus,
  Logger,
  PerformanceMonitor,
} from "@/lib/architecture/core/types";

import type { AgentToolContext } from "./agent-tool-context";
import { DEFAULT_CONFIRMATION_MODE } from "./agent-tool-context";

import type { AgentToolResult } from "./agent-tool-result";
import {
  toolError,
  toolSuccess,
} from "./agent-tool-result";

import { validateAgainstSchema } from "./agent-tool-schema-validator";
import { hydrateTradeSwapArguments } from "@/lib/trade/trade-request";

import type { AgentToolRegistry } from "./agent-tool-registry";
import type { AgentToolMode } from "./agent-tool";

export class AgentToolRuntime {
  constructor(
    private readonly registry: AgentToolRegistry,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    private readonly performanceMonitor: PerformanceMonitor,
  ) {}

  async executeTool(
    toolId: string,
    input: unknown,
    context: Partial<AgentToolContext>,
  ): Promise<AgentToolResult> {
    const start = performance.now();

    const requestId =
      context.requestId ?? generateRequestId();

    const fullContext: AgentToolContext = {
      confirmationMode: DEFAULT_CONFIRMATION_MODE,
      ...context,
      requestId,
    };

    const tool = this.registry.get(toolId);

    if (!tool) {
      return this.finish(
        toolError(
          toolId,
          {
            code: "TOOL_NOT_FOUND",
            message: `No tool is registered with id "${toolId}".`,
          },
          {
            requestId,
          },
        ),
        start,
        requestId,
      );
    }

    // --- Hard safety rule: EXECUTE is never runnable through this
    // runtime in P0.1, unconditionally. See header comment. -----------
    if (tool.mode === "execute") {
      this.logger.warn(
        "Refused an execute-mode tool call — execution is not implemented in P0.1",
        {
          toolId,
          requestId,
        },
      );

      return this.finish(
        toolError(
          toolId,
          {
            code: "EXECUTION_NOT_ALLOWED",
            message:
              "Execute-mode tools cannot run yet — this requires validation, simulation, confirmation, and a wallet signature, none of which P0.1 implements.",
          },
          {
            requestId,
          },
        ),
        start,
        requestId,
      );
    }

    if (
      tool.requiresWallet &&
      !fullContext.walletAddress
    ) {
      return this.finish(
        toolError(
          toolId,
          {
            code: "WALLET_NOT_CONNECTED",
            message: `"${tool.name}" requires a connected wallet.`,
          },
          {
            requestId,
          },
        ),
        start,
        requestId,
      );
    }

    let toolInput = input;
    if (
      (toolId === "trade_get_price" || toolId === "trade_prepare_swap") &&
      toolInput !== null &&
      typeof toolInput === "object" &&
      !Array.isArray(toolInput)
    ) {
      toolInput = hydrateTradeSwapArguments(
        toolInput as Record<string, unknown>,
        fullContext.walletAddress,
      );
    }

    const validation =
      validateAgainstSchema(
        toolInput,
        tool.inputSchema,
      );

    if (!validation.valid) {
      return this.finish(
        toolError(
          toolId,
          {
            code: "INVALID_INPUT",
            message:
              `Invalid input for "${tool.name}": ${validation.errors.join("; ")}`,
          },
          {
            requestId,
          },
        ),
        start,
        requestId,
      );
    }

    const permissionDenied =
      this.checkPermission(
        tool.mode,
        fullContext,
      );

    if (permissionDenied) {
      return this.finish(
        toolError(
          toolId,
          {
            code: "PERMISSION_DENIED",
            message: permissionDenied,
          },
          {
            requestId,
          },
        ),
        start,
        requestId,
      );
    }

    this.eventBus.emit(
      "agent_tool_execution_started",
      {
        toolId,
        requestId,
        mode: tool.mode,
      },
    );

    try {
      const result =
        await this.performanceMonitor.time(
          `tools.runtime.${toolId}`,
          () =>
            tool.execute(
              toolInput,
              fullContext,
            ),
        );

      const finished =
        this.finish(
          result,
          start,
          requestId,
        );

      this.eventBus.emit(
        "agent_tool_execution_completed",
        {
          toolId,
          requestId,
          success: finished.success,
          durationMs:
            finished.metadata.durationMs ?? 0,
        },
      );

      return finished;
    } catch (err) {
      // Never let a thrown exception (or its stack trace) escape this
      // boundary — see agent-tool-result.ts's header comment.
      const message =
        err instanceof Error
          ? err.message
          : String(err);

      this.logger.error(
        "Tool execution threw",
        {
          toolId,
          requestId,
          message,
        },
      );

      const failed =
        this.finish(
          toolError(
            toolId,
            {
              code: "PROVIDER_ERROR",
              message:
                "The tool failed unexpectedly.",
              retryable: true,
            },
            {
              requestId,
            },
          ),
          start,
          requestId,
        );

      this.eventBus.emit(
        "agent_tool_execution_failed",
        {
          toolId,
          requestId,
          message,
        },
      );

      return failed;
    }
  }

  private checkPermission(
    mode: AgentToolMode,
    context: AgentToolContext,
  ): string | null {
    const permissions =
      context.permissions;

    if (!permissions) {
      return null;
    }

    if (
      mode === "read" &&
      !permissions.canRead
    ) {
      return "Read-tool access is disabled for this session.";
    }

    if (
      mode === "prepare" &&
      !permissions.canPrepare
    ) {
      return "Prepare-tool access is disabled for this session.";
    }

    return null;
  }

  private finish(
    result: AgentToolResult,
    start: number,
    requestId: string,
  ): AgentToolResult {
    return {
      ...result,
      metadata: {
        ...result.metadata,
        requestId:
          result.metadata.requestId ??
          requestId,
        durationMs:
          performance.now() - start,
      },
    };
  }
}

function generateRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    "randomUUID" in crypto
  ) {
    return crypto.randomUUID();
  }

  return `req_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

// Re-exported so a caller only needs to import from this file for the
// common "just run a tool" path; toolSuccess stays available from
// agent-tool-result.ts directly for tool implementations themselves.
export { toolSuccess };

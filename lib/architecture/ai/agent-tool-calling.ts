// lib/architecture/ai/agent-tool-calling.ts
//
// P2/P3 production wiring — the shared, provider-agnostic tool-calling
// loop used by network AIProviders.
//
// Tool execution remains client-side through the production
// AgentToolRuntime singleton. Read tools may be executed directly by this
// loop. Prepare tools may only prepare a structured proposal; they can never
// sign, submit, or execute a payment. Execute tools are never reachable.
//
// P3 x402 integration:
//   - x402_prepare_payment is advertised as a "prepare" tool.
//   - Its structured proposal is captured directly from the tool result.
//   - The model is never trusted to invent payment amount, asset, or payTo.
//   - The proposal is returned separately as x402Proposal.
//   - Signing remains outside this loop and requires explicit human
//     confirmation through the existing x402 confirmation/execution flow.

import {
  getAgentActions,
  getAgentHighlights,
  getFollowUpPrompts,
} from "@/lib/agent-actions";
import { AGENT_INTENTS, type AgentIntent } from "@/lib/agent-intelligence";
import type {
  AIProviderRequest,
  AIProviderResponse,
} from "./ai-provider";
import { getAgentToolRegistry } from "@/lib/architecture/tools/agent-tool-registry-instance";
import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import { toolError } from "@/lib/architecture/tools/agent-tool-result";
import type { AgentToolResult } from "@/lib/architecture/tools/agent-tool-result";
import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";

export const MAX_TOOL_CALL_ROUNDS = 3;

function isValidIntent(value: unknown): value is AgentIntent {
  return (
    typeof value === "string" &&
    (AGENT_INTENTS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Model directive parsing
// ---------------------------------------------------------------------------

export interface ToolCallDirective {
  kind: "tool_call";
  toolId: string;
  arguments: Record<string, unknown>;
}

export interface FinalAnswerDirective {
  kind: "final";
  intent: AgentIntent;
  reply: string;
}

export type ModelDirective = ToolCallDirective | FinalAnswerDirective;

export function parseModelDirective(
  content: string,
  previousIntent: AgentIntent | null,
): ModelDirective {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("AI provider response was not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI provider response was not a JSON object.");
  }

  const record = parsed as Record<string, unknown>;

  const rawToolCall = record.toolCall;

  if (
    rawToolCall &&
    typeof rawToolCall === "object" &&
    !Array.isArray(rawToolCall)
  ) {
    const toolCallRecord = rawToolCall as Record<string, unknown>;

    if (
      typeof toolCallRecord.toolId === "string" &&
      toolCallRecord.toolId.trim().length > 0
    ) {
      const args =
        toolCallRecord.arguments &&
        typeof toolCallRecord.arguments === "object" &&
        !Array.isArray(toolCallRecord.arguments)
          ? (toolCallRecord.arguments as Record<string, unknown>)
          : {};

      return {
        kind: "tool_call",
        toolId: toolCallRecord.toolId,
        arguments: args,
      };
    }
  }

  const reply = typeof record.reply === "string" ? record.reply : "";

  if (!reply.trim()) {
    throw new Error(
      "AI provider response was missing a non-empty reply.",
    );
  }

  const intent = isValidIntent(record.intent)
    ? record.intent
    : previousIntent ?? "general_help";

  return {
    kind: "final",
    intent,
    reply,
  };
}

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

/**
 * Existing P2 read-only catalog.
 *
 * Kept unchanged so existing callers/tests retain the original
 * read-only behavior.
 */
export function getReadOnlyToolCatalog(): readonly AnyAgentTool[] {
  return getAgentToolRegistry()
    .list()
    .filter((tool) => tool.mode === "read");
}

/**
 * P3 catalog.
 *
 * Includes read tools and prepare tools.
 *
 * Prepare is intentionally different from execute:
 *   read    -> may inspect data
 *   prepare -> may construct a proposal
 *   execute -> never exposed to this model loop
 */
export function getReadAndPrepareToolCatalog(): readonly AnyAgentTool[] {
  return getAgentToolRegistry()
    .list()
    .filter(
      (tool) => tool.mode === "read" || tool.mode === "prepare",
    );
}

export function buildToolCatalogPromptBlock(
  tools: readonly AnyAgentTool[],
): string {
  if (tools.length === 0) {
    return "";
  }

  const lines = tools.map(
    (tool) =>
      `- "${tool.id}": ${tool.description} Arguments JSON schema: ${JSON.stringify(
        tool.inputSchema,
      )}`,
  );

  return [
    "You have tools for looking up live on-chain/app facts you do not already know and for preparing an x402 payment proposal when the user's request genuinely requires paid resource access.",
    "Read tools may retrieve information.",
    "Prepare tools may construct a proposal only. They never sign, pay, submit, or execute anything.",
    "Execute tools are not available to you.",
    "Never invent tool result data.",
    "Available tools:",
    ...lines,
    'To call a tool, respond with ONLY this JSON and nothing else: {"toolCall":{"toolId":"<id>","arguments":{...matching that tool\'s schema...}}}',
    'Once you have enough information, respond with ONLY this JSON: {"intent":"<intent>","reply":"<answer>"}',
    "Call at most one tool per turn.",
    "Never invent a toolId.",
    "Never invent payment amount, asset, recipient, or any other payment field. If x402_prepare_payment succeeds, the app itself will display the structured proposal.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

/**
 * Existing P2 read-only execution path.
 *
 * Kept intentionally read-only.
 */
export async function runRegisteredReadTool(
  toolId: string,
  args: Record<string, unknown>,
  request: AIProviderRequest,
): Promise<AgentToolResult> {
  const tool = getAgentToolRegistry().get(toolId);

  if (!tool || tool.mode !== "read") {
    return toolError(toolId, {
      code: "TOOL_NOT_FOUND",
      message: `No read-only tool is registered with id "${toolId}".`,
    });
  }

  try {
    return await agentToolRuntime.executeTool(toolId, args, {
      appContext: request.agentContext,
      memoryContext: request.memoryContext,
      walletAddress: request.address,
      confirmationMode: "always_confirm",
      permissions: {
        canRead: true,
        canPrepare: false,
        canExecute: false,
      },
    });
  } catch {
    return toolError(toolId, {
      code: "PROVIDER_ERROR",
      message: "The tool failed unexpectedly.",
      retryable: true,
    });
  }
}

/**
 * P3 execution path.
 *
 * Allows only registered read/prepare tools.
 *
 * Execute tools are rejected before reaching the runtime.
 */
export async function runRegisteredTool(
  toolId: string,
  args: Record<string, unknown>,
  request: AIProviderRequest,
): Promise<AgentToolResult> {
  const tool = getAgentToolRegistry().get(toolId);

  if (
    !tool ||
    (tool.mode !== "read" && tool.mode !== "prepare")
  ) {
    return toolError(toolId, {
      code: "TOOL_NOT_FOUND",
      message: `No read or prepare tool is registered with id "${toolId}".`,
    });
  }

  try {
    return await agentToolRuntime.executeTool(toolId, args, {
      appContext: request.agentContext,
      memoryContext: request.memoryContext,
      walletAddress: request.address,
      confirmationMode: "always_confirm",
      permissions: {
        canRead: true,
        canPrepare: true,
        canExecute: false,
      },
    });
  } catch {
    return toolError(toolId, {
      code: "PROVIDER_ERROR",
      message: "The tool failed unexpectedly.",
      retryable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Tool-calling loop
// ---------------------------------------------------------------------------

export type SendCompletion = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

/**
 * Runs one provider turn with bounded client-side tool calling.
 *
 * P3 x402 behavior:
 *   1. Model requests x402_prepare_payment.
 *   2. Runtime executes the prepare tool.
 *   3. Structured X402PaymentProposal is extracted directly from tool data.
 *   4. Only a short non-sensitive confirmation message is sent back to the
 *      model.
 *   5. Final AIProviderResponse carries x402Proposal separately.
 *
 * The model never constructs the proposal.
 */
export async function runToolCallingLoop(
  request: AIProviderRequest,
  baseSystemPrompt: string,
  sendCompletion: SendCompletion,
): Promise<AIProviderResponse> {
  const catalogBlock = buildToolCatalogPromptBlock(
    getReadAndPrepareToolCatalog(),
  );

  const systemPrompt = catalogBlock
    ? `${baseSystemPrompt}\n\n${catalogBlock}`
    : baseSystemPrompt;

  let transcript = "";

  let capturedX402Proposal:
    | X402PaymentProposal
    | undefined;

  for (
    let round = 1;
    round <= MAX_TOOL_CALL_ROUNDS;
    round++
  ) {
    const isFinalRound =
      round === MAX_TOOL_CALL_ROUNDS;

    const roundSystemPrompt = isFinalRound
      ? `${systemPrompt}\n\nThis is your final turn for this request. You MUST respond with the final answer JSON now. Do not request another tool.`
      : systemPrompt;

    const userPrompt = transcript
      ? `${request.prompt}\n\n${transcript}`
      : request.prompt;

    const content = await sendCompletion(
      roundSystemPrompt,
      userPrompt,
    );

    const directive = parseModelDirective(
      content,
      request.previousIntent,
    );

    if (directive.kind === "final") {
      return {
        intent: directive.intent,
        reply: directive.reply,
        actions: getAgentActions(
          directive.intent,
          request.agentContext,
        ),
        highlights: getAgentHighlights(
          directive.intent,
          request.agentContext,
        ),
        followUps: getFollowUpPrompts(
          directive.intent,
        ),
        ...(capturedX402Proposal
          ? {
              x402Proposal: capturedX402Proposal,
            }
          : {}),
      };
    }

    if (isFinalRound) {
      throw new Error(
        "AI provider requested a tool call on its final allowed turn — refusing to loop further.",
      );
    }

    const toolResult = await runRegisteredTool(
      directive.toolId,
      directive.arguments,
      request,
    );

    const isX402Prepare =
      directive.toolId === "x402_prepare_payment";

    // ---------------------------------------------------------------
    // P3: capture proposal ONLY from structured tool output.
    // ---------------------------------------------------------------

    if (isX402Prepare && toolResult.success) {
      const data = toolResult.data as
        | {
            proposal?: X402PaymentProposal;
          }
        | undefined;

      if (data?.proposal) {
        capturedX402Proposal = data.proposal;
      }
    }

    // ---------------------------------------------------------------
    // Feed a deliberately restricted x402 result back to the model.
    // The payment fields themselves are NOT reintroduced into model
    // text, preventing the model from paraphrasing/inventing them.
    // ---------------------------------------------------------------

    if (isX402Prepare) {
      transcript += [
        "",
        `[Tool result: ${directive.toolId}]`,
        toolResult.success
          ? safeStringify({
              success: true,
              note: "A payment proposal was prepared and will be shown directly in the app UI for user review and explicit confirmation.",
            })
          : safeStringify({
              success: false,
              error: toolResult.error ?? null,
            }),
        'Respond ONLY with the final JSON {"intent":"...","reply":"..."}. Keep the reply short. Do NOT restate the payment amount, asset, recipient address, or other payment fields; the app UI displays those directly from the structured proposal.',
      ].join("\n");
    } else {
      transcript += [
        "",
        `[Tool result: ${directive.toolId}]`,
        safeStringify({
          success: toolResult.success,
          data: toolResult.data ?? null,
          error: toolResult.error ?? null,
          source: toolResult.metadata.source ?? null,
        }),
        'Use this tool result, if relevant, to answer the user\'s original question. Respond ONLY with the final JSON {"intent":"...","reply":"..."}.',
      ].join("\n");
    }
  }

  throw new Error(
    "Tool-calling loop ended without a final answer.",
  );
}

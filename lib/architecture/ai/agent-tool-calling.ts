// lib/architecture/ai/agent-tool-calling.ts
//
// P2 production wiring — the ONE shared, provider-agnostic tool-calling
// loop used by every network AIProvider (OpenAIAIProvider today,
// GeminiAIProvider today, any future network provider). This is the
// piece that was completely missing before this change: P0.2/P2 tools
// existed and were unit-tested directly against AgentToolRuntime, but no
// production code path ever asked a real model to select and invoke one.
//
// Design constraint this file exists to satisfy: both
// app/api/agent/complete/route.ts and app/api/agent/complete/gemini/route.ts
// are deliberately thin, single-turn "systemPrompt + userPrompt in,
// {content: string} out" relays — that's what "the provider abstraction
// intentionally uses JSON-only completion" (see the task's own framing)
// means in this codebase, and neither route (nor the two
// *-ai-provider.ts client classes) has any access to AgentToolRuntime's
// dependencies to begin with: agentToolRuntime executes tools that call
// wagmi/actions against the connected chain config and, for
// portfolio_analyzer, read browser localStorage — both of which only
// exist in the browser, not in a Vercel serverless function. So tool
// EXECUTION has to happen client-side, where agentToolRuntime already
// lives, not inside either route. Rather than rewrite both routes and
// both provider classes to speak a vendor-specific function-calling
// protocol (OpenAI's `tools`/`tool_calls` shape and Gemini's
// `functionDeclarations`/`functionCall` shape are not the same wire
// format), this module defines one small vendor-neutral JSON protocol
// carried inside the existing systemPrompt/userPrompt/content strings
// both routes already pass through untouched:
//
//   Model turn -> JSON object, exactly one of:
//     { "toolCall": { "toolId": string, "arguments": object } }
//     { "intent": string, "reply": string }
//
// A tool call is executed HERE (client-side, via the real
// agentToolRuntime singleton — see agent-tool-runtime-instance.ts), the
// sanitized AgentToolResult is folded back into the next userPrompt as
// plain text, and the model is asked again for a final answer. Neither
// route's request/response shape changes at all — `sendCompletion`
// below is exactly each provider's existing fetch-and-unwrap call.
//
// Safety properties (see AgentToolRuntime's own header comment for the
// underlying enforcement — this file adds no new trust, it only calls
// into that existing boundary):
//   - Every tool call goes through agentToolRuntime.executeTool() — the
//     model's JSON never runs anything directly.
//   - Only tools registered with mode "read" are advertised to the model
//     or accepted for execution here (see runRegisteredReadTool below);
//     "prepare"/"execute" tools are unreachable from this loop even if
//     the model hallucinates their id, because the permissions object
//     this file passes into AgentToolContext explicitly sets
//     canPrepare:false, and AgentToolRuntime refuses "execute" mode
//     unconditionally regardless of any permissions object at all.
//   - Tool-call recursion is hard-bounded by MAX_TOOL_CALL_ROUNDS — the
//     model gets a fixed number of model turns total, and the final
//     turn is explicitly told (and, if it disobeys, enforced in code)
//     that another tool call is not accepted.
//   - Unknown tool ids and non-"read" tool ids never reach
//     agentToolRuntime.executeTool() — runRegisteredReadTool checks the
//     registry first and returns a TOOL_NOT_FOUND-shaped AgentToolResult
//     instead, exactly like AgentToolRuntime's own unknown-tool path.
//   - Every failure inside this loop (malformed JSON, an exceeded round
//     count, a tool that couldn't be run) throws — exactly like both
//     providers' pre-existing parseModelContent — so the existing
//     FallbackAIProvider/CircuitBreakerAIProvider chain in
//     ai-provider-registry.ts catches it and falls back to
//     DeterministicAIProvider precisely as it already does today for
//     any other provider failure. Nothing about that resilience chain
//     changes.

import { getAgentActions, getAgentHighlights, getFollowUpPrompts } from "@/lib/agent-actions";
import { AGENT_INTENTS, type AgentIntent } from "@/lib/agent-intelligence";
import type { AIProviderRequest, AIProviderResponse } from "./ai-provider";
import { getAgentToolRegistry } from "@/lib/architecture/tools/agent-tool-registry-instance";
import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import { toolError } from "@/lib/architecture/tools/agent-tool-result";
import type { AgentToolResult } from "@/lib/architecture/tools/agent-tool-result";
import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";

// Hard bound on how many model turns one generateReply() call may use.
// Up to MAX_TOOL_CALL_ROUNDS - 1 of these turns may be tool calls; the
// last turn is always required to be a final answer (enforced below,
// not just requested in the prompt) — see the isFinalRound branch in
// runToolCallingLoop. Exported so tests can assert the loop actually
// stops at this bound instead of hardcoding the number twice.
export const MAX_TOOL_CALL_ROUNDS = 3;

function isValidIntent(value: unknown): value is AgentIntent {
  return typeof value === "string" && (AGENT_INTENTS as readonly string[]).includes(value);
}

// --- Model directive parsing -------------------------------------------

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

/**
 * Parses one model turn's raw JSON string content into either a tool-call
 * request or a final answer. Throws on anything malformed — same
 * "invalid JSON / missing reply" failure behavior both providers already
 * had in their pre-existing parseModelContent, preserved here so a
 * malformed response still degrades via FallbackAIProvider exactly like
 * before this change.
 */
export function parseModelDirective(content: string, previousIntent: AgentIntent | null): ModelDirective {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("AI provider response was not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI provider response was not a JSON object.");
  }
  const record = parsed as Record<string, unknown>;

  const rawToolCall = record.toolCall;
  if (rawToolCall && typeof rawToolCall === "object" && !Array.isArray(rawToolCall)) {
    const toolCallRecord = rawToolCall as Record<string, unknown>;
    if (typeof toolCallRecord.toolId === "string" && toolCallRecord.toolId.trim().length > 0) {
      const args =
        toolCallRecord.arguments && typeof toolCallRecord.arguments === "object" && !Array.isArray(toolCallRecord.arguments)
          ? (toolCallRecord.arguments as Record<string, unknown>)
          : {};
      return { kind: "tool_call", toolId: toolCallRecord.toolId, arguments: args };
    }
  }

  const reply = typeof record.reply === "string" ? record.reply : "";
  if (!reply.trim()) {
    throw new Error("AI provider response was missing a non-empty reply.");
  }
  const intent = isValidIntent(record.intent) ? record.intent : previousIntent ?? "general_help";
  return { kind: "final", intent, reply };
}

// --- Tool catalog / prompt block ----------------------------------------

/** Only "read" tools are ever advertised to a model in this loop — see this file's header comment. */
export function getReadOnlyToolCatalog(): readonly AnyAgentTool[] {
  return getAgentToolRegistry()
    .list()
    .filter((tool) => tool.mode === "read");
}

export function buildToolCatalogPromptBlock(tools: readonly AnyAgentTool[]): string {
  if (tools.length === 0) return "";

  const lines = tools.map(
    (tool) => `- "${tool.id}": ${tool.description} Arguments JSON schema: ${JSON.stringify(tool.inputSchema)}`
  );

  return [
    "You also have read-only tools for looking up live on-chain / app facts you don't already know from the facts above. Only call one when the user's question genuinely needs current data.",
    "Available tools:",
    ...lines,
    'To call a tool: respond with ONLY this JSON and nothing else — {"toolCall": {"toolId": "<id>", "arguments": { ...matching that tool\'s schema... }}}',
    'Once you have an answer (with or without a tool result): respond with ONLY this JSON — {"intent": "<intent>", "reply": "<answer>"}.',
    "Call at most one tool per turn. Never invent a toolId, and never invent tool result data — only report what a tool result actually returned.",
  ].join("\n");
}

// --- Tool execution -------------------------------------------------------

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Executes exactly one tool call through the real production
 * agentToolRuntime singleton — the same instance P0.2/P2 tools are
 * registered into (see agent-tool-runtime-instance.ts). Refuses to even
 * attempt a call for a toolId that isn't registered as a "read" tool;
 * AgentToolRuntime itself would also refuse a non-read tool (unconditionally
 * for "execute", via canPrepare:false below for "prepare"), but this
 * check keeps an unadvertised/unknown id from ever reaching the runtime
 * at all, and gives a clean TOOL_NOT_FOUND result to fold back into the
 * transcript either way.
 */
export async function runRegisteredReadTool(
  toolId: string,
  args: Record<string, unknown>,
  request: AIProviderRequest
): Promise<AgentToolResult> {
  const tool = getAgentToolRegistry().get(toolId);
  if (!tool || tool.mode !== "read") {
    return toolError(toolId, {
      code: "TOOL_NOT_FOUND",
      message: `No read-only tool is registered with id "${toolId}".`,
    });
  }

  try {
    // AgentToolRuntime never throws past its own boundary (see that
    // file's header comment) — it always resolves with a sanitized
    // AgentToolResult, even on an internal failure. This try/catch is
    // defense-in-depth only, so a future change to that guarantee still
    // can't leak a raw exception (with a raw message/stack) into the
    // transcript this file feeds back to the model.
    return await agentToolRuntime.executeTool(toolId, args, {
      appContext: request.agentContext,
      memoryContext: request.memoryContext,
      walletAddress: request.address,
      confirmationMode: "always_confirm",
      // Explicitly closed: this natural-language loop may only ever run
      // "read" tools. canPrepare:false blocks a "prepare" tool even
      // though one is registered under this same id namespace;
      // canExecute is irrelevant (AgentToolRuntime refuses "execute"
      // tools unconditionally, see agent-tool-runtime.ts) but is set
      // false here too so this permissions object never reads as
      // anything but fully locked down.
      permissions: { canRead: true, canPrepare: false, canExecute: false },
    });
  } catch {
    return toolError(toolId, {
      code: "PROVIDER_ERROR",
      message: "The tool failed unexpectedly.",
      retryable: true,
    });
  }
}

// --- The loop --------------------------------------------------------------

export type SendCompletion = (systemPrompt: string, userPrompt: string) => Promise<string>;

/**
 * Runs one full generateReply() turn for a network AIProvider, including
 * up to MAX_TOOL_CALL_ROUNDS model round-trips if the model asks to call
 * a read tool along the way. `sendCompletion` is each provider's existing
 * network call (POST to its own /api/agent/complete[/gemini] route) —
 * this function contains no fetch/network code of its own and no
 * vendor-specific request/response shape; that stays entirely inside
 * each *-ai-provider.ts file, which is the only thing that changes
 * per-provider.
 */
export async function runToolCallingLoop(
  request: AIProviderRequest,
  baseSystemPrompt: string,
  sendCompletion: SendCompletion
): Promise<AIProviderResponse> {
  const catalogBlock = buildToolCatalogPromptBlock(getReadOnlyToolCatalog());
  const systemPrompt = catalogBlock ? `${baseSystemPrompt}\n\n${catalogBlock}` : baseSystemPrompt;

  let transcript = "";

  for (let round = 1; round <= MAX_TOOL_CALL_ROUNDS; round++) {
    const isFinalRound = round === MAX_TOOL_CALL_ROUNDS;
    const roundSystemPrompt = isFinalRound
      ? `${systemPrompt}\n\nThis is your final turn for this request — you must respond with the final answer JSON now. Do not request another tool.`
      : systemPrompt;
    const userPrompt = transcript ? `${request.prompt}\n\n${transcript}` : request.prompt;

    const content = await sendCompletion(roundSystemPrompt, userPrompt);
    const directive = parseModelDirective(content, request.previousIntent);

    if (directive.kind === "final") {
      return {
        intent: directive.intent,
        reply: directive.reply,
        actions: getAgentActions(directive.intent, request.agentContext),
        highlights: getAgentHighlights(directive.intent, request.agentContext),
        followUps: getFollowUpPrompts(directive.intent),
      };
    }

    // directive.kind === "tool_call"
    if (isFinalRound) {
      // The model was explicitly told this turn must be final and asked
      // for a tool anyway — refuse rather than looping further. This is
      // what actually enforces the round bound; the prompt instruction
      // above is a courtesy to the model, not the safety mechanism.
      throw new Error("AI provider requested a tool call on its final allowed turn — refusing to loop further.");
    }

    const toolResult = await runRegisteredReadTool(directive.toolId, directive.arguments, request);
    transcript += [
      "",
      `[Tool result: ${directive.toolId}]`,
      safeStringify({
        success: toolResult.success,
        data: toolResult.data ?? null,
        error: toolResult.error ?? null,
        source: toolResult.metadata.source ?? null,
      }),
      'Use this tool result (if relevant) to answer the user\'s original question now. Respond ONLY with the final JSON {"intent": "...", "reply": "..."}.',
    ].join("\n");
  }

  // Unreachable — the isFinalRound branch above always throws or returns
  // before the loop variable can exceed MAX_TOOL_CALL_ROUNDS. Kept so
  // this function is total under TypeScript's control-flow analysis.
  throw new Error("Tool-calling loop ended without a final answer.");
}

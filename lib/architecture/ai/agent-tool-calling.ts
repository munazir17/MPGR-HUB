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
//
// P4 trade integration:
//   - trade_prepare_swap is advertised as a prepare tool.
//   - Structured TradeProposal is captured from the tool result.
//   - The model is never trusted to invent amounts, tokens, or calldata.
//   - Signing remains behind explicit Confirm & Swap.
//
// P3 robustness addendum:
//   - x402 tool arguments are normalized to resourceUrl (never url).
//   - A valid tool result on the final allowed turn is turned into a
//     grounded {"intent","reply"} instead of throwing into
//     FallbackAIProvider / DeterministicAIProvider.

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
import type { TokenizedStockReport, TradeProposal } from "@/lib/trade/trade-types";

export const MAX_TOOL_CALL_ROUNDS = 3;

const X402_RESOURCE_URL_TOOL_IDS = new Set([
  "x402_discover_resource",
  "x402_prepare_payment",
]);

function isValidIntent(value: unknown): value is AgentIntent {
  return (
    typeof value === "string" &&
    (AGENT_INTENTS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// x402 argument normalization
// ---------------------------------------------------------------------------

/**
 * x402_discover_resource / x402_prepare_payment require `resourceUrl`.
 *
 * Models (and a few older tests) sometimes emit `url` or `resource`.
 * Those aliases are rewritten here so the real tool schema is satisfied
 * without advertising `url` on the declaration.
 */
export function normalizeX402ToolArguments(
  toolId: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!X402_RESOURCE_URL_TOOL_IDS.has(toolId)) {
    return args;
  }

  const resourceUrl = pickResourceUrl(args);

  if (resourceUrl === null) {
    return args;
  }

  const next: Record<string, unknown> = {
    ...args,
    resourceUrl,
  };

  delete next.url;
  delete next.resource;

  return next;
}

const TRADE_TAKER_TOOL_IDS = new Set([
  "trade_get_price",
  "trade_prepare_swap",
  "tokenized_stock_research",
]);

/**
 * CDP quotes are bound to `taker`. If the model omitted it, fill from
 * the connected wallet — never invent a different address.
 */
export function normalizeTradeToolArguments(
  toolId: string,
  args: Record<string, unknown>,
  walletAddress?: string,
): Record<string, unknown> {
  if (!TRADE_TAKER_TOOL_IDS.has(toolId)) return args;
  if (typeof args.taker === "string" && args.taker.trim().length > 0) {
    return args;
  }
  if (typeof walletAddress === "string" && walletAddress.trim().length > 0) {
    return { ...args, taker: walletAddress.trim() };
  }
  return args;
}

function pickResourceUrl(
  args: Record<string, unknown>,
): string | null {
  if (
    typeof args.resourceUrl === "string" &&
    args.resourceUrl.trim()
  ) {
    return args.resourceUrl.trim();
  }

  if (
    typeof args.url === "string" &&
    args.url.trim()
  ) {
    return args.url.trim();
  }

  if (
    typeof args.resource === "string" &&
    args.resource.trim()
  ) {
    return args.resource.trim();
  }

  return null;
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

export type ModelDirective =
  | ToolCallDirective
  | FinalAnswerDirective;

export function parseModelDirective(
  content: string,
  previousIntent: AgentIntent | null,
): ModelDirective {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      "AI provider response was not valid JSON.",
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "AI provider response was not a JSON object.",
    );
  }

  const record = parsed as Record<string, unknown>;

  const rawToolCall = record.toolCall;

  if (
    rawToolCall &&
    typeof rawToolCall === "object" &&
    !Array.isArray(rawToolCall)
  ) {
    const toolCallRecord =
      rawToolCall as Record<string, unknown>;

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

      const toolId = toolCallRecord.toolId.trim();

      return {
        kind: "tool_call",
        toolId,
        arguments: normalizeTradeToolArguments(
          toolId,
          normalizeX402ToolArguments(toolId, args),
        ),
      };
    }
  }

  const reply =
    typeof record.reply === "string"
      ? record.reply
      : "";

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
      (tool) =>
        tool.mode === "read" ||
        tool.mode === "prepare",
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
      '- "' + tool.id + '": ' + tool.description + " Arguments JSON schema: " + JSON.stringify(
        tool.inputSchema,
      ),
  );

  return [
    "You have tools for looking up live on-chain/app facts you do not already know, for preparing an x402 payment proposal, for researching Coinbase Tokenized Stocks on Base, and for preparing a Base swap quote.",
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
    'For x402_discover_resource and x402_prepare_payment the URL argument name is resourceUrl — never url.',
    "Never invent payment amount, asset, recipient, or any other payment field. If x402_prepare_payment succeeds, the app itself will display the structured proposal.",
    'For buy/sell/swap/quote requests call trade_prepare_swap. Dollar buys: fromToken=\"USDC\", amount=\"10\" (human units). Omit taker — the connected wallet is filled automatically.',
    "For Coinbase tokenized-stock research call tokenized_stock_research. Do not invent liquidity or quotes.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function safeStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) =>
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
      message: 'No read-only tool is registered with id "' + toolId + '".',
    });
  }

  try {
    return await agentToolRuntime.executeTool(
      toolId,
      normalizeTradeToolArguments(
        toolId,
        normalizeX402ToolArguments(toolId, args),
        request.address,
      ),
      {
        appContext: request.agentContext,
        memoryContext: request.memoryContext,
        walletAddress: request.address,
        confirmationMode: "always_confirm",
        permissions: {
          canRead: true,
          canPrepare: false,
          canExecute: false,
        },
      },
    );
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
    (tool.mode !== "read" &&
      tool.mode !== "prepare")
  ) {
    return toolError(toolId, {
      code: "TOOL_NOT_FOUND",
      message: 'No read or prepare tool is registered with id "' + toolId + '".',
    });
  }

  try {
    return await agentToolRuntime.executeTool(
      toolId,
      normalizeTradeToolArguments(
        toolId,
        normalizeX402ToolArguments(toolId, args),
        request.address,
      ),
      {
        appContext: request.agentContext,
        memoryContext: request.memoryContext,
        walletAddress: request.address,
        confirmationMode: "always_confirm",
        permissions: {
          canRead: true,
          canPrepare: true,
          canExecute: false,
        },
      },
    );
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

function captureX402Proposal(
  toolId: string,
  toolResult: AgentToolResult,
  current: X402PaymentProposal | undefined,
): X402PaymentProposal | undefined {
  if (
    toolId !== "x402_prepare_payment" ||
    !toolResult.success
  ) {
    return current;
  }

  const data = toolResult.data as
    | {
        proposal?: X402PaymentProposal;
      }
    | undefined;

  return data?.proposal ?? current;
}

function captureTradeProposal(
  toolId: string,
  toolResult: AgentToolResult,
  current: TradeProposal | undefined,
): TradeProposal | undefined {
  if (toolId !== "trade_prepare_swap" || !toolResult.success) {
    return current;
  }
  const data = toolResult.data as { proposal?: TradeProposal } | undefined;
  return data?.proposal ?? current;
}

function captureTokenizedStockReport(
  toolId: string,
  toolResult: AgentToolResult,
  current: TokenizedStockReport | undefined,
): TokenizedStockReport | undefined {
  if (toolId !== "tokenized_stock_research" || !toolResult.success) {
    return current;
  }
  const data = toolResult.data as { report?: TokenizedStockReport } | undefined;
  return data?.report ?? current;
}

function buildLoopResponse(
  request: AIProviderRequest,
  intent: AgentIntent,
  reply: string,
  x402Proposal: X402PaymentProposal | undefined,
  tradeProposal?: TradeProposal,
  tokenizedStockReport?: TokenizedStockReport,
): AIProviderResponse {
  return {
    intent,
    reply,
    actions: getAgentActions(
      intent,
      request.agentContext,
    ),
    highlights: getAgentHighlights(
      intent,
      request.agentContext,
    ),
    followUps: getFollowUpPrompts(intent),
    ...(x402Proposal ? { x402Proposal } : {}),
    ...(tradeProposal ? { tradeProposal } : {}),
    ...(tokenizedStockReport ? { tokenizedStockReport } : {}),
  };
}

/**
 * Last-resort reply when the model keeps requesting tools on its final
 * allowed turn. Grounded only in the structured tool result — never
 * invents payment amount / asset / payTo.
 */
export function synthesizeFinalReplyFromToolResult(
  toolId: string,
  toolResult: AgentToolResult,
  capturedX402Proposal:
    | X402PaymentProposal
    | undefined,
  capturedTradeProposal?: TradeProposal,
): string {
  if (capturedTradeProposal) {
    return capturedTradeProposal.executionAvailable
      ? "A Base swap proposal is ready for you to review in the app. I will not sign or submit anything until you explicitly confirm."
      : "I looked up that pair on Coinbase CDP. No executable Base route is available right now — the research is on screen. I will not sign anything.";
  }

  if (capturedX402Proposal) {
    return "A payment proposal is ready for you to review in the app. I will not sign or submit anything until you explicitly confirm.";
  }

  if (toolId === "x402_discover_resource") {
    if (toolResult.success) {
      const paymentRequired =
        (
          toolResult.data as
            | { paymentRequired?: unknown }
            | undefined
        )?.paymentRequired === true;

      return paymentRequired
        ? "This resource requires an x402 payment. The accepted options come from the resource server. Say if you want me to prepare a payment proposal — I will not sign or submit it."
        : "This resource did not request an x402 payment.";
    }

    return (
      toolResult.error?.message?.trim() ||
      "I could not determine whether that resource requires an x402 payment. Please retry."
    );
  }

  if (toolResult.success) {
    return "I finished that lookup. Ask if you want me to go further — I will not sign or submit any transaction.";
  }

  return (
    toolResult.error?.message?.trim() ||
    "I could not complete that lookup. Please retry or rephrase."
  );
}

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
 *
 * If the model requests another tool on the final allowed turn, the
 * loop still executes that last read/prepare tool (never execute-mode)
 * and returns a grounded final answer. It does not throw into
 * FallbackAIProvider after a valid tool result.
 */
export async function runToolCallingLoop(
  request: AIProviderRequest,
  baseSystemPrompt: string,
  sendCompletion: SendCompletion,
): Promise<AIProviderResponse> {
  const catalogBlock =
    buildToolCatalogPromptBlock(
      getReadAndPrepareToolCatalog(),
    );

  const systemPrompt = catalogBlock
    ? baseSystemPrompt + "\n\n" + catalogBlock
    : baseSystemPrompt;

  let transcript = "";

  let capturedX402Proposal:
    | X402PaymentProposal
    | undefined;
  let capturedTradeProposal: TradeProposal | undefined;
  let capturedStockReport: TokenizedStockReport | undefined;

  for (
    let round = 1;
    round <= MAX_TOOL_CALL_ROUNDS;
    round++
  ) {
    const isFinalRound =
      round === MAX_TOOL_CALL_ROUNDS;

    const roundSystemPrompt = isFinalRound
      ? systemPrompt +
        "\n\nThis is your final turn for this request. You MUST respond with the final answer JSON now. Do not request another tool."
      : systemPrompt;

    const userPrompt = transcript
      ? request.prompt + "\n\n" + transcript
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
      return buildLoopResponse(
        request,
        directive.intent,
        directive.reply,
        capturedX402Proposal,
        capturedTradeProposal,
        capturedStockReport,
      );
    }

    const toolResult = await runRegisteredTool(
      directive.toolId,
      directive.arguments,
      request,
    );

    capturedX402Proposal =
      captureX402Proposal(
        directive.toolId,
        toolResult,
        capturedX402Proposal,
      );
    capturedTradeProposal = captureTradeProposal(
      directive.toolId,
      toolResult,
      capturedTradeProposal,
    );
    capturedStockReport = captureTokenizedStockReport(
      directive.toolId,
      toolResult,
      capturedStockReport,
    );

    if (isFinalRound) {
      const intent =
        request.previousIntent ?? "general_help";

      return buildLoopResponse(
        request,
        intent,
        synthesizeFinalReplyFromToolResult(
          directive.toolId,
          toolResult,
          capturedX402Proposal,
          capturedTradeProposal,
        ),
        capturedX402Proposal,
        capturedTradeProposal,
        capturedStockReport,
      );
    }

    const isX402Prepare =
      directive.toolId === "x402_prepare_payment";
    const isTradePrepare =
      directive.toolId === "trade_prepare_swap";

    if (isX402Prepare) {
      transcript += [
        "",
        "[Tool result: " + directive.toolId + "]",
        toolResult.success
          ? safeStringify({
              success: true,
              note: "A payment proposal was prepared and will be shown directly in the app UI for user review and explicit confirmation.",
            })
          : safeStringify({
              success: false,
              error: toolResult.error ?? null,
            }),
        'Respond ONLY with the final JSON {"intent":"...","reply":"..."}. Keep the reply short; do NOT restate the amount, asset, recipient, or other payment fields — the app UI displays those directly from the structured proposal.',
      ].join("\n");
    } else if (isTradePrepare) {
      transcript += [
        "",
        "[Tool result: " + directive.toolId + "]",
        toolResult.success
          ? safeStringify({
              success: true,
              note: "A swap proposal was prepared and will be shown directly in the app UI for user review and explicit confirmation.",
            })
          : safeStringify({
              success: false,
              error: toolResult.error ?? null,
            }),
        'Respond ONLY with the final JSON {"intent":"...","reply":"..."}. Keep the reply short. Do NOT restate amounts, token addresses, calldata, or recipient fields; the app UI displays those directly from the structured proposal.',
      ].join("\n");
    } else {
      transcript += [
        "",
        "[Tool result: " + directive.toolId + "]",
        safeStringify({
          success: toolResult.success,
          data: toolResult.data ?? null,
          error: toolResult.error ?? null,
          source:
            toolResult.metadata.source ?? null,
        }),
        'Use this tool result, if relevant, to answer the user\'s original question. Respond ONLY with the final JSON {"intent":"...","reply":"..."}.',
      ].join("\n");
    }
  }

  throw new Error(
    "Tool-calling loop ended without a final answer.",
  );
}

import type { AgentToolResult } from "@/lib/architecture/tools/agent-tool-result";
import { toolError } from "@/lib/architecture/tools/agent-tool-result";
import { getAgentToolRegistry } from "@/lib/architecture/tools/agent-tool-registry-instance";
import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import type {
  AIProviderRequest,
  AIProviderResponse,
} from "./ai-provider";
import type { AgentIntent } from "@/lib/agent-intelligence";
import {
  getAgentActions,
  getAgentHighlights,
  getFollowUpPrompts,
} from "@/lib/agent-actions";
import type { TokenizedStockReport, TradeProposal } from "@/lib/trade/trade-types";
import { formatAtomicAmount } from "@/lib/trade/trade-format";
import type { TransferProposal } from "@/lib/trade/transfer-types";
import type { X402PaymentProposal } from "@/lib/x402/x402-proposal";
import { normalizeTradeToolArguments, normalizeX402ToolArguments } from "./tool-call-normalization";

export function safeStringify(value: unknown): string {
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

export function captureX402Proposal(
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

export function captureTradeProposal(
  toolId: string,
  toolResult: AgentToolResult,
  current: TradeProposal | undefined,
): TradeProposal | undefined {
  if (
    (toolId !== "trade_prepare_swap" && toolId !== "tokenized_stock_prepare_order") ||
    !toolResult.success
  ) {
    return current;
  }
  const data = toolResult.data as { proposal?: TradeProposal } | undefined;
  return data?.proposal ?? current;
}

export function captureTokenizedStockReport(
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

export function captureTransferProposal(
  toolId: string,
  toolResult: AgentToolResult,
  current: TransferProposal | undefined,
): TransferProposal | undefined {
  if (toolId !== "transfer_prepare_send" || !toolResult.success) {
    return current;
  }
  const data = toolResult.data as { proposal?: TransferProposal } | undefined;
  return data?.proposal ?? current;
}

/**
 * Deterministic, grounded reply for a failed transfer_prepare_send call.
 *
 * transfer_prepare_send failures already carry a specific, user-facing
 * message from lib/trade/transfer-request.ts / transfer-basename.ts /
 * transfer-proposal.ts / transfer-tool-definitions.ts (invalid
 * recipient, unresolved Basename, resolver failure, provider error,
 * etc). The model must never be given a free turn to paraphrase or
 * replace that message with generic assistant/help text — this is
 * returned directly instead of being folded back into the transcript.
 */
export function formatTransferPrepareFailureReply(
  toolResult: AgentToolResult,
): string {
  const message = toolResult.error?.message?.trim();
  return message
    ? `${message}${/nothing (was|will be) sent/i.test(message) ? "" : " Nothing was sent."}`
    : "Could not prepare that Base transfer. Nothing was sent. Please try again.";
}

/**
 * Deterministic, grounded reply when transfer_prepare_send succeeds but
 * the live on-chain balance check came back short. This is not a tool
 * failure (buildTransferProposal returns ok:true with
 * sufficientBalance:false so the UI can still show why nothing is
 * signable — see transfer-proposal.ts's header comment), but the chat
 * reply must be just as deterministic as an outright failure: never
 * generic "ready to review" text.
 */
export function formatInsufficientBalanceReply(
  proposal: TransferProposal,
): string {
  const available = formatAtomicAmount(
    proposal.senderBalance,
    proposal.asset.decimals,
  );
  if (proposal.kind === "native-transfer") {
    return `Insufficient ETH balance. You have ${available} ETH, which isn't enough to cover ${proposal.displayAmount} plus network fees. Nothing was sent.`;
  }
  return `Insufficient ${proposal.asset.symbol} balance. You have ${available} ${proposal.asset.symbol}, but you're trying to send ${proposal.displayAmount}. Nothing was sent.`;
}

export function buildLoopResponse(
  request: AIProviderRequest,
  intent: AgentIntent,
  reply: string,
  x402Proposal: X402PaymentProposal | undefined,
  tradeProposal?: TradeProposal,
  tokenizedStockReport?: TokenizedStockReport,
  transferProposal?: TransferProposal,
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
    ...(transferProposal ? { transferProposal } : {}),
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
  capturedX402Proposal?:
    | X402PaymentProposal
    | undefined,
  capturedTradeProposal?: TradeProposal,
  capturedTransferProposal?: TransferProposal,
): string {
  if (capturedTransferProposal) {
    return "A Base transfer proposal is ready for you to review in the app. I will not sign or send anything until you explicitly confirm.";
  }

  if (capturedTradeProposal) {
    return capturedTradeProposal.executionAvailable
      ? "A Base swap proposal is ready for you to review in the app. I will not sign or submit anything until you explicitly confirm."
      : "I looked up that pair on Base. No executable route is available right now — the research is on screen. I will not sign anything.";
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
